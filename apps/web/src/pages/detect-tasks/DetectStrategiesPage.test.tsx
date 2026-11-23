import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import type { DetectStrategyView } from '@/lib/detect-tasks';
import { CRON_PRESETS } from '@/pages/eval-plans/eval-plan-form';
import { DetectStrategiesPage } from './DetectStrategiesPage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  run: vi.fn(),
  remove: vi.fn(),
  perms: new Set<string>(),
}));

vi.mock('@/lib/detect-tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detect-tasks')>()),
  detectStrategiesApi: {
    list: mocks.list,
    create: mocks.create,
    update: mocks.update,
    run: mocks.run,
    remove: mocks.remove,
  },
}));
vi.mock('@/lib/tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tools')>()),
  toolsApi: { list: vi.fn().mockResolvedValue({ items: [] }) },
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  assetDiscoveryApi: { scope: vi.fn().mockResolvedValue({ entries: [], ports: [] }) },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => mocks.perms.has(code) }),
}));

const STRATEGY: DetectStrategyView = {
  id: 's1',
  name: '每周测绘',
  description: '',
  items: [
    {
      kind: 'asset_discovery',
      title: '测绘',
      params: { targets: ['https://a.example.com'], ports: [], confirm: true },
      toolId: null,
    },
  ],
  maxParallel: 2,
  cron: '0 3 * * 1',
  timezone: 'Asia/Shanghai',
  enabled: true,
  minIntervalMinutes: 60,
  lastTriggeredAt: null,
  lastSkipReason: '上一个组合任务未结束',
  nextRunAt: '2026-11-23T19:00:00.000Z',
  jobCount: 3,
  createdBy: null,
  createdAt: '2026-11-22T00:00:00.000Z',
  updatedAt: '2026-11-22T00:00:00.000Z',
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <DetectStrategiesPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('DetectStrategiesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.perms = new Set(['detect_task:read', 'detect_task:manage', 'engine:scan']);
    mocks.list.mockResolvedValue({ items: [STRATEGY], total: 1, page: 1, pageSize: 20 });
    mocks.create.mockResolvedValue({ ...STRATEGY, id: 's2' });
  });

  it('列表显示执行周期、下次执行和上次跳过原因', async () => {
    renderPage();
    expect(await screen.findByText('每周测绘')).toBeInTheDocument();
    expect(screen.getByText('每周一 03:00')).toBeInTheDocument();
    expect(screen.getByText('上一个组合任务未结束')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '立即执行' })).toBeInTheDocument();
  });

  it('选「每天」预设时提交的 cron 等于预设值', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '新建检测策略' }));
    await user.type(screen.getByLabelText(/^名称/), '每日测绘');
    await user.selectOptions(screen.getByLabelText(/执行周期/), '仅手动执行');
    const daily = CRON_PRESETS.find((p) => p.label.startsWith('每天'))!;
    await user.selectOptions(screen.getByLabelText(/执行周期/), daily.label);
    await user.selectOptions(screen.getByRole('combobox', { name: '添加子任务' }), 'AI 资产测绘');
    await user.type(screen.getByLabelText(/扫描目标/), 'https://a.example.com');
    await user.click(screen.getByRole('checkbox', { name: '已获授权对目标主动探测' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      name: '每日测绘',
      cron: daily.value,
      timezone: 'Asia/Shanghai',
      enabled: true,
      maxParallel: 4,
      items: [
        {
          kind: 'asset_discovery',
          params: { targets: ['https://a.example.com'], ports: [], confirm: true },
        },
      ],
    });
  });

  it('仅手动执行时提交 cron: null', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '新建检测策略' }));
    await user.type(screen.getByLabelText(/^名称/), '手动测绘');
    await user.selectOptions(screen.getByLabelText(/执行周期/), '仅手动执行');
    await user.selectOptions(screen.getByRole('combobox', { name: '添加子任务' }), 'AI 资产测绘');
    await user.type(screen.getByLabelText(/扫描目标/), 'https://a.example.com');
    await user.click(screen.getByRole('checkbox', { name: '已获授权对目标主动探测' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0]![0].cron).toBeNull();
  });
  it('弹窗里范围写在标签上，两列不因提示行高低不齐；卡片不重复页面标题', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('每周测绘')).toBeInTheDocument();
    expect(screen.queryByText('策略')).toBeNull();
    await user.click(screen.getByRole('button', { name: '新建检测策略' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('并发上限（1–10）')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('最小间隔（5–44640 分钟）')).toBeInTheDocument();
    expect(within(dialog).queryByText('1–10')).toBeNull();
    expect(within(dialog).queryByText('5–44640')).toBeNull();
  });

  it('弹窗网格不留半行空位：自定义 cron 时时区、最小间隔、启用并一行', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '新建检测策略' }));
    const dialog = screen.getByRole('dialog');
    const enabledCell = () =>
      within(dialog).getByRole('checkbox', { name: '启用' }).closest('label')!;
    const grid = enabledCell().parentElement!;
    expect(grid).toHaveClass('sm:grid-cols-6');
    // 按六列依次排：每行要正好排满，不能因为放不下换行留下空位
    const hasHole = () => {
      let used = 0;
      for (const cell of Array.from(grid.children)) {
        const span = Number(/sm:col-span-(\d+)/.exec(cell.className)?.[1] ?? 1);
        if (used + span > 6) return true;
        used = (used + span) % 6;
      }
      return used !== 0;
    };
    expect(hasHole()).toBe(false);
    const cron = within(dialog).getByLabelText(/执行周期/);
    await user.selectOptions(cron, '仅手动执行');
    expect(hasHole()).toBe(false);
    await user.selectOptions(cron, '自定义');
    expect(within(dialog).getByLabelText(/cron 表达式/)).toBeInTheDocument();
    expect(hasHole()).toBe(false);
    expect(enabledCell()).toHaveClass('sm:col-span-2');
  });
});
