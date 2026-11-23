import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/toast';
import { UsersPage } from './UsersPage';

const apiMock = vi.hoisted(() => ({
  list: vi.fn(),
  rolesList: vi.fn(),
  passwordPolicy: vi.fn(),
  create: vi.fn(),
  resetPassword: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  reviewRegistration: vi.fn(),
}));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
const orgMock = vi.hoisted(() => ({ tree: vi.fn() }));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    users: {
      list: apiMock.list,
      create: apiMock.create,
      resetPassword: apiMock.resetPassword,
      remove: apiMock.remove,
      update: apiMock.update,
      reviewRegistration: apiMock.reviewRegistration,
    },
    roles: { list: apiMock.rolesList },
    passwordPolicy: apiMock.passwordPolicy,
  },
}));
vi.mock('@/lib/organizations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/organizations')>();
  return { ...actual, organizationApi: { tree: orgMock.tree } };
});
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => permissions.granted.has(code) }),
}));
vi.mock('@/components/SensitiveText', () => ({
  SensitiveValue: ({ value }: { value: string | null }) => <span>{value ?? '—'}</span>,
}));

const LONG_NAME = 'agentshield-prod-20261014';

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u-1',
    username: 'zhangsan',
    displayName: '张三',
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

function policy(overrides: Record<string, unknown> = {}) {
  return {
    passwordMinLength: 8,
    passwordRequireUppercase: false,
    passwordRequireLowercase: false,
    passwordRequireDigit: false,
    passwordRequireSpecial: false,
    passwordExpireDays: 0,
    ...overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <UsersPage embedded />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('UsersPage 列表', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissions.granted = new Set([
      'user:create',
      'user:update',
      'user:delete',
      'user:reset_password',
    ]);
    apiMock.list.mockResolvedValue({
      items: [
        user({ id: 'u-1', username: LONG_NAME }),
        user({ id: 'u-2', username: 'admin', displayName: '管理员', isBuiltin: true }),
      ],
      total: 2,
      page: 1,
      pageSize: 10,
    });
    apiMock.rolesList.mockResolvedValue({ items: [{ id: 'r-1', name: '评估员' }] });
    apiMock.passwordPolicy.mockResolvedValue(policy());
  });

  it('用户名列不再逐字断行：最小宽度 160px、按词换行，且不再被限成 200px', async () => {
    renderPage();
    const cell = (await screen.findByText(LONG_NAME)).closest('td')!;
    expect(cell).toHaveClass('min-w-[160px]', 'break-words');
    expect(cell).not.toHaveClass('break-all');
    expect(cell.className).not.toMatch(/max-w-\[200px\]/);
  });

  it('操作列压窄到 120px 以内，不再占 248px', async () => {
    renderPage();
    await screen.findByText(LONG_NAME);
    const header = screen.getByRole('columnheader', { name: '操作' });
    expect(header).toHaveClass('w-[120px]');
    expect(header.className).not.toMatch(/w-\[248px\]/);
  });

  it('每行的编辑、重置密码、删除都在，并按用户名区分可访问名称', async () => {
    renderPage();
    const row = (await screen.findByText(LONG_NAME)).closest('tr')!;
    expect(within(row).getByRole('button', { name: `编辑 ${LONG_NAME}` })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: `重置密码 ${LONG_NAME}` })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: `删除 ${LONG_NAME}` })).toBeInTheDocument();
  });

  it('内置角色显示中文名，自建角色按原名', async () => {
    apiMock.list.mockResolvedValue({
      items: [
        user({ id: 'u-3', username: 'tenant-a-admin', roles: [{ id: 'r-ta', name: 'tenant_admin' }] }),
        user({ id: 'u-4', username: 'op', roles: [{ id: 'r-op', name: 'operator' }, { id: 'r-1', name: '评估员' }] }),
      ],
      total: 2,
      page: 1,
      pageSize: 10,
    });
    renderPage();
    const adminRow = (await screen.findByText('tenant-a-admin')).closest('tr')!;
    expect(within(adminRow).getByText('租户管理员')).toBeInTheDocument();
    expect(within(adminRow).queryByText('tenant_admin')).not.toBeInTheDocument();
    const opRow = screen.getByText('op').closest('tr')!;
    expect(within(opRow).getByText('评估操作员')).toBeInTheDocument();
    expect(within(opRow).getByText('评估员')).toBeInTheDocument();
  });

  it('内置用户不能删除，但编辑和重置密码仍在', async () => {
    renderPage();
    const row = (await screen.findByText('admin')).closest('tr')!;
    expect(within(row).getByRole('button', { name: '编辑 admin' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '重置密码 admin' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: '删除 admin' })).not.toBeInTheDocument();
  });

  it('没有对应权限时不显示相应操作', async () => {
    permissions.granted = new Set(['user:update']);
    renderPage();
    const row = (await screen.findByText(LONG_NAME)).closest('tr')!;
    expect(within(row).getByRole('button', { name: `编辑 ${LONG_NAME}` })).toBeInTheDocument();
    expect(
      within(row).queryByRole('button', { name: `重置密码 ${LONG_NAME}` }),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByRole('button', { name: `删除 ${LONG_NAME}` }),
    ).not.toBeInTheDocument();
  });
});

