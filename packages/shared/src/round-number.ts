function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * 把内部零基轮次索引转换成客户可见的一基轮次。
 * value 非法时使用其所在数组的零基位置 fallbackIndex。
 */
export function roundNumberFromZeroBasedIndex(value: unknown, fallbackIndex = 0): number {
  return (nonNegativeInteger(value) ?? nonNegativeInteger(fallbackIndex) ?? 0) + 1;
}

/**
 * 保护已经是一基语义的轮次（例如 RedTeamRoundEvent.roundNumber）。
 * 合法正整数原样返回，0/负数/小数/非数字回退，最终值永不低于 1。
 */
export function normalizeVisibleRoundNumber(value: unknown, fallbackRound = 1): number {
  const round = nonNegativeInteger(value);
  if (round !== null && round >= 1) return round;

  const fallback = nonNegativeInteger(fallbackRound);
  return fallback !== null && fallback >= 1 ? fallback : 1;
}
