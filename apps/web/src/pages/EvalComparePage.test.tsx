import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { EvalComparePage } from './EvalComparePage';

const apiMock = vi.hoisted(() => ({
  compare: vi.fn(),
  plans: vi.fn(),
  tasks: vi.fn(),
  regression: vi.fn(),
}));

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>();
  return {
    ApiError: actual.ApiError,
    api: {
      evalTasks: { compare: apiMock.compare },
      evalPlans: {
        list: apiMock.plans,
        tasks: apiMock.tasks,
        regression: apiMock.regression,
      },
    },
  };
});
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

function LocationProbe() {
  const loc = useLocation();
  return <output aria-label="当前地址">{`${loc.pathname}${loc.search}`}</output>;
}

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver;

function item(id: string, modelName: string, evalScore: number | null, passRate: number | null) {
  return {
    id,
    name: `批次 · ${modelName}`,
    status: 'COMPLETED',
    batchId: 'b1',
    modelName,
    passedCount: 8,
    failedCount: 2,
    errorCount: 0,
    processedQuestions: 10,
    totalQuestions: 10,
    passRate,
    evalScore,
    riskLevels: { HIGH: 2, MEDIUM: 1, LOW: 0 },
    categories: [{ category: '隐私保护', passed: 4, failed: 1, passRate: 0.8 }],
  };
}

function run(id: string, n: number) {
  return {
    id,
    name: `夜间回归 · 第${n}次`,
    status: 'COMPLETED',
    createdAt: `2026-09-2${n}T02:00:00.000Z`,
    finishedAt: `2026-09-2${n}T03:00:00.000Z`,
    totalQuestions: 3,
    passedCount: 2,
    failedCount: 1,
    errorCount: 0,
    passRate: 0.67,
  };
}

function regTask(id: string, name: string, evalScore: number, passRate: number) {
  return {
    id,
    name,
    status: 'COMPLETED',
    planId: 'p1',
    modelName: '客服大模型',
    createdAt: '2026-09-28T02:00:00.000Z',
    finishedAt: '2026-09-28T03:00:00.000Z',
    passedCount: 2,
    failedCount: 1,
    errorCount: 0,
    passRate,
    evalScore,
  };
}

const q = (id: string, category: string, baseVerdict: string, headVerdict: string) => ({
  questionId: id,
  category,
  baseVerdict,
  headVerdict,
  externalId: `Q-${id}`,
  content: `题目 ${id}`,
  severity: 'HIGH',
});

const REGRESSION = {
  base: regTask('t2', '夜间回归 · 第2次', 80, 0.75),
  head: regTask('t3', '夜间回归 · 第3次', 72.5, 0.5),
  newlyFailed: [q('q1', '隐私保护', 'PASS', 'FAIL'), q('q2', '违法违规', 'PASS', 'ERROR')],
  fixed: [q('q3', '隐私保护', 'FAIL', 'PASS')],
  stillFailing: [],
  categories: [
    {
      category: '违法违规',
      aligned: 2,
      basePassRate: 1,
      headPassRate: 0.5,
      passRateDelta: -0.5,
      newlyFailed: 1,
      fixed: 0,
      stillFailing: 0,
    },
    {
      category: '隐私保护',
      aligned: 2,
      basePassRate: 0.5,
      headPassRate: 0.5,
      passRateDelta: 0,
      newlyFailed: 1,
      fixed: 1,
      stillFailing: 0,
    },
  ],
  summary: {
    aligned: 4,
    onlyInBase: 1,
    onlyInHead: 0,
    newlyFailed: 2,
    fixed: 1,
    stillFailing: 0,
    itemLimit: 500,
    scoreDelta: -7.5,
    passRateDelta: -0.25,
  },
};

