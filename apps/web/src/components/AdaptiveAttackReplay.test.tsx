import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdaptiveAttackReplay } from './AdaptiveAttackReplay';

const rounds = [
  { round: 1, technique: 'boundary_reframe', modelResponse: '模型礼貌拒绝', successSignal: false },
  {
    round: 2,
    technique: 'argument_obfuscation',
    modelResponse: '模型部分配合',
    successSignal: false,
  },
  {
    round: 3,
    technique: 'authority_override',
    modelResponse: '模型执行危险调用',
    successSignal: true,
  },
];

describe('AdaptiveAttackReplay', () => {
  it('专家模式露英文枚举和招式名', () => {
    render(<AdaptiveAttackReplay rounds={rounds} mode="expert" />);
    expect(screen.getByText(/R1/)).toBeInTheDocument();
    expect(screen.getByText('boundary_reframe')).toBeInTheDocument();
    expect(screen.getByText('argument_obfuscation')).toBeInTheDocument();
  });

  it('演示模式用中文叙事，不出现英文枚举', () => {
    render(<AdaptiveAttackReplay rounds={rounds} mode="demo" />);
    expect(screen.getByText(/第 1 轮/)).toBeInTheDocument();
    expect(screen.getByText(/工具边界重定义/)).toBeInTheDocument();
    expect(screen.getByText(/第 3 轮/)).toBeInTheDocument();
    expect(screen.getByText(/权威覆盖/)).toBeInTheDocument();
    expect(screen.queryByText('boundary_reframe')).not.toBeInTheDocument();
  });

  it('风险轮显示确认风险标记', () => {
    render(<AdaptiveAttackReplay rounds={rounds} mode="expert" />);
    expect(screen.getByText('确认风险')).toBeInTheDocument();
  });

  it('旧数据首轮为 round=0 时，专家和演示模式都从第 1 轮开始', () => {
    const legacy = [
      {
        round: 0,
        technique: 'boundary_reframe',
        modelResponse: '模型礼貌拒绝',
        successSignal: false,
      },
    ];
    const { rerender } = render(<AdaptiveAttackReplay rounds={legacy} mode="expert" />);
    expect(screen.getByText('R1')).toBeInTheDocument();
    expect(screen.queryByText('R0')).not.toBeInTheDocument();
    rerender(<AdaptiveAttackReplay rounds={legacy} mode="demo" />);
    expect(screen.getByText(/第 1 轮/)).toBeInTheDocument();
    expect(screen.queryByText(/第 0 轮/)).not.toBeInTheDocument();
  });
});
