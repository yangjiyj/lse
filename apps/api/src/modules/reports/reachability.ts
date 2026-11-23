/** needs_whitebox is reserved; no current execution path supplies structured whitebox evidence. */
export type Reachability =
  | 'blackbox_reached'
  | 'needs_whitebox'
  | 'inconclusive'
  | 'unreachable'
  | 'not_executed';
export interface ReachabilityInput {
  status?: string | null;
  finalVerdict?: string | null;
  errorMessage?: string | null;
  engineRuns?: readonly {
    status: string;
    skippedCount?: number;
    errorMessage?: string | null;
    executionStatus?: string;
  }[];
}
// Legacy fallback: exact transport error codes, never business words such as timeout/infra/NETWORK.
const TRANSPORT_ERROR =
  /(?:^|[\s:])(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT)(?:$|[\s:;])/;
export function deriveReachability(input: ReachabilityInput): Reachability {
  const runs = input.engineRuns ?? [];
  if (
    input.status === 'SUCCESS' &&
    runs.length > 0 &&
    runs.every((run) => run.status === 'SKIPPED' && run.executionStatus === 'NOT_EXECUTED')
  )
    return 'not_executed';
  if (input.status !== 'SUCCESS' || runs.some((run) => ['ERROR', 'FAILED'].includes(run.status))) {
    return 'unreachable';
  }
  if (
    [input.errorMessage, ...runs.map((run) => run.errorMessage)].some(
      (error) => error && TRANSPORT_ERROR.test(error),
    )
  ) {
    return 'unreachable';
  }
  if (
    !['PASS', 'FAIL'].includes(input.finalVerdict ?? '') ||
    runs.some((run) => run.status !== 'SUCCESS' || (run.skippedCount ?? 0) > 0)
  ) {
    return 'inconclusive';
  }
  return 'blackbox_reached';
}
export function summarizeReachability(results: readonly ReachabilityInput[], expected: number) {
  const count = {
    blackbox_reached: 0,
    needs_whitebox: 0,
    inconclusive: 0,
    unreachable: 0,
    not_executed: 0,
  };
  for (const result of results) count[deriveReachability(result)]++;
  const planned = Math.max(expected, results.length);
  count.unreachable += Math.max(0, planned - results.length);
  return {
    ...count,
    observed: results.length,
    expected: planned,
    complete: planned > 0 && count.blackbox_reached === planned,
  };
}
export function reachabilityText(counts?: ReturnType<typeof summarizeReachability>): string {
  if (!counts) return '覆盖范围统计待补；旧报告没有执行可达性快照，不能认定已覆盖。';
  const states = [
    counts.not_executed > 0 ? `前提不满足，未执行：${counts.not_executed}` : '',
    counts.blackbox_reached > 0 ? `黑盒可达：${counts.blackbox_reached}` : '',
    counts.inconclusive > 0 ? `已调用，判定不明确：${counts.inconclusive}` : '',
    counts.unreachable > 0 ? `不可达或证据不足：${counts.unreachable}` : '',
  ].filter(Boolean);
  return `${states.length ? states.join('；') : '无实际结果，不能认定已覆盖'}。按主评对象全量结果统计，缺失样本计入不可达；有效安全拒绝仍属成功调用，调用成功但无有效判定须另行复核。`;
}

/** Only the actual local sandbox execution path writes this marker. Raw metadata is never returned to clients. */
export function mcpExecutionStatus(raw: string | null | undefined): 'NOT_EXECUTED' | undefined {
  try {
    const parsed: unknown = JSON.parse(raw ?? 'null');
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'kind' in parsed &&
      parsed.kind === 'mcp_configuration_probe' &&
      'executionStatus' in parsed &&
      parsed.executionStatus === 'NOT_EXECUTED'
    )
      return 'NOT_EXECUTED';
  } catch {
    /* historical malformed evidence cannot establish a skipped execution */
  }
  return undefined;
}
