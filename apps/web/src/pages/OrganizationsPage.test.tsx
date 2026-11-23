import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import type { OrgNode } from '@/lib/organizations';
import { OrganizationsPage } from './OrganizationsPage';

const mocks = vi.hoisted(() => ({
  tree: vi.fn(),
  members: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  perms: new Set<string>(['org:read', 'org:manage']),
  allTenants: false,
}));

vi.mock('@/lib/organizations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/organizations')>();
  return {
    ...actual,
    organizationApi: {
      tree: mocks.tree,
      members: mocks.members,
      create: mocks.create,
      update: mocks.update,
      remove: mocks.remove,
    },
  };
});
vi.mock('@/lib/tenant-view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tenant-view')>();
  return {
    ...actual,
    useTenantView: () => ({ ...actual.useTenantView(), isAllTenants: mocks.allTenants }),
  };
});
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: (code: string) => mocks.perms.has(code) }),
}));
vi.mock('@/components/SensitiveText', () => ({
  SensitiveValue: ({ value }: { value: string | null }) => <span>{value ?? '—'}</span>,
}));

function node(
  id: string,
  name: string,
  parentId: string | null,
  children: OrgNode[] = [],
  memberCount = 0,
): OrgNode {
  return { id, name, parentId, sort: 0, memberCount, children };
}

const SEC = node('o-sec', '安全组', 'o-rd', [], 2);
const RD = node('o-rd', '研发中心', 'o-hq', [SEC], 1);
const OPS = node('o-ops', '运营中心', 'o-hq');
const HQ = node('o-hq', '总部', null, [RD, OPS]);

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <OrganizationsPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function treeItem(name: string) {
  return screen
    .getAllByRole('treeitem')
    .find((el) => within(el).queryByText(name, { exact: true }))!;
}

