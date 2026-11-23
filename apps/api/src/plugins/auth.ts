import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { conflict, forbidden, unauthorized, permissionDenied } from '../lib/errors.js';
import { PLATFORM_ONLY_PERMISSIONS } from '@lse/shared';
import { loadCurrentUser, type CurrentUser } from '../lib/rbac.js';
import { enforcePlatformConnectorAccess } from '../lib/platform-connector-access.js';
import { prisma, prismaUnscoped } from '../db.js';
import {
  isIdleTimedOut,
  isPasswordChangeRequired,
  isPasswordExpired,
  loadSecurityPolicy,
} from '../lib/security-policy.js';
import { setCurrentTenantScope } from '../lib/tenant-context.js';

// 密码已过期或须改密时仍可访问的接口：查看自己、改密、登出、读取密码策略。
const PASSWORD_EXPIRED_ALLOWED = new Set([
  '/api/auth/me',
  '/api/auth/me/password',
  '/api/auth/logout',
  '/api/auth/password-policy',
]);
// 最近活跃时间最多每 30 秒落库一次，避免每个请求都写库。
const ACTIVITY_WRITE_INTERVAL_MS = 30_000;
// 平台管理员代管其他租户时，本次请求按该租户口径放权：只保留租户管理本身。
const PLATFORM_ONLY = new Set<string>(PLATFORM_ONLY_PERMISSIONS);

/** 平台管理员切换租户用的请求头（值为租户 ID 或 all）；其他用户带了也会被忽略。 */
export const TENANT_HEADER = 'x-lse-tenant';
/** 「全部租户」视角：只读汇总所有租户的数据。 */
export const ALL_TENANTS_VALUE = 'all';
export const ALL_TENANTS_NAME = '全部租户';

/** 全局视角下仍允许写的全平台级接口（本来就不属于某个租户）。 */
const ALL_TENANTS_WRITE_PREFIXES = [
  '/api/auth',
  '/api/tenants',
  '/api/system-settings',
  '/api/license',
  '/api/roles',
  // 工具中心是平台级内容，所有租户共用。
  '/api/tools',
];
/** 全局视角下列表页用到、确认只读的 POST 接口（导出/预估等不改变数据）。 */
const ALL_TENANTS_READONLY_POSTS = new Set(['/api/fleet/eval-jobs/estimate']);

function allTenantsWriteAllowed(path: string): boolean {
  if (ALL_TENANTS_READONLY_POSTS.has(path)) return true;
  return ALL_TENANTS_WRITE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?'),
  );
}

declare module 'fastify' {
  interface FastifyRequest {
    /** authenticate 解析出的租户范围；app.ts 的根钩子据此建立请求的租户上下文。 */
    tenantScope?: { tenantId: string | null; sharedWrite: boolean; allTenants?: boolean };
  }
}

