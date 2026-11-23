import type { FastifyInstance } from 'fastify';
import { Prisma, type Severity } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/auth.js';
import { rateOverallRisk, type OverallRiskLevel } from '../../lib/risk-rating.js';
import { resolveReportRiskDomain, riskDomainLabel, riskLabel } from '../reports/labels.js';
import {
  createdAtFilter,
  lastDayKeys,
  resolveRange,
  type PostureRange,
  type Window,
} from './posture-range.js';
import { NON_EXECUTED_TASK_STATUSES, pendingReviewFindingWhere } from './review-scope.js';
import { currentTenantId } from '../../lib/tenant-context.js';

/**
 * 原始 SQL（$queryRaw）不经过租户查询扩展，跨任务统计必须自己带租户条件。
 * 没有租户上下文（worker、种子、直接调函数的测试）时保持全平台口径。
 */
function tenantSql(column = '"tenantId"'): Prisma.Sql {
  const tenantId = currentTenantId();
  return tenantId ? Prisma.sql`AND ${Prisma.raw(column)} = ${tenantId}` : Prisma.empty;
}

/**
 * 首页「安全态势」后端数据接口（纯增量，不改 /overview、/todos）。
 * 原则：只返回能由真实数据如实计算的内容；算不出就返回 null 并说明原因。
 * 口径详见 docs/dashboard-api.md。
 */

const rangeSchema = z.enum(['month', '7d', 'all']).default('month');
const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

type SeverityCountMap = Record<Severity, number>;
const emptySeverity = (): SeverityCountMap => ({
  CRITICAL: 0,
  HIGH: 0,
  MEDIUM: 0,
  LOW: 0,
  INFO: 0,
});

/** 计入统计的「风险回复」：有严重度，且未被人工复核判为误报。 */
const ACTIVE_FINDING: Prisma.FindingWhereInput = {
  severity: { not: null },
  reviewStatus: { not: 'FALSE_POSITIVE' },
};

function taskScope(w: Window): Prisma.EvalTaskWhereInput {
  return { createdAt: createdAtFilter(w) };
}

async function severityByWindow(w: Window): Promise<SeverityCountMap> {
  const rows = await prisma.finding.groupBy({
    by: ['severity'],
    where: { ...ACTIVE_FINDING, createdAt: createdAtFilter(w) },
    _count: { _all: true },
  });
  const out = emptySeverity();
  for (const r of rows) if (r.severity) out[r.severity] += r._count._all;
  return out;
}

const sum = (c: SeverityCountMap) => SEVERITIES.reduce((a, s) => a + c[s], 0);

// ───────────────────────────── 安全态势 ─────────────────────────────

const LEVEL_LABELS: Record<OverallRiskLevel, string> = {
  HIGH: '高',
  MEDIUM_HIGH: '中高',
  MEDIUM: '中',
  LOW: '低',
  UNRATED: '暂无法评级',
};

