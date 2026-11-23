import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import type { DetectTaskRow, DetectTaskStats } from '@/lib/detect-tasks';
import { DetectTasksPage } from './DetectTasksPage';
import { NewTaskChooser } from './NewTaskChooser';

const mocks = vi.hoisted(() => ({
  stats: vi.fn(),
  list: vi.fn(),
  action: vi.fn(),
  perms: new Set<string>(),
}));

vi.mock('@/lib/detect-tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detect-tasks')>()),
  detectTasksApi: { stats: mocks.stats, list: mocks.list, action: mocks.action },
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
const STATS: DetectTaskStats = {
  total: 3,
  byStatus: counts({ RUNNING: 1, COMPLETED: 2 }),
  byCategory: {
    model: { total: 1, byStatus: counts({ COMPLETED: 1 }) },
    data: { total: 0, byStatus: counts() },
    content: { total: 2, byStatus: counts({ RUNNING: 1, COMPLETED: 1 }) },
    app_env: { total: 0, byStatus: counts() },
  },
  byKind: { eval_task: 2, model_file_scan: 1 },
  kinds: ['eval_task', 'model_file_scan'],
};
const row = (o: Partial<DetectTaskRow>): DetectTaskRow => ({
  tenantId: null,
  kind: 'eval_task',
  kindLabel: '评估任务',
  category: 'content',
  id: 't1',
  name: '内容评估一',
  status: 'RUNNING',
  rawStatus: 'RUNNING',
  createdAt: '2026-11-22T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  createdBy: { id: 'u1', username: 'admin' },
  href: '/eval-tasks/t1',
  job: null,
  pauseRequested: false,
  actions: ['pause', 'stop'],
  ...o,
});
const ROWS = [
  row({}),
  row({
    kind: 'model_file_scan',
    kindLabel: '模型文件扫描',
    category: 'model',
    id: 's1',
    name: '/models/qwen',
    status: 'COMPLETED',
    rawStatus: 'COMPLETED',
    href: '/inspect/model-files?scan=s1',
    job: { id: 'j1', name: '季度检测' },
    actions: [],
  }),
];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <DetectTasksPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.perms = new Set(['detect_task:read', 'eval_task:create', 'engine:scan']);
  mocks.stats.mockResolvedValue(STATS);
  mocks.list.mockResolvedValue({ items: ROWS, total: 2, page: 1, pageSize: 20 });
  mocks.action.mockResolvedValue({
    kind: 'eval_task',
    id: 't1',
    status: 'RUNNING',
    pauseRequested: true,
  });
});

describe('DetectTasksPage', () => {
  it('页面标题是「全部任务」', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: '全部任务' })).toBeInTheDocument();
    expect(screen.queryByText('任务总览')).not.toBeInTheDocument();
  });

  it('点「执行中」统计数字后，按执行中筛选列表', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('内容评估一');
    await user.click(screen.getByRole('button', { name: /执行中\s*1/ }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'RUNNING' })),
    );
  });

  it('类别筛选参数传给接口；点四类统计也按类别筛选', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('内容评估一');
    await user.selectOptions(screen.getByLabelText('类别'), 'data');
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'data' })),
    );
    await user.click(screen.getByRole('button', { name: /模型安全\s*1/ }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'model' })),
    );
  });

  it('名称链到记录详情，所属组合任务链到组合任务', async () => {
    renderPage();
    expect(await screen.findByRole('link', { name: '内容评估一' })).toHaveAttribute(
      'href',
      '/eval-tasks/t1',
    );
    expect(screen.getByRole('link', { name: '/models/qwen' })).toHaveAttribute(
      'href',
      '/inspect/model-files?scan=s1',
    );
    expect(screen.getByRole('link', { name: '季度检测' })).toHaveAttribute(
      'href',
      '/detect-tasks/jobs/j1',
    );
  });

  it('只有可暂停的行显示「暂停」，点后调用暂停', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('内容评估一');
    const pauseButtons = screen.getAllByRole('button', { name: '暂停' });
    expect(pauseButtons).toHaveLength(1);
    await user.click(pauseButtons[0]!);
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('eval_task', 't1', 'pause'));
  });
});

