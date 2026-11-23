// 通用 API 传输结构。
export interface ApiError {
  error: {
    message: string;
    code?: string;
    issues?: unknown;
  };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type ViewMode = 'expert' | 'demo';

export interface UserPreferences {
  viewMode?: ViewMode;
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  isBuiltin: boolean;
  roles: string[];
  permissions: string[];
  preferences: UserPreferences;
  /** 安全设置：密码已超过强制更新时间，须先改密。 */
  passwordExpired?: boolean;
  /** 首次登录强制改密：须先改密才能使用其他功能。 */
  passwordChangeRequired?: boolean;
  passwordExpiresAt?: string | null;
  /** 超时登出时间（分钟），0 为不限制。 */
  idleTimeoutMinutes?: number;
  /** 操作日志查看范围：system_admin_only 时只有平台管理员能看。 */
  auditLogAccess?: 'admins_and_auditors' | 'system_admin_only';
  /** 本次操作的租户（平台管理员切换后为目标租户）。 */
  tenant?: { id: string; name: string; isPlatform: boolean };
  /** 用户本属的租户。 */
  homeTenantId?: string;
  /** 平台管理员：可管理租户、切换进入任意租户。 */
  isPlatformAdmin?: boolean;
  /** 平台管理员的「全部租户」只读汇总视角。 */
  allTenants?: boolean;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}
