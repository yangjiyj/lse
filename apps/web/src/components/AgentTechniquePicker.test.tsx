import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentTechniquePicker } from './AgentTechniquePicker';

const techniques = [
  { id: 'boundary_reframe', level: 'L1', label: '工具边界重定义', description: 'desc1' },
  { id: 'authority_override', level: 'L6', label: '权威覆盖', description: 'desc6' },
];

describe('AgentTechniquePicker', () => {
  it('渲染所有技术项，中文标签直显，英文技术码收进技术细节', () => {
    render(<AgentTechniquePicker techniques={techniques} selected={[]} onChange={() => {}} />);
    // 中文标签在普通视图与技术细节里各出现一次
    expect(screen.getAllByText('工具边界重定义').length).toBeGreaterThan(0);
    expect(screen.getAllByText('权威覆盖').length).toBeGreaterThan(0);
    // 英文技术码 / L 编号只在技术细节折叠区里出现
    expect(screen.getByText('L1')).toBeInTheDocument();
    expect(screen.getByText('boundary_reframe')).toBeInTheDocument();
    expect(screen.getByText('L6')).toBeInTheDocument();
    expect(screen.getByText('authority_override')).toBeInTheDocument();
  });

  it('提供覆盖范围预设，完整覆盖选中所有策略', () => {
    const onChange = vi.fn();
    render(<AgentTechniquePicker techniques={techniques} selected={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText('完整覆盖（推荐）'));
    expect(onChange).toHaveBeenCalledWith(['boundary_reframe', 'authority_override']);
  });

  it('点击未选项触发 onChange 加入选中集', () => {
    const onChange = vi.fn();
    render(<AgentTechniquePicker techniques={techniques} selected={[]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('technique-boundary_reframe'));
    expect(onChange).toHaveBeenCalledWith(['boundary_reframe']);
  });

  it('点击已选项触发 onChange 移除', () => {
    const onChange = vi.fn();
    render(
      <AgentTechniquePicker
        techniques={techniques}
        selected={['boundary_reframe']}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('technique-boundary_reframe'));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
