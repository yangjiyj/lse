import type { FastifyRequest } from 'fastify';
import type { CurrentUser } from './rbac.js';

/**
 * 「全部租户」视角的列表辅助。
 *
 * 查询扩展在这个视角下不过滤，所以列表天然汇总所有租户；这里只负责：
 * 1. 可选的 tenantId 筛选（仅全局视角生效，避免普通用户越权指定别人的租户）；
 * 2. 显式按 request.currentUser.tenantId 过滤的地方统一改成可空，防止「列表能看到、详情 404」。
 */

const TENANT_ID_RE = /^[0-9a-f-]{36}$/i;

/** 全局视角下把 query.tenantId 变成 where.tenantId；其他视角一律忽略。 */
export function applyTenantFilter(request: FastifyRequest, where: Record<string, unknown>): void {
  const user = request.currentUser as CurrentUser | undefined;
  if (!user?.allTenants) return;
  const raw = (request.query as Record<string, unknown> | undefined)?.tenantId;
  if (typeof raw === 'string' && TENANT_ID_RE.test(raw)) {
    where.tenantId = raw.toLowerCase();
  }
}

/** 纯函数版：返回可直接 spread 进 Prisma where 的租户条件（全局视角下可选 tenantId）。 */
export function tenantFilterWhere(request: FastifyRequest): { tenantId?: string } {
  const where: Record<string, unknown> = {};
  applyTenantFilter(request, where);
  return where as { tenantId?: string };
}

/** 显式租户条件：全局视角返回 undefined，调用方据此省略 where.tenantId。 */
export function tenantOf(user: CurrentUser): string | undefined {
  return user.allTenants ? undefined : user.tenantId;
}

/** 平台专属集成的租户判断：全局视角按平台租户对待。 */
export function tenantIsPlatform(user: CurrentUser): boolean {
  return user.allTenants || user.tenantIsPlatform;
}

/** 详情/写操作的行归属校验：全局视角没有「当前租户」，任何行都可读（写已被 authenticate 拒绝）。 */
export function tenantMatches(user: CurrentUser, tenantId: string | null): boolean {
  const tid = tenantOf(user);
  return tid === undefined || tid === tenantId;
}
