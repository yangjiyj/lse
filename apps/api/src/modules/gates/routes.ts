import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { GATES_READ_SCOPE, requireApiTokenOrUser } from '../../plugins/api-token-auth.js';
import { gateRulesSchema, listFailingGates } from './service.js';
import { statisticsFromTaskRow } from '../../lib/eval-statistics.js';

const idParams = z.object({ id: z.string().uuid() });

const gateBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    modelTargetId: z.string().uuid().nullable().optional(),
    planId: z.string().trim().min(1).max(100).nullable().optional(),
    rules: gateRulesSchema,
    enabled: z.boolean().default(true),
  })
  .refine((b) => Boolean(b.modelTargetId || b.planId), {
    message: '请指定门禁适用的评估对象或评估计划',
  });

const patchBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  modelTargetId: z.string().uuid().nullable().optional(),
  planId: z.string().trim().min(1).max(100).nullable().optional(),
  rules: gateRulesSchema.optional(),
  enabled: z.boolean().optional(),
});

type EvalRow = {
  id: string;
  gateId: string;
  taskId: string;
  passed: boolean;
  reasons: Prisma.JsonValue;
  metrics: Prisma.JsonValue;
  previousTaskId: string | null;
  createdAt: Date;
};

function serializeEvaluation(row: EvalRow) {
  return {
    id: row.id,
    gateId: row.gateId,
    taskId: row.taskId,
    passed: row.passed,
    reasons: Array.isArray(row.reasons) ? row.reasons : [],
    metrics: row.metrics ?? null,
    previousTaskId: row.previousTaskId,
    createdAt: row.createdAt,
  };
}

async function assertTargetExists(modelTargetId: string | null | undefined): Promise<void> {
  if (!modelTargetId) return;
  const t = await prisma.modelTarget.findUnique({
    where: { id: modelTargetId },
    select: { id: true },
  });
  if (!t) throw badRequest('评估对象不存在');
}

async function assertPlanExists(planId: string | null | undefined): Promise<void> {
  if (!planId) return;
  const p = await prisma.evalPlan.findUnique({ where: { id: planId }, select: { id: true } });
  if (!p) throw badRequest('评估计划不存在', 'EVAL_PLAN_NOT_FOUND');
}

async function latestByGate(gateIds: string[]): Promise<Map<string, EvalRow>> {
  const map = new Map<string, EvalRow>();
  if (gateIds.length === 0) return map;
  const rows = await prisma.gateEvaluation.findMany({
    where: { gateId: { in: gateIds } },
    orderBy: { createdAt: 'desc' },
    distinct: ['gateId'],
  });
  for (const r of rows) map.set(r.gateId, r);
  return map;
}

type GateTaskInfo = {
  name: string;
  status: string;
  sampleSize: number;
  /** 样本量警告（仅展示，不参与门禁判定）；样本充足时为 null */
  sampleWarning: string | null;
};

async function taskNames(taskIds: string[]): Promise<Map<string, GateTaskInfo>> {
  if (taskIds.length === 0) return new Map();
  const rows = await prisma.evalTask.findMany({
    where: { id: { in: taskIds } },
    select: {
      id: true,
      name: true,
      status: true,
      processedQuestions: true,
      passedCount: true,
      failedCount: true,
      errorCount: true,
    },
  });
  return new Map(
    rows.map((r) => {
      const s = statisticsFromTaskRow(r);
      return [
        r.id,
        {
          name: r.name,
          status: r.status,
          sampleSize: s.sampleSize,
          sampleWarning: s.warnings[0] ?? null,
        },
      ];
    }),
  );
}