describe('UsersPage 密码长度按安全设置联动', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissions.granted = new Set(['user:create', 'user:reset_password']);
    apiMock.list.mockResolvedValue({
      items: [user({ id: 'u-1', username: 'zhangsan' })],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    apiMock.rolesList.mockResolvedValue({ items: [{ id: 'r-1', name: '评估员' }] });
    apiMock.passwordPolicy.mockResolvedValue(policy({ passwordMinLength: 12 }));
    apiMock.create.mockResolvedValue({});
    apiMock.resetPassword.mockResolvedValue({});
  });

  it('新建用户：初始密码提示读取安全设置的最小长度，不再写死 8 位', async () => {
    const u = userEvent.setup();
    renderPage();
    await screen.findByText('zhangsan');
    await u.click(screen.getByRole('button', { name: /新建用户/ }));
    const dialog = await screen.findByRole('dialog', { name: '新建用户' });
    await waitFor(() => expect(within(dialog).getByText('至少 12 位')).toBeInTheDocument());
    expect(within(dialog).queryByText('至少 8 位')).not.toBeInTheDocument();
  });

  it('新建用户：密码达不到安全设置要求时不能创建，达到后可以创建', async () => {
    const u = userEvent.setup();
    renderPage();
    await screen.findByText('zhangsan');
    await u.click(screen.getByRole('button', { name: /新建用户/ }));
    const dialog = await screen.findByRole('dialog', { name: '新建用户' });
    await waitFor(() => expect(within(dialog).getByText('至少 12 位')).toBeInTheDocument());

    await u.type(within(dialog).getByPlaceholderText('如 zhangsan'), 'lisi');
    await u.type(within(dialog).getByLabelText(/^初始密码/), 'Short#123');
    await u.type(within(dialog).getByLabelText(/^确认初始密码/), 'Short#123');
    await u.type(within(dialog).getByLabelText(/^姓名/), '李四');
    const create = within(dialog).getByRole('button', { name: '创建' });
    expect(create).toBeDisabled();

    await u.clear(within(dialog).getByLabelText(/^初始密码/));
    await u.clear(within(dialog).getByLabelText(/^确认初始密码/));
    await u.type(within(dialog).getByLabelText(/^初始密码/), 'LongEnough#12345');
    await u.type(within(dialog).getByLabelText(/^确认初始密码/), 'LongEnough#12345');
    expect(create).toBeEnabled();
  });

  it('安全设置里还要求大写字母、数字时，提示里一并写出', async () => {
    apiMock.passwordPolicy.mockResolvedValue(
      policy({ passwordMinLength: 10, passwordRequireUppercase: true, passwordRequireDigit: true }),
    );
    const u = userEvent.setup();
    renderPage();
    await screen.findByText('zhangsan');
    await u.click(screen.getByRole('button', { name: /新建用户/ }));
    const dialog = await screen.findByRole('dialog', { name: '新建用户' });
    await waitFor(() =>
      expect(within(dialog).getByText('至少 10 位，含大写字母、数字')).toBeInTheDocument(),
    );
  });

  it('重置密码：提示与可提交条件同样读取安全设置', async () => {
    const u = userEvent.setup();
    renderPage();
    await screen.findByText('zhangsan');
    await u.click(screen.getByRole('button', { name: '重置密码 zhangsan' }));
    const dialog = await screen.findByRole('dialog', { name: /重置密码：张三/ });
    await waitFor(() => expect(within(dialog).getByText('至少 12 位')).toBeInTheDocument());

    const submit = within(dialog).getByRole('button', { name: '确认重置' });
    await u.type(within(dialog).getByLabelText(/^新密码/), '12345678');
    await u.type(within(dialog).getByLabelText(/^确认新密码/), '12345678');
    expect(submit).toBeDisabled();

    await u.clear(within(dialog).getByLabelText(/^新密码/));
    await u.clear(within(dialog).getByLabelText(/^确认新密码/));
    await u.type(within(dialog).getByLabelText(/^新密码/), '123456789012');
    await u.type(within(dialog).getByLabelText(/^确认新密码/), '123456789012');
    expect(submit).toBeEnabled();
    await u.click(submit);
    await waitFor(() => expect(apiMock.resetPassword).toHaveBeenCalledWith('u-1', '123456789012'));
  });

  it('策略接口取不到时按默认的 8 位兜底，不会卡死表单', async () => {
    apiMock.passwordPolicy.mockRejectedValue(new Error('network'));
    const u = userEvent.setup();
    renderPage();
    await screen.findByText('zhangsan');
    await u.click(screen.getByRole('button', { name: '重置密码 zhangsan' }));
    const dialog = await screen.findByRole('dialog', { name: /重置密码：张三/ });
    expect(within(dialog).getByText('至少 8 位')).toBeInTheDocument();
  });
});

