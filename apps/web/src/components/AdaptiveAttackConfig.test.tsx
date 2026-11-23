import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AdaptiveAttackConfig } from './AdaptiveAttackConfig';

describe('AdaptiveAttackConfig', () => {
  it('开关关闭时不显示轮数和模型选择', () => {
    render(
      <AdaptiveAttackConfig value={{ enabled: false }} onChange={() => {}} attackerTargets={[]} />,
    );
    expect(screen.queryByText('轮数')).not.toBeInTheDocument();
  });

  it('开关从关到开触发 onChange enabled=true', () => {
    const onChange = vi.fn();
    render(
      <AdaptiveAttackConfig value={{ enabled: false }} onChange={onChange} attackerTargets={[]} />,
    );
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('开启后显示轮数滑块和攻击脑模型下拉', () => {
    render(
      <AdaptiveAttackConfig
        value={{ enabled: true, rounds: 3 }}
        onChange={() => {}}
        attackerTargets={[{ id: 'u1', name: 'gpt-4o', model: 'gpt-4o' }]}
      />,
    );
    expect(screen.getByText('轮数')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o（gpt-4o）')).toBeInTheDocument();
  });
});
