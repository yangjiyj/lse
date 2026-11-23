import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, Check, ChevronDown, Settings2 } from 'lucide-react';
import { ALL_TENANTS, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * 顶栏的当前租户。
 * - 平台管理员：下拉切换进入任一租户（代管时高亮），底部进租户管理；只有一个租户时不显示。
 * - 其他租户的用户：只显示所在租户名称；平台租户的普通用户不显示。
 */
export function TenantSwitcher() {
  const { user, switchTenant } = useAuth();
  const navigate = useNavigate();
  const menu = useRef<HTMLDetailsElement>(null);
  const isPlatformAdmin = Boolean(user?.isPlatformAdmin);
  const tenants = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api.tenants.list(),
    enabled: isPlatformAdmin,
    staleTime: 60_000,
  });
  const current = user?.tenant;
  if (!current) return null;

  if (!isPlatformAdmin) {
    if (current.isPlatform) return null;
    return (
      <span
        data-testid="tenant-label"
        className="inline-flex h-9 max-w-[14rem] items-center gap-1.5 rounded-full bg-slate-100 px-3 text-[13px] text-ink-2"
      >
        <Building2 className="h-4 w-4 shrink-0 text-slate-500" />
        <span className="truncate">{current.name}</span>
      </span>
    );
  }

  const items = tenants.data?.items ?? [];
  // 全部租户是独立的只读视角，不按「代管」高亮。
  const isAll = Boolean(user?.allTenants) || current.id === ALL_TENANTS;
  const managing = !isAll && !current.isPlatform;
  if (items.length <= 1 && !managing && !isAll) return null;

  const close = () => menu.current?.removeAttribute('open');

  return (
    <details ref={menu} className="relative" data-testid="tenant-switcher">
      <summary
        aria-label={'当前租户：' + current.name}
        className={cn(
          'flex h-9 max-w-[16rem] cursor-pointer list-none items-center gap-1.5 rounded-full px-3 text-[13px] [&::-webkit-details-marker]:hidden',
          managing
            ? 'bg-amber-50 font-medium text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100'
            : 'bg-slate-100 text-ink-2 hover:bg-slate-200',
        )}
      >
        <Building2 className="h-4 w-4 shrink-0" />
        <span className="truncate">{isAll ? '全部租户' : managing ? `代管：${current.name}` : current.name}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
      </summary>
      <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-xl border border-line bg-white p-1.5 shadow-pop">
        <div className="px-2.5 pb-1 pt-1.5 text-xs text-ink-3">切换租户</div>
        <div className="max-h-72 overflow-y-auto">
          {(items.length >= 2 || isAll) && (
            <button
              type="button"
              data-testid="tenant-all"
              disabled={isAll}
              onClick={() => {
                close();
                switchTenant(ALL_TENANTS);
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px]',
                isAll ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-2 hover:bg-slate-100',
              )}
            >
              <span className="min-w-0 flex-1 truncate">全部租户</span>
              {isAll && <Check className="h-4 w-4 shrink-0" />}
            </button>
          )}
          {items.map((t) => {
            const active = t.id === current.id;
            return (
              <button
                key={t.id}
                type="button"
                disabled={active}
                onClick={() => {
                  close();
                  switchTenant(t.id);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px]',
                  active ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-2 hover:bg-slate-100',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                {!t.isActive && <span className="shrink-0 text-xs text-ink-3">已停用</span>}
                {active && <Check className="h-4 w-4 shrink-0" />}
              </button>
            );
          })}
        </div>
        <div className="my-1 border-t border-line" />
        <button
          type="button"
          onClick={() => {
            close();
            navigate('/tenants');
          }}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-ink-2 hover:bg-slate-100"
        >
          <Settings2 className="h-4 w-4" />
          租户管理
        </button>
      </div>
    </details>
  );
}
