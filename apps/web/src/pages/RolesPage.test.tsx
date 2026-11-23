import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { RolesPage } from './RolesPage';

const apiMock = vi.hoisted(() => ({
  list: vi.fn(),
  permissions: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  users: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    roles: {
      list: apiMock.list,
      create: apiMock.create,
      update: apiMock.update,
      remove: apiMock.remove,
      users: apiMock.users,
    },
    permissions: apiMock.permissions,
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RolesPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('RolesPage responsive permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
    apiMock.permissions.mockResolvedValue({
      groups: [
        {
          group: '评估任务',
          items: [
            { code: 'eval_task:create', name: '创建评估任务' },
            { code: 'eval_task:read', name: '查看评估任务' },
          ],
        },
        {
          group: '模型对象',
          items: [{ code: 'model_target:create', name: '新增模型对象' }],
        },
      ],
      all: [],
    });
  });

  it('permission options use a single readable column on narrow screens', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /新建角色/ }));
    await screen.findByText('评估任务');

    const option = screen.getByLabelText('创建评估任务');
    const grid = option.closest('[data-testid="permission-option-grid"]');

    expect(grid).toHaveClass('grid-cols-1');
    expect(grid).toHaveClass('sm:grid-cols-2');
    expect(option.closest('label')).toHaveClass('items-center');
    expect(screen.queryByText(/勾选后，可以/)).not.toBeInTheDocument();
    expect(screen.getByText('评估对象')).toBeInTheDocument();
    expect(screen.getByLabelText('新建评估对象')).toBeInTheDocument();
    expect(screen.queryByText('模型对象')).not.toBeInTheDocument();
    await waitFor(() => expect(apiMock.permissions).toHaveBeenCalled());
  });

  it('已下线的检测方案权限不在角色编辑里列出', async () => {
    apiMock.permissions.mockResolvedValue({
      groups: [
        {
          group: '评估任务',
          items: [{ code: 'eval_task:read', name: '查看评估任务' }],
        },
        {
          group: '检测方案',
          items: [
            { code: 'scheme:read', name: '查看检测方案' },
            { code: 'scheme:manage', name: '维护检测方案' },
          ],
        },
      ],
      all: [],
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /新建角色/ }));
    await screen.findByLabelText('查看评估任务');
    expect(screen.queryByLabelText('查看检测方案')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('维护检测方案')).not.toBeInTheDocument();
    expect(screen.queryByText('检测方案')).not.toBeInTheDocument();
  });
});

describe('RolesPage 角色下的用户', () => {
  const role = {
    id: 'role-op',
    name: 'operator',
    description: null,
    isBuiltin: true,
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
    userCount: 2,
    permissions: ['eval_task:read'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.list.mockResolvedValue({ items: [role] });
    apiMock.permissions.mockResolvedValue({ groups: [], all: [] });
    apiMock.users.mockResolvedValue({
      items: [
        { id: 'u1', username: 'zhangsan', displayName: '张三', tenantName: '平台', isActive: true },
        { id: 'u2', username: 'lisi', displayName: '李四', tenantName: '租户甲', isActive: false },
      ],
    });
  });

  it('点用户数打开名单抽屉', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '评估操作员的用户（2）' }));

    const drawer = await screen.findByRole('dialog', { name: '评估操作员' });
    expect(apiMock.users).toHaveBeenCalledWith('role-op');
    expect(await within(drawer).findByText('张三')).toBeInTheDocument();
    expect(within(drawer).getByText('zhangsan')).toBeInTheDocument();
    expect(within(drawer).getByText('租户甲')).toBeInTheDocument();
    expect(within(drawer).getByText('禁用')).toBeInTheDocument();

    await userEvent.click(within(drawer).getByRole('button', { name: '关闭详情' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('名单超过 500 人时提示仅显示前 500 人', async () => {
    apiMock.users.mockResolvedValue({
      items: [
        { id: 'u1', username: 'zhangsan', displayName: '张三', tenantName: '平台', isActive: true },
      ],
      truncated: true,
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '评估操作员的用户（2）' }));
    const drawer = await screen.findByRole('dialog', { name: '评估操作员' });
    expect(await within(drawer).findByText('仅显示前 500 人')).toBeInTheDocument();
  });

  it('名单没超过 500 人时不提示', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '评估操作员的用户（2）' }));
    const drawer = await screen.findByRole('dialog', { name: '评估操作员' });
    await within(drawer).findByText('张三');
    expect(within(drawer).queryByText('仅显示前 500 人')).not.toBeInTheDocument();
  });

  it('用户数为 0 时不能点开', async () => {
    apiMock.list.mockResolvedValue({ items: [{ ...role, userCount: 0 }] });
    renderPage();
    await screen.findByText('评估操作员');
    expect(screen.queryByRole('button', { name: /的用户/ })).not.toBeInTheDocument();
  });
});
