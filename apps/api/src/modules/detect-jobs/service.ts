import { Prisma, type DetectJob, type DetectJobItem } from '@prisma/client';
import {
  canReadDetectRecord,
  DETECT_JOB_ITEM_META,
  DETECT_RECORD_KINDS,
  DETECT_TASK_STATUSES,
  detectRecordHref,
  isDetectJobItemKind,
  isDetectTaskTerminal,
  type DetectJobItemKind,
  type DetectRecordKind,
  type DetectTaskStatus,
} from '@lse/shared';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import type { CurrentUser } from '../../lib/rbac.js';
import { withdrawEvalTaskPause } from '../eval-tasks/pause.js';
import {
  assertDetectJobItemRefs,
  assertLedgerAssetRef,
  ledgerAssetExists,
  parseDetectJobItemParams,
} from './item-params.js';
import {
  advanceDetectJob,
  detectJobRuntime,
  loadDetectRecords,
  loadJobCreator,
  syncItemStatuses,
} from './orchestrator.js';
import {
  allowedActions,
  applyRecordAction,
  evalTaskActionFlags,
  supportedActions,
  type DetectRecordAction,
} from './record-actions.js';

// 组合任务（2.4.2 一键启动、2.4.9）的创建、生命周期和序列化。createDetectJob、startDetectJob 供检测方案（C 线）调用。

export const DETECT_JOB_MAX_ITEMS = 20;
export const DETECT_JOB_MAX_PARALLEL = 10;
export const DETECT_JOB_DEFAULT_PARALLEL = 4;

export interface DetectJobItemInput {
  kind: DetectJobItemKind;
  title?: string;
  params: unknown;
  toolId?: string | null;
  ledgerAssetId?: string | null;
}

export interface DetectJobActionContext {
  ip: string | null;
  userAgent: string | null;
}

const stateConflict = () => conflict('当前状态不能执行此操作', 'DETECT_JOB_STATE_CONFLICT');

function audit(
  user: { id: string; username: string },
  action: string,
  jobId: string,
  ctx: DetectJobActionContext | null,
  detail?: unknown,
) {
  return writeAudit({
    actorId: user.id,
    actorName: user.username,
    action,
    targetType: 'detect_job',
    targetId: jobId,
    ip: ctx?.ip ?? null,
    userAgent: ctx?.userAgent ?? null,
    detail,
  });
}

/**
 * 建组合任务（不启动）。逐项校验参数、当前用户要有每个子任务的发起权限（缺了 403 并指出第几项），
 * 引用的评估对象、样本库、模型库文件、来源语料、终端要在当前租户里存在；其余检查放到启动时。
 */
/**
 * 校验子任务清单（组合任务、检测策略共用）：1 到 20 项；逐项校验参数，当前用户要有每个子任务的发起权限
 * （缺了 403 并指出第几项），引用对象要在当前租户里存在。返回参数按 schema 解析后的子任务。
 */
export async function validateDetectJobItems(
  user: CurrentUser,
  items: DetectJobItemInput[],
): Promise<DetectJobItemInput[]> {
  if (items.length < 1 || items.length > DETECT_JOB_MAX_ITEMS) {
    throw badRequest(`子任务为 1 到 ${DETECT_JOB_MAX_ITEMS} 个`, 'DETECT_JOB_ITEMS_INVALID');
  }
  const parsed = items.map((item, index) => {
    const params = parseDetectJobItemParams(item.kind, item.params, index);
    const required = DETECT_JOB_ITEM_META[item.kind].createPermissions;
    const missing = required.filter((p) => !user.permissions.has(p));
    if (missing.length > 0) {
      throw forbidden(
        `第 ${index + 1} 项（${DETECT_JOB_ITEM_META[item.kind].label}）：当前账号没有发起该类检测的权限`,
        'DETECT_JOB_ITEM_FORBIDDEN',
        { index, required: missing },
      );
    }
    return { ...item, params };
  });
  for (const [index, item] of parsed.entries()) {
    await assertDetectJobItemRefs(item.kind, item.params, index);
    if (item.ledgerAssetId) await assertLedgerAssetRef(item.kind, item.ledgerAssetId, index);
  }
  // 子任务选的工具要是工具中心里存在的工具。
  const toolIds = [...new Set(parsed.map((i) => i.toolId).filter((v): v is string => Boolean(v)))];
  if (toolIds.length > 0) {
    const found = new Set(
      (await prisma.tool.findMany({ where: { id: { in: toolIds } }, select: { id: true } })).map(
        (t) => t.id,
      ),
    );
    const index = parsed.findIndex((i) => i.toolId && !found.has(i.toolId));
    if (index >= 0) {
      throw badRequest(
        `第 ${index + 1} 项（${DETECT_JOB_ITEM_META[parsed[index]!.kind].label}）：工具不存在`,
        'DETECT_JOB_ITEM_REF_NOT_FOUND',
        { index, field: 'toolId' },
      );
    }
  }
  return parsed;
}