describe('UsersPage 审核注册', () => {
  const pending = user({
    id: 'u-p',
    username: 'reg-user',
    displayName: '李四',
    phone: '13800138000',
    organization: '某某研究院',
    isActive: false,
    registrationStatus: 'PENDING',
    roles: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    permissions.granted = new Set(['user:update']);
    apiMock.list.mockImplementation((q?: { registrationStatus?: string }) =>
      Promise.resolve(
        q?.registrationStatus === 'PENDING'
          ? { items: [pending], total: 1, page: 1, pageSize: 10 }
          : { items: [user(), pending], total: 2, page: 1, pageSize: 10 },
      ),
    );
    apiMock.rolesList.mockResolvedValue({ items: [{ id: 'r-op', name: 'operator' }] });
    apiMock.reviewRegistration.mockResolvedValue({ ...pending, registrationStatus: 'APPROVED' });
  });

  it('有待审核时「待审核」筛选显示数量，点击后只查待审核', async () => {
    renderPage();
    const filter = await screen.findByRole('button', { name: /待审核\s*1/ });
    await userEvent.setup().click(filter);
    await waitFor(() =>
      expect(apiMock.list).toHaveBeenCalledWith(
        expect.objectContaining({ registrationStatus: 'PENDING', page: 1, pageSize: 10 }),
      ),
    );
  });

  it('列表显示手机号和单位，待审核行有「通过」「拒绝」', async () => {
    renderPage();
    const row = (await screen.findByText('reg-user')).closest('tr')!;
    expect(within(row).getByText('13800138000')).toBeInTheDocument();
    expect(within(row).getByText('某某研究院')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '通过 reg-user' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '拒绝 reg-user' })).toBeInTheDocument();
    const normal = screen.getByText('zhangsan').closest('tr')!;
    expect(within(normal).queryByRole('button', { name: /^通过/ })).not.toBeInTheDocument();
  });

  it('通过时可以选角色', async () => {
    const ue = userEvent.setup();
    renderPage();
    const row = (await screen.findByText('reg-user')).closest('tr')!;
    await ue.click(within(row).getByRole('button', { name: '通过 reg-user' }));
    const dialog = await screen.findByRole('dialog');
    await ue.click(within(dialog).getByRole('button', { name: '评估操作员' }));
    await ue.click(within(dialog).getByRole('button', { name: '通过' }));
    await waitFor(() =>
      expect(apiMock.reviewRegistration).toHaveBeenCalledWith('u-p', {
        action: 'approve',
        roleIds: ['r-op'],
      }),
    );
  });

  it('拒绝前要确认', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const ue = userEvent.setup();
    renderPage();
    const row = (await screen.findByText('reg-user')).closest('tr')!;
    await ue.click(within(row).getByRole('button', { name: '拒绝 reg-user' }));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(apiMock.reviewRegistration).toHaveBeenCalledWith('u-p', { action: 'reject' }),
    );
    confirmSpy.mockRestore();
  });

  it('没有编辑用户权限时不显示审核操作', async () => {
    permissions.granted = new Set();
    renderPage();
    const row = (await screen.findByText('reg-user')).closest('tr')!;
    expect(within(row).queryByRole('button', { name: '通过 reg-user' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: '拒绝 reg-user' })).not.toBeInTheDocument();
  });
});

