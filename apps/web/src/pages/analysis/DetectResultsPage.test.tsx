import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DetectResultRow,
  DetectResultsPage as ResultsPage,
  DetectRiskCategoryStat,
  DetectRiskStatsView,
  RiskCount,
} from '@/lib/detect-risks';
import { DetectResultsPage } from './DetectResultsPage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  tenantView: {
    isAllTenants: false,
    listParams: {} as { tenantId?: string },
    tenantName: (id?: string | null) => id ?? '平台共享',
    guardRow: () => false,
  },
}));

vi.mock('@/lib/detect-risks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detect-risks')>()),
  detectResultsApi: { list: mocks.list, stats: mocks.stats },
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('@/lib/tenant-view', () => ({
  useTenantView: () => mocks.tenantView,
  TenantFilterSelect: () => <select aria-label="租户筛选" />,
}));

const MONTH_START = '2026-10-31T16:00:00.000Z';

const count = (total: number): RiskCount => ({
  total,
  high: 0,
  bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: total, LOW: 0, INFO: 0, UNRATED: 0 },
});

const category = (
  key: DetectRiskCategoryStat['category'],
  label: string,
  sources: Array<[DetectRiskCategoryStat['sources'][number]['source'], string, number | null]>,
): DetectRiskCategoryStat => ({
  category: key,
  label,
  total: sources.reduce((s, [, , n]) => s + (n ?? 0), 0),
  high: 0,
  sources: sources.map(([source, l, n]) => ({
    source,
    label: l,
    count: n === null ? null : count(n),
  })),
});

const stats = (
  truncatedCorpusScans = 0,
  modelVisible = true,
  discoveryRunsTruncated = false,
): DetectRiskStatsView => ({
  since: null,
  until: null,
  truncatedCorpusScans,
  discoveryRunsTruncated,
  profile: null,
  categories: [
    category('model', '模型安全', [['model_file', '模型文件扫描发现', modelVisible ? 2 : null]]),
    category('data', '数据安全', [['corpus', '语料扫描命中', 3]]),
    category('content', '内容安全', [['eval_content', '内容评估风险项', 2]]),
    category('app_env', '应用与环境安全', [
      ['eval_app', '智能体与终端测评风险项', 4],
      ['service_assurance', '服务核验漏洞与基线问题', null],
      ['asset_discovery', '未登记 AI 服务', 1],
    ]),
  ],
});

const row = (over: Partial<DetectResultRow>): DetectResultRow => ({
  source: 'model_file',
  id: 'r1',
  tenantId: 't1',
  title: 'Pickle 加载时可执行危险对象',
  severity: 'HIGH',
  subject: '/models/a.pkl',
  recordKind: 'model_file_scan',
  recordId: 'scan-1',
  recordName: '/models',
  href: '/inspect/model-files?scan=scan-1',
  createdAt: '2026-11-20T02:00:00.000Z',
  ...over,
});

function page(query: { category: string; source?: string }): ResultsPage {
  if (query.category === 'app_env') {
    const source = query.source ?? 'eval_app';
    return {
      category: 'app_env',
      source: source as ResultsPage['source'],
      sources: [
        { source: 'eval_app', label: '智能体与终端测评风险项', total: 4 },
        { source: 'asset_discovery', label: '未登记 AI 服务', total: 1 },
      ],
      items:
        source === 'asset_discovery'
          ? [
              row({
                source: 'asset_discovery',
                id: 'ad1',
                title: '未登记 AI 服务：llama3:8b',
                subject: 'http://10.0.0.8:11434',
                recordKind: 'asset_discovery',
                recordId: 'run-2',
                recordName: '10.0.0.0/24',
                href: '/inspect/asset-discovery?run=run-2',
              }),
            ]
          : [
              row({
                source: 'eval_app',
                id: 'f1',
                title: '越权调用工具',
                subject: '客服智能体',
                recordKind: 'eval_task',
                recordId: 'task-9',
                recordName: '客服智能体评估',
                href: '/eval-tasks/task-9',
              }),
            ],
      total: source === 'asset_discovery' ? 1 : 4,
      page: 1,
      pageSize: 20,
      profile: null,
    };
  }
  return {
    category: query.category as ResultsPage['category'],
    source: 'model_file',
    sources: [{ source: 'model_file', label: '模型文件扫描发现', total: 2 }],
    items: [row({}), row({ id: 'r2', severity: 'MEDIUM', title: 'Pickle 引用非白名单全局对象' })],
    total: 2,
    page: 1,
    pageSize: 20,
    profile: null,
  };
}