export async function createDetectJob(
  user: CurrentUser,
  input: {
    name: string;
    maxParallel?: number;
    items: DetectJobItemInput[];
    strategyId?: string | null;
    schemeId?: string | null;
    triggeredBy: 'manual' | 'schedule' | 'scheme' | 'quick';
  },
): Promise<{ id: string }> {
  const name = input.name.trim();
  if (!name || name.length > 200)
    throw badRequest('组合任务名称为 1 到 200 个字', 'DETECT_JOB_NAME_INVALID');
  const maxParallel = input.maxParallel ?? DETECT_JOB_DEFAULT_PARALLEL;
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > DETECT_JOB_MAX_PARALLEL) {
    throw badRequest(`并发上限为 1 到 ${DETECT_JOB_MAX_PARALLEL}`, 'DETECT_JOB_PARALLEL_INVALID');
  }
  const parsed = await validateDetectJobItems(user, input.items);
  if (input.strategyId) {
    const strategy = await prisma.detectStrategy.findUnique({ where: { id: input.strategyId } });
    if (!strategy) throw notFound('检测策略不存在', 'DETECT_STRATEGY_NOT_FOUND');
  }
  const job = await prisma.detectJob
    .create({
      data: {
        name,
        maxParallel,
        strategyId: input.strategyId ?? null,
        schemeId: input.schemeId ?? null,
        triggeredBy: input.triggeredBy,
        createdById: user.id,
        items: {
          create: parsed.map((item, position) => ({
            position,
            kind: item.kind,
            title: (item.title?.trim() || DETECT_JOB_ITEM_META[item.kind].label).slice(0, 200),
            params: item.params as Prisma.InputJsonValue,
            toolId: item.toolId ?? null,
            ledgerAssetId: item.ledgerAssetId ?? null,
          })),
        },
      },
      select: { id: true },
    })
    .catch(async (err: unknown) => {
      throw (await itemRefError(err, parsed)) ?? err;
    });
  return job;
}

/**
 * 插入时撞了外键（P2003）或租户守卫（LSE_CROSS_TENANT_REFERENCE）：引用的台账资产等在校验之后被删、
 * 或不属于当前租户。翻成 400 DETECT_JOB_ITEM_REF_NOT_FOUND（能定位到哪一项时带「第 N 项」），不冒成 500。
 * 其他错误返回空，由调用方原样抛出。
 */
export async function itemRefError(
  err: unknown,
  items: DetectJobItemInput[],
): Promise<Error | null> {
  const fk = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
  const guard = err instanceof Error && err.message.includes('LSE_CROSS_TENANT_REFERENCE');
  if (!fk && !guard) return null;
  const where = fk
    ? String((err as Prisma.PrismaClientKnownRequestError).meta?.field_name ?? '')
    : (err as Error).message;
  if (/ledgerAssetId/.test(where)) {
    let index = -1;
    for (const [i, item] of items.entries()) {
      if (item.ledgerAssetId && !(await ledgerAssetExists(item.ledgerAssetId))) {
        index = i;
        break;
      }
    }
    if (index < 0) index = items.findIndex((i) => i.ledgerAssetId);
    const item = items[index];
    return badRequest(
      item
        ? `第 ${index + 1} 项（${DETECT_JOB_ITEM_META[item.kind].label}）：台账资产不存在`
        : '子任务关联的台账资产不存在',
      'DETECT_JOB_ITEM_REF_NOT_FOUND',
      { index, field: 'ledgerAssetId' },
    );
  }
  return badRequest('组合任务引用的对象不存在或不属于当前租户', 'DETECT_JOB_ITEM_REF_NOT_FOUND');
}

async function loadJob(jobId: string): Promise<DetectJob> {
  const job = await prisma.detectJob.findUnique({ where: { id: jobId } });
  if (!job) throw notFound('组合任务不存在', 'DETECT_JOB_NOT_FOUND');
  return job;
}

/** 只改指定状态的组合任务（条件更新），改不到就是状态已变：409。 */
async function transition(
  jobId: string,
  from: DetectTaskStatus[],
  data: Prisma.DetectJobUpdateManyMutationInput,
): Promise<void> {
  const r = await prisma.detectJob.updateMany({
    where: { id: jobId, status: { in: from } },
    data,
  });
  if (r.count === 0) throw stateConflict();
}

