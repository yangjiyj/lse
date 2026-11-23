import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { EvalPlansPage, compareWithPreviousHref } from './EvalPlansPage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  toggle: vi.fn(),
  remove: vi.fn(),
  trigger: vi.fn(),
  runs: vi.fn(),
  targets: vi.fn(),
  sets: vi.fn(),
  engines: vi.fn(),
  perms: ['eval_task:read', 'eval_task:create', 'eval_task:delete'] as string[],
}));

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>();
  return {
    ApiError: actual.ApiError,
    api: {
      evalPlans: {
        list: mocks.list,
        create: mocks.create,
        update: mocks.update,
        toggle: mocks.toggle,
        remove: mocks.remove,
        trigger: mocks.trigger,
        runs: mocks.runs,
      },
      modelTargets: { list: mocks.targets },
      questionSets: { list: mocks.sets },
      engines: { list: mocks.engines },
    },
  };
});
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (c: string) => mocks.perms.includes(c) }),
}));

const PLAN = {
  id: 'p1',
  name: '夜间回归',
  description: null,
  targetId: 'm1',
  targetName: '客服大模型',
  targetActive: true,
  templateParams: { questionSetIds: ['s1'], engines: ['rule-judge', 'sensitive-info'] },
  cron: '0 2 * * *',
  timezone: 'Asia/Shanghai',
  enabled: true,
  minIntervalMinutes: 60,
  lastTriggeredAt: '2026-09-28T18:00:00.000Z',
  lastSkipReason: null,
  nextRunAt: '2026-09-29T18:00:00.000Z',
  taskCount: 2,
  createdBy: null,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
};