function Probe() {
  const location = useLocation();
  return <div data-testid="location">{location.search}</div>;
}

function renderPage(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 每次都新建元素：同一个元素对象重渲染时 React 会跳过子树，读不到新的租户视角。
  const tree = () => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/analysis/results"
            element={
              <>
                <DetectResultsPage />
                <Probe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(tree());
  return { ...result, rerenderPage: () => result.rerender(tree()) };
}

const lastList = () => mocks.list.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe('DetectResultsPage 检测结果四视角（2.5.3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tenantView = { ...mocks.tenantView, isAllTenants: false, listParams: {} };
    mocks.stats.mockResolvedValue(stats());
    mocks.list.mockImplementation(async (q: { category: string; source?: string }) => page(q));
  });

  it('地址带 category=model 时打开「模型安全」页签并带该参数请求，页签带数', async () => {
    renderPage('/analysis/results?category=model');
    const tabs = await screen.findByRole('tablist', { name: '检测类别' });
    const model = await within(tabs).findByRole('tab', { name: '模型安全 2' });
    expect(model).toHaveAttribute('aria-selected', 'true');
    expect(within(tabs).getByRole('tab', { name: '应用与环境安全 5' })).toBeInTheDocument();
    await waitFor(() => expect(lastList()).toMatchObject({ category: 'model', page: 1 }));
    expect(lastList().source).toBeUndefined();
    expect(await screen.findByText('Pickle 加载时可执行危险对象')).toBeInTheDocument();
  });

  it('来源分段只显示接口返回的 sources；切来源时请求带 source，地址栏同步', async () => {
    renderPage('/analysis/results?category=app_env');
    const sources = await screen.findByRole('tablist', { name: '来源' });
    expect(
      within(sources)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['智能体与终端测评风险项 4', '未登记 AI 服务 1']);
    expect(within(sources).getByRole('tab', { name: /智能体与终端/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(within(sources).getByRole('tab', { name: /未登记 AI 服务/ }));
    await waitFor(() =>
      expect(lastList()).toMatchObject({ category: 'app_env', source: 'asset_discovery' }),
    );
    expect(screen.getByTestId('location')).toHaveTextContent('source=asset_discovery');
    expect(await screen.findByText('未登记 AI 服务：llama3:8b')).toBeInTheDocument();
  });

  it('行内来源记录链接等于接口给的 href，没有名称时显示记录类型', async () => {
    mocks.list.mockResolvedValueOnce({
      ...page({ category: 'model' }),
      items: [row({}), row({ id: 'r3', recordName: null })],
    });
    renderPage('/analysis/results?category=model');
    expect(await screen.findByRole('link', { name: '/models' })).toHaveAttribute(
      'href',
      '/inspect/model-files?scan=scan-1',
    );
    expect(screen.getByRole('link', { name: '模型文件扫描' })).toHaveAttribute(
      'href',
      '/inspect/model-files?scan=scan-1',
    );
  });

  it('切类别时去掉来源参数，严重度写进地址栏并带进请求', async () => {
    renderPage(
      `/analysis/results?category=app_env&source=asset_discovery&since=${encodeURIComponent(MONTH_START)}`,
    );
    await screen.findByText('未登记 AI 服务：llama3:8b');
    await userEvent.click(screen.getByRole('tab', { name: /^数据安全/ }));
    await waitFor(() => expect(lastList()).toMatchObject({ category: 'data', since: MONTH_START }));
    expect(lastList().source).toBeUndefined();
    const location = screen.getByTestId('location');
    expect(location).toHaveTextContent('category=data');
    expect(location.textContent).not.toContain('source=');
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: '严重度' }),
      'CRITICAL,HIGH',
    );
    await waitFor(() => expect(lastList()).toMatchObject({ severity: 'CRITICAL,HIGH' }));
    expect(location).toHaveTextContent(`severity=${encodeURIComponent('CRITICAL,HIGH')}`);
  });

  it('首页带来的起点在日期框里显示北京时间日期；改日期、清除日期都同步地址栏', async () => {
    renderPage(`/analysis/results?category=content&since=${encodeURIComponent(MONTH_START)}`);
    const start = await screen.findByLabelText('开始日期');
    expect(start).toHaveValue('2026-11-01');
    await waitFor(() => expect(lastList()).toMatchObject({ since: MONTH_START }));
    expect(mocks.stats).toHaveBeenLastCalledWith({ since: MONTH_START, until: undefined });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-11-05' } });
    const until = new Date('2026-11-06T00:00:00+08:00').toISOString();
    await waitFor(() => expect(lastList()).toMatchObject({ until }));
    expect(screen.getByTestId('location')).toHaveTextContent(`until=${encodeURIComponent(until)}`);
    expect(screen.getByLabelText('结束日期')).toHaveValue('2026-11-05');
    await userEvent.click(screen.getByRole('button', { name: '清除日期' }));
    await waitFor(() => expect(lastList().since).toBeUndefined());
    expect(lastList().until).toBeUndefined();
    expect(screen.getByTestId('location').textContent).not.toContain('since=');
  });

  it('地址没有类别时打开第一个能看的类别', async () => {
    mocks.stats.mockResolvedValue(stats(0, false));
    renderPage('/analysis/results');
    await waitFor(() => expect(lastList()).toMatchObject({ category: 'data' }));
    expect(screen.getByRole('tab', { name: /^数据安全/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '模型安全' })).toBeInTheDocument();
  });

  it('语料命中过多时，数据安全视角提示只计已保存的部分', async () => {
    mocks.stats.mockResolvedValue(stats(2));
    renderPage('/analysis/results?category=data');
    expect(await screen.findByText('2 次扫描命中过多，只计已保存的部分')).toBeInTheDocument();
  });

  it('资产测绘次数过多时，应用与环境视角提示只计最近 500 次', async () => {
    mocks.stats.mockResolvedValue(stats(0, true, true));
    renderPage('/analysis/results?category=app_env');
    expect(await screen.findByText('资产测绘超过 500 次，只计最近 500 次')).toBeInTheDocument();
  });

  it('切来源时加载期间保留上一份数据，不清空表格', async () => {
    renderPage('/analysis/results?category=app_env');
    expect(await screen.findByText('越权调用工具')).toBeInTheDocument();
    let resolve!: (v: ResultsPage) => void;
    mocks.list.mockImplementationOnce(() => new Promise<ResultsPage>((r) => (resolve = r)));
    await userEvent.click(screen.getByRole('tab', { name: /未登记 AI 服务/ }));
    await waitFor(() => expect(lastList()).toMatchObject({ source: 'asset_discovery' }));
    expect(screen.getByText('越权调用工具')).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: '来源' })).toBeInTheDocument();
    resolve(page({ category: 'app_env', source: 'asset_discovery' }));
    expect(await screen.findByText('未登记 AI 服务：llama3:8b')).toBeInTheDocument();
    expect(screen.queryByText('越权调用工具')).not.toBeInTheDocument();
  });

  it('换租户时回到第 1 页', async () => {
    mocks.list.mockImplementation(async (q: { category: string; page: number }) => ({
      ...page(q),
      total: 45,
      page: q.page,
    }));
    const view = renderPage('/analysis/results?category=model');
    await userEvent.click(await screen.findByRole('button', { name: /下一页/ }));
    await waitFor(() => expect(lastList()).toMatchObject({ page: 2 }));
    mocks.tenantView = { ...mocks.tenantView, isAllTenants: true, listParams: { tenantId: 't2' } };
    view.rerenderPage();
    await waitFor(() => expect(lastList()).toMatchObject({ page: 1, tenantId: 't2' }));
    const forT2 = mocks.list.mock.calls.map((c) => c[0]).filter((q) => q.tenantId === 't2');
    expect(forT2.every((q) => q.page === 1)).toBe(true);
  });

  it('当前页已经没有数据时自动回到第 1 页', async () => {
    mocks.list.mockImplementation(async (q: { category: string; page: number }) =>
      q.page === 1 ? { ...page(q), total: 45 } : { ...page(q), items: [], total: 12, page: q.page },
    );
    renderPage('/analysis/results?category=model');
    await userEvent.click(await screen.findByRole('button', { name: /下一页/ }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ page: 2 })),
    );
    await waitFor(() => expect(lastList()).toMatchObject({ page: 1 }));
    expect(await screen.findByText('Pickle 加载时可执行危险对象')).toBeInTheDocument();
  });

  it('切类别时不保留上一类的行和来源分段，避免带着新类别点旧来源', async () => {
    renderPage('/analysis/results?category=app_env');
    expect(await screen.findByText('越权调用工具')).toBeInTheDocument();
    mocks.list.mockImplementationOnce(() => new Promise<ResultsPage>(() => undefined));
    await userEvent.click(screen.getByRole('tab', { name: /^模型安全/ }));
    await waitFor(() => expect(lastList()).toMatchObject({ category: 'model' }));
    expect(screen.queryByText('越权调用工具')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: '来源' })).not.toBeInTheDocument();
  });

  it('带 profile 时按画像范围请求，显示可清除的「应用画像」条件，隐藏租户筛选', async () => {
    mocks.tenantView = { ...mocks.tenantView, isAllTenants: true, listParams: { tenantId: 't9' } };
    mocks.list.mockImplementation(async (q: { category: string; source?: string }) => ({
      ...page(q),
      profile: { id: 'p-1', name: '客服智能体平台' },
    }));
    mocks.stats.mockResolvedValue({ ...stats(), profile: { id: 'p-1', name: '客服智能体平台' } });
    renderPage('/analysis/results?category=model&profile=p-1');
    expect(await screen.findByText('应用画像：客服智能体平台')).toBeInTheDocument();
    await waitFor(() => expect(lastList()).toMatchObject({ category: 'model', profile: 'p-1' }));
    expect(lastList().tenantId).toBeUndefined();
    expect(mocks.stats).toHaveBeenLastCalledWith(expect.objectContaining({ profile: 'p-1' }));
    expect(screen.queryByRole('combobox', { name: '租户筛选' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '清除应用画像' }));
    await waitFor(() => expect(lastList().profile).toBeUndefined());
    expect(screen.getByTestId('location').textContent).not.toContain('profile=');
    expect(screen.getByRole('combobox', { name: '租户筛选' })).toBeInTheDocument();
  });

  it('严重度和日期用全站统一的下拉框、输入框', async () => {
    renderPage('/analysis/results?category=model');
    const severity = await screen.findByRole('combobox', { name: '严重度' });
    expect(severity).toHaveClass('appearance-none');
    expect(screen.getByLabelText('开始日期')).toHaveClass('rounded-[10px]');
    expect(screen.getByLabelText('结束日期')).toHaveClass('rounded-[10px]');
  });

  it('来源分段和下拉、日期框一样高；严重度和起止日期是一组，放不下时整组换行', async () => {
    renderPage('/analysis/results?category=app_env');
    const sources = await screen.findByRole('tablist', { name: '来源' });
    const severity = screen.getByRole('combobox', { name: '严重度' });
    expect(sources).toHaveClass('h-10');
    expect(severity).toHaveClass('h-10');
    expect(screen.getByLabelText('开始日期')).toHaveClass('h-10');
    const group = severity.parentElement!;
    expect(group).toContainElement(screen.getByLabelText('开始日期'));
    expect(group).toContainElement(screen.getByLabelText('结束日期'));
    expect(group.parentElement).toBe(sources.parentElement);
  });
});