function recordActionDeps(ctx: DetectJobActionContext | null, clicker: CurrentUser) {
  const rt = detectJobRuntime();
  return {
    pauseEvalTask: rt.pauseEvalTask,
    cancelEvalTask: rt.cancelEvalTask,
    ip: ctx?.ip ?? null,
    userAgent: ctx?.userAgent ?? null,
    // 以创建人的身份操作记录，审计里记实际点按钮的人。
    auditActor: { id: clicker.id, username: clicker.username },
  };
}

const ACTION_LABELS: Record<DetectRecordAction, string> = {
  pause: '暂停',
  resume: '恢复',
  stop: '停止',
};

const isForbidden = (err: unknown) => err instanceof AppError && err.statusCode === 403;

interface RecordActionFailure {
  item: DetectJobItem;
  reason: string;
}

/**
 * 对已启动的子任务记录做暂停、恢复、停止；该类不支持或已结束的跳过（不影响组合任务本身）。
 * 先以组合任务创建人的身份执行（与启动时一致，如模型文件「只能停止自己发起的」）；创建人没有该操作的
 * 权限（或已不存在）时改用点按钮的人，校验他的权限。都不行的记进返回值，原因写进子任务的 error。
 */
async function applyToRecords(
  job: DetectJob,
  clicker: CurrentUser,
  items: DetectJobItem[],
  action: DetectRecordAction,
  ctx: DetectJobActionContext | null,
): Promise<RecordActionFailure[]> {
  if (items.length === 0) return [];
  const creator = await loadJobCreator(job);
  const failures: RecordActionFailure[] = [];
  for (const item of items) {
    if (!item.recordKind || !item.recordId || !(item.recordKind in DETECT_RECORD_KINDS)) continue;
    const kind = item.recordKind as DetectRecordKind;
    // 语料、资产测绘这类不能中途打断的直接跳过；能不能暂停由 applyRecordAction 按记录再判断。
    const status = item.status as DetectTaskStatus;
    if (!supportedActions(kind, status, { pausable: true }).includes(action)) continue;
    const run = (user: CurrentUser) =>
      applyRecordAction(user, kind, item.recordId!, action, recordActionDeps(ctx, clicker));
    try {
      try {
        await run(creator?.isActive ? creator : clicker);
      } catch (err) {
        if (!creator?.isActive || creator.id === clicker.id || !isForbidden(err)) throw err;
        await run(clicker);
      }
    } catch (err) {
      const reason = (err as Error).message;
      failures.push({ item, reason });
      await prisma.detectJobItem
        .update({
          where: { id: item.id },
          data: { error: `${ACTION_LABELS[action]}失败：${reason}`.slice(0, 500) },
        })
        .catch(() => undefined);
      console.warn(`[detect-jobs] 子任务${action}未执行 item=${item.id}:`, reason);
    }
  }
  return failures;
}

/** 启动：只允许未启动的组合任务。置执行中并立即按并发上限启动子任务。 */
export async function startDetectJob(
  user: CurrentUser,
  jobId: string,
  ctx: DetectJobActionContext,
): Promise<void> {
  const job = await loadJob(jobId);
  if (job.status !== 'PENDING') throw stateConflict();
  await transition(jobId, ['PENDING'], { status: 'RUNNING', startedAt: new Date() });
  await audit(user, 'detect_job.start', jobId, ctx, { name: job.name });
  // 子任务一律以组合任务创建人的身份启动（advanceDetectJob 里加载）。
  await advanceDetectJob(jobId, { ...ctx });
}

/** 暂停：只允许执行中。不再启动新子任务；已启动的可暂停评估任务一起暂停，其他类型的继续跑完。 */
export async function pauseDetectJob(
  user: CurrentUser,
  jobId: string,
  ctx: DetectJobActionContext,
): Promise<void> {
  const job = await loadJob(jobId);
  if (job.status !== 'RUNNING') throw stateConflict();
  await transition(jobId, ['RUNNING'], { status: 'PAUSED' });
  const items = await syncItemStatuses(jobId);
  await applyToRecords(
    job,
    user,
    items.filter(
      (i) => i.kind === 'eval_task' && (i.status === 'PENDING' || i.status === 'RUNNING'),
    ),
    'pause',
    ctx,
  );
  await audit(user, 'detect_job.pause', jobId, ctx, { name: job.name });
}

/**
 * 恢复：只允许已暂停。已暂停的评估任务子任务一起恢复；暂停时还在执行（暂停中、在途题没做完）的
 * 评估子任务撤回暂停请求，免得它随后自己停成已暂停、组合任务收不了尾。再继续启动没启动的。
 */
