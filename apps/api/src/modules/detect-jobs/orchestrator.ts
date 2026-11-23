import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  DETECT_JOB_ITEM_META,
  isDetectJobItemKind,
  isDetectTaskTerminal,
  normalizeDetectTaskStatus,
  type DetectRecordKind,
  type DetectTaskStatus,
} from '@lse/shared';
import { prisma, prismaUnscoped } from '../../db.js';
import { tenantCondition } from '../../lib/detect-sql.js';
import { AppError } from '../../lib/errors.js';
import { loadCurrentUser, type CurrentUser } from '../../lib/rbac.js';
import { runInTenant } from '../../lib/tenant-context.js';
import { PLATFORM_TENANT_ID } from '../../lib/tenant-models.js';
import { failInterruptedRuns } from '../asset-discovery/service.js';
import { parseDetectJobItemParams } from './item-params.js';
import { launchDetectJobItem, type Launchers } from './launchers.js';
import { applyRecordAction, supportedActions } from './record-actions.js';

// 组合任务编排（2.4.9）：按并发上限启动子任务、从各检测记录同步状态、全部结束后收尾。
// API（启动、恢复、一键启动）和 worker 的 tick 都调用 advanceDetectJob；靠带持有者的租约保证同一时刻
// 只有一个进程推进。子任务一律以组合任务创建人的身份启动。

/**
 * 运行时注入（buildApp 的 detectJobs、pauseEvalTask、cancelEvalTask 选项）：测试替换启动函数和信号。
 * 放在模块里而不是路由参数里：检测方案（C 线）直接调用 createDetectJob、startDetectJob，
 * 签名里没有这些依赖，测试通过 buildApp 注入的假启动函数要能一路生效。
 */
export interface DetectJobRuntime {
  launchers?: Partial<Launchers>;
  pauseEvalTask?: (taskId: string) => Promise<void>;
  cancelEvalTask?: (taskId: string) => Promise<void>;
}
let runtime: DetectJobRuntime = {};

export function configureDetectJobRuntime(options: DetectJobRuntime): void {
  runtime = { ...options };
}

export function detectJobRuntime(): DetectJobRuntime {
  return runtime;
}

export const DETECT_JOB_LEASE_SECONDS = 60;
/** 已领取、超过这么久还没写回检测记录的子任务算启动中断（进程在启动途中重启）。 */
export const DETECT_JOB_LAUNCH_STALE_MS = 10 * 60_000;
export const LAUNCH_INTERRUPTED_MESSAGE = '启动中断（服务重启或超时），未建出检测记录';
const RECORD_DELETED_MESSAGE = '检测记录已被删除';
/** 占着并发名额的子任务状态（已领取或已启动、还没结束）。 */
const OCCUPYING = ['PENDING', 'RUNNING', 'PAUSED'];

export interface AdvanceDeps {
  ip?: string | null;
  userAgent?: string | null;
  /** 覆盖运行时注入的启动函数（测试） */
  launchers?: Partial<Launchers>;
}

/** 组合任务的创建人：子任务以他的身份启动、停止和暂停，按组合任务所属租户执行。 */
export async function loadJobCreator(job: {
  tenantId: string | null;
  createdById: string | null;
}): Promise<CurrentUser | null> {
  if (!job.createdById) return null;
  const user = await loadCurrentUser(job.createdById);
  return user ? { ...user, tenantId: job.tenantId ?? user.tenantId } : null;
}

/** 发起人能不能启动这些类型的检测；不能时返回按实际原因写的中文说明。 */
export function launcherProblem(user: CurrentUser | null, kinds: string[]): string | null {
  if (!user) return '发起人不存在';
  if (!user.isActive) return '发起人已停用';
  for (const kind of kinds) {
    if (!isDetectJobItemKind(kind)) return '检测类型不支持';
    const meta = DETECT_JOB_ITEM_META[kind];
    if (!meta.createPermissions.every((p) => user.permissions.has(p))) {
      return `发起人没有发起${meta.label}的权限`;
    }
  }
  return null;
}

