import type { FastifyInstance } from 'fastify';
import type { Severity } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { TENANT_ADMIN_ROLE } from '@lse/shared';
import { prismaUnscoped as db } from '../../db.js';
import { authenticate, requirePlatformAdmin } from '../../plugins/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { hashPassword } from '../../lib/password.js';
import { loadSecurityPolicy, passwordPolicyViolation } from '../../lib/security-policy.js';
import { assertUserLimitAllows } from '../../lib/license-enforcement.js';
import { PLATFORM_TENANT_ID } from '../../lib/tenant-models.js';
import { tenantTransferRoutes } from './transfer.js';

const idParams = z.object({ id: z.string().uuid() });

const usernameSchema = z
  .string()
  .trim()
  .min(3, '登录账号至少 3 个字符')
  .max(64)
  .regex(/^[a-zA-Z0-9_.-]+$/, '登录账号仅允许字母、数字、_ . -');

const createSchema = z.object({
  name: z.string().trim().min(1, '请填写租户名称').max(64, '租户名称不超过 64 字'),
  description: z.string().trim().max(200).optional(),
  admin: z.object({
    username: usernameSchema,
    displayName: z.string().trim().min(1).max(64).optional(),
    password: z.string().min(8, '密码至少 8 位').max(128),
  }),
});

const updateSchema = z.object({
  name: z.string().trim().min(1, '请填写租户名称').max(64, '租户名称不超过 64 字').optional(),
  description: z.string().trim().max(200).nullable().optional(),
  isActive: z.boolean().optional(),
});

type TenantRow = Awaited<ReturnType<typeof db.tenant.findMany>>[number];

// 与态势概览 /dashboard/posture 的「有效风险」同口径：有严重度、且未被人工判为误报。
const ACTIVE_FINDING = { severity: { not: null }, reviewStatus: { not: 'FALSE_POSITIVE' } } as const;
const HIGH_SEVERITIES: Severity[] = ['CRITICAL', 'HIGH'];

async function tenantStats(ids: string[]) {
  const by = <T extends { tenantId: string | null; _count: { _all: number } }>(rows: T[]) =>
    new Map(rows.map((r) => [r.tenantId ?? '', r._count._all]));
  const [users, targets, endpoints, tasks, lastTasks, risks, highRisks] = await Promise.all([
    db.user.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids } }, _count: { _all: true } }),
    db.modelTarget.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: ids }, targetType: { notIn: ['JUDGE', 'ENDPOINT_AGENT'] } },
      _count: { _all: true },
    }),
    db.fleetEndpoint.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: ids }, removedAt: null },
      _count: { _all: true },
    }),
    db.evalTask.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids } }, _count: { _all: true } }),
    db.evalTask.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids } }, _max: { createdAt: true } }),
    db.finding.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: ids }, ...ACTIVE_FINDING },
      _count: { _all: true },
    }),
    db.finding.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: ids }, severity: { in: HIGH_SEVERITIES }, reviewStatus: { not: 'FALSE_POSITIVE' } },
      _count: { _all: true },
    }),
  ]);
  return {
    users: by(users),
    targets: by(targets),
    endpoints: by(endpoints),
    tasks: by(tasks),
    lastTaskAt: new Map(lastTasks.map((r) => [r.tenantId ?? '', r._max.createdAt])),
    risks: by(risks),
    highRisks: by(highRisks),
  };
}

function serialize(t: TenantRow, stats?: Awaited<ReturnType<typeof tenantStats>>) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    isActive: t.isActive,
    isPlatform: t.isPlatform,
    createdAt: t.createdAt,
    ...(stats
      ? {
          userCount: stats.users.get(t.id) ?? 0,
          targetCount: stats.targets.get(t.id) ?? 0,
          endpointCount: stats.endpoints.get(t.id) ?? 0,
          taskCount: stats.tasks.get(t.id) ?? 0,
          riskCount: stats.risks.get(t.id) ?? 0,
          highRiskCount: stats.highRisks.get(t.id) ?? 0,
          lastTaskAt: stats.lastTaskAt.get(t.id) ?? null,
        }
      : {}),
  };
}

