import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { ToastProvider } from '@/components/ui/toast';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { resetBrandingForTest } from '@/lib/branding';

const SECTION_LABELS = [
  '工作台',
  '评估中心',
  '专项核验',
  '工具中心',
  '数据安全',
  '数据分析',
  '风险处置',
  '报告中心',
  '系统管理',
];

const logout = vi.fn();
const hasPermission = vi.fn<(permission: string) => boolean>(() => true);
const authState = {
  roles: ['super_admin'] as string[],
  isPlatform: true,
  isPlatformAdmin: false,
  auditLogAccess: 'admins_and_auditors' as 'admins_and_auditors' | 'system_admin_only',
};
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: {
      username: 'admin',
      displayName: '超级管理员',
      roles: authState.roles,
      tenant: { id: 'platform', name: '默认租户', isPlatform: authState.isPlatform },
      isPlatformAdmin: authState.isPlatformAdmin,
      auditLogAccess: authState.auditLogAccess,
    },
    logout,
    hasPermission,
    switchTenant: vi.fn(),
  }),
}));
function renderShell(initialPath = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="*" element={<div>页面内容</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
describe('AppShell', () => {
  beforeEach(() => {
    window.localStorage.clear();
    hasPermission.mockReset();
    hasPermission.mockReturnValue(true);
    logout.mockClear();
    authState.roles = ['super_admin'];
    authState.isPlatform = true;
    authState.isPlatformAdmin = false;
    authState.auditLogAccess = 'admins_and_auditors';
  });
  it('展示 C 控制台九个一级入口（按顺序）、品牌与账号操作', () => {
    renderShell();
    expect(screen.getByText('鉴盾')).toBeInTheDocument();
    expect(screen.getByText('大模型安全评估平台')).toBeInTheDocument();
    const topButtons = within(screen.getByRole('navigation', { name: '一级导航' })).getAllByRole(
      'button',
    );
    expect(topButtons.map((b) => b.textContent)).toEqual(SECTION_LABELS);
    expect(screen.queryByRole('button', { name: '检测任务' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '检测方案' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('当前账号：admin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /修改密码/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /退出/ })).toBeInTheDocument();
  });
  it('只显示当前一级菜单下真实存在且有权限的二级入口', async () => {
    renderShell();
    expect(screen.getByRole('link', { name: /态势概览/ })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('link', { name: /门禁/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '评估中心' }));
    expect(screen.getByRole('link', { name: /评估对象/ })).toHaveAttribute(
      'href',
      '/model-targets',
    );
    expect(screen.getByRole('link', { name: /评估任务/ })).toHaveAttribute('href', '/eval-tasks');
    expect(screen.getByRole('link', { name: '模型题库' })).toHaveAttribute('href', '/question-sets');
    expect(screen.getByRole('link', { name: '智能体样本库' })).toHaveAttribute('href', '/agent-samples');
    expect(screen.getByRole('link', { name: '测评靶场' })).toHaveAttribute('href', '/agent-range');
    await userEvent.click(screen.getByRole('button', { name: '系统管理' }));
    expect(screen.getByRole('link', { name: /用户与权限/ })).toHaveAttribute('href', '/users');
    expect(screen.getByRole('link', { name: /平台设置/ })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: /操作日志/ })).toHaveAttribute('href', '/audit-logs');
  });
  it('按权限过滤菜单', async () => {
    hasPermission.mockImplementation((permission) => permission === 'model_target:read');
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: '评估中心' }));
    expect(screen.getByRole('link', { name: /评估对象/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /评估任务/ })).not.toBeInTheDocument();
  });
  it('平台租户的用户能看到租户管理入口', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: '系统管理' }));
    expect(screen.getByRole('link', { name: /租户管理/ })).toHaveAttribute('href', '/tenants');
  });
  it('非平台租户的用户看不到租户管理与平台设置', async () => {
    authState.isPlatform = false;
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: '系统管理' }));
    expect(screen.getByRole('link', { name: /用户与权限/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /租户管理/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /平台设置/ })).not.toBeInTheDocument();
  });
  it('操作日志设为仅平台管理员时，审计员和租户管理员看不到操作日志菜单', async () => {
    authState.auditLogAccess = 'system_admin_only';
    for (const roles of [['auditor'], ['tenant_admin']]) {
      authState.roles = roles;
      const view = renderShell('/users');
      expect(screen.getByRole('link', { name: /用户与权限/ })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /操作日志/ })).not.toBeInTheDocument();
      view.unmount();
    }
  });
  it('操作日志设为仅平台管理员时，平台管理员仍能看到操作日志菜单', async () => {
    authState.auditLogAccess = 'system_admin_only';
    authState.isPlatformAdmin = true;
    renderShell('/users');
    expect(screen.getByRole('link', { name: /操作日志/ })).toHaveAttribute('href', '/audit-logs');
  });
  it('桌面端可以收起二级导航并记住选择', async () => {
    const user = userEvent.setup();
    renderShell();
    const sidebar = screen.getByTestId('app-sidebar');
    expect(sidebar).toHaveClass('w-[200px]');
    await user.click(screen.getByRole('button', { name: '收起导航' }));
    expect(sidebar).toHaveClass('lg:w-16');
    expect(window.localStorage.getItem('lse.nav.collapsed')).toBe('1');
    await user.click(screen.getByRole('button', { name: '展开导航' }));
    expect(window.localStorage.getItem('lse.nav.collapsed')).toBe('0');
  });
  it('采用浅色 C 控制台与主色导航', () => {
    renderShell();
    expect(screen.getByTestId('app-shell')).toHaveClass('bg-canvas');
    expect(screen.getByTestId('app-sidebar')).toHaveClass('bg-canvas');
    expect(screen.getByTestId('app-header')).toHaveClass('bg-white');
  });
  it('内容区显示面包屑', () => {
    renderShell();
    expect(screen.getByTestId('app-main')).toHaveTextContent('工作台 / 态势概览');
  });
  it('保留主内容内部纵向滚动容器', () => {
    renderShell();
    expect(screen.getByTestId('app-shell')).toHaveClass('h-screen', 'overflow-hidden');
    expect(screen.getByTestId('app-sidebar')).toHaveClass('h-[calc(100vh-3.875rem)]');
    expect(screen.getByTestId('app-content')).toHaveClass('min-h-0');
    expect(screen.getByTestId('app-main')).toHaveClass('overflow-y-auto');
  });
  it('智能体测评向导归属评估中心', () => {
    renderShell('/agent-evals/new');
    expect(screen.getByRole('button', { name: '评估中心' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '终端与智能体' })).toBeInTheDocument();
  });
});

