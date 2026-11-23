import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Paginated } from '@lse/shared';
import { prisma } from '../../db.js';
import { hashPassword } from '../../lib/password.js';
import { loadSecurityPolicy, passwordPolicyViolation } from '../../lib/security-policy.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { assertUserLimitAllows, requireLicensedFeature } from '../../lib/license-enforcement.js';
import { PLATFORM_ADMIN_ROLE } from '@lse/shared';
import type { CurrentUser } from '../../lib/rbac.js';
import { applyTenantFilter, tenantMatches, tenantOf } from '../../lib/all-tenants.js';
import { organizationPaths, organizationSubtreeIds } from '../organizations/service.js';

/** 平台管理员角色只能给平台租户的用户。 */
async function assertRolesAllowed(user: CurrentUser, roleIds: string[]): Promise<void> {
  if (user.tenantIsPlatform || roleIds.length === 0) return;
  const roles = await prisma.role.findMany({ where: { id: { in: roleIds } }, select: { name: true } });
  if (roles.some((r) => r.name === PLATFORM_ADMIN_ROLE)) {
    throw badRequest('「平台管理员」角色只能分配给平台租户的用户', 'PLATFORM_ROLE_FORBIDDEN');
  }
}

/** 用户所属组织必须是该用户所在租户的组织（2.9.1 绑定组织）。 */
async function assertOrganizationInTenant(
  tenantId: string,
  organizationId: string | null | undefined,
): Promise<void> {
  if (!organizationId) return;
  const org = await prisma.organization.findFirst({
    where: { id: organizationId, tenantId },
    select: { id: true },
  });
  if (!org) throw orgNotFound();
}

const orgNotFound = () => badRequest('组织不存在', 'ORG_NOT_FOUND');

/** 校验之后、写库之前组织被删：外键拦下，同样按「组织不存在」处理，不报 500。 */
function rethrowOrgGone(err: unknown): never {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2003' &&
    JSON.stringify(err.meta ?? {}).includes('organizationId')
  ) {
    throw orgNotFound();
  }
  throw err;
}

const idParams = z.object({ id: z.string().uuid() });

/** 用户名规则：管理员新建和自助注册共用。 */
export const usernameSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9_.-]+$/, '用户名仅允许字母、数字、_ . -');

const createSchema = z.object({
  username: usernameSchema,
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(64),
  email: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.string().email().optional(),
  ),
  roleIds: z.array(z.string().uuid()).default([]),
  isActive: z.boolean().default(true),
  organizationId: z.string().uuid().nullable().optional(),
});

const updateSchema = z.object({
  displayName: z.string().min(1).max(64).optional(),
  email: z.preprocess((v) => (v === '' ? null : v), z.string().email().nullable().optional()),
  isActive: z.boolean().optional(),
  roleIds: z.array(z.string().uuid()).optional(),
  organizationId: z.string().uuid().nullable().optional(),
});

const resetPwSchema = z.object({ password: z.string().min(8).max(128) });

const REGISTRATION_STATUSES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'] as const;
type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

const registrationReviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  roleIds: z.array(z.string().uuid()).default([]),
});

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  keyword: z.string().trim().optional(),
  tenantId: z.string().uuid().optional(),
  registrationStatus: z.enum(REGISTRATION_STATUSES).optional(),
  organizationId: z.string().uuid().optional(),
  includeDescendants: z.enum(['true', 'false']).optional(),
});

const userInclude = { roles: { include: { role: true } } } satisfies Prisma.UserInclude;
type UserRow = Prisma.UserGetPayload<{ include: typeof userInclude }>;

/** paths：组织 id → 组织路径（organizationPaths 查出）。 */
function serializeUser(u: UserRow, paths: Map<string, string>) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    phone: u.phone,
    organization: u.organization,
    organizationId: u.organizationId,
    organizationPath: u.organizationId ? (paths.get(u.organizationId) ?? null) : null,
    registrationStatus: u.registrationStatus,
    isActive: u.isActive,
    isBuiltin: u.isBuiltin,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    roles: u.roles
      .filter((ur) => ur.role.name !== 'super_admin')
      .map((ur) => ({ id: ur.role.id, name: ur.role.name })),
    tenantId: u.tenantId,
  };
}

