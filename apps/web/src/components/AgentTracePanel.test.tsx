import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { EvalResultFinding } from '@/lib/api';
import { AgentTracePanel } from './AgentTracePanel';

function finding(trace: Record<string, unknown>[]): EvalResultFinding {
  return {
    engine: 'agent-tool-guard',
    riskCategory: 'agent_tool_abuse',
    verdict: 'FAIL',
    severity: 'HIGH',
    detail: { trace },
  };
}

describe('AgentTracePanel', () => {
  it.each([false, true])('平台已执行的轨迹不显示沙箱处置（allowed=%s）', (allowed) => {
    render(<AgentTracePanel findings={[finding([{
      toolName: 'fetch_url', arguments: { url: 'https://sink.example' },
      allowed, observed: true, blockReason: '命中外发风险', turnIndex: 0,
    }])]} />);

    expect(screen.getByText('平台已执行（事后观测）')).toBeInTheDocument();
    expect(screen.getByText('展示平台实际执行的工具、调用参数和事后观测结果')).toBeInTheDocument();
    expect(screen.getByText('观测依据')).toBeInTheDocument();
    expect(screen.queryByText('评估沙箱已阻断')).not.toBeInTheDocument();
    expect(screen.queryByText('未阻断')).not.toBeInTheDocument();
  });

  it('保留模拟轨迹的沙箱阻断结果', () => {
    render(<AgentTracePanel findings={[finding([{
      toolName: 'fetch_url', allowed: false, blockReason: '禁止外发',
    }])]} />);

    expect(screen.getByText('评估沙箱已阻断')).toBeInTheDocument();
    expect(screen.getByText('阻断原因')).toBeInTheDocument();
  });
});
