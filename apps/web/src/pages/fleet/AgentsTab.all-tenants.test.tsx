import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { TenantViewProvider } from '@/lib/tenant-view';
import { AgentsTab } from './AgentsTab';

/** 全部租户视角下的终端分组头：租户名、责任人按钮先进入所属租户。 */
const m = vi.hoisted(() => ({ agents: vi.fn(), setOwner: vi.fn(), users: vi.fn(), tenants: vi.fn(), switchTenant: vi.fn() }));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  ALL_TENANTS: 'all',
  TENANT_REQUIRED_EVENT: 'lse:tenant-required',
  api: { fleet: { agents: m.agents, setOwner: m.setOwner }, users: { list: m.users }, tenants: { list: m.tenants } },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: { isPlatformAdmin: true, allTenants: true, homeTenantId: 'platform', tenant: { id: 'all', name: '全部租户', isPlatform: true } },
    switchTenant: m.switchTenant,
    hasPermission: () => true,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  m.tenants.mockResolvedValue({ items: [
    { id: 'platform', name: '默认租户', isPlatform: true },
    { id: 't-a', name: '甲单位', isPlatform: false },
  ] });
  m.users.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
  m.agents.mockResolvedValue({
    items: [
      { endpointId: 'ep1', endpointName: 'demo-host', user: 'root', os: 'linux', source: 'jiandun', tenantId: 't-a',
        agentKey: 'claude-code', agentName: 'Claude Code', version: '1', status: 'ready', scope: 'all', reason: null, latest: null, assets: null },
    ],
    groups: [
      { key: 'jiandun\u0000ep1', endpointId: 'ep1', source: 'jiandun', tenantId: 't-a', name: 'demo-host', os: 'linux', osUser: 'root', online: true,
        owner: null, ownerSource: null, assets: null, risks: null },
      { key: 'agentshield\u0000as1', endpointId: 'as1', source: 'agentshield', tenantId: null, name: 'YJ40B4', os: 'windows', osUser: null, online: null,
        owner: { name: 'YJ40B4$', department: null, userId: null, updatedAt: null }, ownerSource: 'reported', assets: null, risks: null },
    ],
    total: 2, page: 1, pageSize: 10,
  });
});

function renderTab() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider><MemoryRouter initialEntries={['/fleet']}><TenantViewProvider><AgentsTab /></TenantViewProvider></MemoryRouter></ToastProvider>
  </QueryClientProvider>);
}

it('智能体安全平台来源的分组租户显示「智能体安全平台」，自管终端显示真实租户名', async () => {
  renderTab();
  const heads = await screen.findAllByTestId('endpoint-group');
  await waitFor(() => expect(within(heads[0]!).getByTestId('tenant-cell')).toHaveTextContent('甲单位'));
  expect(within(heads[1]!).getByTestId('tenant-cell')).toHaveTextContent('智能体安全平台');
  expect(within(heads[1]!).getByTestId('tenant-cell')).not.toHaveTextContent('平台共享');
});

it('全部租户视角点「设置」责任人先进入该租户，不直接打开弹框', async () => {
  renderTab();
  const [head] = await screen.findAllByTestId('endpoint-group');
  await userEvent.click(within(head!).getByRole('button', { name: '设置 demo-host 的责任人' }));
  expect(m.switchTenant).toHaveBeenCalledWith('t-a', '/fleet');
  expect(screen.queryByRole('dialog')).toBeNull();
});
