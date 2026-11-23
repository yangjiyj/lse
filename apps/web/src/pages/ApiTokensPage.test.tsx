import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { ApiTokensPage } from './ApiTokensPage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  roles: ['admin'] as string[],
}));

vi.mock('@/lib/api', () => ({
  api: { apiTokens: { list: mocks.list, create: mocks.create, revoke: mocks.revoke } },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { roles: mocks.roles, permissions: [] } }),
}));

const ITEM = {
  id: 't1',
  name: 'GitLab 流水线',
  prefix: 'abcd1234',
  maskedToken: 'lse_abcd1234_********',
  scopes: ['gates:read'],
  expiresAt: '2026-12-01T00:00:00.000Z',
  revokedAt: null,
  lastUsedAt: null,
  createdById: 'u1',
  createdByName: '管理员',
  createdAt: '2026-09-29T00:00:00.000Z',
  status: 'ACTIVE',
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ApiTokensPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ApiTokensPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.roles = ['admin'];
    mocks.list.mockResolvedValue({ items: [ITEM], scopes: ['gates:read', 'eval-plans:trigger'] });
  });

  it('列表只显示掩码令牌与中文权限范围', async () => {
    renderPage();
    expect(await screen.findByRole('cell', { name: 'GitLab 流水线' })).toBeInTheDocument();
    expect(screen.getByText('lse_abcd1234_********')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '查询门禁判定' })).toBeInTheDocument();
    expect(screen.getByText('有效')).toBeInTheDocument();
  });

  it('创建后弹窗显示一次明文，可复制', async () => {
    const plain = 'lse_abcd1234_0123456789abcdef0123456789abcdef';
    mocks.create.mockResolvedValue({ token: plain, item: ITEM });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    await screen.findByRole('cell', { name: 'GitLab 流水线' });
    await user.click(screen.getByRole('button', { name: '新建令牌' }));
    await user.type(screen.getByLabelText(/名称/), 'CI');
    await user.click(screen.getByLabelText(/触发评估计划/));
    await user.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        name: 'CI',
        scopes: ['gates:read', 'eval-plans:trigger'],
        expiresInDays: 90,
      }),
    );
    expect(await screen.findByTestId('plain-token')).toHaveTextContent(plain);
    expect(screen.getByText(/明文令牌只显示这一次/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '复制' }));
    expect(writeText).toHaveBeenCalledWith(plain);
    await user.click(screen.getByRole('button', { name: '我已保存' }));
    expect(screen.queryByTestId('plain-token')).not.toBeInTheDocument();
  });

  it('空列表显示暂无数据；非管理员不请求列表', async () => {
    mocks.list.mockResolvedValue({ items: [], scopes: [] });
    const { unmount } = renderPage();
    expect(await screen.findByText('暂无数据')).toBeInTheDocument();
    unmount();
    mocks.roles = ['operator'];
    mocks.list.mockClear();
    renderPage();
    expect(screen.getByText('仅管理员可管理 API 令牌')).toBeInTheDocument();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
