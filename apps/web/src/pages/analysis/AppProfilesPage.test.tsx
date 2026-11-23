import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppProfileListItem } from '@/lib/detect-risks';
import { AppProfilesPage } from './AppProfilesPage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  tenantView: {
    isAllTenants: false,
    listParams: {} as { tenantId?: string },
    tenantName: (id?: string | null) => id ?? '平台共享',
  },
}));

vi.mock('@/lib/detect-risks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detect-risks')>()),
  appProfilesApi: { list: mocks.list, get: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('@/lib/tenant-view', () => ({
  useTenantView: () => mocks.tenantView,
  TenantFilterSelect: () => null,
}));

const item = (over: Partial<AppProfileListItem>): AppProfileListItem => ({
  id: 'p-1',
  tenantId: 't',
  name: '客服智能体平台',
  code: 'APP-001',
  ownerName: '张三',
  organizationPath: '集团 / 信息部',
  assetCount: 5,
  truncated: false,
  riskTotal: 6,
  riskHigh: 3,
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/analysis/profiles']}>
        <AppProfilesPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(tree());
  return { ...result, rerenderPage: () => result.rerender(tree()) };
}

const lastList = () => mocks.list.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe('AppProfilesPage 应用画像列表', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tenantView = { ...mocks.tenantView, isAllTenants: false, listParams: {} };
    mocks.list.mockResolvedValue({
      items: [item({}), item({ id: 'p-2', name: '知识库平台', riskTotal: 0, riskHigh: 0 })],
      total: 2,
      page: 1,
      pageSize: 20,
    });
  });

  it('列出应用平台，带风险数，链接到画像', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: '客服智能体平台' });
    expect(link).toHaveAttribute('href', '/analysis/profiles/p-1');
    expect(screen.getByRole('link', { name: '知识库平台' })).toHaveAttribute(
      'href',
      '/analysis/profiles/p-2',
    );
    const row = link.closest('tr')!;
    expect(within(row).getByText('6')).toBeInTheDocument();
    expect(within(row).getByText('3')).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ page: 1 })),
    );
  });

  it('看不到任何风险来源时风险数显示「—」', async () => {
    mocks.list.mockResolvedValue({
      items: [item({ riskTotal: null, riskHigh: null })],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    renderPage();
    const row = (await screen.findByRole('link', { name: '客服智能体平台' })).closest('tr')!;
    expect(within(row).getAllByText('—').length).toBe(2);
  });

  it('搜索输入防抖：停下来才按完整关键词请求一次', async () => {
    renderPage();
    await screen.findByRole('link', { name: '客服智能体平台' });
    await userEvent.type(screen.getByRole('textbox', { name: '搜索应用平台' }), '客服平台');
    await waitFor(() => expect(lastList()).toMatchObject({ q: '客服平台', page: 1 }));
    const queries = mocks.list.mock.calls.map((c) => c[0].q);
    expect(queries.filter((q) => q !== undefined)).toEqual(['客服平台']);
  });

  it('换租户时直接按第 1 页请求，不先用旧页码请求一次', async () => {
    mocks.list.mockImplementation(async (q: { page: number }) => ({
      items: [item({})],
      total: 45,
      page: q.page,
      pageSize: 20,
    }));
    const view = renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /下一页/ }));
    await waitFor(() => expect(lastList()).toMatchObject({ page: 2 }));
    mocks.tenantView = { ...mocks.tenantView, isAllTenants: true, listParams: { tenantId: 't2' } };
    view.rerenderPage();
    await waitFor(() => expect(lastList()).toMatchObject({ page: 1, tenantId: 't2' }));
    const forT2 = mocks.list.mock.calls.map((c) => c[0]).filter((q) => q.tenantId === 't2');
    expect(forT2.every((q) => q.page === 1)).toBe(true);
  });
});
