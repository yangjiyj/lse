import type { FastifyInstance } from 'fastify';
import { Prisma, type Severity } from '@prisma/client';
import { z } from 'zod';
import {
  EVAL_TASK_CATEGORIES,
  EVAL_TASK_CATEGORY_LABELS,
  classifyEvalTask,
  severityToRiskLevel,
  type RiskLevel,
} from '@lse/shared';
import { prisma } from '../../db.js';
import { weightedScoresByTask } from '../../lib/weighted-score.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { buildReadinessRow, type ReadinessTaskInput } from './readiness.js';
import { componentSecurityRoutes } from './component-security.js';
import { postureRoutes } from './posture.js';
import { modelFileTodos } from '../model-files/remediation.js';
import {
  VISIBLE_TARGET_WHERE,
  connectionIssueSummary,
  listConnectionIssueTargets,
} from './connection.js';
import { listFailingGates } from '../gates/service.js';
import { kindWhere } from '../question-sets/kind.js';
import { PENDING_REVIEW_STATUSES, pendingReviewFindingWhere } from './review-scope.js';
import { ruleLibraryStats } from './rule-library.js';
import { RiskCounter, detectRiskStats } from '../detect-risks/stats.js';
import { RISK_SOURCE_PERMISSIONS } from '../detect-risks/sources.js';

const overviewQuery = z.object({
  period: z.enum(['month', '7d', 'all']).default('month'),
});

const HIGH_SEVERITIES: Severity[] = ['CRITICAL', 'HIGH'];
const TREND_DAYS = 14;

export function periodStart(period: 'month' | '7d' | 'all', now: Date): Date | null {
  if (period === 'all') return null;
  if (period === '7d') return new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  // 本月：按东八区自然月
  const shifted = new Date(now.getTime() + 8 * 3600 * 1000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - 8 * 3600 * 1000);
}

