import type { Prisma, PrismaClient } from '@prisma/client';
import {
  binaryMetrics,
  cohensKappa,
  kappaLevel,
  seededSample,
  wilsonInterval,
  type ConfusionCounts,
} from '../../lib/eval-statistics.js';

/** 人工已复核样本少于该值时，不计算一致率与 kappa，直接提示数据不足。 */
export const MIN_CALIBRATION_SAMPLES = 10;
export const DEFAULT_SPOT_CHECK_SIZE = 20;
export const MAX_SPOT_CHECK_SIZE = 200;

/** 复核结论 → 人工认为是否有风险：确认风险/接受风险=有风险；误报=无风险。 */
export function humanLabelOf(reviewStatus: string): 'FAIL' | 'PASS' | null {
  if (reviewStatus === 'CONFIRMED' || reviewStatus === 'ACCEPTED_RISK') return 'FAIL';
  if (reviewStatus === 'FALSE_POSITIVE') return 'PASS';
  return null;
}

export interface CalibrationRow {
  verdict: string;
  reviewStatus: string;
}

export interface JudgeCalibration {
  status: 'OK' | 'INSUFFICIENT';
  /** 人工已复核并且判定器给出明确结论（通过/失败）的样本数 */
  reviewedCount: number;
  /** 人工已复核，但判定为未判定/异常，未纳入一致性计算的数量 */
  excludedReviewedCount: number;
  /** 尚未人工复核的判定数（可抽检池） */
  pendingCount: number;
  minRequired: number;
  agreementRate: number | null;
  agreementLower: number | null;
  agreementUpper: number | null;
  kappa: number | null;
  kappaLevel: string;
  precision: number | null;
  recall: number | null;
  /** 漏报：判定为通过，但人工认为有风险 */
  missedRiskCount: number;
  /** 误报：判定为失败，但人工认为无风险 */
  falseAlarmCount: number;
  confusion: ConfusionCounts;
  message: string;
}

export function computeJudgeCalibration(
  rows: readonly CalibrationRow[],
  minRequired = MIN_CALIBRATION_SAMPLES,
): JudgeCalibration {
  const confusion: ConfusionCounts = { tp: 0, fp: 0, fn: 0, tn: 0 };
  let excluded = 0;
  let pending = 0;
  for (const row of rows) {
    const human = humanLabelOf(row.reviewStatus);
    if (human === null) {
      if (row.verdict === 'PASS' || row.verdict === 'FAIL') pending += 1;
      continue;
    }
    if (row.verdict !== 'PASS' && row.verdict !== 'FAIL') {
      excluded += 1;
      continue;
    }
    if (row.verdict === 'FAIL') {
      if (human === 'FAIL') confusion.tp += 1;
      else confusion.fp += 1;
    } else if (human === 'FAIL') confusion.fn += 1;
    else confusion.tn += 1;
  }
  const reviewed = confusion.tp + confusion.fp + confusion.fn + confusion.tn;
  const base = {
    reviewedCount: reviewed,
    excludedReviewedCount: excluded,
    pendingCount: pending,
    minRequired,
    missedRiskCount: confusion.fn,
    falseAlarmCount: confusion.fp,
    confusion,
  };
  if (reviewed < minRequired) {
    return {
      ...base,
      status: 'INSUFFICIENT',
      agreementRate: null,
      agreementLower: null,
      agreementUpper: null,
      kappa: null,
      kappaLevel: '无法计算',
      precision: null,
      recall: null,
      message: `数据不足：人工已复核 ${reviewed} 条，至少需要 ${minRequired} 条才能评估判定可信度。可使用「随机抽检」补充人工复核。`,
    };
  }
  const metrics = binaryMetrics(confusion);
  const interval = wilsonInterval(confusion.tp + confusion.tn, reviewed);
  const kappa = cohensKappa(confusion);
  return {
    ...base,
    status: 'OK',
    agreementRate: metrics.accuracy,
    agreementLower: interval.lower,
    agreementUpper: interval.upper,
    kappa,
    kappaLevel: kappaLevel(kappa),
    precision: metrics.precision,
    recall: metrics.recall,
    message:
      kappa === null
        ? '人工复核结论几乎全部同类，无法扣除碰巧一致的因素；建议补充不同类型的抽检样本。'
        : '基于人工已复核样本计算，结论仅反映被复核部分，不代表全部判定。',
  };
}

/** 加载任务内的判定与人工复核状态并计算校准结果。 */
export async function loadJudgeCalibration(
  db: Pick<PrismaClient, 'finding'>,
  taskId: string,
): Promise<JudgeCalibration> {
  const rows = await db.finding.findMany({
    where: { taskId },
    select: { verdict: true, reviewStatus: true },
  });
  return computeJudgeCalibration(rows);
}

export interface SpotCheckItem {
  findingId: string;
  resultId: string | null;
  questionId: string | null;
  riskCategory: string;
  severity: string | null;
  verdict: string;
  reviewStatus: string;
  title: string | null;
}

/**
 * 随机抽检清单：从「判定明确（通过/失败）、尚未人工复核、且已进入风险样本」的发现中按种子随机抽取。
 * 复核操作复用「风险样本」页现有的人工复核入口，不在此新建流程。
 */
export async function loadSpotCheckSample(
  db: Pick<PrismaClient, 'finding'>,
  taskId: string,
  size: number,
  seed: string,
): Promise<{ seed: string; size: number; poolSize: number; items: SpotCheckItem[] }> {
  const where: Prisma.FindingWhereInput = {
    taskId,
    verdict: { in: ['FAIL', 'PASS'] },
    reviewStatus: { in: ['UNREVIEWED', 'NEEDS_REVIEW'] },
    result: { wrongAnswers: { some: {} } },
  };
  const pool = await db.finding.findMany({
    where,
    orderBy: { id: 'asc' }, // 固定顺序，保证同种子可复现
    select: {
      id: true,
      resultId: true,
      questionId: true,
      riskCategory: true,
      severity: true,
      verdict: true,
      reviewStatus: true,
      title: true,
    },
  });
  const picked = seededSample(pool, size, seed);
  return {
    seed,
    size: picked.length,
    poolSize: pool.length,
    items: picked.map((f) => ({
      findingId: f.id,
      resultId: f.resultId,
      questionId: f.questionId,
      riskCategory: f.riskCategory,
      severity: f.severity,
      verdict: f.verdict,
      reviewStatus: f.reviewStatus,
      title: f.title,
    })),
  };
}
