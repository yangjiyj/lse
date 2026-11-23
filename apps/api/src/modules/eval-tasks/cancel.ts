import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { clearEvalTaskPause, requestEvalTaskCancel } from '../../lib/queue.js';
import { cancelEndpointTask } from '../endpoint-evals/service.js';
import { evalTaskPausable, PAUSABLE_TASK_SELECT, type EvalTaskActor } from './pause.js';

/**
 * 停止评估任务（停止接口和检测任务的「停止」共用）。不存在 404；已结束的不动，返回 false。
 * - 终端测评交给终端测评自己的取消；
 * - 已暂停的执行器已经停了，直接置已停止并记结束时间；
 * - 排队中、执行中的写取消键并置已停止，执行器看到后收尾（结束时间由执行器写）。
 */
export async function cancelEvalTaskById(
  actor: EvalTaskActor,
  id: string,
  requestCancel: (taskId: string) => Promise<void> = requestEvalTaskCancel,
): Promise<boolean> {
  const task = await prisma.evalTask.findUnique({ where: { id }, select: PAUSABLE_TASK_SELECT });
  if (!task) throw notFound('评估任务不存在');
  if (task.status !== 'RUNNING' && task.status !== 'PENDING' && task.status !== 'PAUSED') {
    return false;
  }
  // 已暂停只处理本平台暂停功能停下的普通评估任务；网关核验写回的「已暂停」等不在这里停。
  if (task.status === 'PAUSED' && !evalTaskPausable(task)) return false;

  if (task.modelTarget.targetType === 'ENDPOINT_AGENT') {
    await cancelEndpointTask(id);
    await writeAudit({
      actorId: actor.id,
      actorName: actor.username,
      action: 'eval_task.cancel',
      targetType: 'eval_task',
      targetId: id,
    });
    return true;
  }

  // 已暂停：执行器已经停了，补结束时间、清暂停字段。
  const cancelPaused = () =>
    prisma.evalTask.updateMany({
      where: { id, status: 'PAUSED' },
      data: {
        status: 'CANCELED',
        finishedAt: new Date(),
        pausedAt: null,
        pauseState: Prisma.DbNull,
        pauseRequestedAt: null,
      },
    });
  const fromPaused = task.status === 'PAUSED' ? await cancelPaused() : { count: 0 };
  if (fromPaused.count === 0) {
    await requestCancel(id);
    const running = await prisma.evalTask.updateMany({
      where: { id, status: { in: ['PENDING', 'RUNNING'] } },
      data: { status: 'CANCELED', pauseRequestedAt: null },
    });
    // 读到时还在执行，随后执行器把它停成了已暂停：按已暂停的路径停止。
    if (running.count === 0) await cancelPaused();
  }
  await clearEvalTaskPause(id).catch(() => undefined);
  await writeAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: 'eval_task.cancel',
    targetType: 'eval_task',
    targetId: id,
    detail: { name: task.name, previousStatus: task.status },
  });
  return true;
}
