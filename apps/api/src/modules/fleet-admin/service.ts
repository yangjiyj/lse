// 自管终端与本平台评估任务（EvalTask）之间的绑定和状态同步。
// 入库统一复用 endpoint-evals/service.ts 的 applyEndpointUpdateTx：AgentShield 回调与终端直连回传走同一条路径。
import { createHash, randomBytes } from 'node:crypto';
import type { FleetEndpoint, FleetEvalJob, FleetJobStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { badRequest } from '../../lib/errors.js';
import { endpointResultSchema, type EndpointCallback } from '../endpoint-evals/config.js';
import { AGENT_JOB_HARD_LIMIT_MS, RESULT_GRACE_MS } from './config.js';
import {
  applyEndpointUpdateTx,
  JOB_LOG,
  parseBinding,
  STATUS_LABELS,
  type JobBinding,
} from '../endpoint-evals/service.js';

export const FLEET_TARGET_PROVIDER = 'jiandun-fleet';

/**
 * 自管终端任务同步到 EvalTask 的状态文案。管理员发起的任务不经过审批，所以不再写「审批」：
 * 创建/排队统一写「等待终端领取」，过期写「终端未领取」。待审批旧任务（升级前遗留）沿用原文案。
 */
export const FLEET_STATUS_LABELS: Record<string, string> = {
  ...STATUS_LABELS,
  queued: '等待终端领取',
  expired: '任务已过期，终端未领取',
};
export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const newJobPublicId = () => `lej_${randomBytes(16).toString('hex')}`;

const PUBLIC_BASE_URL_MESSAGE =
  '平台对外访问地址未配置或格式不正确，终端无法回传结果，请联系部署管理员在部署配置中设置';

/** 与 endpoint-evals/routes.ts 的 publicBaseUrl() 相同规则（该函数未导出，这里保持一致）。 */
export function publicBaseUrl(): string {
  let url: URL;
  try {
    url = new URL(process.env.LSE_PUBLIC_BASE_URL ?? '');
  } catch {
    throw badRequest(PUBLIC_BASE_URL_MESSAGE);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw badRequest(PUBLIC_BASE_URL_MESSAGE);
  return url.origin;
}

const OS_NAMES: Record<string, string> = {
  linux: 'Linux',
  windows: 'Windows',
  darwin: 'macOS',
  macos: 'macOS',
};

/** 终端评估对象的显示名：「主机名（系统）」；终端记录里没有系统就只用主机名。不带任何内部编号。 */
export function fleetTargetName(endpoint: Pick<FleetEndpoint, 'hostname' | 'os'>): string {
  const os = endpoint.os.trim();
  if (!os) return endpoint.hostname;
  return `${endpoint.hostname}（${OS_NAMES[os.toLowerCase()] ?? os}）`;
}

/** 旧版自动生成的名称：「自管终端 主机名（ep_编号）」。只认这一种格式，用户手改过的名称一律不动。 */
function isLegacyAutoName(name: string, publicId: string): boolean {
  return name.startsWith('自管终端 ') && name.endsWith(`（${publicId}）`);
}

/** 评估对象名称全局唯一：主机名和系统都相同的终端，后来者自动加序号区分。 */
async function uniqueTargetName(
  tx: Prisma.TransactionClient,
  base: string,
  excludeId?: string,
): Promise<string> {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base} #${n}`;
    const taken = await tx.modelTarget.findFirst({
      where: { name: candidate, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
}

/**
 * 每台自管终端对应一个 ENDPOINT_AGENT 评估对象（EvalTask.modelTargetId 必填）。
 * schema 里 FleetEndpoint 没有 modelTargetId 字段，故以 accessConfig.fleetEndpointId 关联。
 * 已存在的对象若仍是旧版自动名称，在这里顺带改成新格式（用户改过的名称不动）。
 */
export async function ensureFleetTarget(
  tx: Prisma.TransactionClient,
  endpoint: FleetEndpoint,
  userId: string,
) {
  const existing = await tx.modelTarget.findFirst({
    where: {
      provider: FLEET_TARGET_PROVIDER,
      accessConfig: { path: ['fleetEndpointId'], equals: endpoint.id },
    },
  });
  if (existing) {
    if (!isLegacyAutoName(existing.name, endpoint.publicId)) return existing;
    const name = await uniqueTargetName(tx, fleetTargetName(endpoint), existing.id);
    return tx.modelTarget.update({ where: { id: existing.id }, data: { name } });
  }
  return tx.modelTarget.create({
    data: {
      name: await uniqueTargetName(tx, fleetTargetName(endpoint)),
      provider: FLEET_TARGET_PROVIDER,
      targetType: 'ENDPOINT_AGENT',
      baseUrl: `fleet://${endpoint.publicId}`,
      apiKey: '',
      model: 'endpoint-agent',
      accessConfig: {
        source: 'jiandun-fleet',
        fleetEndpointId: endpoint.id,
        endpointId: endpoint.publicId,
        endpointLabel: endpoint.hostname,
      },
      isGlobal: true,
      isActive: true,
      createdById: userId,
    },
  });
}

const STATUS_TO_CALLBACK: Record<FleetJobStatus, EndpointCallback['status']> = {
  PENDING_APPROVAL: 'pending_approval',
  QUEUED: 'queued',
  DELIVERED: 'delivered',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
};

/** 把 FleetEvalJob 当前状态同步到绑定的 EvalTask（含终态入库），在调用方事务内执行。 */
export async function syncFleetJobTaskTx(
  tx: Prisma.TransactionClient,
  job: Pick<
    FleetEvalJob,
    'publicId' | 'evalTaskId' | 'status' | 'result' | 'errorCode' | 'rejectReason'
  >,
): Promise<void> {
  if (!job.evalTaskId) return;
  let result: EndpointCallback['result'] = null;
  let error: unknown = job.errorCode ?? undefined;
  if (job.status === 'REJECTED' && job.rejectReason) error = job.rejectReason;
  if ((job.status === 'COMPLETED' || job.status === 'FAILED') && job.result != null) {
    const parsed = endpointResultSchema.safeParse(job.result);
    if (parsed.success) result = parsed.data;
    else error = job.errorCode ?? 'invalid_result';
  }
  await applyEndpointUpdateTx(
    tx,
    {
      job_id: job.publicId,
      lse_task_id: job.evalTaskId,
      status: STATUS_TO_CALLBACK[job.status],
      result,
      error,
    },
    undefined,
    { source: 'fleet', labels: FLEET_STATUS_LABELS },
  );
}

export async function loadFleetBinding(
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<JobBinding | null> {
  const log = await tx.evalTaskLog.findFirst({ where: { taskId, message: JOB_LOG } });
  return log ? parseBinding(log.context) : null;
}

/**
 * 已下发/执行中任务的回传期限：min(截止时间, 领取时间 + 6 小时) + 回传宽限。
 * 终端采集器领取 6 小时后会强杀执行器，断电时更不会有任何回传，过了这个时间点就不会再有正常结果。
 * 没有领取时间（旧数据）时只看截止时间。
 */
export function jobResultDueAt(job: { deadline: Date; deliveredAt?: Date | null }): Date {
  const hardLimit = job.deliveredAt
    ? job.deliveredAt.getTime() + AGENT_JOB_HARD_LIMIT_MS
    : Number.POSITIVE_INFINITY;
  return new Date(Math.min(job.deadline.getTime(), hardLimit) + RESULT_GRACE_MS);
}

/** 「已下发/执行中，且回传期限已过」的查询条件，与 jobResultDueAt 同一口径。 */
export function overdueJobWhere(now: Date): Prisma.FleetEvalJobWhereInput {
  const t = now.getTime();
  return {
    status: { in: ['DELIVERED', 'RUNNING'] },
    OR: [
      { deadline: { lte: new Date(t - RESULT_GRACE_MS) } },
      // 显式排除空值：这个条件会被取反用于列表筛选，空值参与比较会让整行被筛掉。
      {
        deliveredAt: { not: null, lte: new Date(t - AGENT_JOB_HARD_LIMIT_MS - RESULT_GRACE_MS) },
      },
    ],
  };
}

/** 清扫里单个任务处理失败时的日志出口：说明、任务内部编号（FleetEvalJob.id）、错误。 */
export type FleetJobErrorLog = (message: string, jobId: string, error: unknown) => void;
const logToConsole: FleetJobErrorLog = (message, jobId, error) =>
  console.error(`[fleet] ${message} jobId=${jobId}:`, (error as Error)?.message);

/**
 * 执行中收敛：已下发/执行中且回传期限已过的任务置 FAILED（result_overdue），并同步 EvalTask。
 * 带状态和时间条件的更新保证与「终端此刻回传结果」「强制结束」只有一个生效；之后的结果回传因状态已变得到 409。
 * 评估任务同步失败不能挡住终端任务本身的收尾：同一事务失败后退一步只把终端任务置为失败（条件不变），并记日志，
 * 否则这台终端会一直被这个任务占住。单个任务出错不影响其余任务，也不向调用方抛出。
 */
export async function closeOverdueJobs(
  where: Prisma.FleetEvalJobWhereInput = {},
  now: Date = new Date(),
  log: FleetJobErrorLog = logToConsole,
): Promise<void> {
  const overdue = await prisma.fleetEvalJob.findMany({
    where: { AND: [where, overdueJobWhere(now)] },
    select: { id: true },
    take: 200,
  });
  for (const { id } of overdue) {
    const close = (db: Prisma.TransactionClient) =>
      db.fleetEvalJob.updateMany({
        where: { AND: [{ id }, overdueJobWhere(now)] },
        data: { status: 'FAILED', finishedAt: now, errorCode: 'result_overdue' },
      });
    let syncFailed = false;
    try {
      await prisma.$transaction(
        async (tx) => {
          const n = await close(tx);
          if (!n.count) return;
          const job = await tx.fleetEvalJob.findUniqueOrThrow({ where: { id } });
          try {
            await syncFleetJobTaskTx(tx, job);
          } catch (error) {
            syncFailed = true;
            throw error;
          }
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      // 不是同步出的错（例如数据库暂时不可用）：只记日志，留给下一次清扫按原样重试。
      if (!syncFailed) {
        log('超期任务收尾失败', id, error);
        continue;
      }
      log('超期任务同步评估任务失败，只收尾终端任务', id, error);
      try {
        await close(prisma);
      } catch (closeError) {
        log('超期任务收尾失败', id, closeError);
      }
    }
  }
}

/**
 * 惰性过期：待审批/排队中且已过 deadline 的任务置 EXPIRED，并同步 EvalTask；
 * 同一批触发点顺带收敛已下发/执行中却迟迟没有回传的任务（closeOverdueJobs）。
 * 单个任务处理失败只记日志，不影响其余任务，也不让后面的收敛走不到。
 */
export async function expireStaleJobs(
  where: Prisma.FleetEvalJobWhereInput = {},
  log: FleetJobErrorLog = logToConsole,
): Promise<void> {
  const stale = await prisma.fleetEvalJob.findMany({
    where: {
      ...where,
      status: { in: ['PENDING_APPROVAL', 'QUEUED'] },
      deadline: { lte: new Date() },
    },
    select: { id: true },
    take: 200,
  });
  for (const { id } of stale) {
    try {
      await prisma.$transaction(async (tx) => {
        const n = await tx.fleetEvalJob.updateMany({
          where: {
            id,
            status: { in: ['PENDING_APPROVAL', 'QUEUED'] },
            deadline: { lte: new Date() },
          },
          data: { status: 'EXPIRED', finishedAt: new Date(), errorCode: 'expired' },
        });
        if (n.count)
          await syncFleetJobTaskTx(tx, await tx.fleetEvalJob.findUniqueOrThrow({ where: { id } }));
      });
    } catch (error) {
      log('过期任务处理失败', id, error);
    }
  }
  await closeOverdueJobs(where, new Date(), log);
}
