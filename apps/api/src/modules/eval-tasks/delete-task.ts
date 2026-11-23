import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { BYO_SET_SOURCE } from '../multimodal-jailbreak/byo-images/executor.js';
import { purgeByoImages } from '../multimodal-jailbreak/byo-images/routes.js';

/**
 * 删除评估任务的共用逻辑：单独删任务（DELETE /eval-tasks/:id）和连同评估对象一起删
 * （DELETE /model-targets/:id?withTasks=true）走同一套判断和收尾。
 */

/** 已下线的 AIG 引擎：带它的历史任务只读。 */
export const RETIRED_AIG_ENGINE = 'ai-infra-guard';

/** 删除任务前要读的字段。 */
export const taskDeleteSelect = {
  id: true,
  name: true,
  status: true,
  engines: true,
  standardRun: { select: { id: true } },
  questionSets: { select: { questionSet: { select: { id: true, source: true } } } },
} satisfies Prisma.EvalTaskSelect;

export type DeletableTask = Prisma.EvalTaskGetPayload<{ select: typeof taskDeleteSelect }>;

export type TaskDeleteBlocker = {
  code: 'AIG_HISTORY_READ_ONLY' | 'EVAL_TASK_RUNNING';
  message: string;
};

/** 这个任务现在能不能删；不能删时返回原因。 */
export function taskDeleteBlocker(task: Pick<DeletableTask, 'status' | 'engines'>): TaskDeleteBlocker | null {
  if (task.engines.includes(RETIRED_AIG_ENGINE)) {
    return { code: 'AIG_HISTORY_READ_ONLY', message: '历史 AIG 任务仅供查看，不支持删除。' };
  }
  if (task.status === 'RUNNING') {
    return { code: 'EVAL_TASK_RUNNING', message: '任务正在运行中，无法删除' };
  }
  return null;
}

/**
 * 在事务里删掉任务，以及挂在 Restrict 外键上、不会随任务级联的记录。
 * 调用前先用 taskDeleteBlocker 确认可删。
 */
export async function deleteTaskRecords(tx: Prisma.TransactionClient, task: DeletableTask): Promise<void> {
  // 标准专项的运行、样本、作答、判定、报告都挂在 Restrict 外键上，任务侧
  // 不主动收，任务和它引用的模型就会永远卡在列表里删不掉。
  if (task.standardRun) {
    const runId = task.standardRun.id;
    const samples = await tx.standardSample.findMany({
      where: { standardRunId: runId },
      select: { id: true },
    });
    const sampleIds = samples.map((sample) => sample.id);
    if (sampleIds.length > 0) {
      await tx.standardJudgment.deleteMany({ where: { sampleId: { in: sampleIds } } });
      await tx.standardSampleAttempt.deleteMany({ where: { sampleId: { in: sampleIds } } });
    }
    await tx.standardReport.deleteMany({ where: { standardRunId: runId } });
    await tx.standardSample.deleteMany({ where: { standardRunId: runId } });
    await tx.standardRun.delete({ where: { id: runId } });
  }

  // 服务核验同样是一串 Restrict 外键，证据挂在评估和组件下面，得从
  // 最外层的证据往回收。
  const assuranceRuns = await tx.serviceAssuranceRun.findMany({
    where: { taskId: task.id },
    select: { id: true },
  });
  const assuranceRunIds = assuranceRuns.map((run) => run.id);
  if (assuranceRunIds.length > 0) {
    const scope = { runId: { in: assuranceRunIds } };
    await tx.serviceEvidence.deleteMany({ where: scope });
    await tx.vulnerabilityAssessment.deleteMany({ where: scope });
    await tx.serviceComponent.deleteMany({ where: scope });
    await tx.serviceAsset.deleteMany({ where: scope });
    await tx.serviceAssuranceRun.deleteMany({ where: { id: { in: assuranceRunIds } } });
  }

  await tx.evalTask.delete({ where: { id: task.id } });
}

/**
 * 任务删除的事务提交之后调用：自带图片集随任务删除，图片字节同步清除（含审计，只记数量与哈希）。
 * 还有别的任务在用的图片集不动。
 */
export async function purgeTaskByoSets(
  task: DeletableTask,
  actor: { id: string; username: string },
): Promise<void> {
  for (const link of task.questionSets) {
    if (link.questionSet.source !== BYO_SET_SOURCE) continue;
    const remaining = await prisma.evalTaskQuestionSet.count({
      where: { questionSetId: link.questionSet.id },
    });
    if (remaining > 0) continue;
    await purgeByoImages(link.questionSet.id, actor, 'task_delete');
    await prisma.questionSet.delete({ where: { id: link.questionSet.id } }).catch(() => undefined);
  }
}