it('一级切换更新二级分组并显示分组标题', async () => {
  renderShell();
  await userEvent.click(screen.getByRole('button', { name: '评估中心' }));
  expect(screen.getByText('评估', { selector: 'div' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '风险处置' }));
  expect(screen.getByText('风险与整改', { selector: 'div' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /风险处置台/ })).toBeInTheDocument();
});

it('账号下拉中打开改密并可触发退出', async () => {
  renderShell();
  await userEvent.click(screen.getByLabelText('当前账号：admin'));
  await userEvent.click(screen.getByRole('button', { name: /修改密码/ }));
  expect(await screen.findByText('当前密码')).toBeInTheDocument();
  await userEvent.click(screen.getByLabelText('当前账号：admin'));
  await userEvent.click(screen.getByRole('button', { name: /退出/ }));
  expect(logout).toHaveBeenCalledOnce();
});

describe('路线图 W1–W6 页面导航', () => {
  beforeEach(() => {
    hasPermission.mockReset();
    hasPermission.mockReturnValue(true);
    authState.roles = ['admin'];
  });

  it('各一级菜单下出现新页面入口', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: '评估中心' }));
    expect(screen.getByText('持续评估', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /评估计划/ })).toHaveAttribute('href', '/eval/plans');
    expect(screen.getByRole('link', { name: /上线门禁/ })).toHaveAttribute('href', '/eval/gates');
    await userEvent.click(screen.getByRole('button', { name: '专项核验' }));
    expect(screen.getByRole('link', { name: /模型文件扫描/ })).toHaveAttribute(
      'href',
      '/inspect/model-files',
    );
    expect(screen.getByRole('link', { name: /AI 资产测绘/ })).toHaveAttribute(
      'href',
      '/inspect/asset-discovery',
    );
    expect(screen.getByRole('link', { name: /RAG 专项评估/ })).toHaveAttribute(
      'href',
      '/inspect/rag',
    );
    await userEvent.click(screen.getByRole('button', { name: '风险处置' }));
    expect(screen.getByRole('link', { name: /策略建议与下发/ })).toHaveAttribute(
      'href',
      '/risk/policy-suggestions',
    );
    await userEvent.click(screen.getByRole('button', { name: '报告中心' }));
    expect(screen.getByRole('link', { name: /国内标准条款/ })).toHaveAttribute(
      'href',
      '/reports/standard-clauses',
    );
    expect(screen.getByRole('link', { name: /框架覆盖/ })).toHaveAttribute(
      'href',
      '/reports/framework-coverage',
    );
    // 备案材料面向需要向网信办备案的服务提供方，普通客户用不上，不在菜单中出现。
    expect(screen.queryByRole('link', { name: /备案材料/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '系统管理' }));
    expect(screen.queryByRole('link', { name: /API 令牌/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /平台设置/ })).toHaveAttribute('href', '/settings');
  });

  it('API 令牌仅 admin 角色可见，即使拥有全部权限码', async () => {
    authState.roles = ['auditor'];
    renderShell('/settings');
    expect(screen.getByRole('link', { name: /平台设置/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /API 令牌/ })).not.toBeInTheDocument();
  });

  it('RAG 专项评估按 rag_eval:read 过滤，门禁满足 gate:read 或 gate:manage 任一即可', async () => {
    hasPermission.mockImplementation(
      (p) => p === 'engine:scan' || p === 'gate:manage' || p === 'eval_task:read',
    );
    renderShell('/inspect/model-files');
    expect(screen.getByRole('link', { name: /模型文件扫描/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /RAG 专项评估/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '评估中心' }));
    expect(screen.getByRole('link', { name: /上线门禁/ })).toBeInTheDocument();
  });

  it('子路径只高亮最具体的入口并显示对应面包屑', () => {
    renderShell('/reports/framework-coverage');
    expect(screen.getByTestId('app-main')).toHaveTextContent('报告中心 / 报告 / 框架覆盖');
    expect(screen.getByRole('link', { name: /框架覆盖/ })).toHaveClass('text-brand-700');
    expect(screen.getByRole('link', { name: /报告管理/ })).not.toHaveClass('text-brand-700');
  });

  it('工具中心：分区和入口同名时面包屑只写一次，详情页仍高亮工具中心', () => {
    renderShell('/tools/abc');
    const crumb = screen.getByTestId('app-main').firstElementChild;
    expect(crumb).toHaveTextContent(/^工具中心$/);
    expect(screen.getByRole('link', { name: /工具中心/ })).toHaveClass('text-brand-700');
  });

  it('模型文件扫描由 AppShell 渲染面包屑', () => {
    renderShell('/inspect/model-files');
    expect(screen.getByTestId('app-main')).toHaveTextContent('专项核验 / 模型文件扫描');
  });

  it('评估任务详情仍归属评估任务入口', () => {
    renderShell('/eval-tasks/abc');
    expect(screen.getByRole('link', { name: /评估任务/ })).toHaveClass('text-brand-700');
  });
});

