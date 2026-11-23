export interface ReportPrimaryResultIdentity {
  side?: string | null;
  controlGroupId?: string | null;
}

/**
 * 选择客户主评估结果：同一对照组优先 B；没有 B 时保留 A。
 * 普通结果、无对照组的 A/B 及其他 side 原样保留，返回顺序与输入稳定一致。
 */
export function selectPrimaryReportResults<T extends ReportPrimaryResultIdentity>(
  results: readonly T[],
): T[] {
  const groupsWithB = new Set(
    results.flatMap((result) =>
      result.side === 'B' && result.controlGroupId ? [result.controlGroupId] : [],
    ),
  );
  return results.filter(
    (result) =>
      result.side !== 'A' || !result.controlGroupId || !groupsWithB.has(result.controlGroupId),
  );
}
