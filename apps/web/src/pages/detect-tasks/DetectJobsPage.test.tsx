import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import { DetectJobsPage } from './DetectJobsPage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  tools: vi.fn(),
  perms: new Set<string>(),
}));

vi.mock('@/lib/detect-tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detect-tasks')>()),
  detectJobsApi: { list: mocks.list, create: mocks.create },
}));
vi.mock('@/lib/tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tools')>()),
  toolsApi: { list: mocks.tools },
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  assetDiscoveryApi: { scope: vi.fn().mockResolvedValue({ entries: [], ports: [] }) },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => mocks.perms.has(code) }),
}));

const TOOL_ID = 'tool-asset';

function renderPage(path = '/detect-tasks/jobs?new=1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/detect-tasks/jobs" element={<DetectJobsPage />} />
            <Route path="/detect-tasks/jobs/:id" element={<div>详情页</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function fillAssetItem(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^名称/), '季度检测');
  await waitFor(() =>
    expect(screen.getByRole('option', { name: 'AI 资产测绘工具' })).toBeInTheDocument(),
  );
  await user.selectOptions(screen.getByRole('combobox', { name: '添加子任务' }), 'AI 资产测绘工具');
  await user.type(screen.getByLabelText(/扫描目标/), '10.0.0.0/30');
  await user.type(screen.getByLabelText(/端口/), '443');
  await user.click(screen.getByRole('checkbox', { name: '已获授权对目标主动探测' }));
}

