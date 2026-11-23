import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { ForcePasswordChangePage } from './ForcePasswordChangePage';

const authMock = vi.hoisted(() => ({ logout: vi.fn(), refreshUser: vi.fn() }));
const apiMock = vi.hoisted(() => ({ changeMyPassword: vi.fn(), passwordPolicy: vi.fn() }));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { changeMyPassword: apiMock.changeMyPassword, passwordPolicy: apiMock.passwordPolicy },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: { username: 'newbie', passwordChangeRequired: true },
    logout: authMock.logout,
    refreshUser: authMock.refreshUser,
  }),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/change-password']}>
          <Routes>
            <Route path="/change-password" element={<ForcePasswordChangePage />} />
            <Route path="/login" element={<div>登录页占位</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ForcePasswordChangePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.logout.mockResolvedValue(undefined);
    authMock.refreshUser.mockResolvedValue(undefined);
    apiMock.passwordPolicy.mockResolvedValue({
      passwordMinLength: 8,
      passwordRequireUppercase: false,
      passwordRequireLowercase: false,
      passwordRequireDigit: false,
      passwordRequireSpecial: false,
      passwordExpireDays: 0,
    });
  });

  it('弹窗底部可以退出登录，回到登录页', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: '退出登录' }));
    await waitFor(() => expect(authMock.logout).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('登录页占位')).toBeInTheDocument();
  });

  it('改密成功后刷新当前用户', async () => {
    apiMock.changeMyPassword.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const { container } = renderPage();
    const [current, next, confirm] = Array.from(
      container.ownerDocument.querySelectorAll<HTMLInputElement>('input[type="password"]'),
    ) as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    await user.type(current, 'OldPass@1');
    await user.type(next, 'NewPass@123');
    await user.type(confirm, 'NewPass@123');
    await user.click(screen.getByRole('button', { name: '确认修改' }));
    await waitFor(() => expect(authMock.refreshUser).toHaveBeenCalled());
  });
});