export async function resumeDetectJob(
  user: CurrentUser,
  jobId: string,
  ctx: DetectJobActionContext,
): Promise<void> {
  const job = await loadJob(jobId);
  if (job.status !== 'PAUSED') throw stateConflict();
  await transition(jobId, ['PAUSED'], { status: 'RUNNING' });
  const items = await syncItemStatuses(jobId);
  for (const item of items) {
    if (item.kind !== 'eval_task' || !item.recordId) continue;
    if (item.status === 'PENDING' || item.status === 'RUNNING') {
      await withdrawEvalTaskPause(item.recordId).catch((err: unknown) =>
        console.warn(`[detect-jobs] 撤回子任务暂停未执行 item=${item.id}:`, (err as Error).message),
      );
    }
  }
  await applyToRecords(
    job,
    user,
    items.filter((i) => i.kind === 'eval_task' && i.status === 'PAUSED'),
    'resume',
    ctx,
  );
  await audit(user, 'detect_job.resume', jobId, ctx, { name: job.name });
  await advanceDetectJob(jobId, { ...ctx });
}

/**
 * 停止：允许未启动、执行中、已暂停。组合任务直接置已停止；没启动的子任务取消；
 * 已启动的能停就停（评估任务、模型文件），语料、资产测绘、体检不能中途打断，跑完照常同步状态。
 */
export async function stopDetectJob(
  user: CurrentUser,
  jobId: string,
  ctx: DetectJobActionContext,
): Promise<void> {
  const job = await loadJob(jobId);
  const from: DetectTaskStatus[] = ['PENDING', 'RUNNING', 'PAUSED'];
  if (!from.includes(job.status as DetectTaskStatus)) throw stateConflict();
  const now = new Date();
  await transition(jobId, from, { status: 'CANCELED', stopRequested: true, finishedAt: now });
  await prisma.detectJobItem.updateMany({
    where: { jobId, recordId: null, launchedAt: null, status: 'PENDING' },
    data: { status: 'CANCELED', finishedAt: now },
  });
  const items = await syncItemStatuses(jobId);
  const failures = await applyToRecords(
    job,
    user,
    items.filter((i) => i.recordId && !isDetectTaskTerminal(i.status)),
    'stop',
    ctx,
  );
  await syncItemStatuses(jobId);
  await audit(user, 'detect_job.stop', jobId, ctx, {
    name: job.name,
    previousStatus: job.status,
    ...(failures.length ? { notStopped: failures.map((f) => f.item.position + 1) } : {}),
  });
  if (failures.length > 0) {
    // 组合任务已停止（不再启动新的），但这几项检测记录没停下来：告诉点按钮的人是哪几项、为什么。
    throw new AppError(
      409,
      `组合任务已停止，但以下子任务没能停止：${failures
        .map((f) => `第 ${f.item.position + 1} 项（${f.item.title}）：${f.reason}`)
        .join('；')}`,
      'DETECT_JOB_STOP_PARTIAL',
      {
        items: failures.map((f) => ({
          index: f.item.position,
          title: f.item.title,
          reason: f.reason,
        })),
      },
    );
  }
}

/** 删除：只允许未启动或已结束；不删子任务建出的检测记录。 */
export async function deleteDetectJob(
  user: CurrentUser,
  jobId: string,
  ctx: DetectJobActionContext,
): Promise<void> {
  const job = await loadJob(jobId);
  if (job.status !== 'PENDING' && !isDetectTaskTerminal(job.status)) throw stateConflict();
  const r = await prisma.detectJob.deleteMany({
    where: { id: jobId, status: job.status },
  });
  if (r.count === 0) throw stateConflict();
  await audit(user, 'detect_job.delete', jobId, ctx, { name: job.name, status: job.status });
}

// ---------- 序列化 ----------

function emptyCounts(): Record<DetectTaskStatus, number> {
  return Object.fromEntries(DETECT_TASK_STATUSES.map((s) => [s, 0])) as Record<
    DetectTaskStatus,
    number
  >;
}

async function usersById(ids: Array<string | null>) {
  const want = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (want.length === 0) return new Map<string, { id: string; username: string }>();
  const rows = await prisma.user.findMany({
    where: { id: { in: want } },
    select: { id: true, username: true },
  });
  return new Map(rows.map((u) => [u.id, u]));
}

function serializeJobBase(job: DetectJob, users: Map<string, { id: string; username: string }>) {
  return {
    id: job.id,
    tenantId: job.tenantId,
    name: job.name,
    status: job.status as DetectTaskStatus,
    maxParallel: job.maxParallel,
    strategyId: job.strategyId,
    schemeId: job.schemeId,
    triggeredBy: job.triggeredBy,
    stopRequested: job.stopRequested,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    createdBy: job.createdById ? (users.get(job.createdById) ?? null) : null,
  };
}

