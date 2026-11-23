import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import type { TenantItem } from '@/lib/api';
import { TenantsPage, generateInitialPassword } from './TenantsPage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  switchTenant: vi.fn(),
  isPlatformAdmin: true,
}));

vi.mock('@/lib/api', () => ({
  api: { tenants: { list: mocks.list, create: mocks.create, update: mocks.update } },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: {
      id: 'u1',
      username: 'admin',
      roles: ['admin'],
      permissions: [],
      isPlatformAdmin: mocks.isPlatformAdmin,
      tenant: { id: 'platform', name: '默认租户', isPlatform: true },
    },
    switchTenant: mocks.switchTenant,
  }),
}));

function tenant(over: Partial<TenantItem> = {}): TenantItem {
  return {
    id: 't-a',
    name: '甲单位',
    description: null,
    isActive: true,
    isPlatform: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    userCount: 2,
    targetCount: 3,
    endpointCount: 1,
    taskCount: 7,
    lastTaskAt: '2026-11-05T08:00:00.000Z',
    ...over,
  };
}

const PLATFORM = tenant({
  id: 'platform',
  name: '默认租户',
  isPlatform: true,
  description: '平台租户',
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <TenantsPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('TenantsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isPlatformAdmin = true;
    mocks.list.mockResolvedValue({ items: [PLATFORM, tenant()] });
  });

  it('平台管理员看到租户列表与各租户的资产统计', async () => {
    renderPage();
    expect(await screen.findByRole('cell', { name: /甲单位/ })).toBeInTheDocument();
    expect(screen.getByText('平台租户')).toBeInTheDocument();
    expect(screen.getByText('平台')).toBeInTheDocument();
    expect(screen.getByText('当前')).toBeInTheDocument();
    const row = screen.getByRole('cell', { name: /甲单位/ }).closest('tr')!;
    for (const value of ['2', '3', '1', '7']) {
      expect(within(row).getByText(value)).toBeInTheDocument();
    }
  });

  it('非平台管理员只看到一句说明，且不请求租户列表', async () => {
    mocks.isPlatformAdmin = false;
    renderPage();
    expect(await screen.findByText('仅平台管理员可以管理租户')).toBeInTheDocument();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('新建租户后显示账号与初始密码，可直接进入该租户', async () => {
    const created = tenant({ id: 't-new', name: '乙单位' });
    mocks.create.mockResolvedValue(created);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('cell', { name: /甲单位/ });

    await user.click(screen.getByRole('button', { name: '新建租户' }));
    await user.type(screen.getByLabelText(/租户名称/), '乙单位');
    await user.type(screen.getByLabelText(/租户管理员账号/), 'yi-admin');
    const password = (screen.getByLabelText(/初始密码/) as HTMLInputElement).value;
    expect(password).toHaveLength(12);
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        name: '乙单位',
        description: undefined,
        admin: { username: 'yi-admin', password },
      }),
    );
    const info = await screen.findByTestId('tenant-created-info');
    expect(info).toHaveTextContent('yi-admin');
    expect(info).toHaveTextContent(password);

    await user.click(screen.getByRole('button', { name: '进入该租户' }));
    expect(mocks.switchTenant).toHaveBeenCalledWith('t-new');
  });

  it('停用与启用直接调接口，不做二次确认', async () => {
    mocks.update.mockResolvedValue(tenant({ isActive: false }));
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByRole('cell', { name: /甲单位/ })).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: '停用' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('t-a', { isActive: false }),
    );
    // 平台租户没有停用/启用入口
    const platformRow = screen.getByText('平台租户').closest('tr')!;
    expect(within(platformRow).queryByRole('button', { name: '停用' })).not.toBeInTheDocument();
    expect(within(platformRow).queryByRole('button', { name: '启用' })).not.toBeInTheDocument();
  });
});

describe('generateInitialPassword', () => {
  it('生成的初始密码满足默认密码策略（大小写、数字、符号各至少一位）', () => {
    for (let i = 0; i < 20; i += 1) {
      const pw = generateInitialPassword();
      expect(pw).toHaveLength(12);
      expect(/[A-Z]/.test(pw)).toBe(true);
      expect(/[a-z]/.test(pw)).toBe(true);
      expect(/[0-9]/.test(pw)).toBe(true);
      expect(/[@#%+=!]/.test(pw)).toBe(true);
    }
  });
});
