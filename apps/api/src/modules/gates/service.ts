import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { riskLevelsByTask } from '../eval-tasks/analytics.js';
import { evaluateGate } from '../eval-tasks/continuous-evaluation.js';
import { weightedScoresByTask } from '../../lib/weighted-score.js';

/** 门禁规则 JSON（存于 GateRule.rules）。失败率为 0–1 小数。 */
export const gateRulesSchema = z
  .object({
    minScore: z.number().min(0).max(100).optional(),
    maxHighRisk: z.number().int().min(0).max(100000).optional(),
    categoryMaxFailRate: z
      .record(z.string().trim().min(1).max(120), z.number().min(0).max(1))
      .optional()
      .refine((v) => !v || Object.keys(v).length <= 50, { message: '类别门槛最多 50 项' }),
    noRegression: z.boolean().optional(),
  })
  .strict()
  .refine(
    (r) =>
      r.minScore !== undefined ||
      r.maxHighRisk !== undefined ||
      Object.keys(r.categoryMaxFailRate ?? {}).length > 0 ||
      r.noRegression === true,
    { message: '至少配置一条门禁条件' },
  );
export type GateRulesJson = z.infer<typeof gateRulesSchema>;

export interface GateMetrics {
  score: number | null;
  highRiskCount: number;
  categoryFailureRates: Record<string, number>;
  previousScore: number | null;
}

type GateDb = Pick<PrismaClient, 'evalTask' | 'gateRule' | 'gateEvaluation' | '$queryRaw'>;

type CategoryRow = { category: string | null; passed: bigint; failed: bigint };

/** 分类失败率：FAIL / (PASS + FAIL)，未分类题目记为「未分类」（与任务对比口径一致）。 */
export async function categoryFailureRatesForTask(
  db: GateDb,
  taskId: string,
): Promise<Record<string, number>> {
  const rows = await db.$queryRaw<CategoryRow[]>(Prisma.sql`
    SELECT q."category" AS "category",
      COUNT(*) FILTER (WHERE r."finalVerdict" = 'PASS') AS "passed",
      COUNT(*) FILTER (WHERE r."finalVerdict" = 'FAIL') AS "failed"
    FROM "eval_results" r JOIN "questions" q ON q."id" = r."questionId"
    WHERE r."taskId" = ${taskId}
    GROUP BY q."category"`);
  const out: Record<string, number> = {};
  for (const row of rows) {
    const passed = Number(row.passed);
    const failed = Number(row.failed);
    if (passed + failed === 0) continue;
    const key = row.category || '未分类';
    out[key] = Math.round((failed / (passed + failed)) * 10000) / 10000;
  }
  return out;
}

type TaskScope = {
  id: string;
  modelTargetId: string;
  planId: string | null;
  finishedAt: Date | null;
  createdAt: Date;
};

function taskPlanId(task: object): string | null {
  const v = (task as { planId?: unknown }).planId;
  return typeof v === 'string' && v ? v : null;
}

/** 同一门禁范围内、早于本任务完成的上一次已完成任务。 */
async function findPreviousTask(
  db: GateDb,
  task: TaskScope,
  gate: { modelTargetId: string | null; planId: string | null },
  taskTenantId: string | null,
): Promise<string | null> {
  const where: Record<string, unknown> = {
    id: { not: task.id },
    status: 'COMPLETED',
    modelTargetId: gate.modelTargetId ?? task.modelTargetId,
  };
  // worker 里没有租户上下文，查询扩展不过滤：这里显式按任务租户限定。
  if (taskTenantId) where.tenantId = taskTenantId;
  if (gate.planId) where.planId = gate.planId;
  const pivot = task.finishedAt ?? task.createdAt;
  where.OR = [
    { finishedAt: { lt: pivot } },
    { finishedAt: null, createdAt: { lt: task.createdAt } },
  ];
  const prev = await db.evalTask.findFirst({
    where: where as Prisma.EvalTaskWhereInput,
    orderBy: [{ finishedAt: 'desc' }, { createdAt: 'desc' }],
    select: { id: true },
  });
  return prev?.id ?? null;
}

/**
 * 任务结束后按启用的门禁规则判定并存档。
 * 匹配：门禁的 modelTargetId / planId 为空视为不限；非空须与任务一致
 * （EvalTask 暂无 planId 字段时，配置了 planId 的门禁不会匹配任何任务）。
 * 同一门禁 × 任务重复判定时覆盖旧存档（任务重跑后结论以最新为准）。
 */