describe('菜单收拢后的归属与面包屑', () => {
  beforeEach(() => {
    hasPermission.mockReset();
    hasPermission.mockReturnValue(true);
    authState.roles = ['admin'];
  });
  const crumb = () => screen.getByTestId('app-main').firstElementChild;

  it('「全部任务」在工作台，排在我的待办之后', () => {
    renderShell('/detect-tasks');
    expect(screen.getByRole('button', { name: '工作台' })).toHaveAttribute('aria-current', 'page');
    const sidebar = screen.getByTestId('app-sidebar');
    expect(
      within(sidebar)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/', '/my-todos', '/detect-tasks']);
    expect(screen.getByRole('link', { name: /全部任务/ })).toHaveClass('text-brand-700');
    expect(crumb()).toHaveTextContent(/^工作台 \/ 全部任务$/);
  });

  it('组合任务详情归属评估中心「评估」组的组合任务，不高亮全部任务', () => {
    renderShell('/detect-tasks/jobs/j1');
    expect(screen.getByRole('button', { name: '评估中心' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: /组合任务/ })).toHaveClass('text-brand-700');
    expect(crumb()).toHaveTextContent(/^评估中心 \/ 评估 \/ 组合任务$/);
  });

  it('检测策略在评估中心「持续评估」组', () => {
    renderShell('/detect-tasks/strategies');
    expect(screen.getByRole('link', { name: /检测策略/ })).toHaveClass('text-brand-700');
    expect(crumb()).toHaveTextContent(/^评估中心 \/ 持续评估 \/ 检测策略$/);
  });

  it('应用台账及详情归属评估中心「评估」组的应用台账', () => {
    renderShell('/ledger/a-1');
    expect(screen.getByRole('button', { name: '评估中心' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const link = screen.getByRole('link', { name: /应用台账/ });
    expect(link).toHaveAttribute('href', '/ledger');
    expect(link).toHaveClass('text-brand-700');
    expect(crumb()).toHaveTextContent(/^评估中心 \/ 评估 \/ 应用台账$/);
    expect(document.title).toBe('应用台账 · 鉴盾');
  });
});

describe('顶栏：没有死入口', () => {
  beforeEach(() => {
    hasPermission.mockReset();
    hasPermission.mockReturnValue(true);
    authState.roles = ['admin'];
  });
  it('不再摆「帮助文档」假入口（没有可链接的帮助页）', () => {
    renderShell();
    expect(screen.queryByText('帮助文档')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /帮助/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /帮助/ })).not.toBeInTheDocument();
  });
});

describe('窄屏顶栏与抽屉导航', () => {
  beforeEach(() => {
    hasPermission.mockReset();
    hasPermission.mockReturnValue(true);
    authState.roles = ['admin'];
  });
  it('一级导航只在 lg 及以上显示，不再在 md 就挤进顶栏', () => {
    renderShell();
    const nav = screen.getByRole('navigation', { name: '一级导航' });
    expect(nav).toHaveClass('hidden', 'lg:flex', 'min-w-0', 'overflow-x-auto');
    expect(nav).not.toHaveClass('md:flex');
  });

  it('右侧账号区不收缩，用户名过长时截断而不是挤掉别的东西', () => {
    renderShell();
    const summary = screen.getByLabelText('当前账号：admin');
    expect(summary.parentElement?.parentElement).toHaveClass('shrink-0');
    expect(within(summary).getByText('admin')).toHaveClass('truncate');
  });

  it('窄屏点「打开导航」后，抽屉里有九个一级入口，并且可以切换分区', async () => {
    const user = userEvent.setup();
    renderShell();
    expect(screen.queryByRole('navigation', { name: '一级导航（窄屏）' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打开导航' }));
    const drawerNav = screen.getByRole('navigation', { name: '一级导航（窄屏）' });
    expect(drawerNav).toHaveClass('lg:hidden');
    expect(
      within(drawerNav)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(SECTION_LABELS);
    expect(within(drawerNav).getByRole('button', { name: '工作台' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await user.click(within(drawerNav).getByRole('button', { name: '评估中心' }));
    expect(screen.getByRole('link', { name: /评估对象/ })).toHaveAttribute(
      'href',
      '/model-targets',
    );
    // 切分区后抽屉保持打开，方便继续选二级入口
    expect(screen.getByRole('button', { name: '关闭导航' })).toBeInTheDocument();
  });

  it('在抽屉里点二级入口后抽屉自动收起', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole('button', { name: '打开导航' }));
    expect(screen.getByRole('button', { name: '打开导航' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await user.click(screen.getByRole('link', { name: /态势概览/ }));
    expect(screen.queryByRole('navigation', { name: '一级导航（窄屏）' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开导航' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('按权限隐藏的二级入口在抽屉里同样不出现', async () => {
    const user = userEvent.setup();
    hasPermission.mockImplementation((permission) => permission === 'model_target:read');
    renderShell();
    await user.click(screen.getByRole('button', { name: '打开导航' }));
    await user.click(
      within(screen.getByRole('navigation', { name: '一级导航（窄屏）' })).getByRole('button', {
        name: '评估中心',
      }),
    );
    expect(screen.getByRole('link', { name: /评估对象/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /评估任务/ })).not.toBeInTheDocument();
  });
});

describe('按页面设置浏览器标题', () => {
  beforeEach(() => {
    hasPermission.mockReset();
    hasPermission.mockReturnValue(true);
    authState.roles = ['admin'];
    resetBrandingForTest();
  });

  it('首页：「态势概览 · 鉴盾」', () => {
    renderShell('/');
    expect(document.title).toBe('态势概览 · 鉴盾');
  });

  it('二级页面取菜单名，详情页沿用所属入口的名称', () => {
    const view = renderShell('/reports/framework-coverage');
    expect(document.title).toBe('框架覆盖 · 鉴盾');
    view.unmount();
    renderShell('/eval-tasks/abc');
    expect(document.title).toBe('评估任务 · 鉴盾');
  });

  it('路径对应不到任何菜单时回退到默认平台标题', () => {
    renderShell('/this-page-does-not-exist');
    expect(document.title).toBe('鉴盾 · 大模型安全评估平台');
  });

  it('离开外壳（如退出登录）后恢复默认平台标题', () => {
    const view = renderShell('/audit-logs');
    expect(document.title).toBe('操作日志 · 鉴盾');
    view.unmount();
    expect(document.title).toBe('鉴盾 · 大模型安全评估平台');
  });

  it('同一外壳内切换页面时标题跟着变', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await user.click(screen.getByRole('button', { name: '系统管理' }));
    await user.click(screen.getByRole('link', { name: /操作日志/ }));
    expect(document.title).toBe('操作日志 · 鉴盾');
  });
});

it('终端详情自己呈现面包屑，页壳不重复叠加路径', () => {
  renderShell('/fleet/endpoints/ep1');
  expect(screen.queryByText(/评估中心.*评估.*终端/)).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /终端/ })).toHaveAttribute('href', '/fleet');
});

describe('一级导航按权限显示，放不下时收进「更多」', () => {
  const restore: Array<() => void> = [];
  beforeEach(() => {
    hasPermission.mockReset();
    hasPermission.mockReturnValue(true);
    authState.roles = ['super_admin'];
  });
  afterEach(() => {
    while (restore.length) restore.pop()!();
  });

  it('没有任何可见页面的分区不出现在一级导航和窄屏抽屉里', async () => {
    hasPermission.mockImplementation((code) => !code.startsWith('corpus_'));
    renderShell();
    const nav = screen.getByRole('navigation', { name: '一级导航' });
    expect(within(nav).queryByRole('button', { name: '数据安全' })).not.toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: '数据分析' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '打开导航' }));
    const drawerNav = screen.getByRole('navigation', { name: '一级导航（窄屏）' });
    expect(within(drawerNav).queryByRole('button', { name: '数据安全' })).not.toBeInTheDocument();
  });

  it('宽度不够时只显示放得下的几项，其余在「更多」里，点了进入该分区', async () => {
    const g = globalThis as { ResizeObserver?: unknown };
    const originalRO = g.ResizeObserver;
    g.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    restore.push(() => {
      g.ResizeObserver = originalRO;
    });
    const ow = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    const cw = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        return (this as HTMLElement).dataset?.navLabel ? 100 : 0;
      },
    });
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return (this as Element).getAttribute('aria-label') === '一级导航' ? 450 : 0;
      },
    });
    restore.push(() => {
      if (ow) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', ow);
      if (cw) Object.defineProperty(Element.prototype, 'clientWidth', cw);
    });

    const user = userEvent.setup();
    renderShell();
    const nav = screen.getByRole('navigation', { name: '一级导航' });
    // 每项 100、间距 4、「更多」100，可用 450：放得下 3 项。
    const topButtons = () => Array.from(nav.querySelectorAll(':scope > button'));
    await waitFor(() => expect(topButtons()).toHaveLength(3));
    expect(topButtons().map((b) => b.textContent)).toEqual(['工作台', '评估中心', '专项核验']);
    expect(nav).toHaveClass('overflow-visible');
    await user.click(within(nav).getByText('更多'));
    const more = within(nav).getByText('更多').closest('details')!;
    const items = within(more as HTMLElement).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual([
      '工具中心',
      '数据安全',
      '数据分析',
      '风险处置',
      '报告中心',
      '系统管理',
    ]);
    await user.click(within(more as HTMLElement).getByRole('button', { name: '系统管理' }));
    expect(more).not.toHaveAttribute('open');
  });
});
