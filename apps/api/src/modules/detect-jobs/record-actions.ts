import {
  normalizeDetectTaskStatus,
  type DetectRecordKind,
  type DetectTaskStatus,
} from '@lse/shared';
import { prisma } from '../../db.js';
import { conflict, notFound, permissionDenied } from '../../lib/errors.js';
import type { CurrentUser } from '../../lib/rbac.js';
import { cancelEvalTaskById } from '../eval-tasks/cancel.js';
import {
  evalTaskPausable,
  PAUSABLE_TASK_SELECT,
  pauseEvalTaskById,
  resumeEvalTaskById,
} from '../eval-tasks/pause.js';
import { cancelModelFileScan } from '../model-files/launch.js';
import { cancelRagEvalRun } from '../rag-eval/cancel.js';
import { cancelStandardRun } from '../standard-evaluations/cancel.js';

// 检测记录的暂停、恢复、停止（2.4.2）：统一任务视图、组合任务共用。
// 停止按记录类型分派到各自模块（国标专项、RAG 有自己的停止）；语料扫描、资产测绘、终端体检等
// 不能中途打断的类型没有可用操作。

export const DETECT_RECORD_ACTIONS = ['pause', 'resume', 'stop'] as const;
export type DetectRecordAction = (typeof DETECT_RECORD_ACTIONS)[number];

const EVAL_TASK_ROW_KINDS: readonly DetectRecordKind[] = [
  'eval_task',
  'standard_run',
  'rag_eval',
  'fleet_eval_job',
];

export function isEvalTaskRowKind(kind: DetectRecordKind): boolean {
  return EVAL_TASK_ROW_KINDS.includes(kind);
}

/** 某条记录当前能做的操作（不看权限）。pausable 只对 eval_task 有意义（见 eval-tasks/pause.ts 的 evalTaskPausable）。 */
export function supportedActions(
  kind: DetectRecordKind,
  status: DetectTaskStatus,
  opts: { pausable: boolean; pauseRequested?: boolean },
): DetectRecordAction[] {
  if (kind === 'eval_task' && opts.pausable) {
    // 暂停中（已请求暂停、还没停下）：可以撤销暂停（恢复）。
    if (status === 'RUNNING' && opts.pauseRequested) return ['resume', 'stop'];
    if (status === 'RUNNING' || status === 'PENDING') return ['pause', 'stop'];
    if (status === 'PAUSED') return ['resume', 'stop'];
    return [];
  }
  if (isEvalTaskRowKind(kind) || kind === 'model_file_scan') {
    return status === 'PENDING' || status === 'RUNNING' ? ['stop'] : [];
  }
  return [];
}

/** 每个操作要的权限；null 表示该类型不支持这个操作。 */
export function actionPermission(
  kind: DetectRecordKind,
  action: DetectRecordAction,
): string | null {
  switch (kind) {
    case 'eval_task':
    case 'fleet_eval_job':
      return action === 'stop' ? 'eval_task:delete' : 'eval_task:re_eval';
    // 国标专项、RAG 只有停止，用各自模块的权限。
    case 'standard_run':
      return action === 'stop' ? 'standard_eval:run' : null;
    case 'rag_eval':
      return action === 'stop' ? 'rag_eval:run' : null;
    case 'model_file_scan':
      return 'engine:scan';
    default:
      return null;
  }
}

/**
 * 当前用户对这条记录实际能点的操作：状态支持、且有对应权限；模型文件扫描只能停止自己发起的
 * （内置角色除外，与 cancelModelFileScan 一致）。统一视图、组合任务详情按它显示按钮。
 */
export function allowedActions(
  user: CurrentUser,
  kind: DetectRecordKind,
  status: DetectTaskStatus,
  opts: { pausable: boolean; pauseRequested?: boolean; createdById?: string | null },
): DetectRecordAction[] {
  return supportedActions(kind, status, opts).filter((action) => {
    const permission = actionPermission(kind, action);
    if (!permission || !user.permissions.has(permission)) return false;
    if (kind === 'model_file_scan' && !user.isBuiltin && opts.createdById !== user.id) return false;
    return true;
  });
}

