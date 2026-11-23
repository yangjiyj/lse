import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';

// 2.9.2 角色下的用户名单：GET /api/roles/:id/users，租户范围与角色列表一致。

const P = 'w2roleusers-';
const PW = ['Role', 'Users', '@', '2026'].join(''); // pragma: allowlist secret

let app!: FastifyInstance;
let adminJwt = '';
let tenantAdminJwt = '';
let operatorJwt = '';
let tenantId = '';
let operatorRoleId = '';
let adminRoleId = '';

const h = (jwt: string, tenant?: string) => ({
  authorization: `Bearer ${jwt}`,
  ...(tenant ? { 'x-lse-tenant': tenant } : {}),
});

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token;
}

async function cleanup(): Promise<void> {
  const tenants = await prisma.tenant.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  await prisma.auditLog.deleteMany({ where: { actorName: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: P } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: P } } });
  if (ids.length) await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
}

async function createUser(
  username: string,
  roleName: string,
  options: { tenantId?: string; isActive?: boolean } = {},
): Promise<void> {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.user.create({
    data: {
      username,
      displayName: `${username}-名`,
      passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
      isActive: options.isActive ?? true,
      ...(options.tenantId ? { tenantId: options.tenantId } : {}),
      roles: { create: { roleId: role.id } },
    },
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  operatorRoleId = (await prisma.role.findUniqueOrThrow({ where: { name: 'operator' } })).id;
  adminRoleId = (await prisma.role.findUniqueOrThrow({ where: { name: 'admin' } })).id;
  const tenant = await prisma.tenant.create({ data: { name: `${P}租户`, code: `${P}t1` } });
  tenantId = tenant.id;

  await createUser(`${P}platform-op`, 'operator');
  await createUser(`${P}platform-op-off`, 'operator', { isActive: false });
  await createUser(`${P}tenant-op`, 'operator', { tenantId });
  await createUser(`${P}tenant-admin`, 'tenant_admin', { tenantId });

  adminJwt = await login('admin', ['Admin', '@', '12345'].join(''));
  tenantAdminJwt = await login(`${P}tenant-admin`, PW);
  operatorJwt = await login(`${P}platform-op`, PW);
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

type RoleUser = {
  id: string;
  username: string;
  displayName: string;
  tenantName: string;
  isActive: boolean;
};

const mine = (items: RoleUser[]) => items.filter((u) => u.username.startsWith(P));

test('未登录返回 401', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/roles/${operatorRoleId}/users` });
  assert.equal(res.statusCode, 401);
});

test('没有 role:read 返回 403', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/roles/${operatorRoleId}/users`,
    headers: h(operatorJwt),
  });
  assert.equal(res.statusCode, 403, res.body);
});

test('平台管理员看平台租户里该角色的用户，字段齐全', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/roles/${operatorRoleId}/users`,
    headers: h(adminJwt),
  });
  assert.equal(res.statusCode, 200, res.body);
  const items = mine(res.json().items as RoleUser[]);
  assert.deepEqual(items.map((u) => u.username).sort(), [`${P}platform-op`, `${P}platform-op-off`]);
  const off = items.find((u) => u.username === `${P}platform-op-off`)!;
  assert.deepEqual(Object.keys(off).sort(), [
    'displayName',
    'id',
    'isActive',
    'tenantName',
    'username',
  ]);
  assert.equal(off.isActive, false);
  assert.equal(off.displayName, `${P}platform-op-off-名`);
  const platform = await prisma.tenant.findUniqueOrThrow({ where: { id: PLATFORM_TENANT_ID } });
  assert.equal(off.tenantName, platform.name);
});

test('名单人数与角色列表的用户数一致', async () => {
  const list = await app.inject({ method: 'GET', url: '/api/roles', headers: h(adminJwt) });
  const role = (list.json().items as Array<{ id: string; userCount: number }>).find(
    (r) => r.id === operatorRoleId,
  )!;
  const res = await app.inject({
    method: 'GET',
    url: `/api/roles/${operatorRoleId}/users`,
    headers: h(adminJwt),
  });
  assert.equal(res.json().items.length, role.userCount);
});

test('全部租户视角看全平台该角色的用户', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/roles/${operatorRoleId}/users`,
    headers: h(adminJwt, 'all'),
  });
  assert.equal(res.statusCode, 200, res.body);
  const items = mine(res.json().items as RoleUser[]);
  const tenantOp = items.find((u) => u.username === `${P}tenant-op`);
  assert.ok(tenantOp);
  assert.equal(tenantOp.tenantName, `${P}租户`);
  assert.equal(items.length, 3);
});

test('租户管理员只看到本租户的用户', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/roles/${operatorRoleId}/users`,
    headers: h(tenantAdminJwt),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    (res.json().items as RoleUser[]).map((u) => u.username),
    [`${P}tenant-op`],
  );
});

test('租户管理员看不到平台管理员角色的名单', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/roles/${adminRoleId}/users`,
    headers: h(tenantAdminJwt),
  });
  assert.equal(res.statusCode, 404, res.body);
});

test('角色不存在返回 404，ID 非法返回 400', async () => {
  const missing = await app.inject({
    method: 'GET',
    url: '/api/roles/00000000-0000-4000-8000-00000000ffff/users',
    headers: h(adminJwt),
  });
  assert.equal(missing.statusCode, 404, missing.body);
  const bad = await app.inject({
    method: 'GET',
    url: '/api/roles/not-a-uuid/users',
    headers: h(adminJwt),
  });
  assert.equal(bad.statusCode, 400, bad.body);
});

test('名单最多返回 500 人，超出时带 truncated: true', async () => {
  const role = await prisma.role.create({ data: { name: `${P}bulk` } });
  await prisma.user.createMany({
    data: Array.from({ length: 501 }, (_, i) => ({
      username: `${P}bulk-${String(i).padStart(3, '0')}`,
      displayName: `批量${i}`,
      passwordHash: '!',
    })),
  });
  const users = await prisma.user.findMany({
    where: { username: { startsWith: `${P}bulk-` } },
    select: { id: true },
  });
  await prisma.userRole.createMany({
    data: users.map((u) => ({ userId: u.id, roleId: role.id })),
  });

  const res = await app.inject({
    method: 'GET',
    url: `/api/roles/${role.id}/users`,
    headers: h(adminJwt),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { items: RoleUser[]; truncated: boolean };
  assert.equal(body.items.length, 500);
  assert.equal(body.truncated, true);
  assert.equal(body.items[0]!.username, `${P}bulk-000`);

  const normal = await app.inject({
    method: 'GET',
    url: `/api/roles/${operatorRoleId}/users`,
    headers: h(adminJwt),
  });
  assert.equal(normal.json().truncated, false);
});
