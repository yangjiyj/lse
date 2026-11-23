import { prisma } from '../../db.js';
import { conflict, notFound } from '../../lib/errors.js';
import { attachFormalFinding } from './persist.js';

const ACTIVE_STATUSES = ['PENDING', 'RUNNING'] as const;

function isActive(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * 把一次独立发起的核验关联到评估任务：只有这里（及已关联任务的执行持久化）会写 findings 表。
 * 按结论当前状态生成正式 Finding（与执行时的规则一致），关联后任务汇总报告按 taskId 自然纳入。
 */
export async function linkRunToTask(
  runId: string,
  taskId: string,
): Promise<{ findingCount: number }> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.serviceAssuranceRun.findUnique({
      where: { id: runId },
      select: { id: true, taskId: true, status: true },
    });
    if (!run) throw notFound('服务安全核验运行不存在', 'SERVICE_ASSURANCE_RUN_NOT_FOUND');
    if (run.taskId) {
      throw conflict(
        '该核验记录已关联评估任务，如需调整请先取消关联。',
        'SERVICE_ASSURANCE_RUN_ALREADY_LINKED',
      );
    }
    if (isActive(run.status)) {
      throw conflict('核验执行结束后才能关联评估任务。', 'SERVICE_ASSURANCE_RUN_ACTIVE');
    }
    const claimed = await tx.serviceAssuranceRun.updateMany({
      where: { id: runId, taskId: null },
      data: { taskId, linkedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw conflict(
        '该核验记录已关联评估任务，如需调整请先取消关联。',
        'SERVICE_ASSURANCE_RUN_ALREADY_LINKED',
      );
    }
    const assessments = await tx.vulnerabilityAssessment.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
    });
    let findingCount = 0;
    for (const assessment of assessments) {
      // 以结论当前状态（含人工复核结果）判定：仅已确认受影响且证据达到版本级以上才生成正式 Finding。
      const source = {
        ...assessment,
        assetKey: '',
        componentKey: null,
        confidence: assessment.confidence ?? 0,
      };
      if (await attachFormalFinding(tx, taskId, assessment.id, source)) findingCount += 1;
    }
    return { findingCount };
  });
}

/**
 * 取消关联：移除本次核验在该任务下生成、且未被该任务其他核验结论引用的正式 Finding 与引擎记录，
 * 记录回到发起人名下；此后该任务的汇总报告不再包含本次核验。
 */
export async function unlinkRunFromTask(runId: string): Promise<{ removedFindingCount: number }> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.serviceAssuranceRun.findUnique({
      where: { id: runId },
      select: { id: true, taskId: true, status: true },
    });
    if (!run) throw notFound('服务安全核验运行不存在', 'SERVICE_ASSURANCE_RUN_NOT_FOUND');
    if (!run.taskId) {
      throw conflict('该核验记录尚未关联评估任务。', 'SERVICE_ASSURANCE_RUN_NOT_LINKED');
    }
    if (isActive(run.status)) {
      throw conflict('核验执行结束后才能取消关联。', 'SERVICE_ASSURANCE_RUN_ACTIVE');
    }
    const taskId = run.taskId;
    const own = await tx.vulnerabilityAssessment.findMany({
      where: { runId },
      select: { id: true, findingId: true, legacyFindingId: true },
    });
    const findingIds = [
      ...new Set(own.flatMap((a) => [a.findingId, a.legacyFindingId]).filter((id): id is string => !!id)),
    ];
    await tx.vulnerabilityAssessment.updateMany({
      where: { runId },
      data: { findingId: null, legacyFindingId: null },
    });
    let removedFindingCount = 0;
    if (findingIds.length > 0) {
      const stillReferenced = await tx.vulnerabilityAssessment.findMany({
        where: {
          runId: { not: runId },
          OR: [{ findingId: { in: findingIds } }, { legacyFindingId: { in: findingIds } }],
        },
        select: { findingId: true, legacyFindingId: true },
      });
      const keep = new Set(stillReferenced.flatMap((a) => [a.findingId, a.legacyFindingId]));
      const removable = findingIds.filter((id) => !keep.has(id));
      if (removable.length > 0) {
        removedFindingCount = (
          await tx.finding.deleteMany({ where: { id: { in: removable }, taskId } })
        ).count;
      }
    }
    await tx.engineRun.deleteMany({
      where: { taskId, requestPayload: { path: ['serviceAssuranceRunId'], equals: runId } },
    });
    await tx.serviceAssuranceRun.update({
      where: { id: runId },
      data: { taskId: null, linkedAt: null },
    });
    return { removedFindingCount };
  });
}