async function newTenantCode(): Promise<string> {
  for (;;) {
    const code = `t-${randomBytes(4).toString('hex')}`;
    if (!(await db.tenant.findUnique({ where: { code } }))) return code;
  }
}

/** 租户管理：仅平台管理员。租户本身是平台级数据，这里一律用不带租户隔离的客户端。 */
export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePlatformAdmin);

  app.get('/', async () => {
    const rows = await db.tenant.findMany({ orderBy: [{ isPlatform: 'desc' }, { createdAt: 'asc' }] });
    const stats = await tenantStats(rows.map((r) => r.id));
    return { items: rows.map((r) => serialize(r, stats)) };
  });

  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    if (await db.tenant.findUnique({ where: { name: body.name } })) {
      throw conflict('已有同名租户');
    }
    if (await db.user.findUnique({ where: { username: body.admin.username } })) {
      throw conflict('登录账号已被占用，请换一个');
    }
    const violation = passwordPolicyViolation(body.admin.password, await loadSecurityPolicy());
    if (violation) throw badRequest(violation, 'PASSWORD_POLICY');
    // 授权许可按全平台启用用户数计。
    await assertUserLimitAllows((await db.user.count({ where: { isActive: true } })) + 1);
    const role = await db.role.findUnique({ where: { name: TENANT_ADMIN_ROLE } });
    if (!role) throw badRequest('缺少内置角色「租户管理员」，请先完成平台升级', 'ROLE_MISSING');
    const passwordHash = await hashPassword(body.admin.password);
    const code = await newTenantCode();
    const tenant = await db.$transaction(async (tx) => {
      const created = await tx.tenant.create({
        data: { name: body.name, code, description: body.description || null },
      });
      // 租户的第一个管理员记为内置账号：不能被删除、停用或改角色，避免租户把自己锁在门外。
      // 初始密码是平台管理员定的，首次登录须改密。
      await tx.user.create({
        data: {
          tenantId: created.id,
          username: body.admin.username,
          displayName: body.admin.displayName || `${body.name}管理员`,
          passwordHash,
          isBuiltin: true,
          isActive: true,
          mustChangePassword: true,
          roles: { create: [{ roleId: role.id }] },
        },
      });
      return created;
    });
    await writeAudit({
      tenantId: PLATFORM_TENANT_ID,
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action: 'tenant.create',
      targetType: 'tenant',
      targetId: tenant.id,
      detail: { name: tenant.name, adminUsername: body.admin.username },
    });
    reply.code(201);
    const stats = await tenantStats([tenant.id]);
    return serialize(tenant, stats);
  });

  app.patch('/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = updateSchema.parse(request.body);
    const existing = await db.tenant.findUnique({ where: { id } });
    if (!existing) throw notFound('租户不存在');
    if (existing.isPlatform && body.isActive === false) {
      throw forbidden('平台租户不能停用');
    }
    if (body.name && body.name !== existing.name) {
      if (await db.tenant.findUnique({ where: { name: body.name } })) throw conflict('已有同名租户');
    }
    const updated = await db.tenant.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description || null } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });
    await writeAudit({
      tenantId: PLATFORM_TENANT_ID,
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action: body.isActive === false ? 'tenant.disable' : body.isActive === true ? 'tenant.enable' : 'tenant.update',
      targetType: 'tenant',
      targetId: id,
      detail: { before: { name: existing.name, isActive: existing.isActive }, after: { name: updated.name, isActive: updated.isActive } },
    });
    const stats = await tenantStats([id]);
    return serialize(updated, stats);
  });

  // 资产归属转移（预检 + 执行）：同样的 authenticate / requirePlatformAdmin 钩子对它生效。
  await tenantTransferRoutes(app);
}