export async function gateRoutes(app: FastifyInstance): Promise<void> {
  // 注意：本插件不全局挂 authenticate —— /:id/latest 需允许 API 令牌访问。
  const canRead = [authenticate, requirePermission('gate:read', 'gate:manage')];
  const canManage = [authenticate, requirePermission('gate:manage')];

  app.get('/', { preHandler: canRead }, async () => {
    const gates = await prisma.gateRule.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const latest = await latestByGate(gates.map((g) => g.id));
    const targetIds = [
      ...new Set(gates.map((g) => g.modelTargetId).filter((v): v is string => !!v)),
    ];
    const targets = targetIds.length
      ? await prisma.modelTarget.findMany({
          where: { id: { in: targetIds } },
          select: { id: true, name: true },
        })
      : [];
    const targetName = new Map(targets.map((t) => [t.id, t.name]));
    const tasks = await taskNames([...latest.values()].map((e) => e.taskId));
    return {
      items: gates.map((g) => {
        const l = latest.get(g.id);
        return {
          ...g,
          modelTargetName: g.modelTargetId ? (targetName.get(g.modelTargetId) ?? null) : null,
          latest: l
            ? {
                ...serializeEvaluation(l),
                taskName: tasks.get(l.taskId)?.name ?? null,
                sampleSize: tasks.get(l.taskId)?.sampleSize ?? null,
                sampleWarning: tasks.get(l.taskId)?.sampleWarning ?? null,
              }
            : null,
        };
      }),
    };
  });

  // 工作台“我的待办 · 门禁未过”：最新一次判定未通过的启用门禁。
  app.get('/failing', { preHandler: canRead }, async () => {
    const items = await listFailingGates();
    return { total: items.length, items };
  });

  // CI 接口：按任务查门禁判定 + 任务状态，供流水线轮询（API 令牌 scope gates:read）。
  // 注册在 /:id/... 之前无冲突（段数不同），仍放在最前以免被误匹配。
  app.get(
    '/evaluations/by-task/:taskId',
    { preHandler: [requireApiTokenOrUser(GATES_READ_SCOPE, 'gate:read', 'gate:manage')] },
    async (request) => {
      const { taskId } = z.object({ taskId: z.string().uuid() }).parse(request.params);
      const task = await prisma.evalTask.findUnique({
        where: { id: taskId },
        select: {
          id: true,
          name: true,
          status: true,
          finishedAt: true,
          totalQuestions: true,
          processedQuestions: true,
          passedCount: true,
          failedCount: true,
          errorCount: true,
        },
      });
      if (!task) throw notFound('评估任务不存在');
      const rows = await prisma.gateEvaluation.findMany({
        where: { taskId },
        orderBy: { createdAt: 'desc' },
        include: { gate: { select: { name: true, enabled: true } } },
      });
      const seen = new Set<string>();
      const items = rows
        .filter((r) => (seen.has(r.gateId) ? false : (seen.add(r.gateId), true)))
        .map((r) => ({
          ...serializeEvaluation(r),
          gateName: r.gate.name,
        }));
      return {
        taskId: task.id,
        taskName: task.name,
        taskStatus: task.status,
        finishedAt: task.finishedAt,
        totalQuestions: task.totalQuestions,
        processedQuestions: task.processedQuestions,
        passedCount: task.passedCount,
        failedCount: task.failedCount,
        errorCount: task.errorCount,
        evaluated: items.length > 0,
        passed: items.length === 0 ? null : items.every((i) => i.passed),
        items,
      };
    },
  );

  app.post('/', { preHandler: canManage }, async (request, reply) => {
    const body = gateBody.parse(request.body);
    await assertTargetExists(body.modelTargetId);
    await assertPlanExists(body.planId);
    const user = request.currentUser!;
    const gate = await prisma.gateRule.create({
      data: {
        name: body.name,
        modelTargetId: body.modelTargetId ?? null,
        planId: body.planId ?? null,
        rules: body.rules as Prisma.InputJsonValue,
        enabled: body.enabled,
        createdById: user.id,
      },
    });
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'gate.create',
      targetType: 'gate_rule',
      targetId: gate.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      detail: {
        name: gate.name,
        modelTargetId: gate.modelTargetId,
        planId: gate.planId,
        rules: body.rules,
      },
    });
    reply.code(201);
    return gate;
  });

  app.patch('/:id', { preHandler: canManage }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = patchBody.parse(request.body);
    const existing = await prisma.gateRule.findUnique({ where: { id } });
    if (!existing) throw notFound('门禁不存在');
    await assertTargetExists(body.modelTargetId);
    await assertPlanExists(body.planId);
    const nextTarget =
      body.modelTargetId !== undefined ? body.modelTargetId : existing.modelTargetId;
    const nextPlan = body.planId !== undefined ? body.planId : existing.planId;
    if (!nextTarget && !nextPlan) throw badRequest('请指定门禁适用的评估对象或评估计划');
    const gate = await prisma.gateRule.update({
      where: { id },
      data: {
        name: body.name,
        modelTargetId: body.modelTargetId,
        planId: body.planId,
        rules: body.rules as Prisma.InputJsonValue | undefined,
        enabled: body.enabled,
      },
    });
    const user = request.currentUser!;
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'gate.update',
      targetType: 'gate_rule',
      targetId: id,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      detail: { changes: body },
    });
    return gate;
  });

  app.delete('/:id', { preHandler: canManage }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const existing = await prisma.gateRule.findUnique({ where: { id } });
    if (!existing) throw notFound('门禁不存在');
    await prisma.gateRule.delete({ where: { id } });
    const user = request.currentUser!;
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'gate.delete',
      targetType: 'gate_rule',
      targetId: id,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      detail: { name: existing.name },
    });
    reply.code(204);
  });

  app.get('/:id/evaluations', { preHandler: canRead }, async (request) => {
    const { id } = idParams.parse(request.params);
    const gate = await prisma.gateRule.findUnique({ where: { id }, select: { id: true } });
    if (!gate) throw notFound('门禁不存在');
    const rows = await prisma.gateEvaluation.findMany({
      where: { gateId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const tasks = await taskNames(rows.map((r) => r.taskId));
    return {
      items: rows.map((r) => ({
        ...serializeEvaluation(r),
        taskName: tasks.get(r.taskId)?.name ?? null,
        sampleSize: tasks.get(r.taskId)?.sampleSize ?? null,
        sampleWarning: tasks.get(r.taskId)?.sampleWarning ?? null,
      })),
    };
  });

  // CI 接口：API 令牌（scope gates:read）或登录用户（gate:read）。
  app.get(
    '/:id/latest',
    { preHandler: [requireApiTokenOrUser(GATES_READ_SCOPE, 'gate:read', 'gate:manage')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const gate = await prisma.gateRule.findUnique({
        where: { id },
        select: { id: true, name: true, enabled: true },
      });
      if (!gate) throw notFound('门禁不存在');
      const latest = await prisma.gateEvaluation.findFirst({
        where: { gateId: id },
        orderBy: { createdAt: 'desc' },
      });
      if (!latest) {
        return {
          gateId: gate.id,
          gateName: gate.name,
          enabled: gate.enabled,
          evaluated: false,
          passed: null,
          reasons: [],
          taskId: null,
          evaluatedAt: null,
        };
      }
      const e = serializeEvaluation(latest);
      return {
        gateId: gate.id,
        gateName: gate.name,
        enabled: gate.enabled,
        evaluated: true,
        passed: e.passed,
        reasons: e.reasons,
        taskId: e.taskId,
        previousTaskId: e.previousTaskId,
        metrics: e.metrics,
        evaluatedAt: e.createdAt,
      };
    },
  );
}