const task = (id: string, name: string) => ({
  id,
  name,
  status: 'COMPLETED',
  passedCount: 8,
  failedCount: 2,
  errorCount: 0,
  totalQuestions: 10,
  finishedAt: '2026-09-28T19:00:00.000Z',
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>
          <EvalPlansPage />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('EvalPlansPage 评估计划', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.perms = ['eval_task:read', 'eval_task:create', 'eval_task:delete'];
    mocks.list.mockResolvedValue({ items: [PLAN], total: 1, page: 1, pageSize: 20 });
    mocks.targets.mockResolvedValue({
      items: [
        { id: 'm1', name: '客服大模型', targetType: 'MODEL_API', isActive: true },
        { id: 'g1', name: '网关日志源', targetType: 'GATEWAY_LOG', isActive: true },
      ],
      total: 2,
      page: 1,
      pageSize: 100,
    });
    mocks.sets.mockResolvedValue({
      items: [{ id: 's1', name: '通用安全题库' }],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    mocks.engines.mockResolvedValue([
      { engine: 'rule-judge', builtin: true, available: true, kind: 'per-question' },
      { engine: 'sensitive-info', builtin: true, available: true, kind: 'per-question' },
    ]);
  });

  it('列表展示对象、cron 中文说明、下次执行、启停与最近运行', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: '评估计划列表' });
    for (const h of ['计划名称', '评估对象', '执行周期', '下次执行', '状态', '最近运行', '操作']) {
      expect(within(table).getByRole('columnheader', { name: h })).toBeInTheDocument();
    }
    expect(within(table).getByText('夜间回归')).toBeInTheDocument();
    expect(within(table).getByText('客服大模型')).toBeInTheDocument();
    expect(within(table).getByText('每天 02:00')).toBeInTheDocument();
    expect(within(table).getByText('0 2 * * *')).toBeInTheDocument();
    expect(within(table).getByText('已启用')).toBeInTheDocument();
    // 主操作直接可见，次要操作收进「更多」菜单
    expect(within(table).getByRole('button', { name: '立即执行' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: '运行记录' })).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: '停用' })).not.toBeInTheDocument();
    await userEvent.click(within(table).getByRole('button', { name: '更多' }));
    const menu = await screen.findByRole('menu', { name: '更多' });
    expect(within(menu).getByRole('menuitem', { name: '编辑' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: '停用' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: '删除' })).toBeInTheDocument();
  });

  it('空列表显示暂无数据', async () => {
    mocks.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderPage();
    expect(await screen.findByText('暂无数据')).toBeInTheDocument();
  });

  it('停用、立即执行（含跳过提示）调用对应接口', async () => {
    mocks.toggle.mockResolvedValue({ ...PLAN, enabled: false });
    mocks.trigger.mockResolvedValue({ status: 'triggered', runId: 'r1', taskId: 't9' });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: '评估计划列表' });
    await user.click(screen.getByRole('button', { name: '更多' }));
    await user.click(await screen.findByRole('menuitem', { name: '停用' }));
    await waitFor(() => expect(mocks.toggle).toHaveBeenCalledWith('p1', false));
    await user.click(screen.getByRole('button', { name: '立即执行' }));
    await waitFor(() => expect(mocks.trigger).toHaveBeenCalledWith('p1'));
    expect(await screen.findByText('已生成评估任务')).toBeInTheDocument();
  });

  it('新建计划：过滤网关日志对象，提交模板参数', async () => {
    mocks.create.mockResolvedValue(PLAN);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '新建计划' }));
    await user.type(screen.getByRole('textbox', { name: /^计划名称/ }), '每周回归');
    await screen.findByRole('option', { name: '客服大模型' });
    expect(screen.queryByRole('option', { name: '网关日志源' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: /^评估对象/ }), 'm1');
    await user.selectOptions(screen.getByLabelText('常用周期'), '0 3 * * 1');
    expect(screen.getByText('每周一 03:00；5 段：分 时 日 月 周')).toBeInTheDocument();
    await user.click(await screen.findByRole('checkbox', { name: '通用安全题库' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        name: '每周回归',
        description: null,
        targetId: 'm1',
        cron: '0 3 * * 1',
        timezone: 'Asia/Shanghai',
        minIntervalMinutes: 60,
        enabled: true,
        templateParams: {
          questionSetIds: ['s1'],
          engines: ['rule-judge', 'sensitive-info'],
          concurrency: 4,
        },
      }),
    );
  });

  it('新建计划：样本库默认只列种子库和自有样本库，运行记录收进“展开运行记录”', async () => {
    mocks.sets.mockResolvedValue({
      items: [
        { id: 's1', name: '通用安全题库', kind: 'seed' },
        { id: 's2', name: '客户自有样本库', kind: 'own' },
        { id: 's3', name: '[综合评估·自主红队] 运行快照', kind: 'run' },
      ],
      total: 3,
      page: 1,
      pageSize: 100,
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '新建计划' }));
    expect(await screen.findByRole('checkbox', { name: '通用安全题库' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: '客户自有样本库' })).toBeVisible();
    const summary = screen.getByText(/展开运行记录/);
    expect(summary.closest('details')).not.toHaveAttribute('open');
    await user.click(summary);
    expect(summary.closest('details')).toHaveAttribute('open');
    expect(screen.getByRole('checkbox', { name: /运行快照/ })).toBeVisible();
  });

  it('新建计划：不列已禁用的样本库', async () => {
    mocks.sets.mockResolvedValue({
      items: [
        { id: 's1', name: '通用安全题库', kind: 'seed', enabled: true },
        { id: 's9', name: '已停用题库', kind: 'own', enabled: false },
      ],
      total: 2,
      page: 1,
      pageSize: 100,
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '新建计划' }));
    expect(await screen.findByRole('checkbox', { name: '通用安全题库' })).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: /已停用题库/ })).not.toBeInTheDocument();
  });

  it('编辑计划：已选的禁用样本库标「（已禁用）」，可以取消勾选后保存', async () => {
    mocks.sets.mockResolvedValue({
      items: [
        { id: 's1', name: '通用安全题库', kind: 'own', enabled: false },
        { id: 's2', name: '客户自有样本库', kind: 'own', enabled: true },
        { id: 's9', name: '别的停用库', kind: 'own', enabled: false },
      ],
      total: 3,
      page: 1,
      pageSize: 100,
    });
    mocks.update.mockResolvedValue(PLAN);
    const user = userEvent.setup();
    renderPage();
    const table = await screen.findByRole('table', { name: '评估计划列表' });
    await user.click(within(table).getByRole('button', { name: '更多' }));
    await user.click(await screen.findByRole('menuitem', { name: '编辑' }));
    const disabledSet = await screen.findByRole('checkbox', { name: '通用安全题库（已禁用）' });
    expect(disabledSet).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /别的停用库/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: '客户自有样本库' }));
    await user.click(disabledSet);
    expect(disabledSet).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update.mock.calls[0]![1].templateParams.questionSetIds).toEqual(['s2']);
  });

  it('后端拒绝（如间隔过短）时在弹窗内显示错误', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.create.mockRejectedValue(
      new ApiError('cron 两次触发间隔小于最小间隔 60 分钟', 400, 'EVAL_PLAN_INTERVAL_TOO_SHORT'),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '新建计划' }));
    await user.type(screen.getByRole('textbox', { name: /^计划名称/ }), 'x');
    await screen.findByRole('option', { name: '客服大模型' });
    await user.selectOptions(screen.getByRole('combobox', { name: /^评估对象/ }), 'm1');
    await user.click(await screen.findByRole('checkbox', { name: '通用安全题库' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('cron 两次触发间隔小于最小间隔 60 分钟')).toBeInTheDocument();
  });

  it('运行记录：任务链接、跳过原因、与上次对比链接', async () => {
    mocks.runs.mockResolvedValue({
      items: [
        {
          id: 'r3',
          triggeredBy: 'ci',
          status: 'triggered',
          reason: null,
          createdAt: '2026-09-29T02:00:00.000Z',
          task: task('t3', '夜间回归 · 3'),
        },
        {
          id: 'r2',
          triggeredBy: 'schedule',
          status: 'skipped',
          reason: '上一次运行任务未结束（t1，RUNNING）',
          createdAt: '2026-09-29T01:00:00.000Z',
          task: null,
        },
        {
          id: 'r1',
          triggeredBy: 'manual',
          status: 'triggered',
          reason: null,
          createdAt: '2026-09-28T02:00:00.000Z',
          task: task('t1', '夜间回归 · 1'),
        },
      ],
      total: 3,
      page: 1,
      pageSize: 10,
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '运行记录' }));
    const runs = await screen.findByRole('table', { name: '运行记录' });
    expect(within(runs).getByRole('link', { name: '夜间回归 · 3' })).toHaveAttribute(
      'href',
      '/eval-tasks/t3',
    );
    expect(within(runs).getByText('CI')).toBeInTheDocument();
    expect(within(runs).getByText('已跳过')).toBeInTheDocument();
    expect(within(runs).getByText('上一次运行任务未结束（t1，RUNNING）')).toBeInTheDocument();
    const compare = within(runs).getAllByRole('link', { name: '与上次对比' });
    // 最早一次运行之前没有可对比的任务
    expect(compare).toHaveLength(1);
    expect(compare[0]).toHaveAttribute('href', compareWithPreviousHref('p1', 't3'));
    expect(compare[0]).toHaveAttribute('href', '/eval-tasks/compare?planId=p1&headTaskId=t3');
  });

  it('只读用户看不到新建与管理操作', async () => {
    mocks.perms = ['eval_task:read'];
    renderPage();
    await screen.findByRole('table', { name: '评估计划列表' });
    expect(screen.queryByRole('button', { name: '新建计划' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '立即执行' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '运行记录' })).toBeInTheDocument();
  });

  it('无查看权限时提示', () => {
    mocks.perms = [];
    renderPage();
    expect(screen.getByText('缺少查看评估计划的权限')).toBeInTheDocument();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
