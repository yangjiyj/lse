import { assertNonEndpointTaskTarget } from '../../lib/endpoint-task-policy.js';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { EVAL_PLANS_TRIGGER_SCOPE, requireApiTokenOrUser } from '../../plugins/api-token-auth.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { checkQuestionSets, questionSetDisabledError } from '../question-sets/enabled.js';
import {
  MAX_PLAN_INTERVAL_MINUTES,
  MIN_PLAN_INTERVAL_MINUTES,
  assertCronAllowed,
  assertValidTimezone,
  nextRunAt,
  normalizeTemplate,
  triggerEvalPlan,
} from './service.js';
import { defaultPlanScheduler, type PlanScheduler } from './scheduler.js';
import { compareRegression } from './regression.js';
import { computePassRate } from '@lse/shared';
import { REPORT_TIME_ZONE } from '../reports/labels.js';

export interface EvalPlanRoutesOptions {
  scheduler?: PlanScheduler;
}

const idParams = z.object({ id: z.string().uuid() });
const baseFields = {
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  targetId: z.string().uuid(),
  cron: z.string().trim().min(9).max(120),
  timezone: z.string().trim().min(1).max(64).default(REPORT_TIME_ZONE),
  minIntervalMinutes: z
    .number()
    .int()
    .min(MIN_PLAN_INTERVAL_MINUTES)
    .max(MAX_PLAN_INTERVAL_MINUTES)
    .default(60),
  enabled: z.boolean().default(true),
  templateParams: z.unknown(),
};
const createPlanBody = z.object(baseFields);
const updatePlanBody = z
  .object({
    name: baseFields.name,
    description: baseFields.description,
    targetId: baseFields.targetId,
    cron: baseFields.cron,
    timezone: z.string().trim().min(1).max(64),
    minIntervalMinutes: z.number().int().min(MIN_PLAN_INTERVAL_MINUTES).max(MAX_PLAN_INTERVAL_MINUTES),
    templateParams: z.unknown(),
  })
  .partial();
const toggleBody = z.object({ enabled: z.boolean() });
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().trim().max(100).optional(),
});
const regressionQuery = z.object({
  planId: z.string().uuid().optional(),
  baseTaskId: z.string().uuid().optional(),
  headTaskId: z.string().uuid().optional(),
});
const runsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const planInclude = {
  target: { select: { id: true, name: true, isActive: true } },
  createdBy: { select: { id: true, username: true, displayName: true } },
  _count: { select: { tasks: true } },
} satisfies Prisma.EvalPlanInclude;
type PlanRow = Prisma.EvalPlanGetPayload<{ include: typeof planInclude }>;

function serializePlan(plan: PlanRow) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    targetId: plan.targetId,
    targetName: plan.target.name,
    targetActive: plan.target.isActive,
    templateParams: plan.templateParams,
    cron: plan.cron,
    timezone: plan.timezone,
    enabled: plan.enabled,
    minIntervalMinutes: plan.minIntervalMinutes,
    lastTriggeredAt: plan.lastTriggeredAt?.toISOString() ?? null,
    lastSkipReason: plan.lastSkipReason,
    nextRunAt: plan.enabled ? (nextRunAt(plan.cron, plan.timezone)?.toISOString() ?? null) : null,
    taskCount: plan._count.tasks,
    createdBy: plan.createdBy
      ? { id: plan.createdBy.id, name: plan.createdBy.displayName || plan.createdBy.username }
      : null,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

/** 计划里已选的样本库 ID（模板不合法时为空）。 */
function planSetIds(templateParams: unknown): string[] {
  try {
    return normalizeTemplate(templateParams).questionSetIds;
  } catch {
    return [];
  }
}

/**
 * 保存前统一校验：对象可主动评估、样本库存在、模板合法、时区与 cron 间隔合规。
 * 样本库须启用；改计划时原已选、后来被禁用的库允许保留（能改名、能取消勾选，计划不会卡死），
 * 触发时会跳过并提示编辑计划；新勾选的库必须是启用的。
 */