export async function listDetectJobs(q: {
  status?: string;
  strategyId?: string;
  schemeId?: string;
  page: number;
  pageSize: number;
}) {
  const where: Prisma.DetectJobWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.strategyId ? { strategyId: q.strategyId } : {}),
    ...(q.schemeId ? { schemeId: q.schemeId } : {}),
  };
  const [total, jobs] = await Promise.all([
    prisma.detectJob.count({ where }),
    prisma.detectJob.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);
  const ids = jobs.map((j) => j.id);
  const groups = ids.length
    ? await prisma.detectJobItem.groupBy({
        by: ['jobId', 'status'],
        where: { jobId: { in: ids } },
        _count: { _all: true },
      })
    : [];
  const counts = new Map<string, Record<DetectTaskStatus, number>>();
  for (const g of groups) {
    const c = counts.get(g.jobId) ?? emptyCounts();
    if (g.status in c) c[g.status as DetectTaskStatus] += g._count._all;
    counts.set(g.jobId, c);
  }
  const users = await usersById(jobs.map((j) => j.createdById));
  return {
    items: jobs.map((j) => {
      const itemCounts = counts.get(j.id) ?? emptyCounts();
      return {
        ...serializeJobBase(j, users),
        itemCount: Object.values(itemCounts).reduce((a, b) => a + b, 0),
        itemCounts,
      };
    }),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

/**
 * 详情：先从记录同步子任务状态（不启动新子任务），子任务带链接、记录名称、统一状态和可用操作。
 * 给了 viewer 时：操作只给他有权限做的；他没有读权限的记录类型只显示类型和状态（restricted）。
 */
export async function getDetectJobDetail(jobId: string, viewer?: CurrentUser) {
  await loadJob(jobId);
  const items = await syncItemStatuses(jobId);
  const job = await loadJob(jobId);
  const launched = items.filter((i) => i.recordKind && i.recordId);
  const records = await loadDetectRecords(
    launched.map((i) => ({ recordKind: i.recordKind!, recordId: i.recordId! })),
  );
  const evalIds = launched.filter((i) => i.recordKind === 'eval_task').map((i) => i.recordId!);
  const flags = await evalTaskActionFlags(evalIds);
  const users = await usersById([job.createdById]);
  const itemCounts = emptyCounts();
  for (const i of items) if (i.status in itemCounts) itemCounts[i.status as DetectTaskStatus] += 1;
  return {
    ...serializeJobBase(job, users),
    itemCount: items.length,
    itemCounts,
    items: items.map((i) => {
      const kind = isDetectJobItemKind(i.kind) ? i.kind : null;
      const recordKind =
        i.recordKind && i.recordKind in DETECT_RECORD_KINDS
          ? (i.recordKind as DetectRecordKind)
          : null;
      const status = i.status as DetectTaskStatus;
      const kindLabel = kind ? DETECT_JOB_ITEM_META[kind].label : i.kind;
      const readKind = recordKind ?? (kind ? DETECT_JOB_ITEM_META[kind].recordKind : null);
      const restricted = Boolean(
        viewer && readKind && !canReadDetectRecord(readKind, (c) => viewer.permissions.has(c)),
      );
      const flag = (i.recordId && flags.get(i.recordId)) || { pausable: false };
      const actions =
        restricted || !recordKind || !i.recordId
          ? []
          : viewer
            ? // 子任务记录以组合任务创建人的身份建出
              allowedActions(viewer, recordKind, status, { ...flag, createdById: job.createdById })
            : supportedActions(recordKind, status, flag);
      return {
        id: i.id,
        position: i.position,
        kind: i.kind,
        kindLabel,
        category: kind ? DETECT_JOB_ITEM_META[kind].category : null,
        title: restricted ? kindLabel : i.title,
        params: restricted ? {} : i.params,
        toolId: i.toolId,
        ledgerAssetId: restricted ? null : i.ledgerAssetId,
        status,
        error: i.error,
        restricted,
        recordKind,
        recordId: restricted ? null : i.recordId,
        recordName: !restricted && i.recordId ? (records.get(i.recordId)?.name ?? null) : null,
        href:
          !restricted && recordKind && i.recordId ? detectRecordHref(recordKind, i.recordId) : null,
        actions,
        launchedAt: i.launchedAt?.toISOString() ?? null,
        finishedAt: i.finishedAt?.toISOString() ?? null,
      };
    }),
  };
}
