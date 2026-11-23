import type { Severity } from '@lse/shared';
import {
  MAX_COVERAGE_DEDUCTION,
  MAX_RISK_DEDUCTION,
  RISK_DEDUCTION,
  SKIPPED_ENGINE_DEDUCTION,
} from '../../lib/risk-rating.js';

type FindingReviewStatus =
  | 'UNREVIEWED'
  | 'NEEDS_REVIEW'
  | 'CONFIRMED'
  | 'FALSE_POSITIVE'
  | 'ACCEPTED_RISK';

export type SecurityScoreGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface SecurityScoreFinding {
  severity: Severity | null;
  reviewStatus?: string | null;
}

export interface SecurityScoreEngineRun {
  status: string;
}

export interface ReportSecurityScore {
  policyVersion?: 'risk-score-v1';
  advisory?: true;
  score: number;
  grade: SecurityScoreGrade;
  activeFindingCount: number;
  confirmedFindingCount: number;
  unreviewedFindingCount: number;
  needsReviewFindingCount: number;
  falsePositiveFindingCount: number;
  acceptedRiskFindingCount: number;
  skippedEngineCount: number;
  coverageIncomplete?: boolean;
  riskDeduction: number;
  reviewDeduction: number;
  coverageDeduction: number;
  totalDeduction: number;
}

function normalizeReviewStatus(value: string | null | undefined): FindingReviewStatus {
  switch (value) {
    case 'NEEDS_REVIEW':
    case 'CONFIRMED':
    case 'FALSE_POSITIVE':
    case 'ACCEPTED_RISK':
    case 'UNREVIEWED':
      return value;
    default:
      return 'UNREVIEWED';
  }
}

export function isExcludedByReview(value: string | null | undefined): boolean {
  const status = normalizeReviewStatus(value);
  return status === 'FALSE_POSITIVE';
}

