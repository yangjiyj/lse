import type { Prisma, PrismaClient } from '@prisma/client';
import { BANK_KINDS, BANK_LABELS, BANK_SOURCES, sampleStandardItems, type BankKind } from '@lse/shared';
import { bankQuestionBase, loadManifest } from '../builtin/gbt45654-bank.js';
import { computeBankCoverage } from '../builtin/bank-service.js';
import { defaultJudgeChat, type JudgeChat } from '../../standard-evaluations/gbt45654/classifier.js';
import {
  ACTIVE_CAP_PER_KEY,
  CANDIDATES_PER_KEY,
  EXAMPLES_PER_KEY,
  JUDGE_BATCH_SIZE,
  MAX_CONSECUTIVE_FAILURES,
  QUESTION_GEN_MAX_TOKENS,
  QUESTION_JUDGE_MAX_TOKENS,
  keysOfBank,
} from './constants.js';
import {
  activatePendingQuestions,
  activeTotals,
  currentBankVersion,
  isAutoQuestion,
  isInactiveQuestion,
  knownQuestionVersions,
  loadBuiltinBankSets,
  lockBankVersion,
  refreshBankSetMetadata,
  retirePendingQuestions,
} from './bank-meta.js';
import { NO_JUDGE_NOTE, resolveBankUpdateModels, type BankUpdateModels } from './models.js';
import { normalizeForDedupe, precheckQuestions, type Candidate } from './precheck.js';
import {
  agreementText,
  buildQuestionJudgePrompt,
  buildQuestionPrompt,
  judgeAccepts,
  parseGeneratedQuestions,
  parseQuestionVerdicts,
} from './prompts.js';
import { StopUpdate, createCaller } from './llm-call.js';
import { finalizeStaleRuns, isBankUpdateRunning, runningTotals, touchHeartbeat } from './run-state.js';
import { compareVersions, maxVersion, nextQuestionVersion, shanghaiDate } from './versions.js';

export type BankUpdateTrigger = 'release' | 'schedule' | 'manual';

type Db = PrismaClient | Prisma.TransactionClient;

export interface QuestionUpdateDeps {
  chat?: JudgeChat;
  /** 注入模型（测试用）；不传则按配置解析。 */
  models?: BankUpdateModels;
  now?: () => Date;
  trigger: Exclude<BankUpdateTrigger, 'release'>;
  actorName: string;
  /** 执行本次更新的队列任务号，写进执行中记录，任务被重投时据此认出遗留记录。 */
  jobId?: string | null;
  /** 只更新这几个题库（测试用）。 */
  banks?: readonly BankKind[];
  /** 覆盖常量（测试用）。 */
  limits?: Partial<{
    candidates: Record<BankKind, number>;
    caps: Record<BankKind, number>;
    examples: number;
    maxFailures: number;
    /** 只处理这些项（测试用），按题库给出。 */
    keys: Partial<Record<BankKind, readonly string[]>>;
  }>;
}

export interface QuestionUpdateResult {
  id: string;
  status: 'succeeded' | 'failed' | 'skipped';
  version: string;
  added: Record<string, Record<string, number>>;
  retired: Record<string, Record<string, number>>;
  note: string;
  error: string | null;
}

/** 裁判不一致而未入库的题：按库、按项，记总数、裁判给的「项/拒答」标签分布和主要原因（中文）。 */
export type RejectedStats = Record<
  string,
  Record<string, { total: number; judged: Record<string, number>; reason?: string }>
>;

/** 裁判标签：项编号/拒答（Y 或 N）；裁判没给出可用判定记「无判定」。 */
export const judgeLabelOf = (v: { item: string; refuse: boolean } | undefined): string =>
  v ? `${v.item}/${v.refuse ? 'Y' : 'N'}` : '无判定';

function recordRejection(stats: RejectedStats, bank: BankKind, key: string, v: { item: string; refuse: boolean } | undefined) {
  const entry = ((stats[bank] ??= {})[key] ??= { total: 0, judged: {} });
  entry.total += 1;
  const label = judgeLabelOf(v);
  entry.judged[label] = (entry.judged[label] ?? 0) + 1;
}

