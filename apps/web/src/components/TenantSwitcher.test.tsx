import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantSwitcher } from './TenantSwitcher';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  switchTenant: vi.fn(),
  user: null as null | Record<string, unknown>,
}));

vi.mock('@/lib/api', () => ({
  ALL_TENANTS: 'all',
  api: { tenants: { list: mocks.list } },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: mocks.user, switchTenant: mocks.switchTenant }),
}));

const POLICY = {
  tenant: { id: 't-a', name: '甲单位', isPlatform: false },
  homeTenantId: 't-a',
  isPlatformAdmin: false,
};

function renderSwitcher() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TenantSwitcher />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TenantSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({
      items: [
        { id: 'platform', name: '默认租户', isActive: true, isPlatform: true },
        { id: 't-a', name: '甲单位', isActive: true, isPlatform: false },
        { id: 't-b', name: '乙单位', isActive: false, isPlatform: false },
      ],
    });
  });

  it('普通租户的用户只看到自己所在的租户名', () => {
    mocks.user = POLICY;
    renderSwitcher();
    const label = screen.getByTestId('tenant-label');
    expect(label).toHaveTextContent('甲单位');
    expect(screen.queryByTestId('tenant-switcher')).not.toBeInTheDocument();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('平台租户的普通用户不显示租户标识', () => {
    mocks.user = {
      tenant: { id: 'platform', name: '默认租户', isPlatform: true },
      homeTenantId: 'platform',
      isPlatformAdmin: false,
    };
    renderSwitcher();
    expect(screen.queryByTestId('tenant-label')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tenant-switcher')).not.toBeInTheDocument();
  });

  it('平台管理员可切换进入其他租户，已停用的租户有标注', async () => {
    mocks.user = {
      tenant: { id: 'platform', name: '默认租户', isPlatform: true },
      homeTenantId: 'platform',
      isPlatformAdmin: true,
    };
    const user = userEvent.setup();
    renderSwitcher();
    expect(await screen.findByTestId('tenant-switcher')).toBeInTheDocument();
    expect(screen.getByLabelText('当前租户：默认租户')).toBeInTheDocument();
    expect(await screen.findByText('乙单位')).toBeInTheDocument();
    expect(screen.getByText('已停用')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /租户管理/ })).toBeInTheDocument();

    await user.click(screen.getByText('甲单位'));
    await waitFor(() => expect(mocks.switchTenant).toHaveBeenCalledWith('t-a'));
  });

  it('代管租户时摘要显示「代管：」，并可切回平台租户', async () => {
    mocks.user = {
      tenant: { id: 't-a', name: '甲单位', isPlatform: false },
      homeTenantId: 'platform',
      isPlatformAdmin: true,
    };
    const user = userEvent.setup();
    renderSwitcher();
    expect(await screen.findByLabelText('当前租户：甲单位')).toHaveTextContent('代管：甲单位');
    await user.click(await screen.findByText('默认租户'));
    await waitFor(() => expect(mocks.switchTenant).toHaveBeenCalledWith('platform'));
  });

  it('全部租户视角：摘要显示「全部租户」，不使用代管的琥珀色，菜单项为当前项', async () => {
    mocks.user = {
      tenant: { id: 'all', name: '全部租户', isPlatform: true },
      homeTenantId: 'platform',
      isPlatformAdmin: true,
      allTenants: true,
    };
    renderSwitcher();
    const summary = await screen.findByLabelText('当前租户：全部租户');
    expect(summary).toHaveTextContent('全部租户');
    expect(summary).not.toHaveTextContent('代管：');
    expect(summary.className).not.toMatch(/amber/);
    const allItem = screen.getByTestId('tenant-all');
    expect(allItem).toBeDisabled();
    expect(allItem).toHaveTextContent('全部租户');
  });

  it('平台管理员可从下拉里点「全部租户」进入全局视角', async () => {
    mocks.user = {
      tenant: { id: 'platform', name: '默认租户', isPlatform: true },
      homeTenantId: 'platform',
      isPlatformAdmin: true,
    };
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(await screen.findByTestId('tenant-all'));
    await waitFor(() => expect(mocks.switchTenant).toHaveBeenCalledWith('all'));
  });
});
