import type { FastifyInstance } from 'fastify';
import type { Organization, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { applyTenantFilter, tenantMatches } from '../../lib/all-tenants.js';
import {
  buildOrganizationTree,
  createOrganization,
  deleteOrganization,
  normalizeOrganizationName,
  organizationMemberCounts,
  organizationPaths,
  organizationSubtreeIds,
  updateOrganization,
} from './service.js';

const idParams = z.object({ id: z.string().uuid() });
const nameSchema = z
  .string()
  .transform(normalizeOrganizationName)
  .pipe(z.string().min(1, '请填写组织名称').max(64, '组织名称不超过 64 字'));
const sortSchema = z.number().int().min(0).max(99999);

const createSchema = z.object({
  name: nameSchema,
  parentId: z.string().uuid().nullable().optional(),
  sort: sortSchema.optional(),
});

const updateSchema = z.object({
  name: nameSchema.optional(),
  parentId: z.string().uuid().nullable().optional(),
  sort: sortSchema.optional(),
});

const membersQuery = z.object({
  includeDescendants: z.enum(['true', 'false']).optional(),
  keyword: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

function serialize(org: Organization) {
  return { id: org.id, name: org.name, parentId: org.parentId, sort: org.sort };
}

/**
 * 组织架构（2.9.3）：租户内的组织树。读要 org:read，写要 org:manage。
 * 「全部租户」视角下读接口按租户分组返回，写接口由 authenticate 统一要求先进入具体租户（TENANT_REQUIRED）。
 */
export async function organizationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/', { preHandler: [requirePermission('org:read')] }, async (request) => {
    const where: Prisma.OrganizationWhereInput = {};
    applyTenantFilter(request, where as Record<string, unknown>);
    const rows = await prisma.organization.findMany({
      where,
      orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, tenantId: true, name: true, parentId: true, sort: true },
    });
    const counts = await organizationMemberCounts(rows.map((row) => row.id));
    if (!request.currentUser!.allTenants) return { items: buildOrganizationTree(rows, counts) };
    const tenants = await prisma.tenant.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.tenantId))] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    });
    return {
      groups: tenants.map((tenant) => ({
        tenantId: tenant.id,
        tenantName: tenant.name,
        items: buildOrganizationTree(
          rows.filter((row) => row.tenantId === tenant.id),
          counts,
        ),
      })),
    };
  });

  app.get('/:id/members', { preHandler: [requirePermission('org:read')] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const q = membersQuery.parse(request.query);
    const org = await prisma.organization.findUnique({ where: { id } });
    if (!org || !tenantMatches(request.currentUser!, org.tenantId)) throw notFound('组织不存在');
    const ids = q.includeDescendants === 'true' ? await organizationSubtreeIds(org) : [org.id];
    const where: Prisma.UserWhereInput = {
      organizationId: { in: ids },
      ...(q.keyword
        ? {
            OR: [
              { username: { contains: q.keyword, mode: 'insensitive' } },
              { displayName: { contains: q.keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        // org:read 给了全部角色：成员接口只返回认人用的字段，不带邮箱等联系方式。
        select: {
          id: true,
          username: true,
          displayName: true,
          isActive: true,
          organizationId: true,
        },
      }),
      prisma.user.count({ where }),
    ]);
    const paths = await organizationPaths(rows.map((row) => row.organizationId));
    return {
      items: rows.map((row) => ({
        ...row,
        organizationPath: row.organizationId ? (paths.get(row.organizationId) ?? null) : null,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  });

  app.post('/', { preHandler: [requirePermission('org:manage')] }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const user = request.currentUser!;
    // 写操作在全局视角下已被 authenticate 拒绝，这里恒为本属/代管租户。
    const org = await createOrganization(user.tenantId, body);
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'organization.create',
      targetType: 'organization',
      targetId: org.id,
      detail: { name: org.name, parentId: org.parentId },
    });
    reply.code(201);
    return { ...serialize(org), memberCount: 0, children: [] };
  });

  app.patch('/:id', { preHandler: [requirePermission('org:manage')] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = updateSchema.parse(request.body);
    if (body.name === undefined && body.parentId === undefined && body.sort === undefined) {
      throw badRequest('没有要修改的内容');
    }
    const user = request.currentUser!;
    const { before, after } = await updateOrganization(user.tenantId, id, body);
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'organization.update',
      targetType: 'organization',
      targetId: id,
      detail: { before: serialize(before), after: serialize(after) },
    });
    return serialize(after);
  });

  app.delete('/:id', { preHandler: [requirePermission('org:manage')] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const user = request.currentUser!;
    const [path] = (await organizationPaths([id])).values();
    const org = await deleteOrganization(user.tenantId, id);
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'organization.delete',
      targetType: 'organization',
      targetId: id,
      detail: { name: org.name, path: path ?? org.name },
    });
    return { ok: true };
  });
}