describe('DetectTasksPage 审查修复', () => {
  /** 模拟后端：统计不按类别筛，按类型筛。 */
  const statsFor = (q: { category?: string; kind?: string }) => {
    expect(q.category).toBeUndefined();
    return STATS;
  };

  it('点某个类别后其余类别统计不变；状态数取该类别的', async () => {
    const user = userEvent.setup();
    mocks.stats.mockImplementation(async (q: object) => statsFor(q));
    renderPage();
    await screen.findByRole('button', { name: /模型安全\s*1/ });
    await user.click(screen.getByRole('button', { name: /内容安全\s*2/ }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'content' })),
    );
    expect(screen.getByRole('button', { name: /模型安全\s*1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /总任务\s*2/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /执行中\s*1/ })).toBeInTheDocument();
  });

  it('选了类别后「类型」只列该类别的；选类型时统计也按类型', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('内容评估一');
    await user.selectOptions(screen.getByLabelText('类别'), 'model');
    const kindSelect = screen.getByLabelText('类型');
    expect(within(kindSelect).queryByRole('option', { name: '评估任务' })).toBeNull();
    await user.selectOptions(kindSelect, 'model_file_scan');
    await waitFor(() =>
      expect(mocks.stats).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'model_file_scan' }),
      ),
    );
  });

  it('行上只显示后端给的操作；没有操作就没有按钮', async () => {
    mocks.list.mockResolvedValue({
      items: [row({ actions: [] })],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    renderPage();
    await screen.findByText('内容评估一');
    expect(screen.queryByRole('button', { name: '暂停' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
  });

  it('停止要二次确认', async () => {
    const user = userEvent.setup();
    mocks.action.mockResolvedValue({ kind: 'eval_task', id: 't1', status: 'CANCELED' });
    renderPage();
    await screen.findByText('内容评估一');
    await user.click(screen.getByRole('button', { name: '停止' }));
    expect(mocks.action).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '确认停止' }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('eval_task', 't1', 'stop'));
  });

  it('列表报错时显示加载失败，不显示成没有数据', async () => {
    mocks.list.mockRejectedValue(new Error('服务异常'));
    renderPage();
    expect(await screen.findByText('数据加载失败')).toBeInTheDocument();
    expect(screen.queryByText('没有符合条件的检测任务')).toBeNull();
  });

  it('日期筛选按北京时间的自然日', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('内容评估一');
    await user.type(screen.getByLabelText('创建时间起'), '2026-11-22');
    await user.type(screen.getByLabelText('创建时间止'), '2026-11-23');
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        expect.objectContaining({
          createdFrom: '2026-11-22T00:00:00+08:00',
          createdTo: '2026-11-23T23:59:59.999+08:00',
        }),
      ),
    );
  });

  it('暂停中：置灰的「暂停中」和「撤销暂停」', async () => {
    mocks.list.mockResolvedValue({
      items: [row({ pauseRequested: true, actions: ['resume', 'stop'] })],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    renderPage();
    expect(await screen.findByRole('button', { name: '暂停中' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '撤销暂停' })).toBeEnabled();
  });

  it('名称搜索清空即生效', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('内容评估一');
    const input = screen.getByLabelText('名称');
    await user.type(input, '评估{enter}');
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: '评估' })),
    );
    await user.clear(input);
    await waitFor(() => expect(mocks.list.mock.calls.at(-1)![0].q).toBeUndefined());
  });

  it('没有任何可新建的检测类型时不显示「新建检测任务」', async () => {
    mocks.perms = new Set(['detect_task:read']);
    renderPage();
    await screen.findByText('内容评估一');
    expect(screen.queryByRole('button', { name: '新建检测任务' })).toBeNull();
  });
});

describe('DetectTasksPage 版式', () => {
  it('类别、类型、状态三个下拉定宽，不各占一整行', async () => {
    renderPage();
    await screen.findByText('内容评估一');
    for (const name of ['类别', '类型', '状态']) {
      expect(screen.getByLabelText(name)).toHaveClass('w-40');
      expect(screen.getByLabelText(name)).not.toHaveClass('w-full');
    }
  });

  it('1366 宽下三个下拉、名称、起止日期一行放得下，第二个日期框不折到下一行', async () => {
    renderPage();
    await screen.findByText('内容评估一');
    const controls = ['类别', '类型', '状态', '名称', '创建时间起', '创建时间止'].map((name) =>
      screen.getByLabelText(name),
    );
    const widths = controls.map(
      (el) => Number(/(?:^|\s)w-(\d+)(?:\s|$)/.exec(el.className)?.[1]) * 4,
    );
    expect(widths.every((w) => w > 0)).toBe(true);
    // 1366 宽时筛选条内宽 1024px（主区 1102 减卡片内边距 48、筛选条边框和内边距 26）；间距 gap-2.5 = 10px
    const total = widths.reduce((sum, w) => sum + w, 0) + 10 * (controls.length - 1);
    expect(total).toBeLessThanOrEqual(1024);
  });
});

describe('NewTaskChooser', () => {
  it('没有发起语料扫描的权限时「语料扫描」置灰；有权限的可点', () => {
    mocks.perms = new Set(['eval_task:create']);
    render(
      <MemoryRouter>
        <NewTaskChooser open onClose={() => undefined} />
      </MemoryRouter>,
    );
    const dialog = screen.getByRole('dialog');
    const corpus = within(dialog).getByText('语料扫描');
    expect(corpus).toHaveAttribute('aria-disabled', 'true');
    expect(within(dialog).getByRole('link', { name: '内容安全评估' })).toBeInTheDocument();
    expect(within(dialog).getByText('组合任务')).toHaveAttribute('aria-disabled', 'true');
  });
});
