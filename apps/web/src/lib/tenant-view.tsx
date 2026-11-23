import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ALL_TENANTS, TENANT_REQUIRED_EVENT, api, type TenantItem } from './api';
import { useAuth } from './auth';

/**
 * 「全部租户」视角的通用能力：租户名映射、筛选、进入租户、新建前选租户、409 兜底弹框。
 * 只在 AuthProvider 之下、路由之内挂载一次。
 */
interface TenantViewValue {
  isAllTenants: boolean;
  tenants: TenantItem[];
  tenantFilter: string;
  setTenantFilter: (value: string) => void;
  /** 直接展开进列表请求的参数（非全局视角为空）。 */
  listParams: { tenantId?: string };
  tenantName: (tenantId?: string | null) => string;
  platformTenantId: string | undefined;
  /** 进入某行所属租户并打开目标路径；平台共享行进入平台租户。 */
  enterTenant: (tenantId: string | null | undefined, path?: string) => void;
  /** 行点击/行操作：全局视角接管返回 true，调用方直接 return。 */
  guardRow: (tenantId: string | null | undefined, path: string) => boolean;
  /** 新建按钮：直接开新建（写操作落本属租户）；不因全局视角打断选租户。 */
  guardCreate: (otherwise: () => void) => void;
  /** 手动打开租户选择框（409 兜底等）。 */
  openPicker: (title?: string, path?: string) => void;
}

const TenantViewContext = createContext<TenantViewValue | null>(null);

/**
 * 没挂 Provider 时的兜底（例如页面被单独渲染、或旧测试里直接 render 页面组件）：
 * 一律按「非全局视角」处理，租户列/筛选不渲染，行与新建操作保持原样。
 */
const FALLBACK_TENANT_VIEW: TenantViewValue = {
  isAllTenants: false,
  tenants: [],
  tenantFilter: '',
  setTenantFilter: () => undefined,
  listParams: {},
  tenantName: (tenantId?: string | null) => tenantId ?? '平台共享',
  platformTenantId: undefined,
  enterTenant: () => undefined,
  guardRow: () => false,
  guardCreate: (otherwise: () => void) => otherwise(),
  openPicker: () => undefined,
};

interface PickerState {
  title: string;
  path: string;
}

export function TenantViewProvider({ children }: { children: ReactNode }) {
  const { user, switchTenant } = useAuth();
  const isAllTenants = Boolean(user?.allTenants) || user?.tenant?.id === ALL_TENANTS;
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [picker, setPicker] = useState<PickerState | null>(null);
  const tenantsQuery = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api.tenants.list(),
    enabled: Boolean(user?.isPlatformAdmin),
    staleTime: 60_000,
  });
  const tenants = tenantsQuery.data?.items ?? [];
  const platformTenantId = tenants.find((t) => t.isPlatform)?.id;
  const tenantFilter = params.get('tenantId') ?? '';

  const setTenantFilter = useCallback(
    (value: string) => {
      const next = new URLSearchParams(params);
      if (value) next.set('tenantId', value);
      else next.delete('tenantId');
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const tenantName = useCallback(
    (tenantId?: string | null) => {
      if (!tenantId) return '平台共享';
      return tenants.find((t) => t.id === tenantId)?.name ?? tenantId.slice(0, 8);
    },
    [tenants],
  );

  const openPicker = useCallback(
    (title = '建到哪个租户', path?: string) => {
      setPicker({ title, path: path ?? location.pathname + location.search });
    },
    [location.pathname, location.search],
  );

  const enterTenant = useCallback(
    (tenantId: string | null | undefined, path?: string) => {
      switchTenant(
        tenantId || platformTenantId || null,
        path ?? location.pathname + location.search,
      );
    },
    [switchTenant, platformTenantId, location.pathname, location.search],
  );

  const guardRow = useCallback(
    (tenantId: string | null | undefined, path: string) => {
      if (!isAllTenants) return false;
      // 已经在具体租户里点击行（例如从筛选结果点开）不需要再切换。
      switchTenant(tenantId || platformTenantId || null, path);
      return true;
    },
    [isAllTenants, switchTenant, platformTenantId],
  );

  // 新建不再弹「建到哪个租户」：写请求不带租户头，一律落在本属租户；
  // 需要把资产给别的租户时走「移到租户」。
  const guardCreate = useCallback((otherwise: () => void) => {
    otherwise();
  }, []);

  // 服务端兜底拒绝写操作时，弹出同一个选择框（不弹普通报错）。
  useEffect(() => {
    if (!isAllTenants) return;
    const onRequired = () => openPicker('选择租户');
    window.addEventListener(TENANT_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(TENANT_REQUIRED_EVENT, onRequired);
  }, [isAllTenants, openPicker]);

  const value = useMemo<TenantViewValue>(
    () => ({
      isAllTenants,
      tenants,
      tenantFilter,
      setTenantFilter,
      listParams: isAllTenants && tenantFilter ? { tenantId: tenantFilter } : {},
      tenantName,
      platformTenantId,
      enterTenant,
      guardRow,
      guardCreate,
      openPicker,
    }),
    [
      isAllTenants,
      tenants,
      tenantFilter,
      setTenantFilter,
      tenantName,
      platformTenantId,
      enterTenant,
      guardRow,
      guardCreate,
      openPicker,
    ],
  );

  return (
    <TenantViewContext.Provider value={value}>
      {children}
      {picker && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setPicker(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            data-testid="tenant-picker"
            className="w-64 rounded-xl border border-line bg-white p-4 shadow-pop"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="mb-2 text-sm font-medium text-ink">{picker.title}</h2>
            <div className="max-h-72 overflow-y-auto">
              {tenants.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  data-testid={'tenant-pick-' + t.id}
                  onClick={() => {
                    setPicker(null);
                    switchTenant(t.id, picker.path);
                  }}
                  className="block w-full truncate rounded-lg px-2.5 py-2 text-left text-[13.5px] text-ink-2 hover:bg-slate-100"
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </TenantViewContext.Provider>
  );
}

export function useTenantView(): TenantViewValue {
  return useContext(TenantViewContext) ?? FALLBACK_TENANT_VIEW;
}

/** 列表上方的租户筛选；非全局视角不渲染。 */
export function TenantFilterSelect() {
  const { isAllTenants, tenants, tenantFilter, setTenantFilter } = useTenantView();
  if (!isAllTenants) return null;
  return (
    <select
      aria-label="租户筛选"
      data-testid="tenant-filter"
      value={tenantFilter}
      onChange={(event) => setTenantFilter(event.target.value)}
      className="h-8 rounded-lg border border-line bg-white px-3 text-[13px] text-ink-2"
    >
      <option value="">全部租户</option>
      {tenants.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  );
}

/** 列表里的「租户」单元格；非全局视角不渲染。 */
export function TenantCell({ tenantId }: { tenantId?: string | null }) {
  const { isAllTenants, tenantName } = useTenantView();
  if (!isAllTenants) return null;
  return <span data-testid="tenant-cell">{tenantName(tenantId)}</span>;
}
