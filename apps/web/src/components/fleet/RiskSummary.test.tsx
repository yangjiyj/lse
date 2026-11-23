import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, it, expect } from 'vitest';
import { RiskSummary } from './RiskSummary';
import { CHECK_CATALOG } from './check-catalog.test-data';
import type { FleetPostureFinding } from '@/lib/api';
afterEach(cleanup);
it('按对象展示三态，风险对象下的未检查也必须计入结论', () => {
  const finding = {
    ruleId: 'permissions',
    title: '权限确认',
    plainTitle: '权限确认',
    severity: 'HIGH',
    verdict: 'FAIL',
    state: 'risk',
    riskCategory: 'agent_tool_abuse',
    evidence: '发现风险',
    compliance: [],
    plainWhy: '需要人工确认',
    plainFix: '保留确认',
    subjects: [
      { kind: 'agent', name: 'Claude Code', state: 'risk', detail: '跳过确认' },
      {
        kind: 'agent',
        name: 'Hermes',
        state: 'not_checked',
        detail: '没有上报权限配置，请更新探针并重新检测。',
      },
      { kind: 'agent', name: 'Codex', state: 'clear', detail: '已完成检查' },
    ],
  } as FleetPostureFinding;
  render(<RiskSummary catalog={CHECK_CATALOG} findings={[finding]} />);
  expect(screen.getByText(/另有 1 项终端没有检查/)).toBeTruthy();
  for (const name of ['Claude Code', 'Hermes', 'Codex'])
    expect(screen.getByText(name)).toBeTruthy();
  expect(screen.getByText('已检查无风险')).toBeTruthy();
  expect(screen.getByText(/没有上报权限配置/)).toBeTruthy();
  expect(screen.queryByText('未采集')).toBeNull();
});
