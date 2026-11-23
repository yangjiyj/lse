import { EngineRunStatus, Prisma } from '@prisma/client';
import {
  computeWeightedScore,
  EVAL_WEIGHT_DIMENSIONS,
  isEvaluationIncomplete,
  type DimensionStat,
  type EvalWeightDimension,
  type WeightedScoreResult,
} from '@lse/shared';
import { prisma } from '../db.js';
import {
  EVALUATION_SETTING_KEY,
  parseStoredEvaluation,
  type EvaluationSettings,
} from './evaluation-config.js';

/** 读取配置管理（evaluation 分组）；每个请求读一次后传给下面的批量函数。 */
export async function loadEvaluationSettings(): Promise<EvaluationSettings> {
  const row = await prisma.systemSetting.findUnique({ where: { key: EVALUATION_SETTING_KEY } });
  return parseStoredEvaluation(row?.value);
}

export type TaskDimensionStats = Partial<Record<EvalWeightDimension, DimensionStat>>;

type StatRow = {
  taskId: string;
  type: string;
  severity: string | null;
  verdict: 'PASS' | 'FAIL';
  count: bigint;
};

/**
 * 一次聚合多个任务的各评估类型（题型）统计：taskId × question.type × severity × finalVerdict，
 * 只计 PASS / FAIL 判定（执行异常与未判定样本不计入）。
 */
export async function dimensionStatsByTask(
  taskIds: string[],
): Promise<Map<string, TaskDimensionStats>> {
  const map = new Map<string, TaskDimensionStats>();
  if (taskIds.length === 0) return map;
  const rows = await prisma.$queryRaw<StatRow[]>(Prisma.sql`
    SELECT r."taskId" AS "taskId", q."type"::text AS "type", q."severity"::text AS "severity",
      r."finalVerdict"::text AS "verdict", COUNT(*) AS "count"
    FROM "eval_results" r JOIN "questions" q ON q."id" = r."questionId"
    WHERE r."taskId" IN (${Prisma.join(taskIds)}) AND r."finalVerdict" IN ('PASS', 'FAIL')
    GROUP BY r."taskId", q."type", q."severity", r."finalVerdict"`);
  for (const row of rows) {
    const dim = row.type as EvalWeightDimension;
    if (!EVAL_WEIGHT_DIMENSIONS.includes(dim)) continue;
    const count = Number(row.count);
    const stats = map.get(row.taskId) ?? {};
    const s = (stats[dim] ??= { total: 0, passed: 0, failedBySeverity: {} });
    s.total += count;
    if (row.verdict === 'PASS') s.passed += count;
    else {
      const sev = (row.severity ?? 'UNSET') as keyof NonNullable<DimensionStat['failedBySeverity']>;
      s.failedBySeverity![sev] = (s.failedBySeverity![sev] ?? 0) + count;
    }
    map.set(row.taskId, stats);
  }
  return map;
}

/**
 * 「评估不完整」的任务 id 集合：与页面结论文案「评估不完整，未形成完整结论」同一谓词
 * （@lse/shared 的 isEvaluationIncomplete，对应 web 端 buildEvaluationOutcome）。
 * 存在未判定 / 执行异常 / 被跳过的引擎 / 没跑完 / 非完成状态的任务都在其中。
 */
export async function incompleteTaskIds(taskIds: string[]): Promise<Set<string>> {
  const incomplete = new Set<string>();
  if (taskIds.length === 0) return incomplete;
  const rows = await prisma.evalTask.findMany({
    where: { id: { in: taskIds } },
    select: {
      id: true,
      status: true,
      totalQuestions: true,
      processedQuestions: true,
      passedCount: true,
      failedCount: true,
      errorCount: true,
      progress: true,
      _count: {
        select: {
          engineRuns: {
            where: { OR: [{ status: EngineRunStatus.SKIPPED }, { skippedCount: { gt: 0 } }] },
          },
        },
      },
    },
  });
  for (const row of rows) {
    if (isEvaluationIncomplete({ ...row, skippedEngineCount: row._count.engineRuns }))
      incomplete.add(row.id);
  }
  return incomplete;
}

/**
 * 批量计算综合评估得分（0–100，1 位小数）。
 * 无已判定样本、或任务「评估不完整」（存在未判定/异常/跳过引擎等）时为 null：
 * 只算 PASS/FAIL 会把没有结论的样本当不存在，让一半样本未判定的任务拿到满分。
 */
export async function weightedScoresByTask(
  taskIds: string[],
  config?: EvaluationSettings,
): Promise<Map<string, number | null>> {
  const scores = new Map<string, number | null>();
  if (taskIds.length === 0) return scores;
  const [cfg, stats, incomplete] = await Promise.all([
    config ?? loadEvaluationSettings(),
    dimensionStatsByTask(taskIds),
    incompleteTaskIds(taskIds),
  ]);
  for (const id of taskIds)
    scores.set(
      id,
      incomplete.has(id) ? null : computeWeightedScore(stats.get(id) ?? {}, cfg).score,
    );
  return scores;
}

/**
 * 单任务版本：返回完整维度明细与已判定样本数，供 /evaluation-config/tasks/:id/score 使用。
 * 评估不完整时 score 为 null 且 incomplete 为 true；维度明细仍按已判定样本给出，仅供参考。
 */
export async function weightedScoreForTask(
  taskId: string,
  config: EvaluationSettings,
): Promise<WeightedScoreResult & { judgedCount: number; incomplete: boolean }> {
  const [statsMap, incompleteSet] = await Promise.all([
    dimensionStatsByTask([taskId]),
    incompleteTaskIds([taskId]),
  ]);
  const stats = statsMap.get(taskId) ?? {};
  const judgedCount = Object.values(stats).reduce((n, s) => n + (s?.total ?? 0), 0);
  const incomplete = incompleteSet.has(taskId);
  const result = computeWeightedScore(stats, config);
  return { ...result, score: incomplete ? null : result.score, judgedCount, incomplete };
}
