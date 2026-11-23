import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';

// 2.9.1 审核注册：通过（启用 + 分配角色）、拒绝、只能审核待审核的、按状态过滤、审计、权限与租户隔离。
const PREFIX = 'w1rev_';
const TENANT_CODE = 'w1rev-tenant';
const PASSWORD = 'Review@1234'; // pragma: allowlist secret

let app!: FastifyInstance;
let adminToken = '';
let auditorToken = '';
let tenantAdminToken = '';
let tenantId = '';
let operatorRoleId = '';
let adminRoleId = '';
let seq = 0;

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function login(username: string, password = PASSWORD) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
}

async function pendingUser(tenant = PLATFORM_TENANT_ID) {
  seq += 1;
  return prismaUnscoped.user.create({
    data: {
      tenantId: tenant,
      username: `${PREFIX}p${seq}`,
      passwordHash: await hashPassword(PASSWORD),
      displayName: `待审核${seq}`,
      phone: '13800138000',
      organization: '测试单位',
      isActive: false,
      registrationStatus: 'PENDING',
    },
  });
}

async function userWithRole(role: string, tenant = PLATFORM_TENANT_ID) {
  seq += 1;
  const roleRow = await prismaUnscoped.role.findUniqueOrThrow({ where: { name: role } });
  const u = await prismaUnscoped.user.create({
    data: {
      tenantId: tenant,
      username: `${PREFIX}${role}${seq}`,
      passwordHash: await hashPassword(PASSWORD),
      displayName: role,
      isActive: true,
      roles: { create: { roleId: roleRow.id } },
    },
  });
  const res = await login(u.username);
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

function review(id: string, payload: Record<string, unknown>, token = adminToken) {
  return app.inject({
    method: 'POST',
    url: `/api/users/${id}/registration`,
    headers: bearer(token),
    payload,
  });
}

async function cleanup() {
  await prismaUnscoped.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  await prismaUnscoped.tenant.deleteMany({ where: { code: TENANT_CODE } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const res = await login('admin', 'Admin@12345'); // pragma: allowlist secret
  assert.equal(res.statusCode, 200, res.body);
  adminToken = res.json().token;
  operatorRoleId = (await prismaUnscoped.role.findUniqueOrThrow({ where: { name: 'operator' } }))
    .id;
  adminRoleId = (await prismaUnscoped.role.findUniqueOrThrow({ where: { name: 'admin' } })).id;
  tenantId = (
    await prismaUnscoped.tenant.create({ data: { name: '审核注册测试租户', code: TENANT_CODE } })
  ).id;
  auditorToken = await userWithRole('auditor');
  tenantAdminToken = await userWithRole('tenant_admin', tenantId);
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('通过：启用账号、状态改为 APPROVED、绑定角色，写审计，之后能登录', async () => {
  const u = await pendingUser();
  const startedAt = new Date(Date.now() - 1000);
  const res = await review(u.id, { action: 'approve', roleIds: [operatorRoleId] });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().registrationStatus, 'APPROVED');
  assert.equal(res.json().isActive, true);

  const row = await prismaUnscoped.user.findUniqueOrThrow({
    where: { id: u.id },
    include: { roles: true },
  });
  assert.equal(row.isActive, true);
  assert.equal(row.registrationStatus, 'APPROVED');
  assert.deepEqual(
    row.roles.map((r) => r.roleId),
    [operatorRoleId],
  );
  const audit = await prismaUnscoped.auditLog.findFirst({
    where: { action: 'user.registration_approve', targetId: u.id, createdAt: { gte: startedAt } },
  });
  assert.ok(audit, '通过写审计 user.registration_approve');
  assert.equal((await login(u.username)).statusCode, 200);
});

test('通过时不选角色也可以', async () => {
  const u = await pendingUser();
  const res = await review(u.id, { action: 'approve' });
  assert.equal(res.statusCode, 200, res.body);
  const row = await prismaUnscoped.user.findUniqueOrThrow({
    where: { id: u.id },
    include: { roles: true },
  });
  assert.equal(row.isActive, true);
  assert.equal(row.roles.length, 0);
});

test('拒绝：状态改为 REJECTED，账号保持未启用，写审计', async () => {
  const u = await pendingUser();
  const startedAt = new Date(Date.now() - 1000);
  const res = await review(u.id, { action: 'reject' });
  assert.equal(res.statusCode, 200, res.body);
  const row = await prismaUnscoped.user.findUniqueOrThrow({ where: { id: u.id } });
  assert.equal(row.registrationStatus, 'REJECTED');
  assert.equal(row.isActive, false);
  const audit = await prismaUnscoped.auditLog.findFirst({
    where: { action: 'user.registration_reject', targetId: u.id, createdAt: { gte: startedAt } },
  });
  assert.ok(audit, '拒绝写审计 user.registration_reject');
  assert.equal((await login(u.username)).statusCode, 401);
});

test('通过只能从待审核或已拒绝发起，拒绝只能从待审核发起；已通过、管理员新建的返回 409', async () => {
  const approved = await pendingUser();
  assert.equal((await review(approved.id, { action: 'approve' })).statusCode, 200);
  assert.equal((await review(approved.id, { action: 'reject' })).statusCode, 409);
  assert.equal((await review(approved.id, { action: 'approve' })).statusCode, 409);

  const rejected = await pendingUser();
  assert.equal((await review(rejected.id, { action: 'reject' })).statusCode, 200);
  assert.equal((await review(rejected.id, { action: 'reject' })).statusCode, 409);

  const admin = await prismaUnscoped.user.findUniqueOrThrow({ where: { username: 'admin' } });
  assert.equal((await review(admin.id, { action: 'approve' })).statusCode, 409);
  assert.equal((await review(admin.id, { action: 'reject' })).statusCode, 409);
});

test('被拒绝的注册可以重新审核通过，角色按这次选的为准', async () => {
  const u = await pendingUser();
  assert.equal((await review(u.id, { action: 'reject' })).statusCode, 200);
  // 拒绝后被人在编辑里加过角色：重新通过时不能撞唯一键，角色以审核时选的为准。
  const auditorRoleId = (
    await prismaUnscoped.role.findUniqueOrThrow({ where: { name: 'auditor' } })
  ).id;
  await prismaUnscoped.userRole.createMany({
    data: [
      { userId: u.id, roleId: operatorRoleId },
      { userId: u.id, roleId: auditorRoleId },
    ],
  });
  const res = await review(u.id, { action: 'approve', roleIds: [operatorRoleId] });
  assert.equal(res.statusCode, 200, res.body);
  const row = await prismaUnscoped.user.findUniqueOrThrow({
    where: { id: u.id },
    include: { roles: true },
  });
  assert.equal(row.registrationStatus, 'APPROVED');
  assert.equal(row.isActive, true);
  assert.deepEqual(
    row.roles.map((r) => r.roleId),
    [operatorRoleId],
  );
  assert.equal((await login(u.username)).statusCode, 200);
});

test('拒绝时一并停用账号', async () => {
  const u = await pendingUser();
  // 模拟脏数据：待审核却已启用。拒绝后必须是未启用。
  await prismaUnscoped.user.update({ where: { id: u.id }, data: { isActive: true } });
  assert.equal((await review(u.id, { action: 'reject' })).statusCode, 200);
  const row = await prismaUnscoped.user.findUniqueOrThrow({ where: { id: u.id } });
  assert.equal(row.registrationStatus, 'REJECTED');
  assert.equal(row.isActive, false);
});

test('待审核、已拒绝的用户不能在编辑里直接启用，要走审核', async () => {
  const pending = await pendingUser();
  const rejected = await pendingUser();
  assert.equal((await review(rejected.id, { action: 'reject' })).statusCode, 200);
  for (const u of [pending, rejected]) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${u.id}`,
      headers: bearer(adminToken),
      payload: { isActive: true },
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error.code, 'REGISTRATION_REVIEW_REQUIRED');
    assert.match(res.json().error.message, /请通过审核启用/);
    const row = await prismaUnscoped.user.findUniqueOrThrow({ where: { id: u.id } });
    assert.equal(row.isActive, false);
    assert.equal((await login(u.username)).statusCode, 401);
  }
  // 改其他字段不受影响
  const rename = await app.inject({
    method: 'PATCH',
    url: `/api/users/${rejected.id}`,
    headers: bearer(adminToken),
    payload: { displayName: '改个名字', isActive: false },
  });
  assert.equal(rename.statusCode, 200, rename.body);
  assert.equal(rename.json().displayName, '改个名字');
});

test('审核通过的注册用户不须改密（密码是本人设的）', async () => {
  const u = await pendingUser();
  assert.equal(
    (await review(u.id, { action: 'approve', roleIds: [operatorRoleId] })).statusCode,
    200,
  );
  const row = await prismaUnscoped.user.findUniqueOrThrow({ where: { id: u.id } });
  assert.equal(row.mustChangePassword, false);
});

test('action 不合法返回 400', async () => {
  const u = await pendingUser();
  assert.equal((await review(u.id, { action: 'delete' })).statusCode, 400);
  assert.equal((await review(u.id, {})).statusCode, 400);
});

test('没有编辑用户权限返回 403', async () => {
  const u = await pendingUser();
  const res = await review(u.id, { action: 'approve' }, auditorToken);
  assert.equal(res.statusCode, 403, res.body);
  const row = await prismaUnscoped.user.findUniqueOrThrow({ where: { id: u.id } });
  assert.equal(row.registrationStatus, 'PENDING');
});

test('租户管理员只能审核本租户的注册，且不能分配平台管理员角色', async () => {
  const other = await pendingUser();
  assert.equal((await review(other.id, { action: 'approve' }, tenantAdminToken)).statusCode, 404);

  const own = await pendingUser(tenantId);
  const bad = await review(own.id, { action: 'approve', roleIds: [adminRoleId] }, tenantAdminToken);
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(
    (await prismaUnscoped.user.findUniqueOrThrow({ where: { id: own.id } })).registrationStatus,
    'PENDING',
  );
  const ok = await review(
    own.id,
    { action: 'approve', roleIds: [operatorRoleId] },
    tenantAdminToken,
  );
  assert.equal(ok.statusCode, 200, ok.body);
});

test('用户列表能按注册状态过滤，并返回手机号和单位', async () => {
  const u = await pendingUser();
  const res = await app.inject({
    method: 'GET',
    url: '/api/users?registrationStatus=PENDING&pageSize=200',
    headers: bearer(adminToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const items = res.json().items as Array<Record<string, unknown>>;
  assert.ok(items.length >= 1);
  assert.ok(items.every((i) => i.registrationStatus === 'PENDING'));
  const mine = items.find((i) => i.id === u.id);
  assert.ok(mine);
  assert.equal(mine.phone, '13800138000');
  assert.equal(mine.organization, '测试单位');

  const bad = await app.inject({
    method: 'GET',
    url: '/api/users?registrationStatus=WHATEVER',
    headers: bearer(adminToken),
  });
  assert.equal(bad.statusCode, 400);
});
