import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  DateRangeFilter,
  ModalNotice,
  OutcomeSummary,
  TaskProgress,
  TaskScoreCell,
  TaskStatusNote,
} from './task-list-parts';

const base = {
  status: 'COMPLETED',
  totalQuestions: 6,
  processedQuestions: 6,
  passedCount: 0,
  failedCount: 2,
  errorCount: 0,
  progress: 1,
};

describe('任务列表组件', () => {
  it('OutcomeSummary 显示结论主徽章与次要计数，悬停保留完整原因', () => {
    render(<OutcomeSummary task={base} />);
    const badge = screen.getByText('发现 2 项风险');
    expect(badge).toHaveAttribute('tabindex', '0');
    expect(badge).toHaveAttribute('title');
    expect(screen.getByText(/通过 0 · 风险 2/)).toBeInTheDocument();
  });

  it('TaskProgress 渲染已处理/总数与进度条', () => {
    render(<TaskProgress processed={3} total={6} status="RUNNING" />);
    expect(screen.getByText('3/6')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '执行进度' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    );
  });

  it('TaskProgress 总数为 0 时不除零', () => {
    render(<TaskProgress processed={0} total={0} status="PENDING" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('DateRangeFilter 保留可访问名称并回调', () => {
    const onFrom = vi.fn();
    const onTo = vi.fn();
    render(
      <DateRangeFilter
        from=""
        to=""
        onFrom={onFrom}
        onTo={onTo}
        fromLabel="执行时间起"
        toLabel="执行时间止"
      />,
    );
    fireEvent.change(screen.getByLabelText('执行时间起'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('执行时间止'), { target: { value: '2026-09-28' } });
    expect(onFrom).toHaveBeenCalledWith('2026-09-01');
    expect(onTo).toHaveBeenCalledWith('2026-09-28');
  });

  it('ModalNotice 渲染主文案与补充说明', () => {
    render(<ModalNotice detail="补充">主文案</ModalNotice>);
    expect(screen.getByText('主文案')).toBeInTheDocument();
    expect(screen.getByText('补充')).toBeInTheDocument();
  });
});

describe('P0-05 已取消任务的结论行', () => {
  const canceled = {
    status: 'CANCELED',
    totalQuestions: 200,
    processedQuestions: 102,
    passedCount: 46,
    failedCount: 2,
    errorCount: 54,
    progress: 0.51,
  };

  it('已取消：显示「已取消，未形成结论（已处理 102/200）」，不显示「发现 N 项风险」', () => {
    render(<OutcomeSummary task={canceled} />);
    expect(screen.getByText('已取消，未形成结论（已处理 102/200）')).toBeInTheDocument();
    expect(screen.queryByText(/发现 2 项风险/)).not.toBeInTheDocument();
    expect(screen.queryByText('评估不完整，未形成完整结论')).not.toBeInTheDocument();
  });

  it('已取消：统计行仍如实展示已产生的计数', () => {
    render(<OutcomeSummary task={canceled} />);
    expect(screen.getByText(/通过 46 · 风险 2 · 异常 54/)).toBeInTheDocument();
  });

  it('非取消任务的结论文案不变', () => {
    render(
      <OutcomeSummary
        task={{
          ...canceled,
          status: 'COMPLETED',
          processedQuestions: 200,
          passedCount: 198,
          failedCount: 2,
          errorCount: 0,
          progress: 1,
        }}
      />,
    );
    expect(screen.getByText('发现 2 项风险')).toBeInTheDocument();
  });
});

describe('P1-06 结论统计行', () => {
  const incomplete = {
    status: 'FAILED',
    totalQuestions: 6,
    processedQuestions: 6,
    passedCount: 0,
    failedCount: 0,
    errorCount: 0,
    progress: 1,
  };

  it('「跳过引擎」为 0 时整项隐藏', () => {
    render(<OutcomeSummary task={{ ...incomplete, skippedEngineCount: 0 }} />);
    expect(screen.getByText('通过 0 · 风险 0 · 异常 0 · 未判定 6')).toBeInTheDocument();
    expect(screen.queryByText(/跳过引擎/)).not.toBeInTheDocument();
  });

  it('「跳过引擎」大于 0 时保留', () => {
    render(<OutcomeSummary task={{ ...incomplete, skippedEngineCount: 2 }} />);
    expect(
      screen.getByText('通过 0 · 风险 0 · 异常 0 · 未判定 6 · 跳过引擎 2'),
    ).toBeInTheDocument();
  });

  it('统计行可换行并带悬停全文，不再被单行截断', () => {
    render(<OutcomeSummary task={{ ...incomplete, skippedEngineCount: 2 }} />);
    const line = screen.getByText(/通过 0 · 风险 0/);
    expect(line).toHaveAttribute('title', '通过 0 · 风险 0 · 异常 0 · 未判定 6 · 跳过引擎 2');
    expect(line.className).not.toMatch(/\btruncate\b/);
    expect(line.className).toMatch(/line-clamp-2|break-words/);
  });
});

describe('P0-04 评估得分单元格', () => {
  const complete = {
    status: 'COMPLETED',
    totalQuestions: 4,
    processedQuestions: 4,
    passedCount: 4,
    failedCount: 0,
    errorCount: 0,
    progress: 1,
  };

  it('完整任务显示一位小数得分', () => {
    render(<TaskScoreCell task={{ ...complete, evalScore: 87 }} />);
    expect(screen.getByText('87.0')).toBeInTheDocument();
  });

  it('评估不完整（后端 evalScore 为 null）：显示「—（评估不完整）」，不出数字', () => {
    render(
      <TaskScoreCell
        task={{ ...complete, passedCount: 2, processedQuestions: 4, evalScore: null }}
      />,
    );
    expect(screen.getByText('—（评估不完整）')).toBeInTheDocument();
    expect(screen.queryByText(/\d+\.\d/)).not.toBeInTheDocument();
  });

  it('评估不完整时即便收到旧的数字也不显示（前后端版本错位的保护）', () => {
    render(
      <TaskScoreCell
        task={{ ...complete, passedCount: 2, processedQuestions: 4, evalScore: 100 }}
      />,
    );
    expect(screen.getByText('—（评估不完整）')).toBeInTheDocument();
    expect(screen.queryByText('100.0')).not.toBeInTheDocument();
  });

  it('尚未开始/排队中的任务只显示「—」，不贴「评估不完整」', () => {
    render(
      <TaskScoreCell
        task={{
          ...complete,
          status: 'PENDING',
          processedQuestions: 0,
          passedCount: 0,
          evalScore: null,
        }}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/评估不完整/)).not.toBeInTheDocument();
  });
});

describe('P1-06 状态副文', () => {
  it('终端任务的状态副文最多两行并带悬停全文，不再单行截断', () => {
    render(<TaskStatusNote targetType="ENDPOINT_AGENT" description="终端管理员已驳回：原因说明" />);
    const el = screen.getByText('终端管理员已驳回：原因说明');
    expect(el).toHaveAttribute('title', '终端管理员已驳回：原因说明');
    expect(el.className).toContain('line-clamp-2');
    expect(el.className).not.toMatch(/\btruncate\b/);
  });

  it('超长原始日志压成一行并限长，完整内容放 title', () => {
    const long = '原始日志'.repeat(1000);
    render(<TaskStatusNote targetType="ENDPOINT_AGENT" description={long} />);
    const el = screen.getByTitle(/原始日志/);
    expect(el.textContent!.length).toBeLessThanOrEqual(121);
    expect(el.textContent!.endsWith('…')).toBe(true);
  });

  it('普通任务或没有说明时不渲染', () => {
    const { container } = render(
      <>
        <TaskStatusNote targetType="MODEL" description="内部配置" />
        <TaskStatusNote targetType="ENDPOINT_AGENT" description={null} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
