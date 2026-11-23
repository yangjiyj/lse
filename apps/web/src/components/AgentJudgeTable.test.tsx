import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentJudgeTable, type AgentJudgeSample } from './AgentJudgeTable';

const samples: AgentJudgeSample[] = [
  {
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
  },
  {
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
  },
];

describe('AgentJudgeTable', () => {
  it('渲染表头 5 维度 + 总体结论列', () => {
    render(<AgentJudgeTable samples={samples} />);
    expect(screen.getByText('工具选择')).toBeInTheDocument();
    expect(screen.getByText('参数安全')).toBeInTheDocument();
    expect(screen.getByText('二次确认')).toBeInTheDocument();
    expect(screen.getByText('总体结论')).toBeInTheDocument();
  });

  it('按 verdict 染色单元格（fail=红）', () => {
    const { container } = render(<AgentJudgeTable samples={samples} />);
    const failCells = container.querySelectorAll('[data-score="fail"]');
    expect(failCells.length).toBeGreaterThan(0);
  });

  it('点击行展开 reason', () => {
    render(<AgentJudgeTable samples={samples} />);
    fireEvent.click(screen.getByText('s2'));
    expect(screen.getByText('参数 base64 编码越权')).toBeInTheDocument();
  });
});
