import { randomUUID } from 'node:crypto';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { assertNonEndpointTaskTarget } from '../../lib/endpoint-task-policy.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { assertLicensedFeature } from '../../lib/license-enforcement.js';
import { enqueueEvalTask } from '../../lib/queue.js';
import { platformAppEnabled } from '../eval-targets/platform-adapters/index.js';
import type { EvalPlanTemplate } from '../eval-plans/service.js';
import { loadEnabledQuestionSets } from '../question-sets/enabled.js';
import { sampledTotal } from './sampling.js';

/**
 * 按「评估对象 + 评估计划同款模板」建一个普通评估任务并入队（组合任务的子任务、检测策略用）。
 * 检查与「新建评估任务」接口一致：对象存在且启用、不是终端或网关日志对象、平台智能体要开启、样本库可用、授权。
 * 必须在租户范围内调用（请求里，或 worker 的 runInTenant 里）。
 */
export async function createEvalTaskFromTemplate(
  user: { id: string; username: string },
  input: {
    name: string;
    modelTargetId: string;
    template: EvalPlanTemplate;
    ip?: string | null;
    userAgent?: string | null;
    /** 审计里记下发起来源，如 detect_job */
    source?: string;
  },
): Promise<{ id: string }> {
  await assertLicensedFeature('web_ai');
  const target = await prisma.modelTarget.findUnique({ where: { id: input.modelTargetId } });
  if (!target) throw badRequest('所选评估对象不存在', 'MODEL_TARGET_NOT_FOUND');
  if (!target.isActive) throw badRequest('所选评估对象已禁用', 'MODEL_TARGET_INACTIVE');
  assertNonEndpointTaskTarget(target);
  if (target.targetType === 'PLATFORM_APP' && !platformAppEnabled()) {
    throw forbidden('平台智能体测评功能未启用', 'PLATFORM_APP_DISABLED');
  }
  if (target.targetType === 'GATEWAY_LOG') {
    throw badRequest(
      '网关流量观测对象不能用于主动评估，请使用网关日志分析入口。',
      'GATEWAY_LOG_TARGET_NOT_EXECUTABLE',
    );
  }

  const t = input.template;
  const uniqueSetIds = [...new Set(t.questionSetIds)];
  const sets = await loadEnabledQuestionSets(prisma, uniqueSetIds);
  const poolQuestions = sets.reduce((sum, s) => sum + s.questionCount, 0);
  const totalQuestions = sampledTotal(poolQuestions, t.sampleSize);
  const sampleSeed = t.sampleSize ? (t.sampleSeed ?? randomUUID()) : null;
  const name = input.name.trim().slice(0, 200) || target.name;

  const created = await prisma.evalTask.create({
    data: {
      name,
      description: t.description ?? null,
      status: 'PENDING',
      modelTargetId: target.id,
      engines: t.engines,
      dimensions: t.dimensions,
      concurrency: t.concurrency,
      totalQuestions,
      sampleSize: t.sampleSize ?? null,
      sampleSeed,
      createdById: user.id,
      questionSets: { create: uniqueSetIds.map((questionSetId) => ({ questionSetId })) },
    },
    select: { id: true },
  });
  await enqueueEvalTask(created.id);
  await writeAudit({
    actorId: user.id,
    actorName: user.username,
    action: 'eval_task.create',
    targetType: 'eval_task',
    targetId: created.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    detail: {
      name,
      modelTargetId: target.id,
      totalQuestions,
      poolQuestions,
      sampleSize: t.sampleSize ?? null,
      sampleSeed,
      questionSetIds: uniqueSetIds,
      ...(input.source ? { source: input.source } : {}),
    },
  });
  return created;
}
