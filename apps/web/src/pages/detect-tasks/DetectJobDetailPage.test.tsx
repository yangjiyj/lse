import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import type { DetectJobDetail } from '@/lib/detect-tasks';
import { DetectJobDetailPage } from './DetectJobDetailPage';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  lifecycle: vi.fn(),
  remove: vi.fn(),
  report: vi.fn(),
  templates: vi.fn(),
  action: vi.fn(),
  perms: new Set<string>(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...original,
    api: { ...original.api, reportTemplates: { list: mocks.templates } },
  };
});

vi.mock('@/lib/detect-tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detect-tasks')>()),
  detectJobsApi: {
    get: mocks.get,
    lifecycle: mocks.lifecycle,
    remove: mocks.remove,
    report: mocks.report,
  },
  detectTasksApi: { action: mocks.action },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => mocks.perms.has(code) }),
}));

const counts = (o: Partial<Record<string, number>> = {}) => ({
  PENDING: 0,
  RUNNING: 0,
  PAUSED: 0,
  COMPLETED: 0,
  FAILED: 0,
  CANCELED: 0,
  ...o,
});

function jobFixture(o: Partial<DetectJobDetail> = {}): DetectJobDetail {
  return {
    id: 'job-1',
    name: '季度检测',
    status: 'PAUSED',
    maxParallel: 2,
    strategyId: null,
    schemeId: null,
    triggeredBy: 'manual',
    stopRequested: false,
    startedAt: '2026-11-22T01:00:00.000Z',
    finishedAt: null,
    createdAt: '2026-11-22T00:00:00.000Z',
    createdBy: { id: 'u1', username: 'admin' },
    itemCount: 2,
    itemCounts: counts({ COMPLETED: 1, PAUSED: 1 }),
    items: [
      {
        id: 'i1',
        position: 0,
        kind: 'eval_task',
        kindLabel: '内容安全评估',
        category: 'content',
        title: '内容评估',
        params: {},
        toolId: null,
        ledgerAssetId: null,
        status: 'PAUSED',
        error: null,
        recordKind: 'eval_task',
        recordId: 't1',
        recordName: '季度检测 · 内容评估',
        href: '/eval-tasks/t1',
        actions: [],
        launchedAt: '2026-11-22T01:00:00.000Z',
        finishedAt: null,
      },
      {
        id: 'i2',
        position: 1,
        kind: 'asset_discovery',
        kindLabel: 'AI 资产测绘',
        category: 'app_env',
        title: '资产测绘',
        params: {},
        toolId: null,
        ledgerAssetId: null,
        status: 'COMPLETED',
        error: null,
        recordKind: 'asset_discovery',
        recordId: 'r1',
        recordName: null,
        href: '/inspect/asset-discovery?run=r1',
        actions: [],
        launchedAt: '2026-11-22T01:00:00.000Z',
        finishedAt: '2026-11-22T01:05:00.000Z',
      },
    ],
    ...o,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/detect-tasks/jobs/job-1']}>
          <Routes>
            <Route path="/detect-tasks/jobs/:id" element={<DetectJobDetailPage />} />
            <Route path="/reports" element={<div>报告详情页</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('DetectJobDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.perms = new Set(['detect_task:read', 'detect_task:manage']);
    mocks.get.mockResolvedValue(jobFixture());
    mocks.templates.mockResolvedValue({ items: [] });
  });

  it('已暂停只显示「恢复」「停止」；子任务带状态和记录链接', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: '季度检测' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '恢复' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument();
    for (const name of ['启动', '暂停', '删除']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByText('完成 1/2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '季度检测 · 内容评估' })).toHaveAttribute(
      'href',
      '/eval-tasks/t1',
    );
    expect(screen.getByRole('link', { name: '查看' })).toHaveAttribute(
      'href',
      '/inspect/asset-discovery?run=r1',
    );
  });

  it('停止要二次确认，确认后才调用停止', async () => {
    const user = userEvent.setup();
    mocks.lifecycle.mockResolvedValue(jobFixture({ status: 'CANCELED' }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: '停止' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText('未启动的子任务将取消，已在执行的语料扫描、资产测绘会继续跑完。'),
    ).toBeInTheDocument();
    expect(mocks.lifecycle).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: '确认停止' }));
    await waitFor(() => expect(mocks.lifecycle).toHaveBeenCalledWith('job-1', 'stop'));
  });

  it('没有 detect_task:manage 时不显示操作按钮', async () => {
    mocks.perms = new Set(['detect_task:read']);
    renderPage();
    expect(await screen.findByRole('heading', { name: '季度检测' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument();
  });

  it('任务未结束时「生成综合报告」置灰', async () => {
    mocks.perms.add('report:generate');
    renderPage();
    expect(await screen.findByRole('button', { name: '生成综合报告' })).toBeDisabled();
  });

  it('任务结束后生成综合报告：带标题和所选模板，生成后进报告详情', async () => {
    const user = userEvent.setup();
    mocks.perms.add('report:generate');
    mocks.get.mockResolvedValue(
      jobFixture({
        status: 'COMPLETED',
        finishedAt: '2026-11-22T02:00:00.000Z',
        itemCounts: counts({ COMPLETED: 2 }),
      }),
    );
    mocks.templates.mockResolvedValue({
      items: [{ id: 'tpl-1', name: '客户交付模板', isDefault: true, sections: [] }],
    });
    mocks.report.mockResolvedValue({
      id: 'rep-1',
      title: '季度检测 综合检测报告',
      kind: 'combined',
    });
    renderPage();
    await user.click(await screen.findByRole('button', { name: '生成综合报告' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText(/报告标题/)).toHaveValue('季度检测 综合检测报告');
    await user.selectOptions(
      await within(dialog).findByRole('combobox', { name: '报告模板' }),
      '客户交付模板（默认）',
    );
    await user.click(within(dialog).getByRole('button', { name: '生成' }));
    await waitFor(() =>
      expect(mocks.report).toHaveBeenCalledWith('job-1', {
        title: '季度检测 综合检测报告',
        templateId: 'tpl-1',
      }),
    );
    expect(await screen.findByText('报告详情页')).toBeInTheDocument();
  });

  it('执行中的组合任务里单独暂停的评估子任务：标出来，给「恢复」', async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(
      jobFixture({
        status: 'RUNNING',
        items: jobFixture().items.map((i, idx) =>
          idx === 0 ? { ...i, actions: ['resume', 'stop'] } : i,
        ),
      }),
    );
    mocks.action.mockResolvedValue({ kind: 'eval_task', id: 't1', status: 'PENDING' });
    renderPage();
    expect(await screen.findByText('已单独暂停，组合任务不会自动恢复')).toBeInTheDocument();
    const row = screen.getByText('内容评估').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('eval_task', 't1', 'resume'));
  });

  it('失败但有完成的子任务显示「部分失败」；停止后还有在跑的子任务时接着刷新', async () => {
    mocks.get.mockResolvedValue(
      jobFixture({
        status: 'FAILED',
        itemCounts: counts({ COMPLETED: 1, FAILED: 1 }),
      }),
    );
    renderPage();
    expect(await screen.findByText('部分失败')).toBeInTheDocument();
  });
  it('来源是检测方案时只写「检测方案」，不给链接', async () => {
    mocks.get.mockResolvedValue(jobFixture({ schemeId: 'sc1', triggeredBy: 'scheme' }));
    renderPage();
    expect(await screen.findByText('检测方案')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '检测方案' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/schemes"]')).toBeNull();
  });

  it('没启动的子任务显示「未启动」；已建检测记录、记录在排队的照旧「排队中」', async () => {
    const [evalItem, discoveryItem] = jobFixture().items;
    mocks.get.mockResolvedValue(
      jobFixture({
        status: 'RUNNING',
        itemCounts: counts({ PENDING: 2 }),
        items: [
          { ...evalItem!, status: 'PENDING' },
          {
            ...discoveryItem!,
            status: 'PENDING',
            recordKind: null,
            recordId: null,
            recordName: null,
            href: null,
            launchedAt: null,
            finishedAt: null,
          },
        ],
      }),
    );
    renderPage();
    const queued = (await screen.findByText('内容评估')).closest('tr')!;
    expect(within(queued).getByText('排队中')).toBeInTheDocument();
    const waiting = screen.getByText('资产测绘').closest('tr')!;
    expect(within(waiting).getByText('未启动')).toBeInTheDocument();
    expect(within(waiting).queryByText('排队中')).toBeNull();
  });

  it('组合任务没启动：概况和子任务都显示「未启动」，不出现「排队中」', async () => {
    mocks.get.mockResolvedValue(
      jobFixture({
        status: 'PENDING',
        startedAt: null,
        itemCounts: counts({ PENDING: 2 }),
        items: jobFixture().items.map((i) => ({
          ...i,
          status: 'PENDING' as const,
          recordKind: null,
          recordId: null,
          recordName: null,
          href: null,
          launchedAt: null,
          finishedAt: null,
        })),
      }),
    );
    renderPage();
    expect(await screen.findByRole('heading', { name: '季度检测' })).toBeInTheDocument();
    expect(screen.getAllByText('未启动')).toHaveLength(3);
    expect(screen.queryByText('排队中')).toBeNull();
  });
});