export async function buildPosture(range: PostureRange, now: Date) {
  const { current } = resolveRange(range, now);
  const scope = taskScope(current);

  const [taskGroups, taskSums, findingGroups, pendingAll, pendingInRange] = await Promise.all([
    prisma.evalTask.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
    prisma.evalTask.aggregate({
      where: scope,
      _sum: { totalQuestions: true, passedCount: true, failedCount: true },
    }),
    prisma.finding.groupBy({
      by: ['severity', 'reviewStatus'],
      where: { severity: { not: null }, task: scope },
      _count: { _all: true },
    }),
    // 待复核两个数都走共享口径（review-scope.ts），与我的待办、风险处置台同一个数。
    prisma.finding.count({ where: pendingReviewFindingWhere() }),
    prisma.finding.count({ where: pendingReviewFindingWhere(scope) }),
  ]);

  const tasksInitiated = taskGroups.reduce((a, g) => a + g._count._all, 0);
  const tasksCompleted = taskGroups.find((g) => g.status === 'COMPLETED')?._count._all ?? 0;

  const active = emptySeverity();
  let findingTotal = 0;
  let falsePositive = 0;
  for (const g of findingGroups) {
    const n = g._count._all;
    findingTotal += n;
    if (g.reviewStatus === 'FALSE_POSITIVE') {
      falsePositive += n;
      continue;
    }
    active[g.severity!] += n;
  }
  const activeTotal = sum(active);

  const total = taskSums._sum.totalQuestions ?? 0;
  const valid = (taskSums._sum.passedCount ?? 0) + (taskSums._sum.failedCount ?? 0);

  let riskLevel: OverallRiskLevel;
  let score: number | null;
  let levelBasis: string;
  let fewValid = false;
  if (tasksInitiated === 0 || (total === 0 && activeTotal === 0)) {
    // 没有任何评估数据：不能说「低风险」，如实暂无法评级。
    riskLevel = 'UNRATED';
    score = null;
    levelBasis = tasksInitiated === 0 ? '所选范围内暂无评估任务' : '所选范围内暂无有效判定结果';
  } else {
    // 与评估报告同一套规则（lib/risk-rating.ts）；评分不计「引擎跳过」覆盖扣分（该项为单任务口径）。
    const rating = rateOverallRisk({
      critical: active.CRITICAL,
      high: active.HIGH,
      medium: active.MEDIUM,
      low: active.LOW + active.INFO,
      total,
      valid,
    });
    riskLevel = rating.level;
    score = rating.score;
    levelBasis = rating.reason;
    fewValid = rating.fewValid;
  }

  return {
    range,
    periodStart: current.start,
    riskLevel,
    riskLevelLabel: LEVEL_LABELS[riskLevel],
    score,
    levelBasis,
    fewValid,
    scoreBasis:
      'risk-score-v1：按严重度加权扣分（严重30/高20/中10/低4/信息1，扣分封顶80），不含引擎跳过覆盖扣分',
    severityCounts: active,
    facts: {
      tasksInitiated,
      tasksCompleted,
      /** 本期任务产生的全部风险回复（与首页 /overview 的 riskDistribution 同口径，含误报）。 */
      findingTotal,
      /** 扣除人工复核判定为误报后的风险回复数（评级与评分所用）。 */
      activeFindingTotal: activeTotal,
      falsePositiveExcluded: falsePositive,
      highCount: active.CRITICAL + active.HIGH,
      criticalCount: active.CRITICAL,
      /** 本期任务的待复核风险回复（UNREVIEWED + NEEDS_REVIEW，排除失败/已取消任务）。 */
      pendingReview: pendingInRange,
      /** 全库待复核总数（与 /dashboard/todos 的 review.count 同口径）。 */
      pendingReviewTotal: pendingAll,
      testItems: total,
      validJudgements: valid,
    },
  };
}

// ───────────────────────────── 趋势 ─────────────────────────────

interface TrendRow {
  d: string;
  findings: number;
  high: number;
  pending: number;
}

export async function buildTrend(days: number, now: Date) {
  const { keys, since } = lastDayKeys(days, now);
  // 北京时间自然日（东八区无夏令时，+8h 后取日期）；走 findings(createdAt) 索引范围扫描，库内聚合。
  const rows = await prisma.$queryRaw<TrendRow[]>(Prisma.sql`
    SELECT to_char(("createdAt" + interval '8 hours')::date, 'YYYY-MM-DD') AS d,
           count(*)::int AS findings,
           (count(*) FILTER (WHERE severity IN ('CRITICAL','HIGH')))::int AS high,
           (count(*) FILTER (
              WHERE "reviewStatus" IN ('UNREVIEWED','NEEDS_REVIEW')
                AND "taskId" NOT IN (SELECT id FROM eval_tasks WHERE status::text IN (${Prisma.join([...NON_EXECUTED_TASK_STATUSES])}))
           ))::int AS pending
    FROM findings
    WHERE "createdAt" >= ${since} AND "createdAt" < ${now}
      AND severity IS NOT NULL AND "reviewStatus" <> 'FALSE_POSITIVE'
      ${tenantSql()}
    GROUP BY 1`);
  const byDay = new Map(rows.map((r) => [r.d, r]));
  const points = keys.map((date) => {
    const r = byDay.get(date);
    return {
      date,
      findings: r?.findings ?? 0,
      high: r?.high ?? 0,
      /** 当日新建的风险回复中「当前仍待复核」的数量（不是当日的待复核存量）。 */
      pendingReview: r?.pending ?? 0,
    };
  });
  return { days, timezone: 'Asia/Shanghai', from: keys[0], to: keys[keys.length - 1], points };
}

// ───────────────────────────── 风险类别 Top N ─────────────────────────────

