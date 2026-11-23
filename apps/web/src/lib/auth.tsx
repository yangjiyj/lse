// 鉴权上下文：挂载时若存在令牌则拉取当前用户；提供 login/logout 与权限判断。
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ALL_TENANTS,
  PASSWORD_CHANGE_REQUIRED_EVENT,
  api,
  clearToken,
  getTenantSelection,
  getToken,
  setTenantSelection,
  setToken,
  type AuthUser,
} from './api';

// 旧版本登录时会把平台管理员自动送进「全部租户」，该选择留在 localStorage 里。
// 这里做一次性清理，让已经登录的人下次刷新就回到本属租户（之后仍可手动切回全部租户）。
const ALL_VIEW_RESET_KEY = 'lse_tenant_all_view_reset_v1';

function resetStaleAllTenantsSelection(): void {
  try {
    if (localStorage.getItem(ALL_VIEW_RESET_KEY)) return;
    localStorage.setItem(ALL_VIEW_RESET_KEY, '1');
    if (getTenantSelection() === ALL_TENANTS) setTenantSelection(null);
  } catch {
    // 隐私模式下 localStorage 可能不可用，忽略。
  }
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  hasPermission: (code: string) => boolean;
  refreshUser: () => Promise<void>;
  /** 平台管理员切换进入某个租户（null 回到本属租户）；切换后整页重新加载，避免看到上一个租户的缓存。
   * path 指定进入后打开的目标页面（缺省回首页）。 */
  switchTenant: (tenantId: string | null, path?: string) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let active = true;
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    resetStaleAllTenantsSelection();
    api
      .me()
      .then((res) => {
        if (active) setUser(res.user);
      })
      .catch(() => {
        clearToken();
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.login({ username, password });
    setTenantSelection(null);
    setToken(res.token);
    // 登录后固定停在账号的本属租户：平台管理员就是自己的管理租户，租户账号就是所在租户。
    // 「全部租户」是只读汇总视角，只由顶栏手动切换进入，不再自动进入（否则每个新建操作都要先选租户）。
    let current = res.user;
    try {
      current = (await api.me()).user;
    } catch {
      // 拉取失败沿用登录响应里的用户。
    }
    setUser(current);
    return current;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // 即便服务端登出失败也清理本地状态
    }
    clearToken();
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const res = await api.me();
      setUser(res.user);
    } catch {
      // 拉取失败保留现有 user 状态
    }
  }, []);

  // 接口报「须先改密」时刷新当前用户，路由守卫看到 passwordChangeRequired 就会跳到改密页。
  useEffect(() => {
    const onRequired = () => {
      void refreshUser();
    };
    window.addEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, onRequired);
  }, [refreshUser]);

  const hasPermission = useCallback(
    (code: string) => {
      if (!user) return false;
      return user.permissions.includes(code);
    },
    [user],
  );

  const switchTenant = useCallback(
    (tenantId: string | null, path?: string) => {
      setTenantSelection(tenantId && tenantId !== user?.homeTenantId ? tenantId : null);
      window.location.assign(path ?? '/');
    },
    [user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, logout, hasPermission, refreshUser, switchTenant }),
    [user, loading, login, logout, hasPermission, refreshUser, switchTenant],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内部使用');
  return ctx;
}

export function useHasPermission(code: string): boolean {
  return useAuth().hasPermission(code);
}