/** 裁判标签转中文短语：A.1.h/Y → 「A.1.h」，A.5.a/N → 「A.5.a（不拒答）」，N/N → 「普通题」。 */
export function judgeLabelText(label: string): string {
  if (label === '无判定') return '无判定';
  const [item, refuse] = label.split('/');
  const name = item === 'N' ? '普通题' : (item ?? label);
  return item !== 'N' && refuse === 'N' ? `${name}（不拒答）` : name;
}

const A5_ITEMS = ['A.5.a', 'A.5.b'];

/**
 * 一条未入库原因（中文）：先看拒答判断与期望是否相符，相符了才看项；
 * 项不符才写「多判为 X」，期望是 N 的（非拒答）不写成「多判为普通题」。
 */
export function rejectionReason(bank: BankKind, key: string, label: string): string {
  if (label === '无判定') return '核验没有结果';
  const [item = '', refuse = ''] = label.split('/');
  const itemName = item === 'N' ? '普通题' : item;
  if (bank === 'refusal') {
    if (refuse === 'N') return '裁判判为不应拒答';
    return `多判为 ${itemName}`;
  }
  if (bank === 'non_refusal') {
    if (refuse === 'Y') return '裁判判为应拒答';
    return `多判为 ${itemName}`;
  }
  if (A5_ITEMS.includes(key)) {
    if (refuse === 'Y') return '裁判判为应拒答';
    return `多判为 ${itemName}`;
  }
  return item === 'N' ? '裁判判为普通题' : `多判为 ${itemName}`;
}

/** 给每一项补上主要原因（中文），写进 totals.rejected，页面直接用。 */
function withReasons(stats: RejectedStats): RejectedStats {
  const out: RejectedStats = {};
  for (const [bank, byKey] of Object.entries(stats)) {
    for (const [key, v] of Object.entries(byKey)) {
      const best = Object.entries(v.judged).sort((a, b) => b[1] - a[1])[0];
      ((out[bank] ??= {})[key] = { ...v, ...(best ? { reason: rejectionReason(bank as BankKind, key, best[0]) } : {}) });
    }
  }
  return out;
}

/** 一句中文：未入库最多的两三项及主要去向；没有未入库返回空串。 */
export function describeRejections(stats: RejectedStats): string {
  const rows = Object.entries(stats).flatMap(([bank, byKey]) =>
    Object.entries(byKey).map(([key, v]) => ({ bank, key, ...v })),
  );
  const total = rows.reduce((a, r) => a + r.total, 0);
  if (total === 0) return '';
  const top = rows
    .sort((a, b) => b.total - a.total)
    .slice(0, 3)
    .map((r) => {
      const best = Object.entries(r.judged).sort((a, b) => b[1] - a[1])[0];
      const where = best ? `，${rejectionReason(r.bank as BankKind, r.key, best[0])}` : '';
      return `${BANK_LABELS[r.bank as BankKind]} ${r.key}（${r.total} 道${where}）`;
    });
  return `裁判不一致未入库最多的是 ${top.join('、')}`;
}

const metaOf = (m: unknown): Record<string, unknown> =>
  m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};

const keyOfRow = (bank: BankKind, m: unknown): string | null => {
  const v = metaOf(m);
  const k = bank === 'non_refusal' ? v.aspect : v.annexItem;
  return typeof k === 'string' && k ? k : null;
};

function asJson(v: unknown): Prisma.InputJsonValue {
  return v as Prisma.InputJsonValue;
}

async function coverageSummary(db: PrismaClient) {
  const out: Record<string, { ok: boolean; total: number; gaps: number }> = {};
  for (const c of await computeBankCoverage(db)) out[c.bank] = { ok: c.ok, total: c.total, gaps: c.gaps.length };
  return out;
}

type Counts = Record<string, Record<string, number>>;

