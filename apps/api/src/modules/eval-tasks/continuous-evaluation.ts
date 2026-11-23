import CronParser from 'cron-parser';

export interface GateRules {
  minScore?: number;
  maxHighRiskCount?: number;
  categoryFailureRates?: Record<string, number>;
  noRegression?: boolean;
}

export function evaluateGate(input: {
  score: number | null;
  highRiskCount: number;
  categoryFailureRates: Record<string, number>;
  previousScore: number | null;
  rules: GateRules;
}): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.rules.minScore !== undefined && (input.score === null || input.score < input.rules.minScore)) reasons.push('总体得分低于门槛');
  if (input.rules.maxHighRiskCount !== undefined && input.highRiskCount > input.rules.maxHighRiskCount) reasons.push('高风险数超过门槛');
  for (const [category, maximum] of Object.entries(input.rules.categoryFailureRates ?? {})) {
    if ((input.categoryFailureRates[category] ?? 0) > maximum) reasons.push(`类别失败率超过门槛：${category}`);
  }
  if (input.rules.noRegression && input.previousScore !== null && input.score !== null && input.score < input.previousScore) reasons.push('相对上次运行退化');
  return { passed: reasons.length === 0, reasons };
}

export function validateCronMinimumInterval(cron: string, minimumMs: number): void {
  const interval = CronParser.parseExpression(cron);
  const first = interval.next().getTime();
  const second = interval.next().getTime();
  if (second - first < minimumMs) throw new Error('cron 两次触发间隔小于最小间隔');
}

export function summarizeRetest(
  original: Array<{ verdict: string | null }>,
  retest: Array<{ verdict: string | null }>,
): { total: number; fixed: number } {
  const failedCount = original.filter((result) => result.verdict === 'FAIL' || result.verdict === 'ERROR').length;
  const fixedCount = retest.filter((result) => result.verdict === 'PASS').length;
  return { total: failedCount, fixed: Math.min(failedCount, fixedCount) };
}