describe('UsersPage 已拒绝与待审核的行', () => {
  const rejected = user({
    id: 'u-r',
    username: 'rej-user',
    displayName: '王五',
    isActive: false,
    registrationStatus: 'REJECTED',
    roles: [],
  });
  const pending = user({
    id: 'u-p',
    username: 'reg-user',
    displayName: '李四',
    isActive: false,
    registrationStatus: 'PENDING',
    roles: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    permissions.granted = new Set(['user:update']);
    apiMock.list.mockImplementation((q?: { registrationStatus?: string }) =>
      Promise.resolve(
        q?.registrationStatus === 'PENDING'
          ? { items: [pending], total: 1, page: 1, pageSize: 10 }
          : { items: [user(), pending, rejected], total: 3, page: 1, pageSize: 10 },
      ),
    );
    apiMock.rolesList.mockResolvedValue({ items: [{ id: 'r-op', name: 'operator' }] });
    apiMock.update.mockResolvedValue(rejected);
    apiMock.reviewRegistration.mockResolvedValue({ ...rejected, registrationStatus: 'APPROVED' });
  });

  it('状态按注册状态如实显示：待审核、已拒绝', async () => {
    renderPage();
    const rejRow = (await screen.findByText('rej-user')).closest('tr')!;
    expect(within(rejRow).getByText('已拒绝')).toBeInTheDocument();
    expect(within(rejRow).queryByText('禁用')).not.toBeInTheDocument();
    const pendRow = screen.getByText('reg-user').closest('tr')!;
    expect(within(pendRow).getByText('待审核')).toBeInTheDocument();
  });

  it('注册状态与启用状态都如实显示，不互相遮盖', async () => {
    apiMock.list.mockResolvedValue({
      items: [
        user({
          id: 'u-x',
          username: 'odd-user',
          isActive: true,
          registrationStatus: 'REJECTED',
          roles: [],
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    renderPage();
    const row = (await screen.findByText('odd-user')).closest('tr')!;
    expect(within(row).getByText('已拒绝')).toBeInTheDocument();
    expect(within(row).getByText('启用')).toBeInTheDocument();
  });

  it('已拒绝的行可以「通过」，不再有「拒绝」', async () => {
    const ue = userEvent.setup();
    renderPage();
    const row = (await screen.findByText('rej-user')).closest('tr')!;
    expect(within(row).queryByRole('button', { name: '拒绝 rej-user' })).not.toBeInTheDocument();
    await ue.click(within(row).getByRole('button', { name: '通过 rej-user' }));
    const dialog = await screen.findByRole('dialog');
    await ue.click(within(dialog).getByRole('button', { name: '通过' }));
    await waitFor(() =>
      expect(apiMock.reviewRegistration).toHaveBeenCalledWith('u-r', {
        action: 'approve',
        roleIds: [],
      }),
    );
  });

  it('已拒绝的行编辑里没有「启用账号」开关，保存时不提交启用状态', async () => {
    const ue = userEvent.setup();
    renderPage();
    const row = (await screen.findByText('rej-user')).closest('tr')!;
    await ue.click(within(row).getByRole('button', { name: /编辑/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('启用账号')).not.toBeInTheDocument();
    await ue.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(apiMock.update).toHaveBeenCalled());
    expect(apiMock.update.mock.calls[0]![1]).not.toHaveProperty('isActive');
  });

  it('普通用户编辑里仍有「启用账号」开关', async () => {
    const ue = userEvent.setup();
    renderPage();
    const row = (await screen.findByText('zhangsan')).closest('tr')!;
    await ue.click(within(row).getByRole('button', { name: /编辑/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('启用账号')).toBeInTheDocument();
  });
});

describe('UsersPage 组织', () => {
  const org = (id: string, name: string, parentId: string | null, children: unknown[] = []) => ({
    id,
    name,
    parentId,
    sort: 0,
    memberCount: 0,
    children,
  });
  const TREE = [org('o-hq', '总部', null, [org('o-rd', '研发中心', 'o-hq'), org('o-ops', '运营中心', 'o-hq')])];

  beforeEach(() => {
    vi.clearAllMocks();
    permissions.granted = new Set(['user:create', 'user:update', 'org:read']);
    apiMock.list.mockResolvedValue({
      items: [
        user({ id: 'u-1', username: 'zhangsan', organizationId: 'o-hq', organizationPath: '总部' }),
        user({ id: 'u-2', username: 'lisi', organizationId: null, organizationPath: null }),
      ],
      total: 2,
      page: 1,
      pageSize: 10,
    });
    apiMock.rolesList.mockResolvedValue({ items: [{ id: 'r-1', name: '评估员' }] });
    apiMock.passwordPolicy.mockResolvedValue(policy());
    apiMock.update.mockResolvedValue(user());
    apiMock.create.mockResolvedValue(user());
    orgMock.tree.mockResolvedValue({ items: TREE });
  });

  it('列表有「组织」列，显示组织路径', async () => {
    renderPage();
    const row = (await screen.findByText('zhangsan')).closest('tr')!;
    expect(screen.getByRole('columnheader', { name: '组织' })).toBeInTheDocument();
    expect(within(row).getByText('总部')).toBeInTheDocument();
  });

  it('按组织筛选：带上组织并包含下级', async () => {
    renderPage();
    await screen.findByText('zhangsan');
    const filter = screen.getByLabelText('按组织筛选');
    await waitFor(() => expect(within(filter).getAllByRole('option')).toHaveLength(4));
    await userEvent.selectOptions(filter, 'o-rd');
    await waitFor(() =>
      expect(apiMock.list).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'o-rd', includeDescendants: true, page: 1 }),
      ),
    );
  });

  it('用户编辑提交时带 organizationId', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '编辑 zhangsan' }));
    const select = await screen.findByLabelText('组织');
    expect(select).toHaveValue('o-hq');
    expect(within(select).getByRole('option', { name: '总部 / 研发中心' })).toBeInTheDocument();
    await userEvent.selectOptions(select, 'o-rd');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(apiMock.update).toHaveBeenCalledWith('u-1', expect.objectContaining({ organizationId: 'o-rd' })),
    );
  });

  it('编辑时清空组织提交 null；不动组织就不提交', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '编辑 zhangsan' }));
    await userEvent.selectOptions(await screen.findByLabelText('组织'), '');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(apiMock.update).toHaveBeenCalledWith('u-1', expect.objectContaining({ organizationId: null })),
    );

    await userEvent.click(await screen.findByRole('button', { name: '编辑 lisi' }));
    await screen.findByLabelText('组织');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(apiMock.update).toHaveBeenCalledTimes(2));
    expect(apiMock.update.mock.calls[1]![1]).not.toHaveProperty('organizationId');
  });

  it('新建用户可选组织', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /新建用户/ }));
    await userEvent.selectOptions(await screen.findByLabelText('组织'), 'o-ops');
    await userEvent.type(screen.getByPlaceholderText('如 zhangsan'), 'wangwu');
    await userEvent.type(screen.getByLabelText(/^初始密码/), 'Passw0rd!');
    await userEvent.type(screen.getByLabelText(/确认初始密码/), 'Passw0rd!');
    await userEvent.type(screen.getByLabelText(/^姓名/), '王五');
    await userEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() =>
      expect(apiMock.create).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'o-ops' })),
    );
  });

  it('没有查看组织架构权限：不查组织树，没有筛选和下拉，组织列照常显示', async () => {
    permissions.granted = new Set(['user:update']);
    renderPage();
    const row = (await screen.findByText('zhangsan')).closest('tr')!;
    expect(within(row).getByText('总部')).toBeInTheDocument();
    expect(screen.queryByLabelText('按组织筛选')).not.toBeInTheDocument();
    expect(orgMock.tree).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '编辑 zhangsan' }));
    expect(screen.queryByLabelText('组织')).not.toBeInTheDocument();
  });
});
