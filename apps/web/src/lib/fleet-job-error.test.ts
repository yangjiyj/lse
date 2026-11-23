import { it, expect } from 'vitest';
import { fleetJobError } from './fleet-job-error';
it('任务错误码全部提供中文原因和处理办法，未知代码也不直接展示', () => {
  for (const code of [
    'scenario_failed',
    'invalid_result',
    'partial_scenario_failed',
    'scenario_timeout',
    'product_not_registered',
    'all_scenarios_skipped',
    'RUNNER_TIMEOUT',
    'unknown_private_code',
  ]) {
    const text = fleetJobError(code, 'codex');
    expect(text).toMatch(/请/);
    expect(text).not.toContain(code);
  }
  expect(fleetJobError('product_not_registered', 'codex')).toMatch(/Codex.*登记|登记.*Codex/);
});

it('终端超时未回传的任务显示中文原因，不出现内部错误码', () => {
  const text = fleetJobError('result_overdue', 'codex');
  expect(text).toMatch(/终端超时未回传/);
  expect(text).not.toContain('result_overdue');
});

it('被强制结束的任务显示中文原因，不出现内部错误码', () => {
  const text = fleetJobError('force_closed', 'codex');
  expect(text).toMatch(/已强制结束/);
  expect(text).not.toContain('force_closed');
});
