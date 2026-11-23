import CronParser from 'cron-parser';
import type { PrismaClient } from '@prisma/client';
import {
  BANK_UPDATE_TZ,
  KEYWORD_CADENCE,
  KEYWORD_CRON,
  QUESTION_BANK_CADENCE,
  QUESTION_BANK_CRON,
} from './constants.js';
import { loadBuiltinBankSets } from './bank-meta.js';
import { isBankUpdateRunning, isRunAlive } from './run-state.js';
import { maxVersion } from './versions.js';

export function nextRunOf(cron: string, now: Date = new Date()): Date | null {
  try {
    return CronParser.parseExpression(cron, { tz: BANK_UPDATE_TZ, currentDate: now }).next().toDate();
  } catch {
    return null;
  }
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const addedTotal = (a: unknown): number =>
  a && typeof a === 'object'
    ? Object.values(a as Record<string, unknown>).reduce<number>((n, v) => n + (typeof v === 'number' ? v : 0), 0)
    : 0;

/** GET /updates 的内容：最近 30 条记录、当前版本、上次更新时间、周期说明、下次计划时间。 */
export async function loadBankUpdateOverview(db: PrismaClient, now: Date = new Date()) {
  const records = await db.gbtBankUpdate.findMany({ orderBy: { startedAt: 'desc' }, take: 30 });
  const lastQuestions = await db.gbtBankUpdate.findFirst({
    where: { kind: 'questions', status: 'succeeded' },
    orderBy: { startedAt: 'desc' },
  });
  const lastKeywords = await db.gbtBankUpdate.findFirst({
    where: { kind: 'keywords', status: 'succeeded', trigger: { not: 'release' } },
    orderBy: { startedAt: 'desc' },
  });
  // 关键词页要看最近一次执行（成功、失败、未执行、中断都算），不只是上次成功的那次。
  const latestKeywordRun = await db.gbtBankUpdate.findFirst({
    where: { kind: 'keywords', trigger: { not: 'release' } },
    orderBy: { startedAt: 'desc' },
  });
  const setVersions: string[] = [];
  for (const s of await loadBuiltinBankSets(db)) {
    const meta = (await db.questionSet.findUnique({ where: { id: s.setId }, select: { metadata: true } }))?.metadata;
    const v = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>).version : null;
    if (typeof v === 'string') setVersions.push(v);
  }
  return {
    items: records.map((r) => ({
      id: r.id,
      kind: r.kind,
      version: r.version,
      trigger: r.trigger,
      status: r.status,
      /** 执行中但心跳已过期（服务重启等）：页面显示「已中断」。 */
      interrupted: r.status === 'running' && !isRunAlive(r, Date.now()),
      actorName: r.actorName,
      startedAt: r.startedAt.toISOString(),
      finishedAt: iso(r.finishedAt),
      added: r.added,
      retired: r.retired,
      totals: r.totals,
      generatorModel: r.generatorModel,
      judgeModel: r.judgeModel,
      note: r.note,
      error: r.error,
    })),
    questions: {
      version: maxVersion(setVersions) ?? lastQuestions?.version ?? null,
      updatedAt: iso(lastQuestions?.finishedAt ?? lastQuestions?.startedAt),
      cadence: QUESTION_BANK_CADENCE,
      cron: QUESTION_BANK_CRON,
      nextRunAt: iso(nextRunOf(QUESTION_BANK_CRON, now)),
      running: await isBankUpdateRunning(db, 'questions'),
    },
    keywords: {
      version: lastKeywords?.version ?? null,
      updatedAt: iso(lastKeywords?.finishedAt ?? lastKeywords?.startedAt),
      lastAdded: lastKeywords ? addedTotal(lastKeywords.added) : null,
      lastRun: latestKeywordRun
        ? {
            status: latestKeywordRun.status,
            interrupted: latestKeywordRun.status === 'running' && !isRunAlive(latestKeywordRun, Date.now()),
            at: iso(latestKeywordRun.finishedAt ?? latestKeywordRun.startedAt),
            added: addedTotal(latestKeywordRun.added),
            reason:
              latestKeywordRun.status === 'failed'
                ? (latestKeywordRun.error ?? '原因未记录')
                : latestKeywordRun.status === 'skipped'
                  ? (latestKeywordRun.note ?? '原因未记录')
                  : null,
          }
        : null,
      cadence: KEYWORD_CADENCE,
      cron: KEYWORD_CRON,
      nextRunAt: iso(nextRunOf(KEYWORD_CRON, now)),
      running: await isBankUpdateRunning(db, 'keywords'),
    },
  };
}