/** 各类检测记录的原始状态和名称，按记录类型批量查（都在当前租户范围内）。 */
export async function loadDetectRecords(
  refs: Array<{ recordKind: string; recordId: string }>,
): Promise<Map<string, { rawStatus: string; name: string }>> {
  const out = new Map<string, { rawStatus: string; name: string }>();
  const ids = (kinds: DetectRecordKind[]) => [
    ...new Set(
      refs.filter((r) => (kinds as string[]).includes(r.recordKind)).map((r) => r.recordId),
    ),
  ];
  const evalIds = ids(['eval_task', 'standard_run', 'rag_eval', 'fleet_eval_job']);
  const fileIds = ids(['model_file_scan']);
  const corpusIds = ids(['corpus_scan']);
  const discoveryIds = ids(['asset_discovery']);
  const [tasks, files, corpus, runs] = await Promise.all([
    evalIds.length
      ? prisma.evalTask.findMany({
          where: { id: { in: evalIds } },
          select: { id: true, status: true, name: true },
        })
      : [],
    fileIds.length
      ? prisma.modelFileScan.findMany({
          where: { id: { in: fileIds } },
          select: { id: true, status: true, path: true },
        })
      : [],
    corpusIds.length
      ? prisma.corpusScan.findMany({
          where: { id: { in: corpusIds } },
          select: { id: true, status: true, fileName: true },
        })
      : [],
    discoveryIds.length
      ? prisma.assetDiscoveryRun.findMany({
          where: { id: { in: discoveryIds } },
          select: { id: true, status: true, targets: true },
        })
      : [],
  ]);
  for (const t of tasks) out.set(t.id, { rawStatus: t.status, name: t.name });
  for (const f of files) out.set(f.id, { rawStatus: f.status, name: f.path });
  for (const c of corpus) out.set(c.id, { rawStatus: c.status, name: c.fileName });
  for (const r of runs) out.set(r.id, { rawStatus: r.status, name: r.targets.join('、') });
  return out;
}

/**
 * 已启动、还没结束的子任务从各检测记录同步统一状态；记录被删的置失败。
 * 返回同步后的子任务（按序号）。不启动新子任务。
 */
export async function syncItemStatuses(jobId: string) {
  const items = await prisma.detectJobItem.findMany({
    where: { jobId },
    orderBy: { position: 'asc' },
  });
  const open = items.filter((i) => i.recordKind && i.recordId && !isDetectTaskTerminal(i.status));
  if (open.length === 0) return items;
  const records = await loadDetectRecords(
    open.map((i) => ({ recordKind: i.recordKind!, recordId: i.recordId! })),
  );
  const now = new Date();
  for (const item of open) {
    const record = records.get(item.recordId!);
    const status: DetectTaskStatus = record
      ? normalizeDetectTaskStatus(record.rawStatus)
      : 'FAILED';
    if (status === item.status && record) continue;
    const terminal = isDetectTaskTerminal(status);
    const data: Prisma.DetectJobItemUpdateInput = {
      status,
      ...(terminal ? { finishedAt: item.finishedAt ?? now } : { finishedAt: null }),
      ...(record ? {} : { error: RECORD_DELETED_MESSAGE }),
    };
    await prisma.detectJobItem.update({ where: { id: item.id }, data });
    Object.assign(item, data);
  }
  return items;
}

/** 抢租约：同一时刻只有一个进程推进这个组合任务。原始 SQL 不经租户扩展，按当前租户范围加条件。 */
async function acquireLease(jobId: string, owner: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "detect_jobs"
    SET "leaseUntil" = now() + make_interval(secs => ${DETECT_JOB_LEASE_SECONDS}), "leaseOwner" = ${owner}
    WHERE "id" = ${jobId}
      AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
      ${tenantCondition('"tenantId"')}
    RETURNING "id"`;
  return rows.length > 0;
}

/** 续租：只续自己持有的；返回 false 表示租约已被别的进程接手。 */
async function renewLease(jobId: string, owner: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "detect_jobs"
    SET "leaseUntil" = now() + make_interval(secs => ${DETECT_JOB_LEASE_SECONDS})
    WHERE "id" = ${jobId} AND "leaseOwner" = ${owner}
      ${tenantCondition('"tenantId"')}
    RETURNING "id"`;
  return rows.length > 0;
}

/** 只释放自己持有的租约，不会把别人刚抢到的清掉。 */
async function releaseLease(jobId: string, owner: string): Promise<void> {
  await prisma.detectJob.updateMany({
    where: { id: jobId, leaseOwner: owner },
    data: { leaseUntil: null, leaseOwner: null },
  });
}

/**
 * 已领取（launchedAt 已写）、超过 DETECT_JOB_LAUNCH_STALE_MS 还没写回检测记录的子任务置为失败：
 * 进程在启动途中重启后，没人会再写回它，不处理会一直占着并发名额、组合任务收不了尾。
 * 不给 jobId 时处理全部（worker 启动维护）。
 */
export async function failInterruptedLaunches(jobId?: string): Promise<number> {
  const r = await prisma.detectJobItem.updateMany({
    where: {
      ...(jobId ? { jobId } : {}),
      recordId: null,
      status: 'PENDING',
      launchedAt: { lt: new Date(Date.now() - DETECT_JOB_LAUNCH_STALE_MS) },
    },
    data: { status: 'FAILED', error: LAUNCH_INTERRUPTED_MESSAGE, finishedAt: new Date() },
  });
  return r.count;
}

