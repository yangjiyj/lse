import { z } from 'zod';
import { prisma } from '../db.js';

/** 安全设置（systemSetting key = 'security'）：密码策略、登录锁定与超时登出。 */
export const SECURITY_SETTING_KEY = 'security';

export const AUDIT_LOG_ACCESS_VALUES = ['admins_and_auditors', 'system_admin_only'] as const;
export type AuditLogAccess = (typeof AUDIT_LOG_ACCESS_VALUES)[number];

export const securitySchema = z.object({
  passwordMinLength: z.coerce.number().int().min(6).max(64),
  passwordRequireUppercase: z.boolean(),
  passwordRequireLowercase: z.boolean(),
  passwordRequireDigit: z.boolean(),
  passwordRequireSpecial: z.boolean(),
  /** 密码强制更新时间（天），0 表示不强制。 */
  passwordExpireDays: z.coerce.number().int().min(0).max(3650),
  /** 最大非法登录次数，0 表示不限制。 */
  maxFailedLoginAttempts: z.coerce.number().int().min(0).max(100),
  /** 超过最大次数后禁用账户时间（分钟）。 */
  lockoutMinutes: z.coerce.number().int().min(1).max(1440),
  /** 超时登出时间（分钟），0 表示不限制。 */
  idleTimeoutMinutes: z.coerce.number().int().min(0).max(1440),
  /** 操作日志查看范围：管理员和审计员（默认，三员分立）或仅平台管理员。 */
  auditLogAccess: z.enum(AUDIT_LOG_ACCESS_VALUES),
  /** 管理员新建、重置密码的用户和新建租户的首个管理员，首次登录须先改密。 */
  forcePasswordChangeOnFirstLogin: z.boolean(),
  /** 是否开放登录页自助注册。 */
  registrationEnabled: z.boolean(),
  /** 自助注册用户归属的租户；为空时归平台租户。 */
  registrationTenantId: z.string().uuid().nullable(),
});

export type SecuritySettings = z.infer<typeof securitySchema>;

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  passwordMinLength: 8,
  passwordRequireUppercase: false,
  passwordRequireLowercase: false,
  passwordRequireDigit: false,
  passwordRequireSpecial: false,
  passwordExpireDays: 0,
  maxFailedLoginAttempts: 5,
  lockoutMinutes: 15,
  idleTimeoutMinutes: 30,
  auditLogAccess: 'admins_and_auditors',
  forcePasswordChangeOnFirstLogin: true,
  registrationEnabled: false,
  registrationTenantId: null,
};

export function parseStoredSecurity(value: unknown): SecuritySettings {
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return securitySchema.parse({ ...DEFAULT_SECURITY_SETTINGS, ...stored });
}

// 每个请求的鉴权都要读取策略，进程内短缓存避免每次打库；保存设置时主动失效。
const CACHE_TTL_MS = 5_000;
let cache: { value: SecuritySettings; at: number } | null = null;

export function invalidateSecurityPolicyCache(): void {
  cache = null;
}

export async function loadSecurityPolicy(): Promise<SecuritySettings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const row = await prisma.systemSetting.findUnique({ where: { key: SECURITY_SETTING_KEY } });
  const value = parseStoredSecurity(row?.value);
  cache = { value, at: Date.now() };
  return value;
}

/** 按安全设置校验密码强度，返回第一条不满足项的中文提示；满足时返回 null。 */
export function passwordPolicyViolation(password: string, policy: SecuritySettings): string | null {
  if (password.length < policy.passwordMinLength) {
    return `密码长度至少 ${policy.passwordMinLength} 位`;
  }
  if (password.length > 128) return '密码过长';
  if (policy.passwordRequireUppercase && !/[A-Z]/.test(password)) return '密码须包含大写字母';
  if (policy.passwordRequireLowercase && !/[a-z]/.test(password)) return '密码须包含小写字母';
  if (policy.passwordRequireDigit && !/[0-9]/.test(password)) return '密码须包含数字';
  if (policy.passwordRequireSpecial && !/[^A-Za-z0-9]/.test(password)) {
    return '密码须包含特殊字符';
  }
  return null;
}

/** 密码到期时间；未开启密码强制更新时返回 null。 */
export function passwordExpiresAt(
  passwordChangedAt: Date | null | undefined,
  policy: SecuritySettings,
): Date | null {
  if (policy.passwordExpireDays <= 0 || !passwordChangedAt) return null;
  return new Date(passwordChangedAt.getTime() + policy.passwordExpireDays * 86_400_000);
}

export function isPasswordExpired(
  passwordChangedAt: Date | null | undefined,
  policy: SecuritySettings,
  now = new Date(),
): boolean {
  const at = passwordExpiresAt(passwordChangedAt, policy);
  return at !== null && at.getTime() <= now.getTime();
}

/** 当前是否须先改密（首次登录强制改密）。 */
export function isPasswordChangeRequired(
  mustChangePassword: boolean,
  policy: SecuritySettings,
): boolean {
  return policy.forcePasswordChangeOnFirstLogin && mustChangePassword;
}

export function isIdleTimedOut(
  lastActiveAt: Date | null | undefined,
  policy: SecuritySettings,
  now = new Date(),
): boolean {
  if (policy.idleTimeoutMinutes <= 0 || !lastActiveAt) return false;
  return now.getTime() - lastActiveAt.getTime() > policy.idleTimeoutMinutes * 60_000;
}

/** 剩余锁定时间的中文描述，如「14 分 30 秒」。 */
export function formatRemaining(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} 秒`;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}