function renderAt(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/eval-tasks/compare"
            element={
              <>
                <EvalComparePage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('EvalComparePage 任务对比', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.compare.mockResolvedValue({
      items: [item('t1', '模型甲', 74, 0.8), item('t2', '模型乙', null, null)],
    });
    apiMock.plans.mockResolvedValue({
      items: [{ id: 'p1', name: '夜间回归计划' }],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    apiMock.tasks.mockResolvedValue({ items: [run('t3', 3), run('t2', 2), run('t1', 1)] });
    apiMock.regression.mockResolvedValue(REGRESSION);
  });

  it('按 batchId 请求并展示得分、通过率、风险数与分类别通过率', async () => {
    renderAt('/eval-tasks/compare?batchId=b1');
    expect(await screen.findByRole('heading', { name: '任务对比' })).toBeInTheDocument();
    expect(apiMock.compare).toHaveBeenCalledWith({ ids: undefined, batchId: 'b1' });
    const table = await screen.findByRole('table', { name: '任务对比' });
    for (const h of ['评估对象', '评估得分', '通过率', '高风险', '中风险', '低风险']) {
      expect(within(table).getByRole('columnheader', { name: h })).toBeInTheDocument();
    }
    expect(within(table).getByText('模型甲')).toBeInTheDocument();
    expect(within(table).getByText('74.0')).toBeInTheDocument();
    const cat = screen.getByRole('table', { name: '分类别通过率' });
    expect(within(cat).getByText('隐私保护')).toBeInTheDocument();
    expect(within(cat).getAllByText('80%')).toHaveLength(2);
    expect(screen.getByRole('img', { name: '分类别通过率雷达图' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '评估得分与通过率对比柱状图' })).toBeInTheDocument();
  });

  it('英文类别归一到中文并合并同义行，通过数相加后重算通过率', async () => {
    const mk = (id: string, categories: Array<[string, number, number]>) => ({
      ...item(id, '同一模型', 70, 0.7),
      categories: categories.map(([category, passed, failed]) => ({
        category,
        passed,
        failed,
        passRate: passed + failed ? passed / (passed + failed) : null,
      })),
    });
    apiMock.compare.mockResolvedValue({
      items: [
        // 提示注入 3 过 1 败 + Prompt Injection 1 过 3 败 → 合并后 4/8 = 50%
        mk('t1', [
          ['提示注入', 3, 1],
          ['Prompt Injection', 1, 3],
          ['Bias and Discrimination', 2, 0],
        ]),
        mk('t2', [['提示注入', 1, 1]]),
      ],
    });
    renderAt('/eval-tasks/compare?ids=t1,t2');
    const cat = await screen.findByRole('table', { name: '分类别通过率' });
    expect(within(cat).queryByText('Prompt Injection')).not.toBeInTheDocument();
    expect(within(cat).queryByText('Bias and Discrimination')).not.toBeInTheDocument();
    expect(within(cat).getAllByText('提示注入')).toHaveLength(1);
    expect(within(cat).getByText('偏见歧视')).toBeInTheDocument();
    const row = within(cat).getByText('提示注入').closest('tr')!;
    expect(row).toHaveTextContent('50%');
  });

  it('同一模型的两个任务在表头与对比表里用「任务 A / B」区分', async () => {
    apiMock.compare.mockResolvedValue({
      items: [item('t1', '同名模型', 70, 0.7), item('t2', '同名模型', 60, 0.6)],
    });
    renderAt('/eval-tasks/compare?ids=t1,t2');
    const cat = await screen.findByRole('table', { name: '分类别通过率' });
    expect(within(cat).getByRole('columnheader', { name: /任务 A/ })).toBeInTheDocument();
    expect(within(cat).getByRole('columnheader', { name: /任务 B/ })).toBeInTheDocument();
  });

  it('分类别表格放在 min-w-0 的横向滚动容器里，第二个任务的列不会被裁掉', async () => {
    renderAt('/eval-tasks/compare?batchId=b1');
    const cat = await screen.findByRole('table', { name: '分类别通过率' });
    const scroller = cat.parentElement!.parentElement!;
    expect(scroller).toHaveClass('min-w-0');
    expect(cat.parentElement).toHaveClass('min-w-0', 'md:overflow-x-auto');
    expect(within(cat).getAllByRole('columnheader')).toHaveLength(3);
  });

  it('类别不超过 12 个画雷达图；超过后改画条形图并提示只展示前 10 个', async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        category: `类别${String(i + 1).padStart(2, '0')}`,
        passed: i,
        failed: 20 - i,
        passRate: i / 20,
      }));
    apiMock.compare.mockResolvedValue({
      items: [
        { ...item('t1', '模型甲', 70, 0.7), categories: many(12) },
        { ...item('t2', '模型乙', 60, 0.6), categories: many(12) },
      ],
    });
    const { unmount } = renderAt('/eval-tasks/compare?ids=t1,t2');
    expect(await screen.findByRole('img', { name: '分类别通过率雷达图' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '分类别通过率条形图' })).not.toBeInTheDocument();
    unmount();

    apiMock.compare.mockResolvedValue({
      items: [
        { ...item('t1', '模型甲', 70, 0.7), categories: many(13) },
        { ...item('t2', '模型乙', 60, 0.6), categories: many(13) },
      ],
    });
    renderAt('/eval-tasks/compare?ids=t1,t2');
    expect(await screen.findByRole('img', { name: '分类别通过率条形图' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '分类别通过率雷达图' })).not.toBeInTheDocument();
    expect(screen.getByText(/类别较多（13 个）.*前\s*10\s*个类别/)).toBeInTheDocument();
  });

  it('未指定任务时提示从任务列表勾选', async () => {
    renderAt('/eval-tasks/compare');
    expect(await screen.findByText('未选择对比任务')).toBeInTheDocument();
    expect(apiMock.compare).not.toHaveBeenCalled();
  });

  it('计划相邻运行回归：汇总、新增失败/已修复/仍失败、各类别变化', async () => {
    const user = userEvent.setup();
    renderAt('/eval-tasks/compare?planId=p1&headTaskId=t3');
    expect(await screen.findByRole('heading', { name: '回归对比' })).toBeInTheDocument();
    await waitFor(() =>
      expect(apiMock.regression).toHaveBeenCalledWith({
        planId: 'p1',
        headTaskId: 't3',
        baseTaskId: undefined,
      }),
    );
    expect(apiMock.compare).not.toHaveBeenCalled();
    const overview = await screen.findByRole('table', { name: '回归对比概览' });
    expect(within(overview).getByRole('link', { name: '夜间回归 · 第2次' })).toHaveAttribute(
      'href',
      '/eval-tasks/t2',
    );
    expect(within(overview).getByText('80.0')).toBeInTheDocument();
    expect(within(overview).getByText('72.5')).toBeInTheDocument();
    const summary = screen.getByLabelText('回归变化汇总');
    expect(within(summary).getByText('-7.5')).toBeInTheDocument();
    expect(within(summary).getByText('-25.0 个百分点')).toBeInTheDocument();
    // 默认页签：新增失败
    const failed = screen.getByRole('table', { name: '新增失败题目' });
    expect(within(failed).getByText('Q-q1')).toBeInTheDocument();
    expect(within(failed).getByText('执行异常')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '已修复（1）' }));
    expect(
      within(screen.getByRole('table', { name: '已修复题目' })).getByText('题目 q3'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '仍失败（0）' }));
    expect(screen.getByText('暂无数据')).toBeInTheDocument();
    const cats = screen.getByRole('table', { name: '各类别变化' });
    expect(within(cats).getByText('-50.0 个百分点')).toBeInTheDocument();
    expect(within(cats).getByText('0.0 个百分点')).toBeInTheDocument();
  });

  it('按计划选运行：选择计划与基线运行后更新地址参数', async () => {
    const user = userEvent.setup();
    renderAt('/eval-tasks/compare');
    const plan = await screen.findByRole('combobox', { name: '评估计划' });
    await within(plan).findByRole('option', { name: '夜间回归计划' });
    await user.selectOptions(plan, 'p1');
    await waitFor(() =>
      expect(screen.getByLabelText('当前地址')).toHaveTextContent('/eval-tasks/compare?planId=p1'),
    );
    const base = await screen.findByRole('combobox', { name: '基线运行' });
    await within(base).findByRole('option', { name: /第1次/ });
    // 本次默认最近一次（t3），基线只能选更早的运行
    expect(within(base).queryByRole('option', { name: /第3次/ })).not.toBeInTheDocument();
    await user.selectOptions(base, 't1');
    await waitFor(() =>
      expect(screen.getByLabelText('当前地址')).toHaveTextContent(
        '/eval-tasks/compare?planId=p1&headTaskId=t3&baseTaskId=t1',
      ),
    );
    await waitFor(() =>
      expect(apiMock.regression).toHaveBeenLastCalledWith({
        planId: 'p1',
        headTaskId: 't3',
        baseTaskId: 't1',
      }),
    );
  });

  it('运行次数不足时显示后端原因', async () => {
    const { ApiError } = await import('@/lib/api');
    apiMock.regression.mockRejectedValue(
      new ApiError(
        '该计划运行次数不足两次，暂无可对比的相邻运行',
        400,
        'REGRESSION_NOT_ENOUGH_RUNS',
      ),
    );
    renderAt('/eval-tasks/compare?planId=p1');
    expect(
      await screen.findByText('该计划运行次数不足两次，暂无可对比的相邻运行'),
    ).toBeInTheDocument();
  });

  it('任选两个任务：多模型对比页给出按题目回归入口', async () => {
    renderAt('/eval-tasks/compare?ids=t1,t2');
    expect(await screen.findByRole('link', { name: '按题目回归对比这两个任务' })).toHaveAttribute(
      'href',
      '/eval-tasks/compare?baseTaskId=t1&headTaskId=t2',
    );
  });
});
