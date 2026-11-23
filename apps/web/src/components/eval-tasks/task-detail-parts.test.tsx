import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { EvalTaskDetail } from '@/lib/api';
import { SectionHeading, Stat, TaskSummaryCard } from './task-detail-parts';

const task = {
  id: 't1',
  name: '一个很长的任务名称 deepseek-v4-flash 智能体工具安全评估',
  description: null,
  status: 'COMPLETED',
  modelTarget: { id: 'm1', name: 'deepseek', model: 'ds-v4', targetType: 'MODEL' },
  engines: [],
  questionSets: [{ id: 'q1', name: '样本库甲', questionCount: 12 }],
  totalQuestions: 12,
  processedQuestions: 6,
  passedCount: 4,
  failedCount: 1,
  errorCount: 0,
  startedAt: null,
  finishedAt: null,
} as unknown as EvalTaskDetail;

describe('详情页组件', () => {
  it('TaskSummaryCard 展示名称、对象、进度与操作区', () => {
    render(<TaskSummaryCard task={task} actions={<button>复测</button>} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('一个很长的任务名称');
    expect(screen.getByText('deepseek（ds-v4）')).toBeInTheDocument();
    expect(screen.getByText('默认内置')).toBeInTheDocument();
    expect(screen.getByText('6/12（50%）')).toBeInTheDocument();
    expect(screen.getByText('样本库甲（12）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复测' })).toBeInTheDocument();
  });

  it('SectionHeading 与 Stat 渲染文本', () => {
    render(
      <>
        <SectionHeading title="结论与评分" />
        <Stat label="通过" value={4} />
      </>,
    );
    expect(screen.getByRole('heading', { name: '结论与评分' })).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });
});

describe('P0-04 详情页顶部得分徽标', () => {
  const full = {
    ...task,
    totalQuestions: 4,
    processedQuestions: 4,
    passedCount: 4,
    failedCount: 0,
    errorCount: 0,
    progress: 1,
  } as unknown as EvalTaskDetail;

  it('完整任务显示「综合评估得分 N」', () => {
    render(
      <TaskSummaryCard task={{ ...full, evalScore: 92.5 } as EvalTaskDetail} actions={null} />,
    );
    expect(screen.getByText('综合评估得分 92.5')).toBeInTheDocument();
  });

  it('评估不完整：徽标显示「—（评估不完整）」，不出数字', () => {
    render(
      <TaskSummaryCard
        task={{ ...full, passedCount: 2, evalScore: null } as unknown as EvalTaskDetail}
        actions={null}
      />,
    );
    expect(screen.getByText('综合评估得分 —（评估不完整）')).toBeInTheDocument();
    expect(screen.queryByText(/综合评估得分 \d/)).not.toBeInTheDocument();
  });

  it('评估不完整时即便收到旧数字也不显示', () => {
    render(
      <TaskSummaryCard
        task={{ ...full, passedCount: 2, evalScore: 100 } as unknown as EvalTaskDetail}
        actions={null}
      />,
    );
    expect(screen.queryByText(/100\.0/)).not.toBeInTheDocument();
    expect(screen.getByText('综合评估得分 —（评估不完整）')).toBeInTheDocument();
  });

  it('排队中/未处理的任务不显示得分徽标', () => {
    render(
      <TaskSummaryCard
        task={
          {
            ...full,
            status: 'PENDING',
            processedQuestions: 0,
            passedCount: 0,
            evalScore: 100,
          } as unknown as EvalTaskDetail
        }
        actions={null}
      />,
    );
    expect(screen.queryByText(/综合评估得分/)).not.toBeInTheDocument();
  });
});