/** 评估任务记录的操作判断依据：能不能暂停、是不是暂停中。列表、详情批量取。 */
export async function evalTaskActionFlags(
  ids: string[],
): Promise<Map<string, { pausable: boolean; pauseRequested: boolean }>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.evalTask.findMany({
    where: { id: { in: ids } },
    select: PAUSABLE_TASK_SELECT,
  });
  return new Map(
    rows.map((t) => [
      t.id,
      {
        pausable: evalTaskPausable(t),
        pauseRequested: t.status === 'RUNNING' && Boolean(t.pauseRequestedAt),
      },
    ]),
  );
}

const unsupported = () => conflict('该类任务不支持此操作', 'DETECT_ACTION_UNSUPPORTED');

export interface RecordActionDeps {
  /** 写评估任务暂停信号（测试注入） */
  pauseEvalTask?: (taskId: string) => Promise<void>;
  /** 写评估任务取消信号（测试注入） */
  cancelEvalTask?: (taskId: string) => Promise<void>;
  ip?: string | null;
  userAgent?: string | null;
  /** 审计里记的操作人（组合任务以创建人身份操作子记录时，记实际点按钮的人）；不给就是 user。 */
  auditActor?: { id: string; username: string };
}

/**
 * 对一条检测记录执行暂停、恢复或停止。权限不够 403；记录不存在（含别的租户的）404；
 * 该类型或当前状态不支持 409 DETECT_ACTION_UNSUPPORTED。返回操作后的统一状态。
 * 必须在租户范围内调用。
 */
export async function applyRecordAction(
  user: CurrentUser,
  kind: DetectRecordKind,
  id: string,
  action: DetectRecordAction,
  deps: RecordActionDeps = {},
): Promise<{ status: DetectTaskStatus; pauseRequested?: boolean }> {
  const permission = actionPermission(kind, action);
  if (!permission) throw unsupported();
  if (!user.permissions.has(permission)) throw permissionDenied([permission]);
  const actor = deps.auditActor ?? user;

  if (kind === 'model_file_scan') {
    const scan = await prisma.modelFileScan.findUnique({ where: { id }, select: { status: true } });
    if (!scan) throw notFound('扫描记录不存在');
    const status = normalizeDetectTaskStatus(scan.status);
    if (!supportedActions(kind, status, { pausable: false }).includes(action)) throw unsupported();
    await cancelModelFileScan(
      user,
      id,
      { ip: deps.ip ?? null, userAgent: deps.userAgent ?? null },
      deps.auditActor,
    );
    return { status: 'CANCELED' };
  }

  const task = await prisma.evalTask.findUnique({ where: { id }, select: PAUSABLE_TASK_SELECT });
  if (!task) throw notFound('评估任务不存在');
  const status = normalizeDetectTaskStatus(task.status);
  const pausable = kind === 'eval_task' && evalTaskPausable(task);
  const requested = task.status === 'RUNNING' && Boolean(task.pauseRequestedAt);
  if (!supportedActions(kind, status, { pausable, pauseRequested: requested }).includes(action)) {
    throw unsupported();
  }

  // 统一视图里国标专项、RAG 的行是它们的评估任务：按任务找到各自的运行记录，走各自模块的停止。
  if (kind === 'standard_run') {
    const run = await prisma.standardRun.findUnique({
      where: { taskId: id },
      select: { id: true },
    });
    if (!run) throw notFound('标准专项运行不存在');
    await cancelStandardRun(actor, run.id, deps.cancelEvalTask);
  } else if (kind === 'rag_eval') {
    const run = await prisma.ragEvalRun.findUnique({ where: { taskId: id }, select: { id: true } });
    if (!run) throw notFound('评估运行不存在');
    await cancelRagEvalRun(actor, run.id, deps.cancelEvalTask);
  } else {
    // 评估任务的暂停、恢复、停止只用 actor 记审计（权限已按 user 校验过）。
    let pauseRequested: boolean | undefined;
    if (action === 'pause') {
      ({ pauseRequested } = await pauseEvalTaskById(actor, id, deps.pauseEvalTask));
    } else if (action === 'resume') {
      await resumeEvalTaskById(actor, id);
    } else {
      await cancelEvalTaskById(actor, id, deps.cancelEvalTask);
    }
    const after = await prisma.evalTask.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    return {
      status: normalizeDetectTaskStatus(after.status),
      ...(pauseRequested === undefined ? {} : { pauseRequested }),
    };
  }
  const after = await prisma.evalTask.findUniqueOrThrow({
    where: { id },
    select: { status: true },
  });
  return { status: normalizeDetectTaskStatus(after.status) };
}
