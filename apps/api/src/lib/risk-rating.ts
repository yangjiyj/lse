/**
 * 总体风险等级与安全评分的共享确定性规则（纯函数，无 I/O）。
 * 评估报告（reports/html、reports/scoring）与首页「安全态势」共用这一份，避免规则漂移。
 */

import type { Severity } from '@lse/shared';

export type OverallRiskLevel = 'HIGH' | 'MEDIUM_HIGH' | 'MEDIUM' | 'LOW' | 'UNRATED';

export const RISK_LEVEL_LABELS: Record<OverallRiskLevel, string> = {
  HIGH: '高',
  MEDIUM_HIGH: '中高',
  MEDIUM: '中',
  LOW: '低',
  UNRATED: '暂无法评级',
};

/** 触发「高」所需的高危项数量（无严重项时）。 */
export const RISK_LEVEL_HIGH_COUNT_THRESHOLD = 5;

/** 附录 B 原样展示的等级规则，与 computeOverallRiskLevel 保持一致。 */
export const RISK_LEVEL_RULE_LINES: Array<{ level: OverallRiskLevel; rule: string }> = [
  {
    level: 'HIGH',
    rule: `存在 1 项及以上严重风险；或高危风险不少于 ${RISK_LEVEL_HIGH_COUNT_THRESHOLD} 项。`,
  },
  {
    level: 'MEDIUM_HIGH',
    rule: `无严重风险，高危风险为 1 至 ${RISK_LEVEL_HIGH_COUNT_THRESHOLD - 1} 项。`,
  },
  { level: 'MEDIUM', rule: '无严重、高危风险，存在中危风险。' },
  { level: 'LOW', rule: '未发现风险，或仅存在低危及以下风险。' },
  {
    level: 'UNRATED',
    rule: '未发现风险，且有效判定（通过 + 发现风险）不足测试项总数的一半：证据不足以评级，需先补齐评估。',
  },
];

export interface RiskLevelInput {
  critical: number;
  high: number;
  medium: number;
  low: number;
  /** 测试项总数与有效判定数（通过 + 发现风险）；缺省时不做「暂无法评级」判断。 */
  total?: number;
  valid?: number;
}

export interface RiskLevelResult {
  level: OverallRiskLevel;
  label: string;
  /** 一句话依据，直接展示在摘要页。 */
  reason: string;
}

function nn(v: number | undefined | null): number {
  return Number.isFinite(v) && (v as number) > 0 ? Math.floor(v as number) : 0;
}

export function computeOverallRiskLevel(input: RiskLevelInput): RiskLevelResult {
  const critical = nn(input.critical);
  const high = nn(input.high);
  const medium = nn(input.medium);
  let level: OverallRiskLevel;
  let reason: string;
  if (critical >= 1 || high >= RISK_LEVEL_HIGH_COUNT_THRESHOLD) {
    level = 'HIGH';
    reason =
      critical >= 1
        ? `存在 ${critical} 项严重风险${high > 0 ? `、${high} 项高危风险` : ''}`
        : `高危风险达 ${high} 项`;
  } else if (high >= 1) {
    level = 'MEDIUM_HIGH';
    reason = `存在 ${high} 项高危风险，无严重风险`;
  } else if (medium >= 1) {
    level = 'MEDIUM';
    reason = `仅存在 ${medium} 项中危风险`;
  } else if (
    input.total !== undefined &&
    input.valid !== undefined &&
    nn(input.low) === 0 &&
    nn(input.total) > 0 &&
    nn(input.valid) * 2 < nn(input.total)
  ) {
    level = 'UNRATED';
    reason = `有效判定仅 ${nn(input.valid)} 项（共 ${nn(input.total)} 个测试项），证据不足以评级`;
  } else {
    level = 'LOW';
    reason = '本次评估范围内未发现严重、高危或中危风险';
  }
  return { level, label: RISK_LEVEL_LABELS[level], reason };
}

/** 有效判定（通过 + 发现风险）少于此数：只给等级并提示样本偏少，不给数值评分。 */
export const RISK_RATING_MIN_VALID_FOR_SCORE = 10;

/** 严重度扣分与扣分上限（risk-score-v1），报告安全评分与首页评分共用。 */
export const RISK_DEDUCTION: Record<Severity, number> = {
  CRITICAL: 30,
  HIGH: 20,
  MEDIUM: 10,
  LOW: 4,
  INFO: 1,
};
export const MAX_RISK_DEDUCTION = 80;
export const MAX_COVERAGE_DEDUCTION = 20;
export const SKIPPED_ENGINE_DEDUCTION = 5;

export type SeverityCounts = Record<Severity, number>;

/** 由各严重度计数直接计算 risk-score-v1 评分（与 buildSecurityScore 逐项一致：风险扣分封顶 80，覆盖扣分封顶 20）。 */
export function scoreFromSeverityCounts(
  counts: Partial<SeverityCounts>,
  skippedEngineCount = 0,
): number {
  let risk = 0;
  for (const sev of Object.keys(RISK_DEDUCTION) as Severity[]) {
    risk += RISK_DEDUCTION[sev] * nn(counts[sev]);
  }
  risk = Math.min(MAX_RISK_DEDUCTION, risk);
  const coverage = Math.min(
    MAX_COVERAGE_DEDUCTION,
    nn(skippedEngineCount) * SKIPPED_ENGINE_DEDUCTION,
  );
  return Math.max(0, Math.min(100, Math.round(100 - risk - coverage)));
}

export interface OverallRating extends RiskLevelResult {
  /** 有效判定不足 10 项（且非「暂无法评级」）：等级仅供参考，不给评分。 */
  fewValid: boolean;
  /** 0–100；暂无法评级或样本偏少时为 null。 */
  score: number | null;
}

/** 报告摘要页与首页态势共用：总体风险等级 + 样本偏少处理 + 评分门槛。 */
export function rateOverallRisk(
  input: RiskLevelInput & { total: number; valid: number },
  skippedEngineCount = 0,
): OverallRating {
  const base = computeOverallRiskLevel(input);
  const unrated = base.level === 'UNRATED';
  const fewValid =
    !unrated && nn(input.total) > 0 && nn(input.valid) < RISK_RATING_MIN_VALID_FOR_SCORE;
  const reason = fewValid
    ? `${base.reason}；有效判定仅 ${nn(input.valid)} 项，样本偏少，等级仅供参考`
    : base.reason;
  const score =
    unrated || fewValid
      ? null
      : scoreFromSeverityCounts(
          {
            CRITICAL: input.critical,
            HIGH: input.high,
            MEDIUM: input.medium,
            LOW: input.low,
          },
          skippedEngineCount,
        );
  return { ...base, reason, fewValid, score };
}