describe('OrganizationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.perms = new Set(['org:read', 'org:manage']);
    mocks.allTenants = false;
    mocks.tree.mockResolvedValue({ items: [HQ] });
    mocks.members.mockResolvedValue({
      items: [
        {
          id: 'u-1',
          username: 'zhangsan',
          displayName: '张三',
          isActive: true,
          organizationId: 'o-sec',
          organizationPath: '总部 / 研发中心 / 安全组',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    mocks.create.mockResolvedValue(node('o-new', '新部门', 'o-rd'));
    mocks.update.mockResolvedValue(node('o-rd', '研发部', 'o-hq'));
    mocks.remove.mockResolvedValue({ ok: true });
  });

  it('树按层级缩进渲染，折叠后隐藏下级', async () => {
    renderPage();
    const tree = await screen.findByRole('tree', { name: '组织架构' });
    const items = within(tree).getAllByRole('treeitem');
    expect(items.map((el) => el.getAttribute('aria-level'))).toEqual(['1', '2', '3', '2']);
    const pad = (name: string) => parseInt(treeItem(name).style.paddingLeft, 10);
    expect(pad('研发中心')).toBeGreaterThan(pad('总部'));
    expect(pad('安全组')).toBeGreaterThan(pad('研发中心'));
    expect(pad('运营中心')).toBe(pad('研发中心'));
    expect(treeItem('总部')).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(within(tree).getByRole('button', { name: '折叠 研发中心' }));
    expect(within(tree).queryByText('安全组')).not.toBeInTheDocument();
    expect(treeItem('研发中心')).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(within(tree).getByRole('button', { name: '展开 研发中心' }));
    expect(within(tree).getByText('安全组')).toBeInTheDocument();
  });

  it('右边是所选节点的成员；勾选含下级组织后按含下级查询', async () => {
    renderPage();
    await screen.findByRole('tree', { name: '组织架构' });
    await waitFor(() =>
      expect(mocks.members).toHaveBeenCalledWith(
        'o-hq',
        expect.objectContaining({ includeDescendants: false }),
      ),
    );
    await userEvent.click(within(treeItem('研发中心')).getByRole('button', { name: '研发中心' }));
    await waitFor(() =>
      expect(mocks.members).toHaveBeenCalledWith(
        'o-rd',
        expect.objectContaining({ includeDescendants: false }),
      ),
    );
    expect(await screen.findByRole('cell', { name: 'zhangsan' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: '含下级组织' }));
    await waitFor(() =>
      expect(mocks.members).toHaveBeenCalledWith(
        'o-rd',
        expect.objectContaining({ includeDescendants: true }),
      ),
    );
    expect(
      await screen.findByRole('cell', { name: '总部 / 研发中心 / 安全组' }),
    ).toBeInTheDocument();
  });

  it('删除有成员的节点时显示后端的 409 提示', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.remove.mockRejectedValue(new Error('请先移走下级组织和成员'));
    renderPage();
    await screen.findByRole('tree', { name: '组织架构' });
    await userEvent.click(within(treeItem('安全组')).getByRole('button', { name: '安全组' }));
    await userEvent.click(screen.getByRole('button', { name: '删除 安全组' }));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('o-sec'));
    expect(await screen.findByText('请先移走下级组织和成员')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('新增下级带上级 id；改名提交新名称；移动只能选自己和下级以外的节点', async () => {
    renderPage();
    await screen.findByRole('tree', { name: '组织架构' });
    await userEvent.click(within(treeItem('研发中心')).getByRole('button', { name: '研发中心' }));

    await userEvent.click(screen.getByRole('button', { name: '新增下级 研发中心' }));
    await userEvent.type(screen.getByLabelText(/名称/), '新部门');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({ name: '新部门', parentId: 'o-rd', sort: 0 }),
    );

    await userEvent.click(screen.getByRole('button', { name: '改名 研发中心' }));
    const nameInput = screen.getByLabelText(/名称/);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, '研发部');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('o-rd', { name: '研发部', sort: 0 }),
    );

    await userEvent.click(screen.getByRole('button', { name: '移动 研发中心' }));
    const select = screen.getByLabelText('上级组织');
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['顶级', '总部', '总部 / 运营中心']);
    await userEvent.selectOptions(select, 'o-ops');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('o-rd', { parentId: 'o-ops' }));
  });

  it('没有维护权限：能看树和成员，没有新建、新增下级、改名、移动、删除', async () => {
    mocks.perms = new Set(['org:read']);
    renderPage();
    await screen.findByRole('tree', { name: '组织架构' });
    await userEvent.click(within(treeItem('研发中心')).getByRole('button', { name: '研发中心' }));
    expect(screen.queryByRole('button', { name: '新建组织' })).not.toBeInTheDocument();
    for (const action of ['新增下级', '改名', '移动', '删除']) {
      expect(screen.queryByRole('button', { name: `${action} 研发中心` })).not.toBeInTheDocument();
    }
  });

  it('全部租户视角：按租户分组显示', async () => {
    mocks.tree.mockResolvedValue({
      groups: [
        { tenantId: 't-a', tenantName: '甲租户', items: [HQ] },
        { tenantId: 't-b', tenantName: '乙租户', items: [node('o-b', '乙总部', null)] },
      ],
    });
    renderPage();
    expect(await screen.findByRole('tree', { name: '甲租户' })).toBeInTheDocument();
    const b = screen.getByRole('tree', { name: '乙租户' });
    expect(within(b).getByText('乙总部')).toBeInTheDocument();
  });

  it('移动只列出挂上去不超过 8 级的目标：目标层级 + 子树高度 ≤ 8', async () => {
    // 另一棵 7 级的链 甲1…甲7；研发中心带一个下级（子树高 2），只能挂到第 6 级及以上
    let chain: OrgNode[] = [];
    for (let level = 7; level >= 1; level -= 1) {
      chain = [node(`o-c${level}`, `甲${level}`, level === 1 ? null : `o-c${level - 1}`, chain)];
    }
    mocks.tree.mockResolvedValue({ items: [HQ, ...chain] });
    renderPage();
    await screen.findByRole('tree', { name: '组织架构' });
    await userEvent.click(within(treeItem('研发中心')).getByRole('button', { name: '研发中心' }));
    await userEvent.click(screen.getByRole('button', { name: '移动 研发中心' }));
    const options = within(screen.getByLabelText('上级组织'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual([
      '顶级',
      '总部',
      '总部 / 运营中心',
      '甲1',
      '甲1 / 甲2',
      '甲1 / 甲2 / 甲3',
      '甲1 / 甲2 / 甲3 / 甲4',
      '甲1 / 甲2 / 甲3 / 甲4 / 甲5',
      '甲1 / 甲2 / 甲3 / 甲4 / 甲5 / 甲6',
    ]);
  });

  it('全部租户视角：只读，不显示新建、新增下级、改名、移动、删除', async () => {
    mocks.allTenants = true;
    mocks.tree.mockResolvedValue({
      groups: [{ tenantId: 't-a', tenantName: '甲租户', items: [HQ] }],
    });
    renderPage();
    const tree = await screen.findByRole('tree', { name: '甲租户' });
    await userEvent.click(within(tree).getByRole('button', { name: '研发中心' }));
    await waitFor(() =>
      expect(mocks.members).toHaveBeenCalledWith('o-rd', expect.objectContaining({ page: 1 })),
    );
    expect(await screen.findByRole('cell', { name: 'zhangsan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新建组织/ })).not.toBeInTheDocument();
    for (const action of ['新增下级', '改名', '移动', '删除']) {
      expect(screen.queryByRole('button', { name: `${action} 研发中心` })).not.toBeInTheDocument();
    }
  });
});
