import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { requestEvalTaskCancel } from '../../lib/queue.js';

/**
 * 停止 RAG 评估运行（停止接口和检测任务的「停止」共用）：写取消信号；还在排队的直接置已停止，
 * 执行中的由执行器收尾。
 */
export async function cancelRagEvalRun(
  actor: { id: string; username: string },
  runId: string,
  requestCancel: (taskId: string) => Promise<void> = requestEvalTaskCancel,
): Promise<void> {
  const run = await prisma.ragEvalRun.findUnique({
    where: { id: runId },
    include: { task: { select: { status: true } } },
  });
  if (!run) throw notFound('评估运行不存在');
  if (!['PENDING', 'RUNNING'].includes(run.task.status)) throw badRequest('该运行已结束');
  await requestCancel(run.taskId);
  if (run.task.status === 'PENDING') {
    await prisma.evalTask.update({
      where: { id: run.taskId },
      data: { status: 'CANCELED', finishedAt: new Date() },
    });
    await prisma.ragEvalRun.update({ where: { id: runId }, data: { status: 'CANCELED' } });
  }
  await writeAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: 'rag_eval.run.cancel',
    targetType: 'rag_eval_run',
    targetId: runId,
  });
}
