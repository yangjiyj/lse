import { PLATFORM_ONLY_PERMISSIONS } from '@lse/shared';
import { prismaUnscoped as prisma } from '../db.js';

export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  isBuiltin: boolean;
  isActive: boolean;
  roles: string[];
  permissions: Set<string>;
  preferences: { viewMode?: 'expert' | 'demo' } | null;
  passwordChangedAt: Date | null;
  /** 须改密标记（是否拦截还要看安全策略的首次登录强制改密开关）。 */
  mustChangePassword: boolean;
  lastActiveAt: Date | null;
  /** 用户本属的租户。 */
  homeTenantId: string;
  homeTenantActive: boolean;
  /** 本属租户是平台租户（平台管理员只能在平台租户里）。 */
  inPlatformTenant: boolean;
  /** 平台管理员：本属平台租户且有租户管理权限，可切换进入任何租户。 */
  isPlatformAdmin: boolean;
  /** 本次请求实际操作的租户（平台管理员切换后为目标租户，其他人恒等于本属租户）；authenticate 填写。 */
  tenantId: string;
  tenantName: string;
  tenantIsPlatform: boolean;
  /** 平台管理员的「全部租户」只读视角：tenantId 仅表示本属租户，不能再当过滤条件用。 */
  allTenants: boolean;
}

const PLATFORM_ONLY = new Set<string>(PLATFORM_ONLY_PERMISSIONS);

/**
 * Load a user with roles flattened to a permission-code set.
 * 非平台租户的用户即使被分配了含平台级权限的角色，这些权限也一律剔除（平台设置、授权许可、角色定义、租户管理）。
 */
export async function loadCurrentUser(userId: string): Promise<CurrentUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      tenant: true,
      roles: {
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      },
    },
  });
  if (!user) return null;

  const inPlatformTenant = user.tenant.isPlatform;
  const roles: string[] = [];
  const permissions = new Set<string>();
  for (const ur of user.roles) {
    if (ur.role.name !== 'super_admin') roles.push(ur.role.name);
    for (const rp of ur.role.permissions) {
      if (!inPlatformTenant && PLATFORM_ONLY.has(rp.permission.code)) continue;
      permissions.add(rp.permission.code);
    }
  }

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    isBuiltin: user.isBuiltin,
    isActive: user.isActive,
    roles,
    permissions,
    preferences: (user.preferences as { viewMode?: 'expert' | 'demo' } | null) ?? null,
    passwordChangedAt: user.passwordChangedAt,
    mustChangePassword: user.mustChangePassword,
    lastActiveAt: user.lastActiveAt,
    homeTenantId: user.tenantId,
    homeTenantActive: user.tenant.isActive,
    inPlatformTenant,
    isPlatformAdmin: inPlatformTenant && permissions.has('tenant:manage'),
    tenantId: user.tenantId,
    tenantName: user.tenant.name,
    tenantIsPlatform: inPlatformTenant,
    allTenants: false,
  };
}