function dayKey(date: Date): string {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 按任务聚合高/中/低风险发现数。 */
async function riskCountsByTask(taskIds: string[]) {
  const map = new Map<string, Record<RiskLevel, number>>();
  if (taskIds.length === 0) return map;
  const rows = await prisma.finding.groupBy({
    by: ['taskId', 'severity'],
    where: { taskId: { in: taskIds }, severity: { not: null } },
    _count: { _all: true },
  });
  for (const row of rows) {
    const bucket = map.get(row.taskId) ?? { HIGH: 0, MEDIUM: 0, LOW: 0 };
    bucket[severityToRiskLevel(row.severity!)] += row._count._all;
    map.set(row.taskId, bucket);
  }
  return map;
}

/** 近 14 天每日新建任务数与完成数（任务评估情况统计图 · 按日）。 */
async function taskTrend(now: Date) {
  const since = new Date(now.getTime() - (TREND_DAYS - 1) * 24 * 3600 * 1000);
  const sinceDay = new Date(`${dayKey(since)}T00:00:00+08:00`);
  const tasks = await prisma.evalTask.findMany({
    where: { createdAt: { gte: sinceDay } },
    select: { createdAt: true, status: true },
  });
  const days = new Map<
    string,
    { date: string; created: number; completed: number; failed: number }
  >();
  for (let i = 0; i < TREND_DAYS; i += 1) {
    const key = dayKey(new Date(sinceDay.getTime() + i * 24 * 3600 * 1000));
    days.set(key, { date: key, created: 0, completed: 0, failed: 0 });
  }
  for (const t of tasks) {
    const bucket = days.get(dayKey(t.createdAt));
    if (!bucket) continue;
    bucket.created += 1;
    if (t.status === 'COMPLETED') bucket.completed += 1;
    if (t.status === 'FAILED') bucket.failed += 1;
  }
  return [...days.values()];
}

/** 最近任务列表 + 检测流程就绪表（最近 8 个任务）。 */
async function recentAndReadiness() {
  const tasks = await prisma.evalTask.findMany({
    orderBy: [{ createdAt: 'desc' }],
    take: 8,
    select: {
      id: true,
      tenantId: true,
      name: true,
      status: true,
      engines: true,
      dimensions: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
      totalQuestions: true,
      modelTargetId: true,
      modelTarget: { select: { name: true, isActive: true, lastTestStatus: true } },
      _count: { select: { questionSets: true, reports: true, findings: true } },
    },
  });
  const ids = tasks.map((t) => t.id);
  const pending = ids.length
    ? await prisma.finding.groupBy({
        by: ['taskId'],
        where: { taskId: { in: ids }, reviewStatus: { in: [...PENDING_REVIEW_STATUSES] } },
        _count: { _all: true },
      })
    : [];
  const pendingMap = new Map(pending.map((p) => [p.taskId, p._count._all]));

  const recentTasks = tasks.map((t) => {
    const category = classifyEvalTask(t);
    return {
      id: t.id,
      tenantId: t.tenantId ?? null,
      name: t.name,
      category,
      categoryLabel: EVAL_TASK_CATEGORY_LABELS[category],
      status: t.status,
      modelName: t.modelTarget?.name ?? null,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
    };
  });
  const readiness = tasks.map((t) =>
    buildReadinessRow({
      id: t.id,
      name: t.name,
      status: t.status,
      startedAt: t.startedAt,
      totalQuestions: t.totalQuestions,
      questionSetCount: t._count.questionSets,
      reportCount: t._count.reports,
      findingCount: t._count.findings,
      pendingReviewCount: pendingMap.get(t.id) ?? 0,
      modelTargetId: t.modelTargetId,
      modelTarget: t.modelTarget,
    } satisfies ReadinessTaskInput),
  );
  return { recentTasks, readiness };
}

/** 高危评估任务 TOP5：按高风险（CRITICAL/HIGH）发现数降序，同数按创建时间倒序。 */
async function topHighRiskTasks(periodWhere: Prisma.EvalTaskWhereInput) {
  const grouped = await prisma.finding.groupBy({
    by: ['taskId'],
    where: { severity: { in: HIGH_SEVERITIES }, task: periodWhere },
    _count: { _all: true },
    orderBy: { _count: { taskId: 'desc' } },
    take: 20,
  });
  if (grouped.length === 0) return [];
  const tasks = await prisma.evalTask.findMany({
    where: { id: { in: grouped.map((g) => g.taskId) } },
    select: {
      id: true,
      name: true,
      status: true,
      createdAt: true,
      passedCount: true,
      failedCount: true,
      modelTarget: { select: { name: true } },
    },
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ids = tasks.map((t) => t.id);
  const [risk, scores] = await Promise.all([riskCountsByTask(ids), weightedScoresByTask(ids)]);
  return grouped
    .map((g) => ({ g, t: byId.get(g.taskId) }))
    .filter((x): x is { g: (typeof grouped)[number]; t: (typeof tasks)[number] } => Boolean(x.t))
    .sort(
      (a, b) =>
        b.g._count._all - a.g._count._all || b.t.createdAt.getTime() - a.t.createdAt.getTime(),
    )
    .slice(0, 5)
    .map(({ g, t }) => {
      const levels = risk.get(t.id) ?? { HIGH: 0, MEDIUM: 0, LOW: 0 };
      return {
        id: t.id,
        name: t.name,
        status: t.status,
        modelName: t.modelTarget?.name ?? null,
        createdAt: t.createdAt,
        highRiskCount: g._count._all,
        mediumRiskCount: levels.MEDIUM,
        lowRiskCount: levels.LOW,
        // 综合评估得分：与任务列表/详情同一口径（配置管理权重）；评估不完整时为 null。
        evalScore: scores.get(t.id) ?? null,
      };
    });
}

const SEVERITY_RANK: Record<Severity, number> = {
  INFO: 1,
  LOW: 2,
  MEDIUM: 3,
  HIGH: 4,
  CRITICAL: 5,
};

const todosQuery = z.object({
  reviewTaskPage: z.coerce.number().int().min(1).default(1),
  reviewTaskPageSize: z.coerce.number().int().min(1).max(200).default(20),
});

/**
 * 待复核待办：口径取自 review-scope.ts（与首页卡片、风险处置台同一份条件）。
 * 按任务分组，每个任务的数量是该任务真实待复核数（不是截断后的数）；
 * 列出全部有待复核的任务并分页，不再「只取最近 10 条风险项再合并」。
 * 返回里保留旧字段 items（最近 10 条，向后兼容）。
 */
async function pendingReviewTodos(page: number, pageSize: number) {
  const where = pendingReviewFindingWhere();
  const [groups, recent] = await Promise.all([
    prisma.finding.groupBy({
      by: ['taskId'],
      where,
      _count: { _all: true },
      _max: { createdAt: true, severity: true },
    }),
    prisma.finding.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        tenantId: true,
        taskId: true,
        title: true,
        severity: true,
        createdAt: true,
        task: { select: { name: true } },
      },
    }),
  ]);
  const count = groups.reduce((sum, g) => sum + g._count._all, 0);
  const ordered = [...groups].sort(
    (a, b) =>
      (b._max.severity ? SEVERITY_RANK[b._max.severity] : 0) -
        (a._max.severity ? SEVERITY_RANK[a._max.severity] : 0) ||
      b._count._all - a._count._all ||
      (b._max.createdAt?.getTime() ?? 0) - (a._max.createdAt?.getTime() ?? 0) ||
      a.taskId.localeCompare(b.taskId),
  );
  const pageGroups = ordered.slice((page - 1) * pageSize, page * pageSize);
  const pageIds = pageGroups.map((g) => g.taskId);
  const [tasks, titleRows] = pageIds.length
    ? await Promise.all([
        prisma.evalTask.findMany({
          where: { id: { in: pageIds } },
          select: { id: true, name: true, tenantId: true },
        }),
        prisma.finding.groupBy({
          by: ['taskId', 'title'],
          where: { AND: [where, { taskId: { in: pageIds } }] },
          _max: { severity: true },
        }),
      ])
    : [[], []];
  const nameById = new Map(tasks.map((t) => [t.id, t.name]));
  const tenantById = new Map(tasks.map((t) => [t.id, t.tenantId ?? null]));
  const titlesByTask = new Map<string, Array<{ title: string | null; rank: number }>>();
  for (const row of titleRows) {
    const list = titlesByTask.get(row.taskId) ?? [];
    list.push({ title: row.title, rank: row._max.severity ? SEVERITY_RANK[row._max.severity] : 0 });
    titlesByTask.set(row.taskId, list);
  }
  return {
    count,
    items: recent.map((f) => ({
      id: f.id,
      tenantId: f.tenantId ?? null,
      taskId: f.taskId,
      taskName: f.task.name,
      title: f.title,
      severity: f.severity,
      createdAt: f.createdAt,
    })),
    tasks: pageGroups.map((g) => ({
      taskId: g.taskId,
      tenantId: tenantById.get(g.taskId) ?? null,
      taskName: nameById.get(g.taskId) ?? '评估任务',
      count: g._count._all,
      topSeverity: g._max.severity,
      latestAt: g._max.createdAt,
      titles: (titlesByTask.get(g.taskId) ?? [])
        .sort((a, b) => b.rank - a.rank)
        .map((t) => t.title ?? '风险发现')
        .slice(0, 20),
    })),
    taskTotal: groups.length,
    taskPage: page,
    taskPageSize: pageSize,
  };
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  await app.register(componentSecurityRoutes);
  await app.register(postureRoutes);

  app.get('/todos', { preHandler: [requirePermission('eval_task:read')] }, async (request) => {
    const user = request.currentUser!;
    const canReadRemediation = user.permissions.has('remediation:read');
    const canReadTargets = user.permissions.has('model_target:read');
    const canReadGates = user.permissions.has('gate:read') || user.permissions.has('gate:manage');
    const paging = todosQuery.parse(request.query);
    // 打开首页/我的待办是纯读取，不写审计（审计只留关键操作，避免被「查看待办」淹没）。
    const now = new Date();
    const dueLimit = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const [
      reviewBlock,
      remediationRows,
      remediationCount,
      connectionRows,
      connectionSummary,
      failingGates,
    ] = await Promise.all([
      pendingReviewTodos(paging.reviewTaskPage, paging.reviewTaskPageSize),
      canReadRemediation
        ? prisma.finding.findMany({
            where: {
              remediationDueAt: { lte: dueLimit },
              remediationStatus: { notIn: ['VERIFIED_CLOSED', 'NOT_APPLICABLE'] },
            },
            orderBy: { remediationDueAt: 'asc' },
            take: 10,
            select: {
              id: true,
              tenantId: true,
              taskId: true,
              title: true,
              severity: true,
              remediationDueAt: true,
              task: { select: { name: true } },
            },
          })
        : Promise.resolve([]),
      canReadRemediation
        ? prisma.finding.count({
            where: {
              remediationDueAt: { lte: dueLimit },
              remediationStatus: { notIn: ['VERIFIED_CLOSED', 'NOT_APPLICABLE'] },
            },
          })
        : Promise.resolve(0),
      canReadTargets ? listConnectionIssueTargets(10) : Promise.resolve([]),
      canReadTargets ? connectionIssueSummary() : Promise.resolve({ count: 0, untestedCount: 0 }),
      canReadGates ? listFailingGates() : Promise.resolve([]),
    ]);
    return {
      review: reviewBlock,
      remediation: {
        count: remediationCount,
        items: remediationRows.map((f) => ({
          id: f.id,
          tenantId: f.tenantId ?? null,
          taskId: f.taskId,
          taskName: f.task.name,
          title: f.title,
          severity: f.severity,
          dueAt: f.remediationDueAt,
          overdue: f.remediationDueAt! < now,
        })),
      },
      connection: {
        count: connectionSummary.count,
        items: connectionRows.map((t) => ({
          targetId: t.id,
          tenantId: t.tenantId ?? null,
          targetName: t.name,
          active: t.isActive,
          lastTestStatus: t.lastTestStatus,
          lastTestedAt: t.lastTestedAt,
        })),
      },
      gate: { count: failingGates.length, items: failingGates.slice(0, 10) },
      // 模型文件扫描发现（不挂评估任务，单独成组，不混入 review/remediation 计数）
      modelFile: await modelFileTodos(canReadRemediation),
      gates: {
        remediation: canReadRemediation,
        connection: canReadTargets,
        planning: canReadGates,
      },
    };
  });

  // 规则库统计（2.2.1）：不随统计周期变化，单独一个接口，前端缓存键不带周期；服务端按租户范围缓存 60 秒。
  app.get('/rule-library', { preHandler: [requirePermission('eval_task:read')] }, async () =>
    ruleLibraryStats(),
  );

  // 四类风险（2.2.2）：口径见 docs/detect-risk-categories.md；有任一来源的权限即可看，没权限的来源为 null。
  app.get(
    '/detect-risks',
    { preHandler: [requirePermission(...RISK_SOURCE_PERMISSIONS)] },
    async (request) => {
      const { period } = overviewQuery.parse(request.query);
      const start = periodStart(period, new Date());
      const perms = request.currentUser!.permissions;
      const counter = new RiskCounter({ since: start, until: null });
      const stats = await detectRiskStats((code) => perms.has(code), counter);
      return { period, periodStart: start, ...stats };
    },
  );

  app.get('/overview', { preHandler: [requirePermission('eval_task:read')] }, async (request) => {
    const { period } = overviewQuery.parse(request.query);
    const canReadTargets = request.currentUser!.permissions.has('model_target:read');
    const now = new Date();
    const start = periodStart(period, now);
    const periodWhere: Prisma.EvalTaskWhereInput = start ? { createdAt: { gte: start } } : {};

    const [
      taskTotal,
      modelTargetCount,
      ownQuestionSetCount,
      runQuestionSetCount,
      periodTasks,
      statusGroups,
    ] = await Promise.all([
      prisma.evalTask.count(),
      // 与评估对象页同口径：不含 JUDGE（系统判定模型）。
      prisma.modelTarget.count({ where: VISIBLE_TARGET_WHERE }),
      // 与样本库页「自有样本库」同口径（question-sets/kind.ts）；运行记录不算自有。
      prisma.questionSet.count({ where: kindWhere('own') }),
      prisma.questionSet.count({ where: kindWhere('run') }),
      prisma.evalTask.findMany({
        where: periodWhere,
        select: { id: true, engines: true, dimensions: true },
      }),
      prisma.evalTask.groupBy({
        by: ['status'],
        where: periodWhere,
        _count: { _all: true },
      }),
    ]);

    const categoryCounts = new Map<string, number>();
    for (const t of periodTasks) {
      const c = classifyEvalTask(t);
      categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1);
    }
    const categories = EVAL_TASK_CATEGORIES.map((category) => ({
      category,
      label: EVAL_TASK_CATEGORY_LABELS[category],
      count: categoryCounts.get(category) ?? 0,
    }));

    // 高/中/低风险回复分布（本期任务产生的风险发现）
    const severityGroups = await prisma.finding.groupBy({
      by: ['severity'],
      where: { task: periodWhere, severity: { not: null } },
      _count: { _all: true },
    });
    const riskDistribution: Record<RiskLevel, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const g of severityGroups) {
      riskDistribution[severityToRiskLevel(g.severity!)] += g._count._all;
    }

    // 工具数（2.2.1）：当前用户在工具中心能看到的工具（平台级，不分租户）；隐藏的只有 tool:manage 算。
    const perms = request.currentUser!.permissions;
    const tools = perms.has('tool:read')
      ? await prisma.tool.count({ where: perms.has('tool:manage') ? {} : { hidden: false } })
      : null;

    return {
      period,
      periodStart: start,
      counts: {
        taskTotal,
        periodTaskCount: periodTasks.length,
        modelTargetCount,
        ownQuestionSetCount,
        runQuestionSetCount,
        tools,
      },
      categories,
      riskDistribution,
      taskStatus: statusGroups.map((g) => ({ status: g.status, count: g._count._all })),
      taskTrend: await taskTrend(now),
      // 接入异常：与 /dashboard/todos 同一共享口径（按不重复评估对象）
      connectionIssues: canReadTargets ? await connectionIssueSummary() : null,
      ...(await recentAndReadiness()),
      topHighRiskTasks: await topHighRiskTasks(periodWhere),
    };
  });
}