/** worker 启动维护：启动中断的子任务置失败；worker 里执行、被重启打断的资产测绘也收尾（条件同 API）。 */
export async function recoverInterruptedDetectWork(): Promise<{ launches: number }> {
  const launches = await failInterruptedLaunches();
  await failInterruptedRuns();
  return { launches };
}

/** 资产测绘的周期收尾间隔：tick 每 15 秒一次，收尾每分钟最多一次。 */
const RUN_SWEEP_EVERY_MS = 60_000;
let lastRunSweepAt = 0;

function launchErrorMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  return `启动失败：${message}`.slice(0, 500);
}

function recordActionDeps(deps: AdvanceDeps) {
  return {
    pauseEvalTask: runtime.pauseEvalTask,
    cancelEvalTask: runtime.cancelEvalTask,
    ip: deps.ip ?? null,
    userAgent: deps.userAgent ?? null,
  };
}

/**
 * 推进一次组合任务：
 * 1. 抢租约（带持有者），抢不到直接返回；
 * 2. 启动中断的子任务置失败，同步已启动子任务的状态；
 * 3. 执行中时按序号启动没启动的子任务，每次领取前按库里的占位数（含已领取、还没写回的）判断并发上限，
 *    每启动一个续一次租约，租约被别人接手就停；
 * 4. 写回检测记录后再看组合任务：启动途中被停止的，新记录跟着停止、该项置为已停止；被暂停的，评估记录跟着暂停；
 * 5. 全部子任务结束时收尾（停止 → 已停止；全部完成 → 已完成；否则失败）。
 * 必须在组合任务所属租户的范围内调用。
 */
export async function advanceDetectJob(jobId: string, deps: AdvanceDeps = {}): Promise<void> {
  const owner = randomUUID();
  if (!(await acquireLease(jobId, owner))) return;
  try {
    const job = await prisma.detectJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    await failInterruptedLaunches(jobId);
    let items = await syncItemStatuses(jobId);
    // 本次领取过的子任务数（启动成功或失败都算）：有变化才再同步、再读组合任务。
    let touched = 0;
    let state: { status: string; stopRequested: boolean; maxParallel: number } | null = job;

    let creator: CurrentUser | null | undefined;
    while (state && state.status === 'RUNNING' && !state.stopRequested) {
      const occupied = await prisma.detectJobItem.count({
        where: {
          jobId,
          status: { in: OCCUPYING },
          OR: [{ recordId: { not: null } }, { launchedAt: { not: null } }],
        },
      });
      if (occupied >= state.maxParallel) break;
      const next = await prisma.detectJobItem.findFirst({
        where: { jobId, recordId: null, launchedAt: null, status: 'PENDING' },
        orderBy: { position: 'asc' },
      });
      if (!next) break;
      const claimed = await prisma.detectJobItem.updateMany({
        where: { id: next.id, recordId: null, launchedAt: null, status: 'PENDING' },
        data: { launchedAt: new Date() },
      });
      if (claimed.count === 0) continue;
      touched += 1;
      if (creator === undefined) creator = await loadJobCreator(job);
      const problem = launcherProblem(creator, [next.kind]);
      if (problem || !creator || !isDetectJobItemKind(next.kind)) {
        await prisma.detectJobItem.update({
          where: { id: next.id },
          data: { status: 'FAILED', error: problem ?? '检测类型不支持', finishedAt: new Date() },
        });
      } else {
        try {
          const params = parseDetectJobItemParams(next.kind, next.params, next.position);
          const record = await launchDetectJobItem(
            next.kind,
            params,
            {
              user: creator,
              ip: deps.ip ?? null,
              userAgent: deps.userAgent ?? null,
              source: 'detect_job',
              title: next.title,
            },
            deps.launchers ?? runtime.launchers,
          );
          // 写回要带条件：启动超过 DETECT_JOB_LAUNCH_STALE_MS 时，别的推进者已把它置为启动中断。
          const written = await prisma.detectJobItem.updateMany({
            where: { id: next.id, recordId: null, status: 'PENDING' },
            data: {
              recordKind: record.recordKind,
              recordId: record.recordId,
              status: 'PENDING',
              error: null,
            },
          });
          if (written.count > 0) await followJobState(jobId, next.id, record, creator, deps);
          else await stopOrphanRecord(next.id, record, creator, deps);
        } catch (err) {
          await prisma.detectJobItem.updateMany({
            where: { id: next.id, recordId: null, status: 'PENDING' },
            data: { status: 'FAILED', error: launchErrorMessage(err), finishedAt: new Date() },
          });
        }
      }
      if (!(await renewLease(jobId, owner))) break;
      state = await prisma.detectJob.findUnique({
        where: { id: jobId },
        select: { status: true, stopRequested: true, maxParallel: true },
      });
    }

    // 新启动的子任务可能已经结束（如终端体检直接建出已完成的任务），启动失败的已置失败：有领取才再同步一次。
    if (touched > 0) items = await syncItemStatuses(jobId);
    const current = touched > 0 ? await prisma.detectJob.findUnique({ where: { id: jobId } }) : job;
    if (!current || isDetectTaskTerminal(current.status) || current.status === 'PENDING') return;
    if (items.length > 0 && items.every((i) => isDetectTaskTerminal(i.status))) {
      const status: DetectTaskStatus = current.stopRequested
        ? 'CANCELED'
        : items.every((i) => i.status === 'COMPLETED')
          ? 'COMPLETED'
          : 'FAILED';
      await prisma.detectJob.updateMany({
        where: { id: jobId, status: current.status },
        data: { status, finishedAt: new Date() },
      });
    }
  } finally {
    await releaseLease(jobId, owner);
  }
}