async function serializeOne(u: UserRow) {
  return serializeUser(u, await organizationPaths([u.organizationId]));
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/', { preHandler: [requirePermission('user:read')] }, async (request) => {
    const q = listQuery.parse(request.query);
    const keyword: Prisma.UserWhereInput = q.keyword
      ? {
          OR: [
            { username: { contains: q.keyword, mode: 'insensitive' } },
            { displayName: { contains: q.keyword, mode: 'insensitive' } },
          ],
        }
      : {};
    const tid = tenantOf(request.currentUser!);
    // 按组织筛：含下级时按该组织所在租户的树展开；查不到组织（如别的租户的）就只按原 id 筛，自然为空。
    let organizationIds: string[] | undefined;
    if (q.organizationId) {
      organizationIds = [q.organizationId];
      if (q.includeDescendants === 'true') {
        const org = await prisma.organization.findUnique({
          where: { id: q.organizationId },
          select: { id: true, tenantId: true },
        });
        if (org && tenantMatches(request.currentUser!, org.tenantId)) {
          organizationIds = await organizationSubtreeIds(org);
        }
      }
    }
    const where: Prisma.UserWhereInput = {
      ...keyword,
      ...(tid ? { tenantId: tid } : {}),
      ...(q.registrationStatus ? { registrationStatus: q.registrationStatus } : {}),
      ...(organizationIds ? { organizationId: { in: organizationIds } } : {}),
    };
    applyTenantFilter(request, where as Record<string, unknown>);
    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: userInclude,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.user.count({ where }),
    ]);
    const paths = await organizationPaths(rows.map((u) => u.organizationId));
    const body: Paginated<ReturnType<typeof serializeUser>> = {
      items: rows.map((u) => serializeUser(u, paths)),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
    return body;
  });

  app.get('/:id', { preHandler: [requirePermission('user:read')] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const u = await prisma.user.findUnique({ where: { id }, include: userInclude });
    if (!u || !tenantMatches(request.currentUser!, u.tenantId)) throw notFound('用户不存在');
    return serializeOne(u);
  });

  app.post(
    '/',
    { preHandler: [requirePermission('user:create'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = createSchema.parse(request.body);
      if (await prisma.user.findUnique({ where: { username: body.username } })) {
        throw conflict('用户名已存在');
      }
      if (body.isActive) {
        const activeCount = await prisma.user.count({ where: { isActive: true } });
        await assertUserLimitAllows(activeCount + 1);
      }
      const violation = passwordPolicyViolation(body.password, await loadSecurityPolicy());
      if (violation) throw badRequest(violation, 'PASSWORD_POLICY');
      await assertRolesAllowed(request.currentUser!, body.roleIds);
      await assertOrganizationInTenant(request.currentUser!.tenantId, body.organizationId);
      const passwordHash = await hashPassword(body.password);
      const u = await prisma.user
        .create({
          data: {
            // 写操作在全局视角下已被 authenticate 拒绝，这里恒为本属/代管租户。
            tenantId: request.currentUser!.tenantId,
            username: body.username,
            passwordHash,
            displayName: body.displayName,
            email: body.email,
            isActive: body.isActive,
            organizationId: body.organizationId ?? null,
            mustChangePassword: true,
            roles: { create: body.roleIds.map((roleId) => ({ roleId })) },
          },
          include: userInclude,
        })
        .catch(rethrowOrgGone);
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'user.create',
        targetType: 'user',
        targetId: u.id,
        detail: { username: u.username },
      });
      reply.code(201);
      return serializeOne(u);
    },
  );

  app.patch(
    '/:id',
    { preHandler: [requirePermission('user:update'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = updateSchema.parse(request.body);
      const target = await prisma.user.findUnique({ where: { id } });
      if (!target || !tenantMatches(request.currentUser!, target.tenantId)) throw notFound('用户不存在');
      if (target.isBuiltin && body.isActive === false) throw forbidden('内置用户不可禁用');
      // 自助注册还没审核通过（待审核、已拒绝）的账号，只能走审核启用。
      if (
        body.isActive === true &&
        (target.registrationStatus === 'PENDING' || target.registrationStatus === 'REJECTED')
      ) {
        throw conflict('该账号是自助注册的，请通过审核启用', 'REGISTRATION_REVIEW_REQUIRED');
      }
      if (body.isActive === true && !target.isActive) {
        const activeCount = await prisma.user.count({ where: { isActive: true } });
        await assertUserLimitAllows(activeCount + 1);
      }

      const data: Prisma.UserUncheckedUpdateInput = {};
      if (body.displayName !== undefined) data.displayName = body.displayName;
      if (body.email !== undefined) data.email = body.email;
      if (body.isActive !== undefined) data.isActive = body.isActive;
      if (body.roleIds) {
        if (target.isBuiltin) throw forbidden('内置用户角色不可修改');
        await assertRolesAllowed(request.currentUser!, body.roleIds);
        data.roles = { deleteMany: {}, create: body.roleIds.map((roleId) => ({ roleId })) };
      }
      const nextOrganizationId =
        body.organizationId === undefined ? target.organizationId : body.organizationId;
      const organizationChanged = nextOrganizationId !== target.organizationId;
      if (organizationChanged) {
        await assertOrganizationInTenant(target.tenantId, nextOrganizationId);
        // 直接写外键列：组织在校验之后被删时由外键拦下（rethrowOrgGone），不走 connect 的「查不到」404。
        data.organizationId = nextOrganizationId;
      }
      const u = await prisma.user
        .update({ where: { id }, data, include: userInclude })
        .catch(rethrowOrgGone);
      const paths = await organizationPaths([target.organizationId, u.organizationId]);
      const orgState = (organizationId: string | null) => ({
        organizationId,
        organizationPath: organizationId ? (paths.get(organizationId) ?? null) : null,
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'user.update',
        targetType: 'user',
        targetId: id,
        // 组织有变化时记下改前改后（组织 id 和路径）
        ...(organizationChanged
          ? {
              detail: {
                before: orgState(target.organizationId),
                after: orgState(u.organizationId),
              },
            }
          : {}),
      });
      return serializeUser(u, paths);
    },
  );

  // 审核自助注册：通过 = 启用并分配角色（待审核、已拒绝的都可以通过）；拒绝 = 停用，只处理待审核的。
  // 注册用户的密码是本人设的，通过时不要求改密。
  app.post(
    '/:id/registration',
    { preHandler: [requirePermission('user:update'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = registrationReviewSchema.parse(request.body);
      const target = await prisma.user.findUnique({ where: { id } });
      if (!target || !tenantMatches(request.currentUser!, target.tenantId)) throw notFound('用户不存在');
      const approve = body.action === 'approve';
      const from: RegistrationStatus[] = approve ? ['PENDING', 'REJECTED'] : ['PENDING'];
      const notReviewable = () =>
        conflict(
          approve ? '该用户不是待审核或已拒绝状态' : '该用户不是待审核状态',
          'REGISTRATION_NOT_PENDING',
        );
      if (!from.includes(target.registrationStatus)) throw notReviewable();
      const roleIds = [...new Set(body.roleIds)];
      if (approve) {
        if (roleIds.length > 0) {
          const found = await prisma.role.count({ where: { id: { in: roleIds } } });
          if (found !== roleIds.length) throw badRequest('角色不存在', 'ROLE_NOT_FOUND');
        }
        await assertRolesAllowed(request.currentUser!, roleIds);
        const activeCount = await prisma.user.count({ where: { isActive: true } });
        await assertUserLimitAllows(activeCount + 1);
      }
      let u: UserRow;
      try {
        // 带状态条件更新：两个人同时审核时只有一个生效。角色以这次审核选的为准。
        u = await prisma.user.update({
          where: { id, registrationStatus: { in: from } },
          data: approve
            ? {
                isActive: true,
                registrationStatus: 'APPROVED',
                roles: { deleteMany: {}, create: roleIds.map((roleId) => ({ roleId })) },
              }
            : { registrationStatus: 'REJECTED', isActive: false },
          include: userInclude,
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
          throw notReviewable();
        }
        throw err;
      }
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: approve ? 'user.registration_approve' : 'user.registration_reject',
        targetType: 'user',
        targetId: id,
        detail: { username: u.username, ...(approve ? { roleIds } : {}) },
      });
      return serializeOne(u);
    },
  );

  app.delete('/:id', { preHandler: [requirePermission('user:delete')] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target || target.tenantId !== tenantOf(request.currentUser!)) throw notFound('用户不存在');
    if (target.isBuiltin) throw forbidden('内置用户不可删除');
    if (target.id === request.currentUser!.id) throw forbidden('不可删除当前登录用户');
    await prisma.user.delete({ where: { id } });
    await writeAudit({
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action: 'user.delete',
      targetType: 'user',
      targetId: id,
      detail: { username: target.username },
    });
    return { ok: true };
  });

  app.post(
    '/:id/reset-password',
    { preHandler: [requirePermission('user:reset_password')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { password } = resetPwSchema.parse(request.body);
      const target = await prisma.user.findUnique({ where: { id } });
      if (!target || !tenantMatches(request.currentUser!, target.tenantId)) throw notFound('用户不存在');
      const violation = passwordPolicyViolation(password, await loadSecurityPolicy());
      if (violation) throw badRequest(violation, 'PASSWORD_POLICY');
      const passwordHash = await hashPassword(password);
      // 管理员重置同时解除锁定并重置改密时间。
      await prisma.user.update({
        where: { id },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          mustChangePassword: true,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'user.reset_password',
        targetType: 'user',
        targetId: id,
      });
      return { ok: true };
    },
  );
}
