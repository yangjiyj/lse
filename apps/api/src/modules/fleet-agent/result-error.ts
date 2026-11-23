import { runnerProducts, registryComplete } from '../fleet-admin/agents.js';
/** 结果已经过结构校验；未登记必须有终端的登记状态佐证，不能仅从跳过结果推测。 */
export function resultErrorCode(
  result: Record<string, unknown>,
  product: string,
  health: unknown,
): string {
  const scenarios = Array.isArray(result.scenarios)
    ? (result.scenarios as Array<Record<string, unknown>>)
    : [];
  if (scenarios.length && scenarios.every((s) => s.status === 'skipped')) {
    const registry = runnerProducts(health);
    const entry = registry.find((p) => p.product === product);
    if (entry?.registered === false || (!entry && registryComplete(health)))
      return 'product_not_registered';
    return 'all_scenarios_skipped';
  }
  // 有场景跑完就先按「部分没跑完」说：已完成的结果仍有效，不能说成整批没有完成检查
  if (hasPartialCompletion(scenarios)) return 'partial_scenario_failed';
  if (scenarios.some((s) => s.status === 'timeout')) return 'scenario_timeout';
  return 'scenario_failed';
}

/** 至少一个场景跑完、且至少一个没跑完。 */
export function hasPartialCompletion(scenarios: ReadonlyArray<Record<string, unknown>>): boolean {
  return scenarios.some((s) => s.status === 'completed') && scenarios.some((s) => s.status !== 'completed');
}
