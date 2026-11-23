import type { Prisma, PrismaClient } from '@prisma/client';
import { BANK_SOURCES, sampleStandardItems } from '@lse/shared';
import { defaultJudgeChat, type JudgeChat } from '../../standard-evaluations/gbt45654/classifier.js';
import {
  AUTO_KEYWORD_SOURCE,
  KEYWORDS_PER_ITEM,
  KEYWORD_EXAMPLES_PER_ITEM,
  KEYWORD_ITEMS,
  KEYWORD_JUDGE_BATCH_SIZE,
  MAX_CONSECUTIVE_FAILURES,
} from './constants.js';
import { StopUpdate, createCaller } from './llm-call.js';
import { finalizeStaleRuns, runningTotals, touchHeartbeat } from './run-state.js';
import { isInactiveQuestion } from './bank-meta.js';
import { NO_JUDGE_NOTE, resolveBankUpdateModels, type BankUpdateModels } from './models.js';
import { precheckKeywords } from './precheck.js';
import {
  buildKeywordJudgePrompt,
  buildKeywordPrompt,
  parseGeneratedKeywords,
  parseKeywordVerdicts,
} from './prompts.js';
import { keywordVersion } from './versions.js';

export interface KeywordUpdateDeps {
  chat?: JudgeChat;
  models?: BankUpdateModels;
  now?: () => Date;
  trigger: 'schedule' | 'manual';
  actorName: string;
  /** 执行本次补充的队列任务号，见 QuestionUpdateDeps.jobId。 */
  jobId?: string | null;
  limits?: Partial<{ perItem: number; examples: number; maxFailures: number; items: readonly string[] }>;
}

export interface KeywordUpdateResult {
  id: string;
  status: 'succeeded' | 'failed' | 'skipped';
  version: string;
  /** 按项的新增数（候选）。 */
  added: Record<string, number>;
  note: string;
  error: string | null;
}