export async function evaluateGateForTask(
  taskId: string,
  db: GateDb = prisma,
): Promise<Array<{ gateId: string; passed: boolean; reasons: string[] }>> {
  const task = await db.evalTask.findUnique({ where: { id: taskId } });
  if (!task || task.status !== 'COMPLETED') return [];
  const planId = taskPlanId(task);
  // 任务所属租户：worker 判定时没有租户上下文，必须显式带上，否则会把别的租户的「不限对象」门禁捞进来。
  const taskTenantId = (task as { tenantId?: string | null }).tenantId ?? null;
  const gates = await db.gateRule.findMany({
    where: {
      enabled: true,
      ...(taskTenantId ? { tenantId: taskTenantId } : {}),
      AND: [
        { OR: [{ modelTargetId: null }, { modelTargetId: task.modelTargetId }] },
        planId ? { OR: [{ planId: null }, { planId }] } : { planId: null },
      ],
    },
    orderBy: { createdAt: 'asc' },
  });
  if (gates.length === 0) return [];

  const [scores, levels, categoryFailureRates] = await Promise.all([
    weightedScoresByTask([taskId]),
    riskLevelsByTask([taskId]),
    categoryFailureRatesForTask(db, taskId),
  ]);
  const score = scores.get(taskId) ?? null;
  const highRiskCount = levels.get(taskId)?.HIGH ?? 0;
  const scope: TaskScope = { ...task, planId };

  const out: Array<{ gateId: string; passed: boolean; reasons: string[] }> = [];
  for (const gate of gates) {
    const parsed = gateRulesSchema.safeParse(gate.rules);
    if (!parsed.success) continue;
    const rules = parsed.data;
    const previousTaskId = rules.noRegression
      ? await findPreviousTask(db, scope, gate, taskTenantId)
      : null;
    const previousScore = previousTaskId
      ? ((await weightedScoresByTask([previousTaskId])).get(previousTaskId) ?? null)
      : null;
    const result = evaluateGate({
      score,
      highRiskCount,
      categoryFailureRates,
      previousScore,
      rules: {
        minScore: rules.minScore,
        maxHighRiskCount: rules.maxHighRisk,
        categoryFailureRates: rules.categoryMaxFailRate,
        noRegression: rules.noRegression,
      },
    });
    const metrics: GateMetrics = { score, highRiskCount, categoryFailureRates, previousScore };
    await db.gateEvaluation.deleteMany({ where: { gateId: gate.id, taskId } });
    await db.gateEvaluation.create({
      data: {
        gateId: gate.id,
        taskId,
        passed: result.passed,
        reasons: result.reasons,
        metrics: metrics as unknown as Prisma.InputJsonValue,
        previousTaskId,
      },
    });
    out.push({ gateId: gate.id, ...result });
  }
  return out;
}

export interface FailingGateItem {
  gateId: string;
  gateName: string;
  modelTargetId: string | null;
  planId: string | null;
  taskId: string;
  taskName: string | null;
  reasons: string[];
  evaluatedAt: Date;
}

/** 启用门禁中最新一次判定未通过的项（未判定过的门禁不算），按判定时间倒序。 */
export async function listFailingGates(db: GateDb = prisma): Promise<FailingGateItem[]> {
  const gates = await db.gateRule.findMany({
    where: { enabled: true },
    select: { id: true, name: true, modelTargetId: true, planId: true },
  });
  if (gates.length === 0) return [];
  const rows = await db.gateEvaluation.findMany({
    where: { gateId: { in: gates.map((g) => g.id) } },
    orderBy: { createdAt: 'desc' },
    distinct: ['gateId'],
  });
  const latest = new Map(rows.map((r) => [r.gateId, r]));
  const failing = gates.filter((g) => latest.get(g.id)?.passed === false);
  const taskIds = [...new Set(failing.map((g) => latest.get(g.id)!.taskId))];
  const tasks = taskIds.length
    ? await db.evalTask.findMany({
        where: { id: { in: taskIds } },
        select: { id: true, name: true },
      })
    : [];
  const taskName = new Map(tasks.map((t) => [t.id, t.name]));
  return failing
    .map((g) => {
      const l = latest.get(g.id)!;
      return {
        gateId: g.id,
        gateName: g.name,
        modelTargetId: g.modelTargetId,
        planId: g.planId,
        taskId: l.taskId,
        taskName: taskName.get(l.taskId) ?? null,
        reasons: Array.isArray(l.reasons) ? (l.reasons as string[]) : [],
        evaluatedAt: l.createdAt,
      };
    })
    .sort((a, b) => b.evaluatedAt.getTime() - a.evaluatedAt.getTime());
}