/** 写回检测记录后对齐组合任务的当前状态：启动途中被停止或暂停的，新记录跟着停止或暂停。 */
async function followJobState(
  jobId: string,
  itemId: string,
  record: { recordKind: DetectRecordKind; recordId: string },
  creator: CurrentUser,
  deps: AdvanceDeps,
): Promise<void> {
  const now = await prisma.detectJob.findUnique({
    where: { id: jobId },
    select: { status: true, stopRequested: true },
  });
  const stopped = !now || now.stopRequested || now.status === 'CANCELED';
  const action = stopped
    ? 'stop'
    : now.status === 'PAUSED' && record.recordKind === 'eval_task'
      ? 'pause'
      : null;
  // 不能中途打断的（语料、资产测绘、体检）照常跑完，状态继续同步。
  if (
    !action ||
    !supportedActions(record.recordKind, 'PENDING', { pausable: true }).includes(action)
  ) {
    return;
  }
  try {
    await applyRecordAction(
      creator,
      record.recordKind,
      record.recordId,
      action,
      recordActionDeps(deps),
    );
    if (stopped) {
      await prisma.detectJobItem.update({
        where: { id: itemId },
        data: { status: 'CANCELED', finishedAt: new Date() },
      });
    }
  } catch (err) {
    console.warn(
      `[detect-jobs] 启动后跟随组合任务${stopped ? '停止' : '暂停'}未执行 item=${itemId}:`,
      (err as Error).message,
    );
  }
}

/**
 * 子任务已被置为启动中断、原启动者才建出检测记录：没人会跟踪这条记录，能停的停掉（语料、资产测绘这类
 * 不能中途打断的只记日志）。
 */
async function stopOrphanRecord(
  itemId: string,
  record: { recordKind: DetectRecordKind; recordId: string },
  creator: CurrentUser,
  deps: AdvanceDeps,
): Promise<void> {
  console.warn(
    `[detect-jobs] 子任务已置为启动中断，新建的检测记录无人跟踪 item=${itemId} record=${record.recordKind}:${record.recordId}`,
  );
  if (!supportedActions(record.recordKind, 'PENDING', { pausable: true }).includes('stop')) return;
  await applyRecordAction(
    creator,
    record.recordKind,
    record.recordId,
    'stop',
    recordActionDeps(deps),
  ).catch((err: unknown) =>
    console.warn(
      `[detect-jobs] 停止无人跟踪的检测记录失败 item=${itemId}:`,
      (err as Error).message,
    ),
  );
}

/**
 * worker 每 15 秒调用：不带租户范围找执行中的组合任务，逐个在其租户范围内推进。
 * 每分钟顺带收尾一次被 worker 重启打断的资产测绘（心跳超时），不用等下一次进程重启。
 */
export async function tickDetectJobs(deps: AdvanceDeps = {}): Promise<number> {
  if (Date.now() - lastRunSweepAt >= RUN_SWEEP_EVERY_MS) {
    lastRunSweepAt = Date.now();
    await failInterruptedRuns().catch((err: unknown) =>
      console.warn('[detect-jobs] 资产测绘中断收尾失败:', (err as Error).message),
    );
  }
  const jobs = await prismaUnscoped.detectJob.findMany({
    where: { status: 'RUNNING' },
    select: { id: true, tenantId: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const job of jobs) {
    try {
      await runInTenant(job.tenantId ?? PLATFORM_TENANT_ID, () => advanceDetectJob(job.id, deps));
    } catch (err) {
      console.error(`[detect-jobs] 推进组合任务失败 jobId=${job.id}:`, err);
    }
  }
  return jobs.length;
}
