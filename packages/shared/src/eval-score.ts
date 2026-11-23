/**
 * 通过率工具。评测得分统一使用 eval-weights.ts 的 computeWeightedScore（配置管理可配权重），
 * 服务端入口为 apps/api/src/lib/weighted-score.ts；此处不再提供独立的评分公式。
 */

function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 通过率 = 通过 / (通过 + 风险)，无已判定样本返回 null。 */
export function computePassRate(passedCount: number, failedCount: number): number | null {
  const passed = nonNegative(passedCount);
  const judged = passed + nonNegative(failedCount);
  return judged > 0 ? passed / judged : null;
}