/** 每周补关键词：出题模型写新词 → 预检 → 裁判模型判 fit/specific → 以候选入库（不自动生效）。 */
export async function runKeywordUpdate(db: PrismaClient, deps: KeywordUpdateDeps): Promise<KeywordUpdateResult> {
  const chat = deps.chat ?? defaultJudgeChat;
  const now = (deps.now ?? (() => new Date()))();
  const perItem = deps.limits?.perItem ?? KEYWORDS_PER_ITEM;
  const examplesN = deps.limits?.examples ?? KEYWORD_EXAMPLES_PER_ITEM;
  const items = deps.limits?.items ?? KEYWORD_ITEMS;
  const version = keywordVersion(now);

  // 心跳过期的执行中记录（上次被中断）先收尾。
  await finalizeStaleRuns(db, 'keywords', { jobId: deps.jobId });

  const models = deps.models ?? (await resolveBankUpdateModels(db));
  if (!models.judge || !models.generator) {
    const rec = await db.gbtBankUpdate.create({
      data: {
        kind: 'keywords',
        version,
        trigger: deps.trigger,
        status: 'skipped',
        actorName: deps.actorName,
        startedAt: now,
        finishedAt: new Date(),
        note: NO_JUDGE_NOTE,
      },
    });
    return { id: rec.id, status: 'skipped', version, added: {}, note: NO_JUDGE_NOTE, error: null };
  }
  const generator = models.generator;
  const judge = models.judge;
  const addedSoFar: Record<string, number> = {};
  const rec = await db.gbtBankUpdate.create({
    data: {
      kind: 'keywords',
      version,
      trigger: deps.trigger,
      status: 'running',
      actorName: deps.actorName,
      startedAt: now,
      generatorModel: generator.model,
      judgeModel: judge.model,
      totals: runningTotals(deps.jobId),
    },
  });

  // running 记录创建之后的任何异常都要把记录写回终态，不留「执行中」。
  try {
    return await executeKeywordRun();
  } catch (e) {
    const error = `更新中断：${(e as Error).message}`.slice(0, 500);
    await db.gbtBankUpdate
      .updateMany({
        where: { id: rec.id, status: 'running' },
        data: { status: 'failed', finishedAt: new Date(), added: addedSoFar as Prisma.InputJsonValue, error },
      })
      .catch(() => undefined);
    return { id: rec.id, status: 'failed' as const, version, added: addedSoFar, note: '', error };
  }

  async function executeKeywordRun(): Promise<KeywordUpdateResult> {

  const existing = await db.standardKeyword.findMany({
    where: { tenantId: null },
    select: { itemCode: true, term: true, reviewStatus: true },
  });
  const existingTerms = new Set(existing.map((k) => k.term));
  const byItem = new Map<string, string[]>();
  // 示例词只取生效的：候选、停用、已剔除的不给模型当范例。
  for (const k of existing) {
    if (k.reviewStatus !== 'approved') continue;
    (byItem.get(k.itemCode) ?? byItem.set(k.itemCode, []).get(k.itemCode)!).push(k.term);
  }
  // 在用非拒答题的题面：词出现在里面就会误伤正常提问。
  const nonRefusalSet = await db.questionSet.findFirst({
    where: { source: BANK_SOURCES.non_refusal, tenantId: null },
    select: { id: true },
  });
  const nonRefusalText = nonRefusalSet
    ? (await db.question.findMany({ where: { questionSetId: nonRefusalSet.id }, select: { content: true, metadata: true } }))
        .filter((q) => !isInactiveQuestion(q.metadata))
        .map((q) => q.content.normalize('NFKC').toLowerCase())
    : [];

  const caller = createCaller(chat, deps.limits?.maxFailures ?? MAX_CONSECUTIVE_FAILURES, () => touchHeartbeat(db, rec.id, deps.jobId));
  const added = addedSoFar;
  const stats = { candidates: 0, precheckRejected: 0, judgeRejected: 0, accepted: 0, noVerdict: 0 };
  let stopError = null as string | null;

  try {
    for (const itemCode of items) {
      const pool = (byItem.get(itemCode) ?? []).map((term) => ({ id: term, term }));
      const examples = sampleStandardItems(pool, Math.min(examplesN, pool.length), `${version}:kw:${itemCode}`).map(
        (p) => p.term,
      );
      const parsed = await caller.call(
        'generator',
        generator.cfg,
        buildKeywordPrompt({ itemCode, examples, count: perItem }),
        2048,
        0.9,
        parseGeneratedKeywords,
      );
      if (!parsed) continue;
      stats.candidates += parsed.length;
      const pre = precheckKeywords(
        parsed.map((term) => ({ itemCode, term })),
        { existingTerms, nonRefusalText },
      );
      stats.precheckRejected += pre.rejected.length;
      const keep: Array<{ itemCode: string; term: string }> = [];
      for (let i = 0; i < pre.accepted.length; i += KEYWORD_JUDGE_BATCH_SIZE) {
        const batch = pre.accepted.slice(i, i + KEYWORD_JUDGE_BATCH_SIZE).map((c, j) => ({ n: j + 1, ...c }));
        let verdicts = null as ReturnType<typeof parseKeywordVerdicts>;
        for (let attempt = 0; attempt < 2 && !verdicts; attempt += 1) {
          verdicts = await caller.call('judge', judge.cfg, buildKeywordJudgePrompt(batch), 2048, 0, parseKeywordVerdicts);
        }
        for (const b of batch) {
          const v = verdicts?.get(b.n);
          if (v && v.fit && v.specific) keep.push({ itemCode: b.itemCode, term: b.term });
          else {
            stats.judgeRejected += 1;
            if (!v) stats.noVerdict += 1;
          }
        }
      }
      if (keep.length === 0) continue;
      // 平台词表的去重在应用层做（NULL 租户不触发唯一索引）。
      const res = await db.standardKeyword.createMany({
        data: keep.map((k) => ({
          tenantId: null,
          itemCode: k.itemCode,
          term: k.term,
          source: AUTO_KEYWORD_SOURCE,
          reviewStatus: 'pending',
        })),
        skipDuplicates: true,
      });
      for (const k of keep) existingTerms.add(k.term);
      added[itemCode] = res.count;
      stats.accepted += res.count;
    }
  } catch (e) {
    stopError = e instanceof StopUpdate ? e.message : `更新中断：${(e as Error).message}`.slice(0, 500);
  }

  const total = Object.values(added).reduce((a, n) => a + n, 0);
  // 与题库更新同一口径：新增为 0，或「无判定」占多数，说明模型没有正常工作，记失败。
  if (!stopError) {
    const judged = stats.judgeRejected + stats.accepted;
    if (total === 0) {
      stopError =
        stats.candidates === 0
          ? (caller.lastError ?? '出题模型没有产出可用候选词')
          : judged === 0
            ? '候选词全部被预检剔除，没有词进入裁判核验'
            : stats.noVerdict === stats.judgeRejected
              ? caller.lastError
                ? `裁判模型无有效判定（${caller.lastError}）`
                : '裁判模型无有效判定'
              : `没有词通过裁判核验（${stats.judgeRejected} 个不合格）`;
    } else if (stats.noVerdict * 2 > judged) {
      stopError = `裁判模型无有效判定占多数（${stats.noVerdict}/${judged} 个）`;
    }
  }
  const status: 'succeeded' | 'failed' = stopError ? 'failed' : 'succeeded';
  const platformTotal = await db.standardKeyword.count({ where: { tenantId: null, reviewStatus: 'approved' } });
  const note =
    (models.same
      ? `出题与核验用的是同一个模型（${generator.model}）`
      : `出题模型 ${generator.model}，裁判模型 ${judge.model}`) +
    `；候选 ${stats.candidates} 个，预检剔除 ${stats.precheckRejected} 个，裁判判定不合格 ${stats.judgeRejected} 个（其中无判定 ${stats.noVerdict} 个），新增 ${total} 个，均为候选。`;
  // 只改仍在执行中的记录：已被收尾（中断后重新执行）的不覆盖。
  await db.gbtBankUpdate.updateMany({
    where: { id: rec.id, status: 'running' },
    data: {
      status,
      finishedAt: new Date(),
      added: added as Prisma.InputJsonValue,
      totals: { keywords: platformTotal } as Prisma.InputJsonValue,
      note,
      error: stopError,
    },
  });
  return { id: rec.id, status, version, added, note, error: stopError };
  }
}
