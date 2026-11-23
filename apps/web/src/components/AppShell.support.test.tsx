import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/toast';
import { AppShell } from './AppShell';

// 普通账号（没有任何管理权限）也能从右上角用户菜单进入技术支持和意见反馈。
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: {
      username: 'viewer',
      displayName: '只读用户',
      roles: [],
      tenant: { id: 't-a', name: '甲单位', isPlatform: false },
      isPlatformAdmin: false,
    },
    logout: vi.fn(),
    hasPermission: () => false,
    switchTenant: vi.fn(),
  }),
}));

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={<div>首页</div>} />
              <Route path="/support" element={<div>技术支持页</div>} />
              <Route path="/feedback" element={<div>意见反馈页</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('用户菜单里的技术支持与意见反馈', () => {
  it('所有登录用户都能看到并进入', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: /技术支持/ }));
    expect(await screen.findByText('技术支持页')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /意见反馈/ }));
    expect(await screen.findByText('意见反馈页')).toBeInTheDocument();
  });
});