/**
 * 轮换下线：只处理本次新增过题的项；只下线自动更新加的题（有 addedInVersion），不动内置题，本次新加的也不下线。
 * 在用题超过上限的部分，从最老的自动题开始下线。
 */
async function rotateOldAutoQuestions(
  db: Db,
  sets: ReadonlyArray<{ setId: string; bank: BankKind }>,
  banks: readonly BankKind[],
  added: Counts,
  caps: Record<BankKind, number>,
  version: string,
): Promise<Counts> {
  const retired: Counts = {};
  for (const bank of banks) {
    const set = sets.find((s) => s.bank === bank);
    const touched = Object.keys(added[bank] ?? {});
    if (!set || touched.length === 0) continue;
    const rows = await db.question.findMany({
      where: { questionSetId: set.setId },
      select: { id: true, externalId: true, metadata: true, createdAt: true },
    });
    for (const key of touched) {
      const active = rows
        .filter((r) => keyOfRow(bank, r.metadata) === key && !isInactiveQuestion(r.metadata))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      const excess = active.length - caps[bank];
      if (excess <= 0) continue;
      const old = active
        .filter((r) => isAutoQuestion(r.metadata) && !(r.externalId ?? '').includes(`:auto-${version}-`))
        .slice(0, excess);
      if (old.length === 0) continue;
      const ids = old.map((r) => r.id);
      await db.$executeRaw`
        UPDATE "questions"
        SET "metadata" = COALESCE("metadata", '{}'::jsonb)
          || jsonb_build_object('retired', true, 'retiredInVersion', ${version}::text, 'retiredBy', 'rotation')
        WHERE "id" = ANY(${ids}::text[])`;
      (retired[bank] ??= {})[key] = old.length;
    }
  }
  return retired;
}

const sumOf = (m: Counts, b: string) => Object.values(m[b] ?? {}).reduce((a, n) => a + n, 0);

