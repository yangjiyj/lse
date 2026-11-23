import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PERMISSION_CODES, PLATFORM_ADMIN_ROLE } from '@lse/shared';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { tenantOf } from '../../lib/all-tenants.js';

const idParams = z.object({ id: z.string().uuid() });
/** 角色用户名单一次最多返回的人数。 */
export const ROLE_USERS_LIMIT = 500;
const codeSet = new Set<string>(PERMISSION_CODES);

const createSchema = z.object({
  name: z.string().min(2).max(64),
  description: z.string().max(255).optional(),
  permissions: z.array(z.string()).default([]),
});

const updateSchema = z.object({
  description: z.string().max(255).nullable().optional(),
  permissions: z.array(z.string()).optional(),
});

const roleInclude = {
  permissions: { include: { permission: true } },
  _count: { select: { users: true } },
} satisfies Prisma.RoleInclude;
type RoleRow = Prisma.RoleGetPayload<{ include: typeof roleInclude }>;

/** 角色是全平台共用的定义；人数只算当前租户的用户（全部租户视角算全平台）。 */
function roleIncludeFor(tenantId: string | undefined) {
  return tenantId
    ? {
        permissions: { include: { permission: true } },
        _count: { select: { users: { where: { user: { tenantId } } } } },
      }
    : roleInclude;
}

const DEPRECATED_ROLE_NAMES = new Set(['super_admin']);

function isDeprecatedRoleName(name: string): boolean {
  return DEPRECATED_ROLE_NAMES.has(name);
}

function serializeRole(r: RoleRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    isBuiltin: r.isBuiltin,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    userCount: r._count.users,
    permissions: r.permissions.map((rp) => rp.permission.code).sort(),
  };
}

async function setRolePermissions(roleId: string, codes: string[]): Promise<void> {
  const invalid = codes.filter((c) => !codeSet.has(c));
  if (invalid.length) throw badRequest('包含无效的权限码：' + invalid.join(', '));
  const perms = await prisma.permission.findMany({
    where: { code: { in: codes } },
    select: { id: true },
  });
  await prisma.rolePermission.deleteMany({ where: { roleId } });
  if (perms.length) {
    await prisma.rolePermission.createMany({
      data: perms.map((p) => ({ roleId, permissionId: p.id })),
      skipDuplicates: true,
    });
  }
}

export async function roleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/', { preHandler: [requirePermission('role:read')] }, async (request) => {
    const user = request.currentUser!;
    // 非平台租户看不到、也分配不了「平台管理员」角色。
    const hidden = user.tenantIsPlatform ? ['super_admin'] : ['super_admin', PLATFORM_ADMIN_ROLE];
    const rows = await prisma.role.findMany({
      where: { name: { notIn: hidden } },
      include: roleIncludeFor(tenantOf(user)),
      orderBy: { createdAt: 'asc' },
    });
    return { items: rows.map(serializeRole) };
  });

  app.get('/:id', { preHandler: [requirePermission('role:read')] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const r = await prisma.role.findUnique({ where: { id }, include: roleIncludeFor(tenantOf(request.currentUser!)) });
    if (!r || isDeprecatedRoleName(r.name)) throw notFound('角色不存在');
    return serializeRole(r);
  });

  // 角色下的用户名单：范围与角色列表的人数一致（当前租户；全部租户视角为全平台）。
  app.get('/:id/users', { preHandler: [requirePermission('role:read')] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const user = request.currentUser!;
    const r = await prisma.role.findUnique({ where: { id }, select: { name: true } });
    if (!r || isDeprecatedRoleName(r.name)) throw notFound('角色不存在');
    if (r.name === PLATFORM_ADMIN_ROLE && !user.tenantIsPlatform) throw notFound('角色不存在');
    const tid = tenantOf(user);
    const rows = await prisma.user.findMany({
      where: { roles: { some: { roleId: id } }, ...(tid ? { tenantId: tid } : {}) },
      select: {
        id: true,
        username: true,
        displayName: true,
        isActive: true,
        tenant: { select: { name: true } },
      },
      orderBy: { username: 'asc' },
      take: ROLE_USERS_LIMIT + 1,
    });
    return {
      items: rows.slice(0, ROLE_USERS_LIMIT).map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        tenantName: u.tenant.name,
        isActive: u.isActive,
      })),
      truncated: rows.length > ROLE_USERS_LIMIT,
    };
  });

  app.post('/', { preHandler: [requirePermission('role:create')] }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    if (isDeprecatedRoleName(body.name)) {
      throw badRequest('该角色名称为系统保留名称');
    }
    if (await prisma.role.findUnique({ where: { name: body.name } })) {
      throw conflict('角色名已存在');
    }
    const created = await prisma.role.create({
      data: { name: body.name, description: body.description },
    });
    await setRolePermissions(created.id, body.permissions);
    const full = await prisma.role.findUnique({ where: { id: created.id }, include: roleInclude });
    await writeAudit({
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action: 'role.create',
      targetType: 'role',
      targetId: created.id,
      detail: { name: created.name },
    });
    reply.code(201);
    return serializeRole(full!);
  });

  app.patch('/:id', { preHandler: [requirePermission('role:update')] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = updateSchema.parse(request.body);
    const r = await prisma.role.findUnique({ where: { id } });
    if (!r || isDeprecatedRoleName(r.name)) throw notFound('角色不存在');
    if (r.isBuiltin) throw forbidden('内置角色不可修改');
    if (body.description !== undefined) {
      await prisma.role.update({ where: { id }, data: { description: body.description } });
    }
    if (body.permissions) await setRolePermissions(id, body.permissions);
    const full = await prisma.role.findUnique({ where: { id }, include: roleInclude });
    await writeAudit({
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action: 'role.update',
      targetType: 'role',
      targetId: id,
    });
    return serializeRole(full!);
  });

  app.delete('/:id', { preHandler: [requirePermission('role:delete')] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const r = await prisma.role.findUnique({ where: { id }, include: roleInclude });
    if (!r || isDeprecatedRoleName(r.name)) throw notFound('角色不存在');
    if (r.isBuiltin) throw forbidden('内置角色不可删除');
    if (r._count.users > 0) throw badRequest('该角色仍有用户关联，无法删除');
    await prisma.role.delete({ where: { id } });
    await writeAudit({
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action: 'role.delete',
      targetType: 'role',
      targetId: id,
      detail: { name: r.name },
    });
    return { ok: true };
  });
}
