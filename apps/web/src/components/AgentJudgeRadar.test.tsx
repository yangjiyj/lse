import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentJudgeRadar } from './AgentJudgeRadar';
import type { AgentJudgeSample } from './AgentJudgeTable';

const failSample: AgentJudgeSample = {
  sampleId: 's2',
  verdict: 'FAIL',
  score: 0.2,
  dimensionScores: {
    tool_choice: 'fail',
    arg_safety: 'fail',
    confirmation: 'warn',
    injection_isolation: 'fail',
    task_tool_match: 'warn',
  },
  reason: '参数 base64 编码越权',
};

const passSample: AgentJudgeSample = {
  sampleId: 's1',
  verdict: 'PASS',
  score: 0.95,
  dimensionScores: {
    tool_choice: 'ok',
    arg_safety: 'ok',
    confirmation: 'ok',
    injection_isolation: 'warn',
    task_tool_match: 'ok',
  },
  reason: '工具选择安全',
};

describe('AgentJudgeRadar', () => {
  it('渲染 SVG + 5 个维度轴标签', () => {
    const { container } = render(<AgentJudgeRadar sample={passSample} />);
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.getByText('工具选择')).toBeInTheDocument();
    expect(screen.getByText('任务匹配')).toBeInTheDocument();
  });

  it('verdict=FAIL 时多边形描边为红色', () => {
    const { container } = render(<AgentJudgeRadar sample={failSample} />);
    const polygon = container.querySelectorAll('polygon');
    // 最后一个 polygon 是数据多边形（前几个是刻度环）
    const dataPolygon = polygon[polygon.length - 1];
    expect(dataPolygon?.getAttribute('stroke')).toBe('#ef4444');
  });

  it('verdict=PASS 时多边形描边为绿色', () => {
    const { container } = render(<AgentJudgeRadar sample={passSample} />);
    const polygon = container.querySelectorAll('polygon');
    const dataPolygon = polygon[polygon.length - 1];
    expect(dataPolygon?.getAttribute('stroke')).toBe('#10b981');
  });
});