export async function buildRiskCategories(limit: number, range: PostureRange, now: Date) {
  const { current } = resolveRange(range, now);
  const rows = await prisma.finding.groupBy({
    by: ['riskCategory', 'engine', 'severity'],
    where: { ...ACTIVE_FINDING, task: taskScope(current) },
    _count: { _all: true },
  });
  const byDomain = new Map<string, { count: number; severity: SeverityCountMap }>();
  for (const r of rows) {
    const domain = resolveReportRiskDomain({
      riskCategory: r.riskCategory,
      riskCategoryLabel: riskLabel(r.riskCategory, r.engine),
      engine: r.engine,
    });
    const b = byDomain.get(domain) ?? { count: 0, severity: emptySeverity() };
    b.count += r._count._all;
    b.severity[r.severity!] += r._count._all;
    byDomain.set(domain, b);
  }
  const all = [...byDomain.entries()]
    .map(([key, v]) => ({
      key,
      label: riskDomainLabel(key),
      count: v.count,
      high: v.severity.CRITICAL + v.severity.HIGH,
      severity: v.severity,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return {
    range,
    periodStart: current.start,
    total: all.reduce((a, c) => a + c.count, 0),
    categoryCount: all.length,
    items: all.slice(0, limit),
  };
}

// ───────────────────────────── 较上期变化 ─────────────────────────────

interface ReviewAgg {
  hours: number | null;
  n: number;
}

/**
 * 平均复核时长：取审计日志 finding.review 中每个风险回复「首次做出最终结论」
 * （已确认 / 误报 / 接受风险）的时刻，减去该风险回复的创建时间；统计窗口按复核发生时间划分。
 * Finding 表本身没有复核时间列，审计日志是唯一可靠来源。
 */
async function avgReviewHours(w: Window): Promise<ReviewAgg> {
  const lower = w.start ? Prisma.sql`AND x.reviewed_at >= ${w.start}` : Prisma.empty;
  const rows = await prisma.$queryRaw<Array<{ hours: number | null; n: number }>>(Prisma.sql`
    SELECT avg(extract(epoch FROM (x.reviewed_at - f."createdAt")) / 3600.0)::float8 AS hours,
           count(*)::int AS n
    FROM (
      SELECT DISTINCT ON (a."targetId") a."targetId" AS fid, a."createdAt" AS reviewed_at
      FROM audit_logs a
      WHERE a.action = 'finding.review'
        AND a.detail->>'reviewStatus' IN ('CONFIRMED','FALSE_POSITIVE','ACCEPTED_RISK')
        ${tenantSql('a."tenantId"')}
      ORDER BY a."targetId", a."createdAt" ASC
    ) x
    JOIN findings f ON f.id = x.fid
    WHERE x.reviewed_at < ${w.end} ${lower}
      AND x.reviewed_at >= f."createdAt"`);
  const r = rows[0];
  if (!r || r.n === 0 || r.hours === null) return { hours: null, n: 0 };
  return { hours: Math.round(r.hours * 10) / 10, n: r.n };
}

const share = (c: SeverityCountMap) => {
  const t = sum(c);
  return t === 0 ? null : (c.CRITICAL + c.HIGH) / t;
};
const round4 = (v: number | null) => (v === null ? null : Math.round(v * 10000) / 10000);

export async function buildChanges(range: PostureRange, now: Date) {
  const { current, previous } = resolveRange(range, now);
  const [cur, prev, curReview, prevReview] = await Promise.all([
    severityByWindow(current),
    previous ? severityByWindow(previous) : Promise.resolve(null),
    avgReviewHours(current),
    previous ? avgReviewHours(previous) : Promise.resolve(null),
  ]);
  const curTotal = sum(cur);
  const prevTotal = prev ? sum(prev) : null;
  const unavailableReason =
    curReview.hours === null
      ? '本期暂无已完成复核（已确认/误报/接受风险）的记录，无法计算平均复核时长'
      : null;
  return {
    range,
    current: { start: current.start, end: current.end },
    previous: previous ? { start: previous.start, end: previous.end } : null,
    previousUnavailableReason: previous ? null : '「全部」范围没有可比的上一周期',
    newFindings: {
      current: curTotal,
      previous: prevTotal,
      delta: prevTotal === null ? null : curTotal - prevTotal,
    },
    highShare: {
      current: round4(share(cur)),
      previous: prev ? round4(share(prev)) : null,
      /** 占比之差（百分点 / 100），任一期无风险回复时为 null。 */
      delta:
        share(cur) !== null && prev && share(prev) !== null
          ? round4(share(cur)! - share(prev)!)
          : null,
    },
    avgReviewHours: {
      current: curReview.hours,
      previous: prevReview?.hours ?? null,
      sampleSize: { current: curReview.n, previous: prevReview?.n ?? null },
      unavailableReason,
    },
  };
}

// ───────────────────────────── 路由 ─────────────────────────────

export async function postureRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [requirePermission('eval_task:read')] };

  app.get('/posture', guard, async (request) => {
    const { range } = z.object({ range: rangeSchema }).parse(request.query);
    return buildPosture(range, new Date());
  });

  app.get('/trend', guard, async (request) => {
    const { days } = z
      .object({ days: z.coerce.number().int().min(1).max(90).default(30) })
      .parse(request.query);
    return buildTrend(days, new Date());
  });

  app.get('/risk-categories', guard, async (request) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(20).default(7), range: rangeSchema })
      .parse(request.query);
    return buildRiskCategories(q.limit, q.range, new Date());
  });

  app.get('/changes', guard, async (request) => {
    const { range } = z.object({ range: rangeSchema }).parse(request.query);
    return buildChanges(range, new Date());
  });
}
