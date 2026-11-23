import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/toast';
import { DEFAULT_SECURITY_SETTINGS, SecuritySettingsCard } from './SecuritySettingsCard';

const apiMock = vi.hoisted(() => ({
  settingsGet: vi.fn(),
  settingsUpdate: vi.fn(),
  tenantsList: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    systemSettings: { get: apiMock.settingsGet, update: apiMock.settingsUpdate },
    tenants: { list: apiMock.tenantsList },
  },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { isPlatformAdmin: true } }),
}));

function tenant(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, isPlatform: false, isActive: true, ...extra };
}

function renderCard(security = DEFAULT_SECURITY_SETTINGS) {
  apiMock.settingsGet.mockResolvedValue({ security, updatedAt: { security: null } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <SecuritySettingsCard canUpdate />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('SecuritySettingsCard 注册用户归属租户', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.tenantsList.mockResolvedValue({
      items: [
        tenant('t-platform', '平台', { isPlatform: true }),
        tenant('t-a', '甲单位'),
        tenant('t-off', '已停用单位', { isActive: false }),
      ],
    });
    apiMock.settingsUpdate.mockImplementation(async (body: { security: unknown }) => ({
      security: body.security,
      updatedAt: { security: '2026-11-21T00:00:00.000Z' },
    }));
  });

  it('关着注册时不显示归属租户', async () => {
    renderCard();
    await screen.findByLabelText('开放注册');
    expect(screen.queryByLabelText('注册用户归属租户')).not.toBeInTheDocument();
  });

  it('打开注册后要选归属租户才能保存，选项为现有租户', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByLabelText('开放注册'));
    const select = await screen.findByLabelText('注册用户归属租户');
    await waitFor(() => expect(screen.getByRole('option', { name: '甲单位' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: '已停用单位' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '保存安全设置' }));
    expect(await screen.findByText('请选择注册用户归属租户')).toBeInTheDocument();
    expect(apiMock.settingsUpdate).not.toHaveBeenCalled();

    await user.selectOptions(select, 't-a');
    await user.click(screen.getByRole('button', { name: '保存安全设置' }));
    await waitFor(() =>
      expect(apiMock.settingsUpdate).toHaveBeenCalledWith({
        security: expect.objectContaining({
          registrationEnabled: true,
          registrationTenantId: 't-a',
        }),
      }),
    );
  });

  it('已配置的归属租户回显', async () => {
    renderCard({
      ...DEFAULT_SECURITY_SETTINGS,
      registrationEnabled: true,
      registrationTenantId: 't-a',
    });
    const select = await screen.findByLabelText('注册用户归属租户');
    await waitFor(() => expect(select).toHaveValue('t-a'));
  });
});
