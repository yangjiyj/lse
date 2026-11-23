import type { Prisma } from '@prisma/client';
import { severityToRiskLevel, type RiskLevel } from '@lse/shared';
import { z } from 'zod';
import { prisma } from '../../db.js';

/** 任务列表“运行结果”筛选：发现风险 / 全部通过 / 执行异常。 */
export const TASK_RESULT_FILTERS = ['risk', 'pass', 'error'] as const;
export type TaskResultFilter = (typeof TASK_RESULT_FILTERS)[number];

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');

/** 追加到任务列表 query 的筛选参数（执行时间按东八区自然日，含首尾两天）。 */
export const listAnalyticsQuery = z.object({
  result: z.enum(TASK_RESULT_FILTERS).optional(),
  startFrom: dateOnly.optional(),
  startTo: dateOnly.optional(),
});

export function analyticsWhere(q: z.infer<typeof listAnalyticsQuery>): Prisma.EvalTaskWhereInput[] {
  const and: Prisma.EvalTaskWhereInput[] = [];
  if (q.result === 'risk') and.push({ failedCount: { gt: 0 } });
  if (q.result === 'pass') {
    and.push({ status: 'COMPLETED', failedCount: 0, errorCount: 0, processedQuestions: { gt: 0 } });
  }
  if (q.result === 'error') and.push({ OR: [{ errorCount: { gt: 0 } }, { status: 'FAILED' }] });
  if (q.startFrom || q.startTo) {
    const range: Prisma.DateTimeFilter = {};
    if (q.startFrom) range.gte = new Date(`${q.startFrom}T00:00:00+08:00`);
    if (q.startTo)
      range.lt = new Date(new Date(`${q.startTo}T00:00:00+08:00`).getTime() + 86400000);
    and.push({ startedAt: range });
  }
  return and;
}

export type RiskLevelCounts = Record<RiskLevel, number>;

/** 按任务聚合高/中/低风险发现数（CRITICAL/HIGH→高，MEDIUM→中，LOW/INFO→低）。 */
export async function riskLevelsByTask(taskIds: string[]): Promise<Map<string, RiskLevelCounts>> {
  const map = new Map<string, RiskLevelCounts>();
  if (taskIds.length === 0) return map;
  const rows = await prisma.finding.groupBy({
    by: ['taskId', 'severity'],
    where: { taskId: { in: taskIds }, severity: { not: null } },
    _count: { _all: true },
  });
  for (const row of rows) {
    const level = severityToRiskLevel(row.severity!);
    const bucket = map.get(row.taskId) ?? { HIGH: 0, MEDIUM: 0, LOW: 0 };
    bucket[level] += row._count._all;
    map.set(row.taskId, bucket);
  }
  return map;
}

/**
 * 给序列化后的任务附加高中低风险数与评测得分。
 * evalScore 即综合评测得分（lib/weighted-score.ts 的 weightedScoresByTask，按配置管理权重计算），
 * 与 /evaluation-config/tasks/:id/score 同一口径。
 */
export function withScore<T extends { id: string }>(
  task: T,
  levels: RiskLevelCounts | undefined,
  scores: Map<string, number | null>,
) {
  return {
    ...task,
    riskLevels: levels ?? { HIGH: 0, MEDIUM: 0, LOW: 0 },
    evalScore: scores.get(task.id) ?? null,
  };
}

/** 复核进度：未复核 / 待人工复核 的发现视为待复核。 */
export async function reviewSummary(taskId: string) {
  const [findingCount, pendingReviewCount] = await Promise.all([
    prisma.finding.count({ where: { taskId } }),
    prisma.finding.count({
      where: { taskId, reviewStatus: { in: ['UNREVIEWED', 'NEEDS_REVIEW'] } },
    }),
  ]);
  return { findingCount, pendingReviewCount };
}
