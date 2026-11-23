import { SEVERITY } from '@lse/shared';
import type { ReportConclusionSnapshot, ReportConclusionState } from './report-conclusion.js';
import { parseReportListSummary } from './report-list-summary.js';

/**
 * 报告趋势（M14 报告富化 · Part 3）——按模型对象（modelTargetId）聚合历史报告，
 * 形成通过率 / 风险数随时间的时间序列，并给出整体走向判定。
 *
 * 本文件只放纯函数 + 类型，便于 TDD；路由层负责取数（prisma）后调用。
 */

export const REPORT_TREND_SELECT = {
  id: true,
  taskId: true,
  createdAt: true,
  kind: true,
  listSummary: true,
  task: { select: { name: true } },
} as const;

/** 单条历史报告的趋势输入（由路由层从 prisma.report 投影而来）。 */
export interface TrendReportInput {
  id: string;
  taskId: string;
  taskName: string;
  createdAt: Date;
  kind: string;
  listSummary: unknown;
}

/** 时间序列中的一个数据点。 */
export interface ReportTrendPoint {
  reportId: string;
  taskId: string;
  taskName: string;
  /** 数据库冻结的报告类型，用于判断趋势点是否可比较。 */
  kind: string;
  createdAt: Date;
  /** 与列表、详情、下载共用的冻结结论快照。 */
  conclusionSnapshot: ReportConclusionSnapshot;
  conclusionState: ReportConclusionState;
  /** 通过率百分数（保留 1 位小数），无数据为 null。 */
  passRatePercent: number | null;
  totalQuestions: number;
  /** 风险项总数（各严重度计数之和）。 */
  findingCount: number;
  /** 归一化后的严重度计数：固定包含全部 5 个等级，缺失补 0。 */
  severityCounts: Record<string, number>;
  /** 高危及以上数量（HIGH + CRITICAL）。 */
  highRiskCount: number;
}

export type TrendDirection = 'improving' | 'declining' | 'flat' | 'unknown';

export interface ReportTrendSummary {
  reportCount: number;
  firstPassRatePercent: number | null;
  latestPassRatePercent: number | null;
  /** 最新 - 最早 的通过率百分数差（保留 1 位小数）；样本不足或缺值为 null。 */
  passRateDeltaPercent: number | null;
  direction: TrendDirection;
}

export interface ReportTrend {
  modelTargetId: string;
  points: ReportTrendPoint[];
  summary: ReportTrendSummary;
}

function toPercent(passRate: number | null): number | null {
  if (passRate === null || passRate === undefined || Number.isNaN(passRate)) {
    return null;
  }
  return Math.round(passRate * 1000) / 10;
}

function buildPoint(r: TrendReportInput): ReportTrendPoint {
  const summary = parseReportListSummary(r.listSummary, {
    kind: r.kind,
    totalQuestions: null,
    riskDistribution: null,
  });
  const bySeverity = summary.severityDistribution;
  const severityCounts: Record<string, number> = {};
  let findingCount = 0;
  for (const sev of SEVERITY) {
    const n = bySeverity[sev] ?? 0;
    severityCounts[sev] = n;
    findingCount += n;
  }
  const highRiskCount = (severityCounts.HIGH ?? 0) + (severityCounts.CRITICAL ?? 0);
  return {
    reportId: r.id,
    taskId: r.taskId,
    taskName: r.taskName,
    kind: r.kind,
    createdAt: r.createdAt,
    conclusionSnapshot: summary.conclusionSnapshot,
    conclusionState: summary.conclusionSnapshot.state,
    passRatePercent: toPercent(summary.conclusionSnapshot.passRate),
    totalQuestions: summary.totalQuestions,
    findingCount,
    severityCounts,
    highRiskCount,
  };
}

function compareOverallDirection(
  first: ReportTrendPoint,
  latest: ReportTrendPoint,
): TrendDirection {
  const deltas = [
    latest.passRatePercent! - first.passRatePercent!,
    first.findingCount - latest.findingCount,
    first.highRiskCount - latest.highRiskCount,
  ];
  const hasImprovement = deltas.some((delta) => delta > 0);
  const hasRegression = deltas.some((delta) => delta < 0);
  if (!hasImprovement && !hasRegression) return 'flat';
  if (hasImprovement && !hasRegression) return 'improving';
  if (!hasImprovement && hasRegression) return 'declining';
  return 'unknown';
}

export function buildReportTrend(modelTargetId: string, reports: TrendReportInput[]): ReportTrend {
  const sorted = [...reports].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const points = sorted.map(buildPoint);

  const first = points[0] ?? null;
  const latest = points.length > 0 ? points[points.length - 1]! : null;
  const firstPassRatePercent = first?.passRatePercent ?? null;
  const latestPassRatePercent = latest?.passRatePercent ?? null;

  let passRateDeltaPercent: number | null = null;
  let direction: TrendDirection = 'unknown';
  if (
    points.length >= 2 &&
    first &&
    latest &&
    points.every(
      (point) =>
        point.kind === first?.kind &&
        point.conclusionSnapshot.scopeKind === first?.conclusionSnapshot.scopeKind &&
        point.conclusionSnapshot.coverageComplete,
    ) &&
    firstPassRatePercent !== null &&
    latestPassRatePercent !== null
  ) {
    passRateDeltaPercent = Math.round((latestPassRatePercent - firstPassRatePercent) * 10) / 10;
    direction = compareOverallDirection(first, latest);
  }

  return {
    modelTargetId,
    points,
    summary: {
      reportCount: points.length,
      firstPassRatePercent,
      latestPassRatePercent,
      passRateDeltaPercent,
      direction,
    },
  };
}
