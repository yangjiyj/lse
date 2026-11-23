import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { TenantViewProvider } from '@/lib/tenant-view';
import { UsersPage } from './UsersPage';

/** 代表性列表页：验证「租户」列、租户筛选、点行进入租户、新建前选租户。 */
const mocks = vi.hoisted(() => ({
  usersList: vi.fn(),
  rolesList: vi.fn(),
  passwordPolicy: vi.fn(),
  tenantsList: vi.fn(),
  switchTenant: vi.fn(),
  orgTree: vi.fn(),
  permissions: { granted: new Set<string>() },
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  ALL_TENANTS: 'all',
  TENANT_REQUIRED_EVENT: 'lse:tenant-required',
  api: {
    users: {
      list: mocks.usersList,
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      resetPassword: vi.fn(),
    },
    roles: { list: mocks.rolesList },
    passwordPolicy: mocks.passwordPolicy,
    tenants: { list: mocks.tenantsList },
  },
}));
vi.mock('@/lib/organizations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/organizations')>();
  return { ...actual, organizationApi: { tree: mocks.orgTree } };
});
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: {
      isPlatformAdmin: true,
      allTenants: true,
      homeTenantId: 'platform',
      tenant: { id: 'all', name: '全部租户', isPlatform: true },
    },
    switchTenant: mocks.switchTenant,
    hasPermission: (code: string) => mocks.permissions.granted.has(code),
  }),
}));
vi.mock('@/components/SensitiveText', () => ({
  SensitiveValue: ({ value }: { value: string | null }) => <span>{value ?? '—'}</span>,
}));

function row(overrides: Record<string, unknown>) {
  return {
    id: 'u-a',
    username: 'jia-user',
    displayName: '甲用户',
    email: null,
    isActive: true,
    isBuiltin: false,
    lastLoginAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    roles: [{ id: 'r-1', name: '评估员' }],
    ...overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/users']}>
        <TenantViewProvider>
          <ToastProvider>
            <UsersPage embedded />
          </ToastProvider>
        </TenantViewProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UsersPage 的全部租户视角', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissions.granted = new Set([
      'user:create',
      'user:update',
      'user:delete',
      'user:reset_password',
    ]);
    mocks.tenantsList.mockResolvedValue({
      items: [
        { id: 'platform', name: '默认租户', isPlatform: true },
        { id: 't-a', name: '甲单位', isPlatform: false },
        { id: 't-b', name: '乙单位', isPlatform: false },
      ],
    });
    mocks.usersList.mockResolvedValue({
      items: [
        row({ id: 'u-a', username: 'jia-user', tenantId: 't-a' }),
        row({ id: 'u-b', username: 'yi-user', displayName: '乙用户', tenantId: 't-b' }),
      ],
      total: 2,
      page: 1,
      pageSize: 10,
    });
    mocks.rolesList.mockResolvedValue({ items: [{ id: 'r-1', name: '评估员' }] });
    mocks.passwordPolicy.mockResolvedValue({
      passwordMinLength: 8,
      passwordRequireUppercase: false,
      passwordRequireLowercase: false,
      passwordRequireDigit: false,
      passwordRequireSpecial: false,
      passwordExpireDays: 0,
    });
  });

  it('显示租户筛选与「租户」列，并按 tenantId 映射租户名', async () => {
    renderPage();
    expect(await screen.findByTestId('tenant-filter')).toBeInTheDocument();
    await screen.findByText('jia-user');
    expect(await screen.findByRole('columnheader', { name: '租户' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByTestId('tenant-cell').map((c) => c.textContent)).toEqual([
        '甲单位',
        '乙单位',
      ]),
    );
    expect(mocks.usersList).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 10 }),
    );
  });

  it('切换租户筛选会把 tenantId 带进列表请求', async () => {
    renderPage();
    const u = userEvent.setup();
    await screen.findByRole('option', { name: '乙单位' });
    await u.selectOptions(screen.getByTestId('tenant-filter'), 't-b');
    await waitFor(() =>
      expect(mocks.usersList).toHaveBeenLastCalledWith(
        expect.objectContaining({ tenantId: 't-b' }),
      ),
    );
  });

  it('点行操作先进入该行所属租户，并停留在用户与权限页', async () => {
    renderPage();
    await userEvent.setup().click(await screen.findByRole('button', { name: '编辑 jia-user' }));
    await waitFor(() => expect(mocks.switchTenant).toHaveBeenCalledWith('t-a', '/users'));
  });

  it('点「新建用户」直接开新建弹窗，不弹租户选择框、不切租户', async () => {
    renderPage();
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: /新建用户/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('tenant-picker')).not.toBeInTheDocument();
    expect(mocks.switchTenant).not.toHaveBeenCalled();
  });

  it('换租户筛选时清掉组织筛选并回到第 1 页', async () => {
    mocks.permissions.granted = new Set(['user:update', 'org:read']);
    const groups = [
      {
        tenantId: 't-a',
        tenantName: '甲单位',
        items: [
          { id: 'o-a', name: '甲总部', parentId: null, sort: 0, memberCount: 1, children: [] },
        ],
      },
      {
        tenantId: 't-b',
        tenantName: '乙单位',
        items: [
          { id: 'o-b', name: '乙总部', parentId: null, sort: 0, memberCount: 1, children: [] },
        ],
      },
    ];
    mocks.orgTree.mockImplementation(async (query?: { tenantId?: string }) => ({
      groups: groups.filter((g) => !query?.tenantId || g.tenantId === query.tenantId),
    }));
    mocks.usersList.mockImplementation(async (query: { page: number }) => ({
      items: [row({ id: 'u-a', username: 'jia-user', tenantId: 't-a' })],
      total: 25,
      page: query.page,
      pageSize: 10,
    }));
    // 只看列表本身的请求（待审核计数也走 users.list，pageSize 为 1）
    type ListQuery = { page: number; pageSize: number; tenantId?: string; organizationId?: string };
    const listCalls = () =>
      mocks.usersList.mock.calls.map((c) => c[0] as ListQuery).filter((q) => q.pageSize === 10);
    renderPage();
    const u = userEvent.setup();
    const orgFilter = await screen.findByLabelText('按组织筛选');
    await screen.findByRole('option', { name: '甲总部' });
    await u.selectOptions(orgFilter, 'o-a');
    await u.click(await screen.findByRole('button', { name: '下一页' }));
    await waitFor(() =>
      expect(listCalls().at(-1)).toEqual(
        expect.objectContaining({ organizationId: 'o-a', page: 2 }),
      ),
    );

    await screen.findByRole('option', { name: '乙单位' });
    await u.selectOptions(screen.getByTestId('tenant-filter'), 't-b');
    await waitFor(() =>
      expect(listCalls().at(-1)).toEqual(expect.objectContaining({ tenantId: 't-b', page: 1 })),
    );
    expect(listCalls().at(-1)!.organizationId).toBeUndefined();
    // 不会带着上一个租户的组织去查新租户
    expect(listCalls().some((q) => q.tenantId === 't-b' && q.organizationId)).toBe(false);
    expect(screen.getByLabelText('按组织筛选')).toHaveValue('');
  });
});