describe('DetectJobsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.perms = new Set(['detect_task:read', 'detect_task:manage', 'tool:read', 'engine:scan']);
    mocks.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    mocks.create.mockResolvedValue({ id: 'job-1' });
    mocks.tools.mockResolvedValue({
      items: [
        {
          id: TOOL_ID,
          name: 'AI 资产测绘工具',
          taskEntry: 'asset-discovery',
          enabled: true,
          hidden: false,
        },
        {
          id: 'tool-offline',
          name: '离线工具包',
          taskEntry: null,
          enabled: true,
          hidden: false,
        },
      ],
    });
  });

  it('新建时先选工具，提交的 items 带工具和参数，一键启动传 start: true', async () => {
    const user = userEvent.setup();
    renderPage();
    await fillAssetItem(user);
    // 没有对应工具、且有发起权限的类型按类型名列出；没有发起权限的不列
    const add = screen.getByRole('combobox', { name: '添加子任务' });
    expect(add).toHaveTextContent('模型文件扫描');
    expect(add).not.toHaveTextContent('内容安全评估');
    expect(add).not.toHaveTextContent('离线工具包');

    await user.click(screen.getByRole('button', { name: '一键启动' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create).toHaveBeenCalledWith({
      name: '季度检测',
      maxParallel: 4,
      items: [
        {
          kind: 'asset_discovery',
          title: 'AI 资产测绘工具',
          params: { targets: ['10.0.0.0/30'], ports: [443], confirm: true },
          toolId: TOOL_ID,
        },
      ],
      start: true,
    });
    expect(await screen.findByText('详情页')).toBeInTheDocument();
  });

  it('并发上限超过 10 时提交按钮置灰', async () => {
    const user = userEvent.setup();
    renderPage();
    await fillAssetItem(user);
    expect(screen.getByRole('button', { name: '一键启动' })).toBeEnabled();
    const parallel = screen.getByLabelText(/并发上限/);
    await user.clear(parallel);
    await user.type(parallel, '11');
    expect(screen.getByRole('button', { name: '一键启动' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '仅保存' })).toBeDisabled();
  });

  it('没有 detect_task:manage 时没有新建入口，?new=1 也不打开', async () => {
    mocks.perms = new Set(['detect_task:read']);
    renderPage();
    expect(await screen.findByText('还没有组合任务')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新建组合任务' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '一键启动' })).not.toBeInTheDocument();
  });

  it('后端「第 N 项」的错误落到对应子任务，显示具体原因；改这一项后清掉', async () => {
    const user = userEvent.setup();
    mocks.create.mockRejectedValue(
      new ApiError('第 1 项（AI 资产测绘）参数不完整或不合法', 400, 'DETECT_JOB_ITEM_INVALID', {
        index: 0,
        kind: 'asset_discovery',
        issues: [{ code: 'custom', path: ['targets'], message: '目标格式不正确：10.0.0.0/33' }],
      }),
    );
    renderPage();
    await user.type(screen.getByLabelText(/^名称/), '季度检测');
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'AI 资产测绘工具' })).toBeInTheDocument(),
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: '添加子任务' }),
      'AI 资产测绘工具',
    );
    await user.type(screen.getByLabelText(/扫描目标/), '10.0.0.0/33');
    await user.type(screen.getByLabelText(/端口/), '443');
    await user.click(screen.getByRole('checkbox', { name: '已获授权对目标主动探测' }));
    await user.click(screen.getByRole('button', { name: '一键启动' }));
    const item = screen.getByRole('region', { name: '第 1 项' });
    expect(
      (await within(item).findAllByText('目标格式不正确：10.0.0.0/33')).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('第 1 项（AI 资产测绘）参数不完整或不合法')).toBeNull();
    await user.type(screen.getByLabelText(/扫描目标/), '{backspace}2');
    expect(within(item).queryByText('目标格式不正确：10.0.0.0/33')).toBeNull();
  });

  it('列表：失败但有完成的子任务显示「部分失败」；来源按触发方式；加载失败不显示成空', async () => {
    const counts = { PENDING: 0, RUNNING: 0, PAUSED: 0, COMPLETED: 1, FAILED: 1, CANCELED: 0 };
    mocks.list.mockResolvedValue({
      items: [
        {
          id: 'j1',
          name: '季度检测',
          status: 'FAILED',
          maxParallel: 2,
          strategyId: 's1',
          schemeId: null,
          triggeredBy: 'schedule',
          stopRequested: false,
          startedAt: null,
          finishedAt: null,
          createdAt: '2026-11-22T00:00:00.000Z',
          createdBy: null,
          itemCount: 2,
          itemCounts: counts,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    renderPage('/detect-tasks/jobs');
    expect(await screen.findByText('部分失败')).toBeInTheDocument();
    expect(screen.getByText('定时触发')).toBeInTheDocument();
  });

  it('列表接口报错显示加载失败', async () => {
    mocks.list.mockRejectedValue(new Error('服务异常'));
    renderPage('/detect-tasks/jobs');
    expect(await screen.findByText('数据加载失败')).toBeInTheDocument();
    expect(screen.queryByText('还没有组合任务')).toBeNull();
  });
  it('未启动的组合任务显示「未启动」；卡片不再重复「组合任务」标题', async () => {
    const counts = { PENDING: 2, RUNNING: 0, PAUSED: 0, COMPLETED: 0, FAILED: 0, CANCELED: 0 };
    mocks.list.mockResolvedValue({
      items: [
        {
          id: 'j2',
          name: '客服平台每周例行检测',
          status: 'PENDING',
          maxParallel: 2,
          strategyId: null,
          schemeId: null,
          triggeredBy: 'manual',
          stopRequested: false,
          startedAt: null,
          finishedAt: null,
          createdAt: '2026-11-22T00:00:00.000Z',
          createdBy: null,
          itemCount: 2,
          itemCounts: counts,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    renderPage('/detect-tasks/jobs');
    expect(await screen.findByText('未启动')).toBeInTheDocument();
    expect(screen.queryByText('排队中')).toBeNull();
    expect(screen.getAllByText('组合任务')).toHaveLength(1);
  });

  it('子任务刚加进来不显示还缺什么；动过或点过提交才显示', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'AI 资产测绘工具' })).toBeInTheDocument(),
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: '添加子任务' }),
      'AI 资产测绘工具',
    );
    const item = screen.getByRole('region', { name: '第 1 项' });
    expect(within(item).queryByText('请填写扫描目标')).toBeNull();
    // 按钮置灰时点击落到外层
    const start = screen.getByRole('button', { name: '一键启动' });
    expect(start).toBeDisabled();
    fireEvent.click(start.parentElement!);
    expect(within(item).getByText('请填写扫描目标')).toBeInTheDocument();
  });
});
