import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { prisma, prismaUnscoped } from '../db.js';
import { setCurrentTenantScope } from '../lib/tenant-context.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';
import { authenticate, requirePermission } from './auth.js';

/** CI 查询门禁最新判定。 */
export const GATES_READ_SCOPE = 'gates:read';
/** CI 触发评估计划（POST /api/eval-plans/:id/trigger，由 W3a 挂载）。 */
export const EVAL_PLANS_TRIGGER_SCOPE = 'eval-plans:trigger';
/** CI 导出评估任务结果（GET /api/eval-tasks/:id/export，只读）。 */
export const EVAL_TASKS_READ_SCOPE = 'eval-tasks:read';
export const API_TOKEN_SCOPES = [
  GATES_READ_SCOPE,
  EVAL_PLANS_TRIGGER_SCOPE,
  EVAL_TASKS_READ_SCOPE,
] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export interface ApiTokenPrincipal {
  id: string;
  name: string;
  scopes: string[];
  createdById: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** 仅在经 requireApiTokenOrUser 以 API 令牌鉴权通过时存在。 */
    apiToken?: ApiTokenPrincipal;
  }
}

const TOKEN_RE = /^lse_([0-9a-f]{8})_([0-9a-f]{32})$/;
const TOKEN_HEADER_RE = /^Bearer\s+(lse_\S*)$/i;

export function hashApiToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

/** 生成新令牌明文：lse_<8位十六进制前缀>_<32位十六进制随机>。 */
export function generateApiToken(): { token: string; prefix: string; tokenHash: string } {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(16).toString('hex');
  const token = `lse_${prefix}_${secret}`;
  return { token, prefix, tokenHash: hashApiToken(token) };
}

/** 请求头里是否带了 lse_ 形态的 Bearer 令牌（不做校验）。 */
export function extractApiToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = TOKEN_HEADER_RE.exec(header.trim());
  return m ? m[1]! : null;
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

type FailReason =
  | 'MALFORMED'
  | 'NOT_FOUND'
  | 'HASH_MISMATCH'
  | 'REVOKED'
  | 'EXPIRED'
  | 'SCOPE_MISMATCH';

async function auditUse(
  request: FastifyRequest,
  ok: boolean,
  tokenId: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  await writeAudit({
    actorId: null,
    actorName: typeof detail.label === 'string' ? `API 令牌：${detail.label}` : 'API 令牌',
    action: ok ? 'api_token.use' : 'api_token.use_failed',
    targetType: 'api_token',
    targetId: tokenId,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    detail: { ...detail, method: request.method, route: request.routeOptions.url ?? null },
  });
}

async function verifyApiToken(
  request: FastifyRequest,
  plain: string,
  scope: string,
): Promise<void> {
  const fail = async (
    reason: FailReason,
    status: 401 | 403,
    token?: { id: string; name: string; prefix: string },
  ): Promise<never> => {
    await auditUse(request, false, token?.id ?? null, {
      reason,
      scope,
      label: token?.name,
      prefix: token?.prefix ?? TOKEN_RE.exec(plain)?.[1] ?? null,
    });
    if (status === 403) throw forbidden(`API 令牌缺少权限范围：${scope}`, 'API_TOKEN_SCOPE');
    throw unauthorized('API 令牌无效、已过期或已吊销', 'API_TOKEN_INVALID');
  };

  const m = TOKEN_RE.exec(plain);
  if (!m) return fail('MALFORMED', 401);
  const row = await prisma.apiToken.findUnique({ where: { prefix: m[1]! } });
  // 前缀不存在时仍做一次等长比较，避免通过响应耗时区分“前缀存在与否”。
  const presented = hashApiToken(plain);
  if (!row) {
    safeEqualHex(presented, presented);
    return fail('NOT_FOUND', 401);
  }
  const meta = { id: row.id, name: row.name, prefix: row.prefix };
  if (!safeEqualHex(presented, row.tokenHash)) return fail('HASH_MISMATCH', 401, meta);
  if (row.revokedAt) return fail('REVOKED', 401, meta);
  if (row.expiresAt.getTime() <= Date.now()) return fail('EXPIRED', 401, meta);
  if (!row.scopes.includes(scope)) return fail('SCOPE_MISMATCH', 403, meta);

  // 令牌只在它所属的租户里生效；租户停用后令牌一并失效。
  const tenant = row.tenantId
    ? await prismaUnscoped.tenant.findUnique({ where: { id: row.tenantId } })
    : null;
  if (!tenant || !tenant.isActive) return fail('REVOKED', 401, meta);
  request.tenantScope = { tenantId: tenant.id, sharedWrite: false };
  setCurrentTenantScope(tenant.id, false);

  await prisma.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  await auditUse(request, true, row.id, { scope, label: row.name, prefix: row.prefix });
  request.apiToken = {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    createdById: row.createdById,
  };
}

/**
 * preHandler：Authorization: Bearer lse_... 走 API 令牌校验（需含 scope）；
 * 否则回退到现有 JWT 用户鉴权，并要求用户具备 userPermissions 中任一权限（为空则只要登录）。
 *
 * 注意：API 令牌只对显式挂了本 preHandler 的路由生效；所在插件不能再全局
 * addHook('preHandler', authenticate)，否则令牌请求会先被 JWT 校验拒绝。
 */
export function requireApiTokenOrUser(
  scope: ApiTokenScope | string,
  ...userPermissions: string[]
): preHandlerHookHandler {
  const needPerm = userPermissions.length > 0 ? requirePermission(...userPermissions) : null;
  return async function apiTokenOrUser(request, reply) {
    const plain = extractApiToken(request);
    if (plain) {
      await verifyApiToken(request, plain, scope);
      return;
    }
    await authenticate.call(this, request, reply, () => undefined);
    if (needPerm) await needPerm.call(this, request, reply, () => undefined);
  };
}