function requestedTenantHeader(request: FastifyRequest): string | null {
  const raw = request.headers[TENANT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function requestedTenant(request: FastifyRequest): string | null {
  const trimmed = requestedTenantHeader(request);
  return trimmed && /^[0-9a-f-]{36}$/i.test(trimmed) ? trimmed : null;
}

function requestedAllTenants(request: FastifyRequest): boolean {
  return requestedTenantHeader(request) === ALL_TENANTS_VALUE;
}

/**
 * 确定本次请求操作哪个租户：平台管理员按请求头进入目标租户，其他人固定在本属租户。
 * 写回 user.tenantId / tenantName / tenantIsPlatform，并建立租户隔离范围。
 */
export async function applyTenantScope(user: CurrentUser, request: FastifyRequest): Promise<void> {
  if (!user.homeTenantActive && !user.isPlatformAdmin) {
    throw forbidden('所在租户已停用，请联系平台管理员', 'TENANT_DISABLED');
  }
  // 平台管理员的「全部租户」视角：查询扩展不过滤，平台专属集成仍按平台租户对待。
  // user.tenantId 只保留本属租户的含义，任何按它过滤的地方都要先看 allTenants。
  if (user.isPlatformAdmin && requestedAllTenants(request)) {
    user.allTenants = true;
    user.tenantId = user.homeTenantId;
    user.tenantName = ALL_TENANTS_NAME;
    user.tenantIsPlatform = true;
    request.tenantScope = { tenantId: null, sharedWrite: false, allTenants: true };
    setCurrentTenantScope(null, false, true);
    return;
  }
  const wanted = requestedTenant(request);
  if (user.isPlatformAdmin && wanted && wanted !== user.homeTenantId) {
    const tenant = await prismaUnscoped.tenant.findUnique({ where: { id: wanted } });
    if (!tenant) throw forbidden('要进入的租户不存在或已删除', 'TENANT_NOT_FOUND');
    user.tenantId = tenant.id;
    user.tenantName = tenant.name;
    user.tenantIsPlatform = tenant.isPlatform;
  }
  // 平台管理员进入非平台租户代管时，平台级写权限（平台设置、授权许可、角色定义、标准题库发布）
  // 在本次请求里一并去掉，否则能在别人的租户范围里改全平台配置。租户管理页靠 isPlatformAdmin 判断，不受影响。
  if (user.isPlatformAdmin && !user.tenantIsPlatform) {
    user.permissions = new Set(
      [...user.permissions].filter((code) => code === 'tenant:manage' || !PLATFORM_ONLY.has(code)),
    );
  }
  const scope = {
    tenantId: user.tenantId,
    sharedWrite: user.isPlatformAdmin && user.tenantIsPlatform,
  };
  request.tenantScope = scope;
  setCurrentTenantScope(scope.tenantId, scope.sharedWrite);
}

/** preHandler: verify JWT and attach the resolved user (with fresh permissions). */
export const authenticate: preHandlerHookHandler = async (request) => {
  try {
    await request.jwtVerify();
  } catch {
    throw unauthorized();
  }
  const user = await loadCurrentUser(request.user.sub);
  if (!user) throw unauthorized('用户不存在或已被删除');
  if (!user.isActive) throw forbidden('用户已被禁用');
  const policy = await loadSecurityPolicy();
  const now = new Date();
  // 超时登出（后端兜底）：以落库的最近活跃时间为准（登录时刷新），缺失时退回令牌签发时间。
  const iat = (request.user as { iat?: number }).iat;
  const lastActive = user.lastActiveAt ?? (typeof iat === 'number' ? new Date(iat * 1000) : null);
  if (isIdleTimedOut(lastActive, policy, now)) {
    throw unauthorized('长时间未操作，已超时登出，请重新登录', 'SESSION_IDLE_TIMEOUT');
  }
  if (!lastActive || now.getTime() - lastActive.getTime() > ACTIVITY_WRITE_INTERVAL_MS) {
    await prismaUnscoped.user.update({ where: { id: user.id }, data: { lastActiveAt: now } });
  }
  const path = request.routeOptions.url ?? request.url.split('?')[0];
  if (
    isPasswordExpired(user.passwordChangedAt, policy, now) &&
    !PASSWORD_EXPIRED_ALLOWED.has(path ?? '')
  ) {
    throw forbidden('密码已超过强制更新时间，请先修改密码', 'PASSWORD_EXPIRED');
  }
  if (
    isPasswordChangeRequired(user.mustChangePassword, policy) &&
    !PASSWORD_EXPIRED_ALLOWED.has(path ?? '')
  ) {
    throw forbidden('首次登录须先修改密码', 'PASSWORD_CHANGE_REQUIRED');
  }
  await applyTenantScope(user, request);
  request.currentUser = user;
  // 全部租户视角是只读汇总视角：写操作一律拒绝，避免前端漏拦时写出跨租户数据。
  if (user.allTenants && request.method !== 'GET' && request.method !== 'HEAD') {
    const routePath = request.routeOptions.url?.split('?')[0] ?? '';
    const actualPath = request.url.split('?')[0] ?? '';
    if (!allTenantsWriteAllowed(routePath) && !allTenantsWriteAllowed(actualPath)) {
      throw conflict('请先进入具体租户再操作', 'TENANT_REQUIRED');
    }
  }
  await enforcePlatformConnectorAccess(user, request, prisma);
};

/** preHandler factory: require at least one of the given permission codes (OR). */
export function requirePermission(...codes: string[]): preHandlerHookHandler {
  return async (request) => {
    const user = request.currentUser;
    if (!user) throw unauthorized();
    const ok = codes.some((code) => user.permissions.has(code));
    if (!ok) throw permissionDenied(codes);
  };
}

/** preHandler：仅平台管理员（租户管理）。 */
export const requirePlatformAdmin: preHandlerHookHandler = async (request) => {
  const user = request.currentUser;
  if (!user) throw unauthorized();
  if (!user.isPlatformAdmin) throw forbidden('仅平台管理员可以管理租户', 'PLATFORM_ADMIN_REQUIRED');
};