async function validatePlanInput(
  input: {
    targetId: string;
    cron: string;
    timezone: string;
    minIntervalMinutes: number;
    templateParams?: unknown;
  },
  previousSetIds: readonly string[] = [],
) {
  assertValidTimezone(input.timezone);
  assertCronAllowed(input.cron, input.timezone, input.minIntervalMinutes);
  const template = normalizeTemplate(input.templateParams);
  const target = await prisma.modelTarget.findUnique({ where: { id: input.targetId } });
  if (!target) throw badRequest('所选评估对象不存在', 'MODEL_TARGET_NOT_FOUND');
  assertNonEndpointTaskTarget(target);
  if (target.targetType === 'GATEWAY_LOG') {
    throw badRequest('网关流量观测对象不能用于主动评估', 'GATEWAY_LOG_TARGET_NOT_EXECUTABLE');
  }
  const { missing, disabled } = await checkQuestionSets(prisma, template.questionSetIds);
  if (missing.length > 0) {
    throw badRequest('部分所选样本库不存在，请刷新后重新选择。', 'QUESTION_SET_NOT_FOUND');
  }
  const kept = new Set(previousSetIds);
  const newlyDisabled = disabled.filter((s) => !kept.has(s.id));
  if (newlyDisabled.length > 0) throw questionSetDisabledError(newlyDisabled);
  return template;
}

