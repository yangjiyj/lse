import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { EvalJudgeCalibration, EvalTaskStatistics } from '@/lib/api';
import {
  JudgeCalibrationCard,
  TaskStatisticsCard,
  differenceTone,
  formatFailRateWithInterval,
} from './EvalCredibility';

const calibration = vi.hoisted(() => vi.fn());
const sample = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { evalTasks: { judgeCalibration: calibration, judgeCalibrationSample: sample } },
}));

const TASK_ID = '11111111-1111-4111-8111-111111111111';

const stats = (over: Partial<EvalTaskStatistics> = {}): EvalTaskStatistics => ({
  sampleSize: 100,
  failedCount: 30,
  unknownCount: 10,
  errorCount: 0,
  failRate: 0.3,
  failRateLower: 0.219,
  failRateUpper: 0.396,
  unknownRate: 0.1,
  confidenceLevel: 0.95,
  warningCodes: [],
  warnings: [],
  note: '',
  ...over,
});

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TaskStatisticsCard', () => {
  it('用一句话说明小样本风险比例，详细说明可折叠', () => {
    wrap(<TaskStatisticsCard statistics={stats({ sampleSize: 10, failedCount: 3 })} />);
    expect(screen.getByText(/测了 10 条，其中 3 条有风险/)).toBeInTheDocument();
    expect(screen.getByText('了解更多')).toBeInTheDocument();
    expect(screen.queryByText(/置信区间的白话解释/)).toBeNull();
  });
  it('展示失败率、区间、样本量与未判定占比，并说明未判定不计为通过', () => {
    wrap(<TaskStatisticsCard statistics={stats()} />);
    expect(screen.getByText('30.0%')).toBeInTheDocument();
    expect(screen.getByText('21.9% ~ 39.6%')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText(/未判定（不计为通过）/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('小样本显示警告文案', () => {
    wrap(
      <TaskStatisticsCard
        statistics={stats({
          sampleSize: 8,
          warningCodes: ['TOO_FEW'],
          warnings: ['样本过少，仅供参考，不宜据此下结论。'],
        })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('仅供参考');
  });

  it('无 statistics 时不渲染', () => {
    const { container } = wrap(<TaskStatisticsCard />);
    expect(container.firstChild).toBeNull();
  });

  it('不出现原始英文术语', () => {
    const { container } = wrap(<TaskStatisticsCard statistics={stats()} />);
    expect(container.textContent).not.toMatch(/wilson|kappa/i);
  });
});

describe('格式化与差异提示', () => {
  it('失败率区间文案', () => {
    expect(formatFailRateWithInterval(stats())).toBe('30.0%（置信区间 21.9% ~ 39.6%）');
    expect(formatFailRateWithInterval(undefined)).toBe('—');
  });
  it('差异提示配色', () => {
    expect(
      differenceTone({ verdict: 'within_noise', delta: 0.1, message: '差异未超出统计波动' })
        .className,
    ).toContain('amber');
    expect(
      differenceTone({ verdict: 'beyond_noise', delta: 0.4, message: 'x' }).className,
    ).toContain('emerald');
  });
});

const okCalibration: EvalJudgeCalibration = {
  status: 'OK',
  reviewedCount: 100,
  excludedReviewedCount: 0,
  pendingCount: 30,
  minRequired: 10,
  agreementRate: 0.85,
  agreementLower: 0.77,
  agreementUpper: 0.91,
  kappa: 0.7,
  kappaLevel: '较强',
  precision: 0.8,
  recall: 0.89,
  missedRiskCount: 5,
  falseAlarmCount: 10,
  confusion: { tp: 40, fp: 10, fn: 5, tn: 45 },
  message: '基于人工已复核样本计算。',
};

describe('JudgeCalibrationCard', () => {
  beforeEach(() => {
    calibration.mockReset();
    sample.mockReset();
  });

  it('数据不足时显示提示而不是数字', async () => {
    calibration.mockResolvedValue({
      ...okCalibration,
      status: 'INSUFFICIENT',
      reviewedCount: 3,
      agreementRate: null,
      kappa: null,
      message: '数据不足：人工已复核 3 条，至少需要 10 条。',
    });
    wrap(<JudgeCalibrationCard taskId={TASK_ID} />);
    expect(await screen.findByText(/数据不足/)).toBeInTheDocument();
    expect(screen.queryByText('判定与人工一致率')).toBeNull();
  });

  it('展示一致率、漏报、误报与白话说明', async () => {
    calibration.mockResolvedValue(okCalibration);
    wrap(<JudgeCalibrationCard taskId={TASK_ID} />);
    expect(await screen.findByText('85.0%')).toBeInTheDocument();
    expect(screen.getByText('0.70')).toBeInTheDocument();
    expect(screen.getByText('较强')).toBeInTheDocument();
    expect(screen.getByText(/漏报（判通过、人工有风险）/)).toBeInTheDocument();
    expect(screen.getByText(/误报（判有风险、人工无风险）/)).toBeInTheDocument();
  });

  it('随机抽检：按数量与种子请求，并给出跳转链接', async () => {
    calibration.mockResolvedValue(okCalibration);
    sample.mockResolvedValue({
      seed: 'abc',
      size: 2,
      poolSize: 30,
      items: [
        {
          findingId: 'f1',
          resultId: 'r1',
          questionId: 'q1',
          riskCategory: 'x',
          severity: 'HIGH',
          verdict: 'FAIL',
          reviewStatus: 'UNREVIEWED',
          title: '标题一',
        },
        {
          findingId: 'f2',
          resultId: 'r2',
          questionId: 'q2',
          riskCategory: 'y',
          severity: 'LOW',
          verdict: 'FAIL',
          reviewStatus: 'UNREVIEWED',
          title: null,
        },
      ],
    });
    wrap(<JudgeCalibrationCard taskId={TASK_ID} />);
    await screen.findByText('85.0%');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('随机种子'), 'abc');
    await user.click(screen.getByRole('button', { name: '随机抽取' }));
    await waitFor(() => expect(sample).toHaveBeenCalledWith(TASK_ID, { size: 20, seed: 'abc' }));
    const link = await screen.findByRole('link', { name: '前往风险样本逐条复核' });
    expect(link.getAttribute('href')).toBe(`/wrong-answers?taskId=${TASK_ID}&findingIds=f1,f2`);
    expect(screen.getByText(/标题一/)).toBeInTheDocument();
  });
});
