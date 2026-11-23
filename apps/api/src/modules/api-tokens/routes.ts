import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { PLATFORM_ADMIN_ROLE, TENANT_ADMIN_ROLE } from '@lse/shared';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { authenticate } from '../../plugins/auth.js';
import { API_TOKEN_SCOPES, generateApiToken } from '../../plugins/api-token-auth.js';

export const MAX_API_TOKEN_DAYS = 365;

/** 仅管理员（平台管理员或本租户的租户管理员）可管理 API 令牌；令牌只在所属租户内生效。 */
const requireAdmin: preHandlerHookHandler = async (request) => {
  const user = request.currentUser;
  if (!user) throw unauthorized();
  if (!user.roles.includes(PLATFORM_ADMIN_ROLE) && !user.roles.includes(TENANT_ADMIN_ROLE))
    throw forbidden('仅管理员可管理 API 令牌');
};

const createBody = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(API_TOKEN_SCOPES)).min(1).max(API_TOKEN_SCOPES.length),
  expiresInDays: z.number().int().min(1).max(MAX_API_TOKEN_DAYS),
});

type TokenRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdById: string | null;
  createdByName: string | null;
  createdAt: Date;
};

const SAFE_SELECT = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  expiresAt: true,
  revokedAt: true,
  lastUsedAt: true,
  createdById: true,
  createdByName: true,
  createdAt: true,
} as const;

/** 列表/详情序列化：永不包含明文或哈希。 */
export function serializeApiToken(row: TokenRow, now = new Date()) {
  const status = row.revokedAt ? 'REVOKED' : row.expiresAt <= now ? 'EXPIRED' : 'ACTIVE';
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    maskedToken: `lse_${row.prefix}_${'*'.repeat(8)}`,
    scopes: row.scopes,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdById: row.createdById,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    status,
  };
}

export async function apiTokenRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => {
    const rows = await prisma.apiToken.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: SAFE_SELECT,
    });
    return { items: rows.map((r) => serializeApiToken(r)), scopes: API_TOKEN_SCOPES };
  });

  app.post('/', async (request, reply) => {
    const body = createBody.parse(request.body);
    const user = request.currentUser!;
    const { token, prefix, tokenHash } = generateApiToken();
    const expiresAt = new Date(Date.now() + body.expiresInDays * 86400_000);
    const row = await prisma.apiToken.create({
      data: {
        name: body.name,
        prefix,
        tokenHash,
        scopes: [...new Set(body.scopes)],
        expiresAt,
        createdById: user.id,
        createdByName: user.displayName || user.username,
      },
      select: SAFE_SELECT,
    });
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'api_token.create',
      targetType: 'api_token',
      targetId: row.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      detail: { name: row.name, prefix: row.prefix, scopes: row.scopes, expiresAt },
    });
    reply.code(201);
    // 明文只在此处返回一次。
    return { token, item: serializeApiToken(row) };
  });

  app.post('/:id/revoke', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const user = request.currentUser!;
    const existing = await prisma.apiToken.findUnique({ where: { id }, select: SAFE_SELECT });
    if (!existing) throw notFound('API 令牌不存在');
    const row = existing.revokedAt
      ? existing
      : await prisma.apiToken.update({
          where: { id },
          data: { revokedAt: new Date() },
          select: SAFE_SELECT,
        });
    if (!existing.revokedAt) {
      await writeAudit({
        actorId: user.id,
        actorName: user.username,
        action: 'api_token.revoke',
        targetType: 'api_token',
        targetId: row.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        detail: { name: row.name, prefix: row.prefix },
      });
    }
    return serializeApiToken(row);
  });
}
