import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { requestEvalTaskCancel } from '../../lib/queue.js';
import { standardTaskCounters } from './task-evidence.js';

/**
 * 停止国标专项运行（停止接口和检测任务的「停止」共用）：写取消信号，把取消当时的计数一并写回，
 * 运行标记为证据不完整。
 */
export async function cancelStandardRun(
  actor: { id: string; username: string },
  runId: string,
  requestCancel: (taskId: string) => Promise<void> = requestEvalTaskCancel,
): Promise<{ runId: string; taskId: string }> {
  const run = await prisma.standardRun.findUnique({
    where: { id: runId },
    select: { id: true, taskId: true },
  });
  if (!run) throw notFound('标准专项运行不存在');
  await requestCancel(run.taskId);
  // 取消当时的计数一并写回：以前这里只写状态，计数停在旧值，要等有人打开详情页才"自愈"，
  // 同一任务在打开前后显示两套数字（还会把已取消任务显示成"发现 N 项风险"）。
  const counters = await standardTaskCounters(prisma, run.taskId);
  await prisma.$transaction([
    prisma.standardRun.update({
      where: { id: runId },
      data: { status: 'CANCELED', evidenceCompleteness: 'PARTIAL' },
    }),
    prisma.evalTask.update({
      where: { id: run.taskId },
      data: {
        status: 'CANCELED',
        finishedAt: new Date(),
        processedQuestions: counters.processed,
        passedCount: counters.passed,
        failedCount: counters.failed,
        errorCount: counters.error,
        progress: counters.total ? counters.processed / counters.total : 0,
      },
    }),
  ]);
  await writeAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: 'standard_evaluation.cancel',
    targetType: 'standard_run',
    targetId: runId,
    detail: { taskId: run.taskId },
  });
  return { runId, taskId: run.taskId };
}
