import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  Headset,
  KeyRound,
  LogOut,
  Menu,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { setPageName } from '@/lib/branding';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';
import { SessionSecurityGuard } from '@/components/SessionSecurityGuard';
import { PageWatermark } from '@/components/PageWatermark';
import { BrandLogo } from '@/components/brand/Logo';
import { TenantSwitcher } from '@/components/TenantSwitcher';
import { NAV_SECTIONS, type NavEntry } from './nav-config';

const COLLAPSE_KEY = 'lse.nav.collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function AppShell() {
  const { user, logout, hasPermission } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const accountName = user?.username ?? 'admin';
  // 平台租户的用户：平台管理员，或平台租户里的普通账号（能看到平台设置等平台级页面）。
  const inPlatformTenant = Boolean(user?.tenant?.isPlatform || user?.isPlatformAdmin);
  const allTenants = Boolean(user?.allTenants) || user?.tenant?.id === 'all';
  const isAdmin = Boolean(
    user?.roles.includes('admin') || user?.roles.includes('tenant_admin'),
  );
  const auditLogAdminOnly = user?.auditLogAccess === 'system_admin_only';
  const canSee = (item: NavEntry) => {
    if (item.adminOnly && !isAdmin) return false;
    if (item.platformOnly && !inPlatformTenant) return false;
    if (item.followsAuditLogAccess && auditLogAdminOnly && !user?.isPlatformAdmin) return false;
    // 全部租户视角只开放汇总类页面，其余页面进入具体租户后再用。
    if (allTenants && !item.allTenantsAllowed) return false;
    if (!item.permission) return true;
    const codes = Array.isArray(item.permission) ? item.permission : [item.permission];
    return codes.some((code) => hasPermission(code));
  };
  // 取路径最长的匹配项：子路径只高亮最具体的入口，不同时高亮上级「报告管理」等。
  const matches = (path: string) =>
    location.pathname === path || (path !== '/' && location.pathname.startsWith(path + '/')) ||
    (path === '/fleet' && location.pathname.startsWith('/agent-evals/'));
  const crumb = NAV_SECTIONS.flatMap((section) =>
    section.groups.flatMap((group) => group.items.map((item) => ({ section, group, item }))),
  )
    .filter(({ item }) => matches(item.path))
    .sort((a, b) => b.item.path.length - a.item.path.length)[0];
  const activeSection = crumb?.section ?? NAV_SECTIONS[0]!;
  // 一级菜单只列有可见页面的分区。
  const navSections = NAV_SECTIONS.filter((section) =>
    section.groups.some((group) => group.items.some(canSee)),
  );
  const sectionKey = navSections.map((section) => section.label).join('|');

  // 顶栏放不下时，从放不下的那一项起收进「更多」。各项宽度在全部显示时量一次并缓存。
  const navRef = useRef<HTMLElement>(null);
  const widthCache = useRef(new Map<string, number>());
  const [overflowFrom, setOverflowFrom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === 'undefined') return;
    const labels = sectionKey.split('|');
    const compute = () => {
      nav.querySelectorAll<HTMLElement>('[data-nav-label]').forEach((el) => {
        if (el.offsetWidth > 0) widthCache.current.set(el.dataset.navLabel!, el.offsetWidth);
      });
      const widths = labels.map((label) => widthCache.current.get(label));
      // 有没量过的项（权限或租户变了），先全部显示一次再量。
      if (widths.some((w) => w === undefined)) {
        setOverflowFrom(null);
        return;
      }
      const avail = nav.clientWidth;
      if (!avail) return;
      const gap = 4;
      const sizes = widths as number[];
      const total = sizes.reduce((sum, w) => sum + w, 0) + gap * (sizes.length - 1);
      if (total <= avail) {
        setOverflowFrom(null);
        return;
      }
      let used = widthCache.current.get('__more') ?? 76;
      let fit = 0;
      for (const w of sizes) {
        if (used + gap + w > avail) break;
        used += gap + w;
        fit += 1;
      }
      setOverflowFrom(fit);
    };
    compute();
    const observer = new ResizeObserver(() => compute());
    observer.observe(nav);
    void document.fonts?.ready.then(() => compute());
    return () => observer.disconnect();
  }, [sectionKey, overflowFrom === null]);
  const shownSections = overflowFrom === null ? navSections : navSections.slice(0, overflowFrom);
  const moreSections = overflowFrom === null ? [] : navSections.slice(overflowFrom);
  const moreActive = moreSections.some((section) => section.label === activeSection.label);
  const visibleGroups = activeSection.groups
    .map((group) => ({ ...group, items: group.items.filter(canSee) }))
    .filter((group) => group.items.length > 0);

  // 浏览器页签标题：「页面名 · 产品名」；路径对不上任何菜单时回退到默认平台标题。
  const pageLabel = crumb?.item.label ?? null;
  useEffect(() => {
    setPageName(pageLabel);
    return () => setPageName(null);
  }, [pageLabel]);

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      // 隐私模式下折叠状态仅本次会话有效。
    }
  }, [collapsed]);

  // 一级菜单点击：进入该分区第一个有权限的页面（桌面顶栏与窄屏抽屉共用）。
  const goSection = (section: (typeof NAV_SECTIONS)[number]) =>
    navigate(section.groups.flatMap((group) => group.items).find(canSee)?.path ?? '/');

  // 用户菜单里的页面入口：跳转后收起下拉。
  const goFromMenu = (event: MouseEvent<HTMLElement>, path: string) => {
    event.currentTarget.closest('details')?.removeAttribute('open');
    navigate(path);
  };

  const onLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div
      data-testid="app-shell"
      className="flex h-screen flex-col overflow-hidden bg-canvas text-ink"
    >
      <header
        data-testid="app-header"
        className="z-20 flex h-[62px] shrink-0 items-center gap-3 border-b border-line bg-white px-5 text-ink-2"
      >
        <div className="flex min-w-0 items-center xl:w-[200px] xl:shrink-0">
          <BrandLogo
            size={32}
            nameClassName="text-[16px]"
            className="lg:max-xl:[&>span:last-child]:hidden"
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-slate-500 lg:hidden"
          onClick={() => setMobileOpen(true)}
          aria-label="打开导航"
          aria-expanded={mobileOpen}
          aria-controls="app-sidebar"
        >
          <Menu className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="hidden text-slate-500 lg:inline-flex"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? '展开导航' : '收起导航'}
          aria-pressed={collapsed}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-5 w-5" />
          ) : (
            <PanelLeftClose className="h-5 w-5" />
          )}
        </Button>
        <nav
          ref={navRef}
          aria-label="一级导航"
          className={cn(
            'hidden min-w-0 flex-1 items-center gap-1 lg:flex',
            moreSections.length > 0 ? 'overflow-visible' : 'overflow-x-auto scrollbar-thin',
          )}
        >
          {shownSections.map((section) => (
            <button
              key={section.label}
              type="button"
              data-nav-label={section.label}
              onClick={() => goSection(section)}
              aria-current={activeSection.label === section.label ? 'page' : undefined}
              className={cn(
                'shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-[14px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                activeSection.label === section.label
                  ? 'bg-brand-50 font-semibold text-brand-700'
                  : 'font-medium text-ink-2 hover:bg-slate-100 hover:text-ink',
              )}
            >
              {section.label}
            </button>
          ))}
          {moreSections.length > 0 && (
            <details className="relative shrink-0">
              <summary
                data-nav-label="__more"
                aria-current={moreActive ? 'page' : undefined}
                className={cn(
                  'flex cursor-pointer list-none items-center gap-1 whitespace-nowrap rounded-full px-3 py-1.5 text-[14px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden',
                  moreActive
                    ? 'bg-brand-50 font-semibold text-brand-700'
                    : 'font-medium text-ink-2 hover:bg-slate-100 hover:text-ink',
                )}
              >
                更多
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              </summary>
              <div className="absolute left-0 top-full z-50 mt-1 min-w-36 rounded-xl border border-line bg-white p-1.5 shadow-pop">
                {moreSections.map((section) => (
                  <Button
                    key={section.label}
                    variant="ghost"
                    size="sm"
                    aria-current={activeSection.label === section.label ? 'page' : undefined}
                    onClick={(event) => {
                      event.currentTarget.closest('details')?.removeAttribute('open');
                      goSection(section);
                    }}
                    className={cn(
                      'w-full justify-start',
                      activeSection.label === section.label
                        ? 'font-semibold text-brand-700'
                        : 'text-slate-600',
                    )}
                  >
                    {section.label}
                  </Button>
                ))}
              </div>
            </details>
          )}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-3 pl-3">
          <TenantSwitcher />
          <details className="relative">
            <summary
              aria-label={'当前账号：' + accountName}
              className="flex h-10 cursor-pointer list-none items-center gap-2 rounded-full pl-1 pr-2 text-[13.5px] text-ink-2 hover:bg-slate-100 [&::-webkit-details-marker]:hidden"
            >
              <span
                aria-hidden="true"
                className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-[#4C8DFF] to-[#1B45C4] font-num text-[13px] font-semibold text-white"
              >
                {accountName.slice(0, 1).toUpperCase()}
              </span>
              <span className="hidden max-w-[10rem] truncate 2xl:inline">{accountName}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            </summary>
            <div className="absolute right-0 top-full z-50 mt-1 min-w-40 rounded-xl border border-line bg-white p-1.5 shadow-pop">
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => goFromMenu(e, '/support')}
                className="w-full justify-start text-slate-600"
              >
                <Headset className="h-4 w-4" />
                技术支持
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => goFromMenu(e, '/feedback')}
                className="w-full justify-start text-slate-600"
              >
                <MessageSquareText className="h-4 w-4" />
                意见反馈
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPwOpen(true)}
                className="w-full justify-start text-slate-600"
              >
                <KeyRound className="h-4 w-4" />
                修改密码
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onLogout}
                className="w-full justify-start text-slate-600"
              >
                <LogOut className="h-4 w-4" />
                退出
              </Button>
            </div>
          </details>
        </div>
      </header>
      <div data-testid="app-content" className="flex min-h-0 min-w-0 flex-1">
        {mobileOpen && (
          <button
            className="fixed inset-y-[62px] inset-x-0 z-30 bg-slate-950/30 lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="关闭导航"
          />
        )}
        <aside
          id="app-sidebar"
          data-testid="app-sidebar"
          className={cn(
            'fixed inset-y-[62px] left-0 z-40 flex h-[calc(100vh-3.875rem)] shrink-0 flex-col bg-canvas text-ink transition-[transform,width] max-lg:border-r max-lg:border-line lg:static lg:h-full lg:translate-x-0',
            collapsed ? 'w-[200px] lg:w-16' : 'w-[200px]',
            mobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          {mobileOpen && (
            <nav
              aria-label="一级导航（窄屏）"
              className="flex shrink-0 flex-wrap gap-1.5 border-b border-line px-3 py-3 lg:hidden"
            >
              {navSections.map((section) => (
                <button
                  key={section.label}
                  type="button"
                  onClick={() => goSection(section)}
                  aria-current={activeSection.label === section.label ? 'page' : undefined}
                  className={cn(
                    'whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    activeSection.label === section.label
                      ? 'bg-brand-50 font-semibold text-brand-700'
                      : 'bg-white font-medium text-ink-2 hover:bg-slate-100 hover:text-ink',
                  )}
                >
                  {section.label}
                </button>
              ))}
            </nav>
          )}
          <nav
            className={cn(
              'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-5',
              collapsed ? 'px-3 lg:px-2.5' : 'px-3',
            )}
          >
            {visibleGroups.map((group, index) => (
              <div key={group.label ?? `group-${index}`} className="flex flex-col gap-0.5">
                {group.label && (
                  <div
                    className={cn(
                      'px-3.5 pb-1.5 pt-1 text-xs font-medium tracking-[0.06em] text-[#64748B]',
                      collapsed && 'lg:sr-only',
                    )}
                  >
                    {group.label}
                  </div>
                )}
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = crumb?.item.path === item.path;
                  return (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      end={item.path === '/'}
                      title={collapsed ? item.label : item.hint}
                      onClick={() => setMobileOpen(false)}
                      className={() =>
                        cn(
                          'relative flex h-10 items-center gap-2.5 rounded-[11px] px-3.5 text-[14px] transition-colors',
                          collapsed && 'lg:justify-center lg:px-0',
                          active
                            ? 'bg-white font-semibold text-brand-700 shadow-card'
                            : 'text-ink-2 hover:bg-white/70 hover:text-ink',
                        )
                      }
                    >
                      <Icon
                        className={cn('h-[18px] w-[18px] shrink-0', active && 'text-brand-600')}
                      />
                      <span className={cn('truncate', collapsed && 'lg:sr-only')}>
                        {item.label}
                      </span>
                    </NavLink>
                  );
                })}
              </div>
            ))}
          </nav>
        </aside>
        <div data-testid="app-main-wrap" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SessionSecurityGuard />
          <PageWatermark />
          <main
            data-testid="app-main"
            className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-canvas px-4 pb-10 pt-5 lg:px-8 lg:pt-6"
          >
            {crumb && !location.pathname.startsWith('/fleet/endpoints/') && (
              <div className="mb-1.5 text-xs text-ink-3">
                {/* 分区只有一个同名入口（如工具中心）时只写一次。 */}
                {crumb.item.label !== activeSection.label && (
                  <>
                    {activeSection.label}
                    {crumb.group.label && crumb.group.label !== activeSection.label
                      ? ' / ' + crumb.group.label
                      : ''}{' '}
                    /{' '}
                  </>
                )}
                <span className="text-ink-2">{crumb.item.label}</span>
              </div>
            )}
            <Outlet />
          </main>
        </div>
      </div>
      {pwOpen && <ChangePasswordModal open onClose={() => setPwOpen(false)} />}
    </div>
  );
}
