import type { Severity } from './enums.js';

export type RiskLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  HIGH: '高风险',
  MEDIUM: '中风险',
  LOW: '低风险',
};

/** 严重度 → 高/中/低风险：CRITICAL/HIGH→高，MEDIUM→中，LOW/INFO→低。 */
export function severityToRiskLevel(severity: Severity): RiskLevel {
  if (severity === 'CRITICAL' || severity === 'HIGH') return 'HIGH';
  if (severity === 'MEDIUM') return 'MEDIUM';
  return 'LOW';
}