export async function evalPlanRoutes(
  app: FastifyInstance,
  options: EvalPlanRoutesOptions = {},
): Promise<void> {
  const scheduler = options.scheduler ?? defaultPlanScheduler();
  // 注意：本插件不全局挂 authenticate —— /:id/trigger 需允许 API 令牌（CI）访问。
  const canRead = [authenticate, requirePermission('eval_task:read')];
  const canCreate = [authenticate, requirePermission('eval_task:create')];
  const canDelete = [authenticate, requirePermission('eval_task:delete')];

  // 回归对比：planId[+headTaskId]（计划相邻两次运行）或 baseTaskId+headTaskId（任选两任务）。
  // 注册在 /:id 之前，避免 "regression" 被当作 id。
  app.get('/regression', { preHandler: canRead }, async (request) => {
    const q = regressionQuery.parse(request.query);
    return compareRegression(prisma, q);
  });

  // 计划下的运行任务（新→旧），供对比页“按计划选运行”。
  app.get('/:id/tasks', { preHandler: canRead }, async (request) => {
    const { id } = idParams.parse(request.params);
    const exists = await prisma.evalPlan.count({ where: { id } });
    if (!exists) throw notFound('评估计划不存在');
    const tasks = await prisma.evalTask.findMany({
      where: { planId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: {
        id: true,
        name: true,
        status: true,
        createdAt: true,
        finishedAt: true,
        totalQuestions: true,
        passedCount: true,
        failedCount: true,
        errorCount: true,
      },
    });
    return {
      items: tasks.map((t) => ({
        ...t,
        createdAt: t.createdAt.toISOString(),
        finishedAt: t.finishedAt?.toISOString() ?? null,
        passRate: computePassRate(t.passedCount, t.failedCount),
      })),
    };
  });

  app.get('/', { preHandler: canRead }, async (request) => {
    const q = listQuery.parse(request.query);
    const where: Prisma.EvalPlanWhereInput = q.keyword
      ? { name: { contains: q.keyword, mode: 'insensitive' } }
      : {};
    const [total, rows] = await Promise.all([
      prisma.evalPlan.count({ where }),
      prisma.evalPlan.findMany({
        where,
        include: planInclude,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { items: rows.map(serializePlan), total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/:id', { preHandler: canRead }, async (request) => {
    const { id } = idParams.parse(request.params);
    const plan = await prisma.evalPlan.findUnique({ where: { id }, include: planInclude });
    if (!plan) throw notFound('评估计划不存在');
    return serializePlan(plan);
  });

  app.post(
    '/',
    { preHandler: [...canCreate, requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = createPlanBody.parse(request.body ?? {});
      const template = await validatePlanInput(body);
      const plan = await prisma.evalPlan.create({
        data: {
          name: body.name,
          description: body.description ?? null,
          targetId: body.targetId,
          templateParams: template as Prisma.InputJsonValue,
          cron: body.cron,
          timezone: body.timezone,
          enabled: body.enabled,
          minIntervalMinutes: body.minIntervalMinutes,
          createdById: request.currentUser!.id,
        },
        include: planInclude,
      });
      await scheduler.sync(plan);
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'eval_plan.create',
        targetType: 'eval_plan',
        targetId: plan.id,
        detail: {
          name: plan.name,
          targetId: plan.targetId,
          cron: plan.cron,
          timezone: plan.timezone,
          enabled: plan.enabled,
          minIntervalMinutes: plan.minIntervalMinutes,
          questionSetIds: template.questionSetIds,
        },
      });
      reply.code(201);
      return serializePlan(plan);
    },
  );

  app.patch(
    '/:id',
    { preHandler: [...canCreate, requireLicensedFeature('web_ai')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = updatePlanBody.parse(request.body ?? {});
      const existing = await prisma.evalPlan.findUnique({ where: { id } });
      if (!existing) throw notFound('评估计划不存在');
      const merged = {
        targetId: body.targetId ?? existing.targetId,
        cron: body.cron ?? existing.cron,
        timezone: body.timezone ?? existing.timezone,
        minIntervalMinutes: body.minIntervalMinutes ?? existing.minIntervalMinutes,
        templateParams:
          body.templateParams === undefined ? existing.templateParams : body.templateParams,
      };
      const template = await validatePlanInput(merged, planSetIds(existing.templateParams));
      const plan = await prisma.evalPlan.update({
        where: { id },
        data: {
          name: body.name ?? undefined,
          description: body.description === undefined ? undefined : body.description,
          targetId: merged.targetId,
          cron: merged.cron,
          timezone: merged.timezone,
          minIntervalMinutes: merged.minIntervalMinutes,
          templateParams: template as Prisma.InputJsonValue,
        },
        include: planInclude,
      });
      await scheduler.sync(plan);
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'eval_plan.update',
        targetType: 'eval_plan',
        targetId: plan.id,
        detail: { changed: Object.keys(body), cron: plan.cron, timezone: plan.timezone },
      });
      return serializePlan(plan);
    },
  );

  app.post(
    '/:id/toggle',
    { preHandler: canCreate },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { enabled } = toggleBody.parse(request.body ?? {});
      const existing = await prisma.evalPlan.findUnique({ where: { id } });
      if (!existing) throw notFound('评估计划不存在');
      if (enabled) assertCronAllowed(existing.cron, existing.timezone, existing.minIntervalMinutes);
      const plan = await prisma.evalPlan.update({
        where: { id },
        data: { enabled },
        include: planInclude,
      });
      await scheduler.sync(plan);
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: enabled ? 'eval_plan.enable' : 'eval_plan.disable',
        targetType: 'eval_plan',
        targetId: plan.id,
        detail: { name: plan.name },
      });
      return serializePlan(plan);
    },
  );

  app.delete('/:id', { preHandler: canDelete }, async (request) => {
    const { id } = idParams.parse(request.params);
    const existing = await prisma.evalPlan.findUnique({
      where: { id },
      include: { _count: { select: { tasks: true } } },
    });
    if (!existing) throw notFound('评估计划不存在');
    // 历史任务保留（planId 置空），只删除计划与运行记录。
    await prisma.evalPlan.delete({ where: { id } });
    await scheduler.remove(id);
    await writeAudit({
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action: 'eval_plan.delete',
      targetType: 'eval_plan',
      targetId: id,
      detail: { name: existing.name, keptTaskCount: existing._count.tasks },
    });
    return { ok: true };
  });

  // CI 接口：API 令牌（scope eval-plans:trigger）或登录用户（eval_task:create）。
  // 跳过（上次未结束、间隔不足、已停用等）返回 409，便于 CI 用 curl -f 直接失败。
  app.post(
    '/:id/trigger',
    { preHandler: [requireApiTokenOrUser(EVAL_PLANS_TRIGGER_SCOPE, 'eval_task:create')] },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const exists = await prisma.evalPlan.count({ where: { id } });
      if (!exists) throw notFound('评估计划不存在');
      const token = request.apiToken;
      const result = await triggerEvalPlan(
        prisma,
        id,
        token
          ? { triggeredBy: 'ci', actorId: null, actorName: `api_token:${token.name}` }
          : {
              triggeredBy: 'manual',
              actorId: request.currentUser!.id,
              actorName: request.currentUser!.username,
            },
      );
      if (result.status === 'skipped') {
        reply.code(409);
        return {
          ...result,
          taskId: null,
          code: 'EVAL_PLAN_TRIGGER_SKIPPED',
          message: `本次触发已跳过：${result.reason ?? ''}`,
        };
      }
      return result;
    },
  );

  app.get('/:id/runs', { preHandler: canRead }, async (request) => {
    const { id } = idParams.parse(request.params);
    const q = runsQuery.parse(request.query);
    const exists = await prisma.evalPlan.count({ where: { id } });
    if (!exists) throw notFound('评估计划不存在');
    const [total, runs] = await Promise.all([
      prisma.evalPlanRun.count({ where: { planId: id } }),
      prisma.evalPlanRun.findMany({
        where: { planId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          task: {
            select: {
              id: true,
              name: true,
              status: true,
              passedCount: true,
              failedCount: true,
              errorCount: true,
              totalQuestions: true,
              finishedAt: true,
            },
          },
        },
      }),
    ]);
    return {
      items: runs.map((run) => ({
        id: run.id,
        triggeredBy: run.triggeredBy,
        status: run.status,
        reason: run.reason,
        createdAt: run.createdAt.toISOString(),
        task: run.task
          ? { ...run.task, finishedAt: run.task.finishedAt?.toISOString() ?? null }
          : null,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  });
}
