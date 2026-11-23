import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { clearEvalTaskPause, enqueueEvalTask, requestEvalTaskPause } from '../../lib/queue.js';
import { ENDPOINT_ENGINE } from '../endpoint-evals/service.js';

// 评估任务暂停、恢复（2.4.2）。拍板：不再派新题，进行中的题做完再停；只限走普通执行器的任务。

export interface PausableTaskShape {
  standardRun?: { id: string } | null;
  ragEvalRun?: { id: string } | null;
  modelTarget: { targetType: string };
  dimensions: readonly string[];
  engines: readonly string[];
}

/** 只有走普通执行器 runEvalTask 的任务能暂停：国标专项、RAG、终端测评、网关流量分析和网关核验不行。 */
export function evalTaskPausable(task: PausableTaskShape): boolean {
  if (task.standardRun || task.ragEvalRun) return false;
  if (task.modelTarget.targetType === 'ENDPOINT_AGENT' || task.engines.includes(ENDPOINT_ENGINE)) {
    return false;
  }
  if (task.dimensions.includes('gateway_traffic_log')) return false;
  if (task.engines.includes('gateway-assurance')) return false;
  return true;
}

export const PAUSABLE_TASK_SELECT = {
  id: true,
  name: true,
  status: true,
  engines: true,
  dimensions: true,
  pauseRequestedAt: true,
  modelTarget: { select: { targetType: true } },
  standardRun: { select: { id: true } },
  ragEvalRun: { select: { id: true } },
} satisfies Prisma.EvalTaskSelect;

export interface EvalTaskActor {
  id: string;
  username: string;
}

async function loadPausableTask(id: string) {
  const task = await prisma.evalTask.findUnique({ where: { id }, select: PAUSABLE_TASK_SELECT });
  if (!task) throw notFound('评估任务不存在');
  if (!evalTaskPausable(task)) throw conflict('该类任务不支持暂停', 'EVAL_TASK_NOT_PAUSABLE');
  return task;
}

/**
 * 暂停：执行中的只写暂停键（执行器在派下一题前看到，在途的题做完后置为已暂停）；
 * 排队中的另外直接置为已暂停。返回执行器是否还要自己停下来（pauseRequested）。
 */
export async function pauseEvalTaskById(
  actor: EvalTaskActor,
  id: string,
  requestPause: (taskId: string) => Promise<void> = requestEvalTaskPause,
): Promise<{ pauseRequested: boolean }> {
  const task = await loadPausableTask(id);
  if (task.status !== 'RUNNING' && task.status !== 'PENDING') {
    throw conflict('只有排队中或执行中的任务能暂停', 'EVAL_TASK_STATE_CONFLICT');
  }
  await requestPause(id);
  let pauseRequested = task.status === 'RUNNING';
  if (task.status === 'PENDING') {
    const updated = await prisma.evalTask.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'PAUSED', pausedAt: new Date() },
    });
    if (updated.count === 0) {
      // 执行器刚把它置为执行中：暂停键已写，执行器会在派下一题前停下。
      const now = await prisma.evalTask.findUnique({ where: { id }, select: { status: true } });
      pauseRequested = now?.status === 'RUNNING';
    }
  }
  if (pauseRequested) {
    // 「暂停中」落库：页面据此显示，恢复接口据此撤销暂停。
    await prisma.evalTask.updateMany({
      where: { id, status: 'RUNNING' },
      data: { pauseRequestedAt: new Date() },
    });
  }
  await writeAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: 'eval_task.pause',
    targetType: 'eval_task',
    targetId: id,
    detail: { name: task.name, previousStatus: task.status },
  });
  return { pauseRequested };
}

/** 撤回暂停请求（清暂停键和「暂停中」标记），不改状态。组合任务恢复时对还在执行的评估子任务调用。 */
export async function withdrawEvalTaskPause(id: string): Promise<void> {
  await clearEvalTaskPause(id);
  await prisma.evalTask.updateMany({
    where: { id, pauseRequestedAt: { not: null } },
    data: { pauseRequestedAt: null },
  });
}

/**
 * 恢复：
 * - 已暂停：清暂停键，回到排队中（保留 pausedAt，执行器据此接续），重新入队；
 * - 执行中且已请求暂停（暂停中）：撤销暂停，执行器继续跑；
 * - 其他状态 409。
 */
export async function resumeEvalTaskById(
  actor: EvalTaskActor,
  id: string,
): Promise<{ withdrawn: boolean }> {
  const task = await loadPausableTask(id);
  if (task.status === 'RUNNING' && task.pauseRequestedAt) {
    await withdrawEvalTaskPause(id);
    await writeAudit({
      actorId: actor.id,
      actorName: actor.username,
      action: 'eval_task.resume',
      targetType: 'eval_task',
      targetId: id,
      detail: { name: task.name, withdrawPause: true },
    });
    return { withdrawn: true };
  }
  if (task.status !== 'PAUSED') {
    throw conflict('只有已暂停或暂停中的任务能恢复', 'EVAL_TASK_STATE_CONFLICT');
  }
  await clearEvalTaskPause(id);
  const updated = await prisma.evalTask.updateMany({
    where: { id, status: 'PAUSED' },
    data: { status: 'PENDING' },
  });
  if (updated.count === 0) {
    throw conflict('只有已暂停的任务能恢复', 'EVAL_TASK_STATE_CONFLICT');
  }
  await enqueueEvalTask(id);
  await writeAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: 'eval_task.resume',
    targetType: 'eval_task',
    targetId: id,
    detail: { name: task.name },
  });
  return { withdrawn: false };
}