/** 每月自动出题：出题模型写新题 → 预检 → 裁判模型核验 → 待生效入库 → 成功后一次性生效、轮换下线、刷新题集元数据。 */
export async function runQuestionBankUpdate(db: PrismaClient, deps: QuestionUpdateDeps): Promise<QuestionUpdateResult> {
  const chat = deps.chat ?? defaultJudgeChat;
  const now = (deps.now ?? (() => new Date()))();
  const banks = deps.banks ?? BANK_KINDS;
  const candidatesPer = deps.limits?.candidates ?? CANDIDATES_PER_KEY;
  const caps = deps.limits?.caps ?? ACTIVE_CAP_PER_KEY;
  const examplesN = deps.limits?.examples ?? EXAMPLES_PER_KEY;
  const maxFailures = deps.limits?.maxFailures ?? MAX_CONSECUTIVE_FAILURES;

  // 心跳过期的执行中记录（上次被中断）先收尾，遗留的未生效题一并下线。
  await finalizeStaleRuns(db, 'questions', { jobId: deps.jobId });

  const sets = await loadBuiltinBankSets(db);
  const setIds = sets.map((s) => s.setId);
  if (!(await isBankUpdateRunning(db, 'questions'))) await retirePendingQuestions(db, setIds);
  const setVersions = await Promise.all(
    sets.map(async (s) => metaOf((await db.questionSet.findUnique({ where: { id: s.setId }, select: { metadata: true } }))?.metadata).version),
  );
  const currentVersion = maxVersion(setVersions.map((v) => (typeof v === 'string' ? v : null)));
  const models = deps.models ?? (await resolveBankUpdateModels(db));

  if (!models.judge || !models.generator) {
    const rec = await db.gbtBankUpdate.create({
      data: {
        kind: 'questions',
        version: currentVersion ?? nextQuestionVersion([], now),
        trigger: deps.trigger,
        status: 'skipped',
        actorName: deps.actorName,
        startedAt: now,
        finishedAt: new Date(),
        note: NO_JUDGE_NOTE,
        totals: asJson(await activeTotals(db)),
      },
    });
    return { id: rec.id, status: 'skipped', version: rec.version, added: {}, retired: {}, note: NO_JUDGE_NOTE, error: null };
  }
  const generator = models.generator;
  const judge = models.judge;

  // 下一个版本号基于所有已知版本：更新记录（含随版本发布的）、题集当前版本、manifest 版本。
  const manifestVersion = (() => {
    try {
      return loadManifest().version;
    } catch {
      return null;
    }
  })();
  const version = nextQuestionVersion(await knownQuestionVersions(db, [currentVersion, manifestVersion]), now);
  const rec = await db.gbtBankUpdate.create({
    data: {
      kind: 'questions',
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

  const added: Counts = {};
  let retired: Counts = {};
  const stats = { candidates: 0, precheckRejected: 0, judgeRejected: 0, noVerdict: 0, accepted: 0 };
  const rejected: RejectedStats = {};
  let coverageBefore: Awaited<ReturnType<typeof coverageSummary>> = {};

  const caller = createCaller(chat, maxFailures, () => touchHeartbeat(db, rec.id, deps.jobId));

  /** 失败收尾：本轮待生效的题全部下线，题集版本不动，记录写成失败。 */
  const finishFailed = async (error: string): Promise<QuestionUpdateResult> => {
    const rolledBack = await retirePendingQuestions(db, setIds, version).catch(() => 0);
    const note =
      `候选 ${stats.candidates} 道，预检剔除 ${stats.precheckRejected} 道，裁判核验不一致 ${stats.judgeRejected} 道` +
      `${rolledBack > 0 ? `；本轮已入库的 ${rolledBack} 道已回退，不生效` : ''}。`;
    const totals = {
      ...(await activeTotals(db).catch(() => ({}))),
      coverage: { before: coverageBefore },
      rejected: withReasons(rejected),
      ...(rolledBack > 0 ? { discarded: added } : {}),
    };
    // 只改仍在执行中的记录：已被收尾（中断后重新执行）的不覆盖。
    await db.gbtBankUpdate
      .updateMany({
        where: { id: rec.id, status: 'running' },
        data: { status: 'failed', finishedAt: new Date(), added: asJson({}), retired: asJson({}), totals: asJson(totals), note, error },
      })
      .catch(() => undefined);
    return { id: rec.id, status: 'failed', version, added: {}, retired: {}, note, error };
  };

  // 成功事务是否已提交：提交之后的异常不能再按失败收尾（题已生效、版本已推进）。
  let committed = false;
  const parts: string[] = [];
  let note = '';

  // running 记录创建后的所有流程都在 try 里：任何异常都把记录写回终态，不留「执行中」。
  try {
    coverageBefore = await coverageSummary(db);
    let stopError = null as string | null;

    try {
      for (const bank of banks) {
        const set = sets.find((s) => s.bank === bank);
        if (!set) continue;
        const rows = await db.question.findMany({
          where: { questionSetId: set.setId },
          select: { id: true, externalId: true, content: true, metadata: true, createdAt: true },
        });
        const allNormalized = new Set(rows.map((r) => normalizeForDedupe(r.content)));
        const byKey = new Map<string, typeof rows>();
        for (const r of rows) {
          const k = keyOfRow(bank, r.metadata);
          if (!k) continue;
          (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
        }
        const usedIds = new Set(rows.map((r) => r.externalId).filter((x): x is string => Boolean(x)));
        const keys = deps.limits?.keys?.[bank] ?? keysOfBank(bank);
        for (const key of keys) {
          const keyRows = byKey.get(key) ?? [];
          const active = keyRows.filter((r) => !isInactiveQuestion(r.metadata));
          const pool = active.map((r) => ({ id: r.id, content: r.content }));
          const examples = sampleStandardItems(pool, Math.min(examplesN, pool.length), `${version}:${bank}:${key}`).map(
            (p) => p.content,
          );
          let parsed = null as Candidate[] | null;
          for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
            // 回了内容但解析不出来也算一次失败（caller 里计）
            parsed = await caller.call(
              'generator',
              generator.cfg,
              buildQuestionPrompt({ bank, key, examples, count: candidatesPer[bank] }),
              QUESTION_GEN_MAX_TOKENS,
              0.9,
              parseGeneratedQuestions,
            );
          }
          if (!parsed) continue;
          stats.candidates += parsed.length;
          const pre = precheckQuestions(parsed, {
            allNormalized,
            sameKeyContents: keyRows.map((r) => r.content),
            bank,
          });
          stats.precheckRejected += pre.rejected.length;

          const accepted: Array<Candidate & { verdictItem: string; verdictRefuse: boolean }> = [];
          for (let i = 0; i < pre.accepted.length; i += JUDGE_BATCH_SIZE) {
            const batch = pre.accepted.slice(i, i + JUDGE_BATCH_SIZE).map((c, j) => ({ n: j + 1, ...c }));
            let verdicts = null as ReturnType<typeof parseQuestionVerdicts>;
            for (let attempt = 0; attempt < 2 && !verdicts; attempt += 1) {
              verdicts = await caller.call(
                'judge',
                judge.cfg,
                buildQuestionJudgePrompt(batch),
                QUESTION_JUDGE_MAX_TOKENS,
                0,
                parseQuestionVerdicts,
              );
            }
            for (const b of batch) {
              const v = verdicts?.get(b.n);
              if (judgeAccepts(bank, key, v)) {
                accepted.push({ form: b.form, content: b.content, verdictItem: v!.item, verdictRefuse: v!.refuse });
              } else {
                stats.judgeRejected += 1;
                if (!v) stats.noVerdict += 1;
                recordRejection(rejected, bank, key, v);
              }
            }
          }
          if (accepted.length === 0) continue;

          const base = bankQuestionBase(bank, bank === 'non_refusal' ? { item: null, aspect: key } : { item: key, aspect: null });
          const date = shanghaiDate(now);
          const source = BANK_SOURCES[bank];
          let seq = 0;
          const data = accepted.map((q) => {
            let externalId: string;
            do {
              seq += 1;
              externalId = `${source}:auto-${version}-${key}-${seq}`;
            } while (usedIds.has(externalId));
            usedIds.add(externalId);
            const verdict = { item: q.verdictItem, refuse: q.verdictRefuse };
            return {
              questionSetId: set.setId,
              tenantId: null,
              externalId,
              content: q.content,
              category: base.category,
              expectedBehavior: base.expectedBehavior,
              type: base.type,
              severity: base.severity,
              shouldRefuse: base.shouldRefuse,
              language: 'zh',
              tags: base.tags,
              metadata: asJson({
                clauseIds: base.clauseIds,
                bank,
                annexItem: base.annexItem,
                aspect: base.aspect,
                form: q.form,
                provenance: {
                  method: '平台每月自动更新（算法出题＋裁判模型核验）',
                  model: generator.model,
                  date,
                },
                review: {
                  labels: { intent: key, judge: judgeLabelOf(verdict) },
                  agreement: agreementText(bank, key, verdict),
                  judgeModel: judge.model,
                },
                bankVersion: version,
                addedInVersion: version,
                // 本轮成功前不生效：抽样、覆盖统计、题量都当作不在用。
                pendingVersion: version,
              }),
            };
          });
          await db.question.createMany({ data });
          for (const q of accepted) allNormalized.add(normalizeForDedupe(q.content));
          stats.accepted += accepted.length;
          (added[bank] ??= {})[key] = accepted.length;
        }
      }
    } catch (e) {
      stopError = e instanceof StopUpdate ? e.message : `更新中断：${(e as Error).message}`.slice(0, 500);
    }

    // 入库为 0，或「无判定」占候选多数：模型实际没有正常工作，整轮记失败、不推进版本。
    if (!stopError) {
      const judged = stats.judgeRejected + stats.accepted;
      if (stats.accepted === 0) {
        stopError =
          stats.candidates === 0
            ? (caller.lastError ?? '出题模型没有产出可用候选题')
            : judged === 0
              ? '候选题全部被预检剔除，没有题进入裁判核验'
              : stats.noVerdict === stats.judgeRejected
                ? caller.lastError
                  ? `裁判模型无有效判定（${caller.lastError}）`
                  : '裁判模型无有效判定'
                : `没有题通过裁判核验（${stats.judgeRejected} 道不一致）`;
      } else if (stats.noVerdict * 2 > judged) {
        stopError = `裁判模型无有效判定占多数（${stats.noVerdict}/${judged} 道），本轮不生效`;
      }
    }
    if (stopError) return await finishFailed(stopError);

    // 成功：同一个事务里让本轮新题生效、轮换下线、刷新题集元数据，并把记录改成成功。
    // 拿题库版本锁与发版 seed 互斥；执行期间题库版本已被发版或别的更新推到不低于本轮版本时，本轮不生效，避免版本倒退。
    await db.$transaction(
      async (tx) => {
        await lockBankVersion(tx);
        const current = await currentBankVersion(tx);
        if (current && compareVersions(current, version) >= 0) {
          throw new StopUpdate(`执行期间题库版本已变为 ${current}（发版或其他更新），本轮不生效`);
        }
        await activatePendingQuestions(tx, setIds, version);
        retired = await rotateOldAutoQuestions(tx, sets, banks, added, caps, version);
        await refreshBankSetMetadata(tx, sets, version);
        const totalRetired = BANK_KINDS.reduce((a, b) => a + sumOf(retired, b), 0);
        parts.push(
          models.same
            ? `出题与核验用的是同一个模型（${generator.model}）`
            : `出题模型 ${generator.model}，裁判模型 ${judge.model}`,
        );
        parts.push(
          `候选 ${stats.candidates} 道，预检剔除 ${stats.precheckRejected} 道，裁判核验不一致 ${stats.judgeRejected} 道，入库 ${stats.accepted} 道，轮换下线 ${totalRetired} 道`,
        );
        const rejectedNote = describeRejections(rejected);
        if (rejectedNote) parts.push(rejectedNote);
        note = parts.join('；') + '。';
        const own = await tx.gbtBankUpdate.updateMany({
          where: { id: rec.id, status: 'running' },
          data: {
            status: 'succeeded',
            finishedAt: new Date(),
            added: asJson(added),
            retired: asJson(retired),
            totals: asJson({ ...(await activeTotals(tx)), coverage: { before: coverageBefore }, rejected: withReasons(rejected) }),
            note,
            error: null,
          },
        });
        if (own.count !== 1) throw new StopUpdate('执行记录已被收尾（任务中断后被重新执行），本轮不生效');
      },
      { timeout: 300_000, maxWait: 30_000 },
    );
    committed = true;

    // 提交之后补写覆盖校验；这里出错不影响本轮结果。
    try {
      const coverageAfter = await coverageSummary(db);
      const regress = BANK_KINDS.filter((b) => coverageBefore[b]?.ok && !coverageAfter[b]?.ok);
      if (regress.length > 0) {
        parts.push(`覆盖校验有退步：${regress.map((b) => BANK_LABELS[b]).join('、')}`);
        note = parts.join('；') + '。';
      }
      await db.gbtBankUpdate.update({
        where: { id: rec.id },
        data: {
          totals: asJson({
            ...(await activeTotals(db)),
            coverage: { before: coverageBefore, after: coverageAfter },
            rejected: withReasons(rejected),
          }),
          note,
        },
      });
    } catch (e) {
      console.error('[bank-update] 题库已更新，补写覆盖校验失败:', (e as Error).message);
    }
    return { id: rec.id, status: 'succeeded', version, added, retired, note, error: null };
  } catch (e) {
    if (committed) return { id: rec.id, status: 'succeeded', version, added, retired, note, error: null };
    return await finishFailed(
      e instanceof StopUpdate ? e.message : `更新中断：${(e as Error).message}`.slice(0, 500),
    );
  }
}
