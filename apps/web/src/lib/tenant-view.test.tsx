import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantCell, TenantFilterSelect, TenantViewProvider, useTenantView } from './tenant-view';

const mocks = vi.hoisted(() => ({
  tenantsList: vi.fn(),
  switchTenant: vi.fn(),
  user: null as null | Record<string, unknown>,
}));

vi.mock('@/lib/api', () => ({
  ALL_TENANTS: 'all',
  TENANT_REQUIRED_EVENT: 'lse:tenant-required',
  api: { tenants: { list: mocks.tenantsList } },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: mocks.user, switchTenant: mocks.switchTenant }),
}));

const ALL_USER = {
  isPlatformAdmin: true,
  allTenants: true,
  homeTenantId: 'platform',
  tenant: { id: 'all', name: '全部租户', isPlatform: true },
};
const SINGLE_USER = {
  isPlatformAdmin: false,
  allTenants: false,
  homeTenantId: 't-a',
  tenant: { id: 't-a', name: '甲单位', isPlatform: false },
};

function UrlProbe() {
  const [params] = useSearchParams();
  return <span data-testid="url-tenant">{params.get('tenantId') ?? ''}</span>;
}

function Harness() {
  const view = useTenantView();
  const [created, setCreated] = useState(false);
  return (
    <div>
      <TenantFilterSelect />
      <TenantCell tenantId="t-a" />
      <UrlProbe />
      <span data-testid="is-all">{String(view.isAllTenants)}</span>
      <span data-testid="list-params">{JSON.stringify(view.listParams)}</span>
      <span data-testid="created">{String(created)}</span>
      <button type="button" onClick={() => view.guardCreate(() => setCreated(true))}>
        新建
      </button>
      <button type="button" onClick={() => view.guardRow('t-b', '/eval-tasks/42')}>
        行
      </button>
      <button type="button" onClick={() => view.enterTenant('t-a', '/')}>
        进入
      </button>
    </div>
  );
}

function renderView(path = '/model-targets') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <TenantViewProvider>
          <Harness />
        </TenantViewProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('全部租户视角的通用能力（TenantViewProvider）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tenantsList.mockResolvedValue({
      items: [
        { id: 'platform', name: '默认租户', isPlatform: true },
        { id: 't-a', name: '甲单位', isPlatform: false },
        { id: 't-b', name: '乙单位', isPlatform: false },
      ],
    });
    mocks.user = ALL_USER;
  });

  it('非全局视角：不渲染筛选与租户列，新建按钮照常执行原逻辑', async () => {
    mocks.user = SINGLE_USER;
    renderView();
    expect(screen.getByTestId('is-all')).toHaveTextContent('false');
    expect(screen.queryByTestId('tenant-filter')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tenant-cell')).not.toBeInTheDocument();
    expect(screen.getByTestId('list-params')).toHaveTextContent('{}');

    await userEvent.setup().click(screen.getByRole('button', { name: '新建' }));
    expect(screen.getByTestId('created')).toHaveTextContent('true');
    expect(mocks.switchTenant).not.toHaveBeenCalled();
  });

  it('全局视角：租户筛选与租户列出现，租户名来自 /api/tenants', async () => {
    renderView();
    expect(screen.getByTestId('is-all')).toHaveTextContent('true');
    const filter = await screen.findByTestId('tenant-filter');
    expect(within(filter).getByRole('option', { name: '全部租户' })).toBeInTheDocument();
    expect(await within(filter).findByRole('option', { name: '甲单位' })).toBeInTheDocument();
    expect(within(filter).getByRole('option', { name: '乙单位' })).toBeInTheDocument();
    expect(screen.getByTestId('tenant-cell')).toHaveTextContent('甲单位');
  });

  it('选择租户筛选会写进 URL 并变成列表请求参数', async () => {
    renderView();
    const u = userEvent.setup();
    await screen.findByRole('option', { name: '乙单位' });
    await u.selectOptions(screen.getByTestId('tenant-filter'), 't-b');
    expect(screen.getByTestId('url-tenant')).toHaveTextContent('t-b');
    expect(screen.getByTestId('list-params')).toHaveTextContent('"tenantId":"t-b"');
  });

  it('全局视角点「新建」直接开新建，不再弹「建到哪个租户」', async () => {
    renderView('/model-targets');
    await userEvent.setup().click(screen.getByRole('button', { name: '新建' }));
    // 写操作落在本属租户，界面不打断：直接执行原新建逻辑，不切租户、不弹选择框。
    expect(screen.getByTestId('created')).toHaveTextContent('true');
    expect(screen.queryByTestId('tenant-picker')).not.toBeInTheDocument();
    expect(mocks.switchTenant).not.toHaveBeenCalled();
  });

  it('全局视角点行进入该行所属租户并打开目标路径', async () => {
    renderView();
    await userEvent.setup().click(screen.getByRole('button', { name: '行' }));
    await waitFor(() => expect(mocks.switchTenant).toHaveBeenCalledWith('t-b', '/eval-tasks/42'));
  });

  it('服务端 409 TENANT_REQUIRED 时弹出「选择租户」', async () => {
    renderView();
    fireEvent(window, new CustomEvent('lse:tenant-required'));
    expect(await screen.findByTestId('tenant-picker')).toBeInTheDocument();
    expect(screen.getByText('选择租户')).toBeInTheDocument();
  });

  it('各租户概况点租户名进入该租户的首页', async () => {
    renderView('/');
    await userEvent.setup().click(screen.getByRole('button', { name: '进入' }));
    await waitFor(() => expect(mocks.switchTenant).toHaveBeenCalledWith('t-a', '/'));
  });
});
