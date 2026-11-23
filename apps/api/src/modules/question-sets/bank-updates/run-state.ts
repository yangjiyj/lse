import type { Prisma, PrismaClient } from '@prisma/client';
import { retirePendingQuestions, loadBuiltinBankSets } from './bank-meta.js';

/** 心跳超过这么久没更新，执行中的记录视为已中断。 */
export const HEARTBEAT_TTL_MS = 30 * 60_000;
export const INTERRUPTED_ERROR = '执行被中断（服务重启）';

type RunningLike = { startedAt: Date; totals: unknown };

const totalsOf = (t: unknown): Record<string, unknown> =>
  t && typeof t === 'object' && !Array.isArray(t) ? (t as Record<string, unknown>) : {};

/** 记录最近一次心跳时间：优先 totals.heartbeatAt，没有就用开始时间。 */
export function heartbeatOf(rec: RunningLike): Date {
  const t = totalsOf(rec.totals).heartbeatAt;
  const d = typeof t === 'string' ? new Date(t) : null;
  return d && !Number.isNaN(d.getTime()) ? d : rec.startedAt;
}

/** 执行这条记录的队列任务号（worker 执行时写进 totals.jobId）。 */
export function jobIdOf(rec: { totals: unknown }): string | null {
  const v = totalsOf(rec.totals).jobId;
  return typeof v === 'string' && v ? v : null;
}

/** 执行中记录的 totals：心跳时间，加上队列任务号（有的话）。 */
export function runningTotals(jobId?: string | null): Prisma.InputJsonValue {
  return { heartbeatAt: new Date().toISOString(), ...(jobId ? { jobId } : {}) };
}

/** 执行中且心跳在 30 分钟内才算「在跑」。 */
export function isRunAlive(rec: RunningLike, nowMs: number = Date.now()): boolean {
  return nowMs - heartbeatOf(rec).getTime() <= HEARTBEAT_TTL_MS;
}

/** 写一次心跳（放在 totals.heartbeatAt，不加列；任务结束时 totals 会被最终统计覆盖）。 */
export async function touchHeartbeat(db: PrismaClient, id: string, jobId?: string | null): Promise<void> {
  await db.gbtBankUpdate
    .updateMany({ where: { id, status: 'running' }, data: { totals: runningTotals(jobId) } })
    .catch(() => undefined);
}

export type BankUpdateKindName = 'questions' | 'keywords';

/** 同类更新是否正在执行：有 running 记录，且心跳在 30 分钟内。 */
export async function isBankUpdateRunning(db: PrismaClient, kind: BankUpdateKindName): Promise<boolean> {
  const rows = await db.gbtBankUpdate.findMany({ where: { kind, status: 'running' }, select: { startedAt: true, totals: true } });
  const now = Date.now();
  return rows.some((r) => isRunAlive(r, now));
}

/**
 * 把已中断的 running 记录收尾成 failed（执行被中断）；题库更新同时把遗留的未生效题下线。
 * 已中断：心跳超过 30 分钟，或者记录的任务号就是当前任务（worker 被杀后队列把同一个任务重投回来）。
 * worker 启动时和每次任务开始时调用。返回收尾的记录数。
 */
export async function finalizeStaleRuns(
  db: PrismaClient,
  kind?: BankUpdateKindName,
  opts: { jobId?: string | null } = {},
): Promise<number> {
  const rows = await db.gbtBankUpdate.findMany({
    where: { status: 'running', ...(kind ? { kind } : {}) },
    select: { id: true, kind: true, startedAt: true, totals: true },
  });
  const now = Date.now();
  const isOrphan = (r: (typeof rows)[number]) =>
    !isRunAlive(r, now) || (Boolean(opts.jobId) && jobIdOf(r) === opts.jobId);
  const stale = rows.filter(isOrphan);
  for (const r of stale) {
    await db.gbtBankUpdate.updateMany({
      where: { id: r.id, status: 'running' },
      data: { status: 'failed', finishedAt: new Date(), error: INTERRUPTED_ERROR },
    });
  }
  const questionsStale = stale.some((r) => r.kind === 'questions');
  const questionsAlive = rows.some((r) => r.kind === 'questions' && !isOrphan(r));
  if (questionsStale && !questionsAlive) {
    const sets = await loadBuiltinBankSets(db);
    await retirePendingQuestions(db, sets.map((s) => s.setId));
  }
  return stale.length;
}