export function isActiveRiskFinding(finding: SecurityScoreFinding): boolean {
  return !isExcludedByReview(finding.reviewStatus);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function gradeForScore(score: number): SecurityScoreGrade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * 把内部等级字母（A/B/C/D/F）翻成客户看得懂的中文档位。
 * 仅用于给人读的报告文本，不改变任何计算与枚举 code。
 */
export function gradeLabelZh(grade: SecurityScoreGrade): string {
  switch (grade) {
    case 'A':
      return 'A 档';
    case 'B':
      return 'B 档';
    case 'C':
      return 'C 档';
    case 'D':
      return 'D 档';
    case 'F':
    default:
      return 'F 档';
  }
}

/**
 * 给辅助分数配一句中性解读，说明扣分程度与后续证据核查重点。
 * 分档仅表示风险排序区间：90+ A / 80+ B / 70+ C / 60+ D / 60 以下 F。
 */
export function scoreVerdictZh(score: number): string {
  if (score >= 90) {
    return 'A 档 —— 风险扣分较少，分数仅作风险排序参考';
  }
  if (score >= 80) {
    return 'B 档 —— 存在一定风险扣分，需结合风险项与覆盖完整性研判';
  }
  if (score >= 70) {
    return 'C 档 —— 风险扣分较明显，需优先核查高影响风险项';
  }
  if (score >= 60) {
    return 'D 档 —— 风险扣分较多，需逐项处置并复核证据';
  }
  return 'F 档 —— 风险扣分较多，需优先处置高影响风险并补充复核';
}

/**
 * 生成“分数 + 中性档位说明”的展示文本，供报告辅助指标区域使用。
 * 例：「85 分（B 档 —— 存在一定风险扣分，需结合风险项与覆盖完整性研判）」
 */
export function scoreDisplayZh(score: number): string {
  return `${score} 分（${scoreVerdictZh(score)}）`;
}

export function buildSecurityScore(input: {
  findings: readonly SecurityScoreFinding[];
  engineRuns: readonly SecurityScoreEngineRun[];
  coverageIncomplete?: boolean;
}): ReportSecurityScore {
  let confirmedFindingCount = 0;
  let unreviewedFindingCount = 0;
  let needsReviewFindingCount = 0;
  let falsePositiveFindingCount = 0;
  let acceptedRiskFindingCount = 0;
  let riskDeduction = 0;
  const reviewDeduction = 0;

  for (const finding of input.findings) {
    const status = normalizeReviewStatus(finding.reviewStatus);
    const severityDeduction = finding.severity ? RISK_DEDUCTION[finding.severity] : 0;

    if (status === 'FALSE_POSITIVE') {
      falsePositiveFindingCount += 1;
      continue;
    }
    if (status === 'ACCEPTED_RISK') {
      acceptedRiskFindingCount += 1;
    } else if (status === 'NEEDS_REVIEW') {
      needsReviewFindingCount += 1;
    } else if (status === 'CONFIRMED') {
      confirmedFindingCount += 1;
    } else {
      unreviewedFindingCount += 1;
    }
    // 复核状态只描述治理进度，不改变风险事实与严重度扣分。
    // 已接受风险仍是残余风险，待复核风险也不能按 40% 打折。
    riskDeduction += severityDeduction;
  }

  const skippedEngineCount = input.engineRuns.filter((run) => run.status === 'SKIPPED').length;
  const coverageIncomplete = input.coverageIncomplete === true;
  riskDeduction = Math.min(MAX_RISK_DEDUCTION, riskDeduction);
  const coverageDeduction = coverageIncomplete
    ? MAX_COVERAGE_DEDUCTION
    : Math.min(MAX_COVERAGE_DEDUCTION, skippedEngineCount * SKIPPED_ENGINE_DEDUCTION);
  const totalDeduction = riskDeduction + reviewDeduction + coverageDeduction;
  const score = clampInt(100 - totalDeduction, 0, 100);

  return {
    policyVersion: 'risk-score-v1',
    advisory: true,
    score,
    grade: gradeForScore(score),
    activeFindingCount:
      confirmedFindingCount +
      unreviewedFindingCount +
      needsReviewFindingCount +
      acceptedRiskFindingCount,
    confirmedFindingCount,
    unreviewedFindingCount,
    needsReviewFindingCount,
    falsePositiveFindingCount,
    acceptedRiskFindingCount,
    skippedEngineCount,
    ...(input.coverageIncomplete === undefined ? {} : { coverageIncomplete }),
    riskDeduction,
    reviewDeduction,
    coverageDeduction,
    totalDeduction,
  };
}


export const DEFAULT_RISK_SCORE_WEIGHTS = {
  correctness: 40,
  safety: 30,
  robustness: 20,
  coverage: 10,
} as const;

export type UnifiedRiskScoreWeights = Record<keyof typeof DEFAULT_RISK_SCORE_WEIGHTS, number>;
export type UnifiedRiskScoreLevel = '一级' | '二级' | '三级' | '四级';

export function buildUnifiedRiskScore(
  dimensions: Record<keyof UnifiedRiskScoreWeights, number>,
  weights: UnifiedRiskScoreWeights = DEFAULT_RISK_SCORE_WEIGHTS,
): { score: number; level: UnifiedRiskScoreLevel; weights: UnifiedRiskScoreWeights } {
  const entries = Object.keys(DEFAULT_RISK_SCORE_WEIGHTS) as Array<keyof UnifiedRiskScoreWeights>;
  const totalWeight = entries.reduce((sum, key) => sum + weights[key], 0);
  if (totalWeight <= 0 || entries.some((key) => !Number.isFinite(dimensions[key]) || dimensions[key] < 0 || dimensions[key] > 100 || !Number.isFinite(weights[key]) || weights[key] < 0)) {
    throw new Error('评分维度或权重无效');
  }
  const score = clampInt(entries.reduce((sum, key) => sum + dimensions[key] * weights[key], 0) / totalWeight, 0, 100);
  const level: UnifiedRiskScoreLevel = score >= 90 ? '一级' : score >= 75 ? '二级' : score >= 60 ? '三级' : '四级';
  return { score, level, weights: { ...weights } };
}
