import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { parseStoredSecurity } from '../src/lib/security-policy.js';

// 2.9.8 首次登录强制改密：管理员新建、管理员重置、新建租户的首个管理员登录后须先改密；
// 自助注册的用户密码是本人设的，审核通过后不须改密。
const PREFIX = 'w1pwd_';
const INITIAL = 'Initial@123'; // pragma: allowlist secret
const CHANGED = 'Changed@456'; // pragma: allowlist secret

let app!: FastifyInstance;
let adminToken = '';
let operatorRoleId = '';
let savedSecurity: unknown = undefined;
let seq = 0;

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

function login(username: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
}

async function patchSecurity(security: Record<string, unknown>) {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: bearer(adminToken),
    payload: { security },
  });
  assert.equal(res.statusCode, 200, res.body);
}

/** 管理员通过用户管理新建一个评估操作员。 */
async function adminCreatesUser(): Promise<{ id: string; username: string }> {
  seq += 1;
  const username = `${PREFIX}u${seq}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: bearer(adminToken),
    payload: { username, password: INITIAL, displayName: '改密测试', roleIds: [operatorRoleId] },
  });
  assert.equal(res.statusCode, 201, res.body);
  return { id: res.json().id, username };
}

function get(url: string, token: string) {
  return app.inject({ method: 'GET', url, headers: bearer(token) });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const row = await prisma.systemSetting.findUnique({ where: { key: 'security' } });
  savedSecurity = row?.value;
  await prismaUnscoped.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  const res = await login('admin', 'Admin@12345'); // pragma: allowlist secret
  assert.equal(res.statusCode, 200, res.body);
  adminToken = res.json().token;
  operatorRoleId = (await prismaUnscoped.role.findUniqueOrThrow({ where: { name: 'operator' } }))
    .id;
  await patchSecurity({ forcePasswordChangeOnFirstLogin: true });
});

after(async () => {
  if (savedSecurity === undefined) {
    await prisma.systemSetting.deleteMany({ where: { key: 'security' } });
  } else {
    await prisma.systemSetting.update({
      where: { key: 'security' },
      data: { value: savedSecurity as object },
    });
  }
  await prismaUnscoped.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

test('首次登录强制改密默认开启', () => {
  assert.equal(parseStoredSecurity({}).forcePasswordChangeOnFirstLogin, true);
});

test('存量用户不须改密', async () => {
  const res = await login('admin', 'Admin@12345'); // pragma: allowlist secret
  assert.equal(res.json().user.passwordChangeRequired, false);
  assert.equal((await get('/api/model-targets', res.json().token)).statusCode, 200);
});

test('管理员新建的用户登录后须改密：只放行查看自己、改密、登出、密码策略', async () => {
  const u = await adminCreatesUser();
  const res = await login(u.username, INITIAL);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().user.passwordChangeRequired, true);
  const token = res.json().token as string;

  const me = await get('/api/auth/me', token);
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().user.passwordChangeRequired, true);
  assert.equal((await get('/api/auth/password-policy', token)).statusCode, 200);

  for (const url of ['/api/model-targets', '/api/eval-tasks', '/api/dashboard/overview']) {
    const blocked = await get(url, token);
    assert.equal(blocked.statusCode, 403, `${url}: ${blocked.body}`);
    assert.equal(blocked.json().error.code, 'PASSWORD_CHANGE_REQUIRED');
  }
  const prefs = await app.inject({
    method: 'PATCH',
    url: '/api/auth/me/preferences',
    headers: bearer(token),
    payload: { viewMode: 'demo' },
  });
  assert.equal(prefs.statusCode, 403, prefs.body);

  const logout = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: bearer(token),
  });
  assert.equal(logout.statusCode, 200, logout.body);
});

test('自己改完密码后标记清除，接口恢复正常', async () => {
  const u = await adminCreatesUser();
  const token = (await login(u.username, INITIAL)).json().token as string;
  const change = await app.inject({
    method: 'POST',
    url: '/api/auth/me/password',
    headers: bearer(token),
    payload: { currentPassword: INITIAL, newPassword: CHANGED },
  });
  assert.equal(change.statusCode, 200, change.body);

  const me = await get('/api/auth/me', token);
  assert.equal(me.json().user.passwordChangeRequired, false);
  assert.equal((await get('/api/model-targets', token)).statusCode, 200);
  const again = await login(u.username, CHANGED);
  assert.equal(again.json().user.passwordChangeRequired, false);
});

test('管理员重置密码后须改密', async () => {
  seq += 1;
  const username = `${PREFIX}reset${seq}`;
  const roleRow = await prismaUnscoped.role.findUniqueOrThrow({ where: { name: 'operator' } });
  const u = await prismaUnscoped.user.create({
    data: {
      username,
      passwordHash: await hashPassword(INITIAL),
      displayName: '重置测试',
      roles: { create: { roleId: roleRow.id } },
    },
  });
  assert.equal((await login(username, INITIAL)).json().user.passwordChangeRequired, false);

  const reset = await app.inject({
    method: 'POST',
    url: `/api/users/${u.id}/reset-password`,
    headers: bearer(adminToken),
    payload: { password: CHANGED },
  });
  assert.equal(reset.statusCode, 200, reset.body);
  const res = await login(username, CHANGED);
  assert.equal(res.json().user.passwordChangeRequired, true);
  assert.equal((await get('/api/model-targets', res.json().token)).statusCode, 403);
});

test('审核通过的注册用户登录后不须改密', async () => {
  seq += 1;
  const username = `${PREFIX}reg${seq}`;
  const u = await prismaUnscoped.user.create({
    data: {
      username,
      passwordHash: await hashPassword(INITIAL),
      displayName: '注册测试',
      phone: '13800138000',
      organization: '测试单位',
      isActive: false,
      registrationStatus: 'PENDING',
    },
  });
  const approve = await app.inject({
    method: 'POST',
    url: `/api/users/${u.id}/registration`,
    headers: bearer(adminToken),
    payload: { action: 'approve', roleIds: [operatorRoleId] },
  });
  assert.equal(approve.statusCode, 200, approve.body);
  const res = await login(username, INITIAL);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().user.passwordChangeRequired, false);
  assert.equal((await get('/api/model-targets', res.json().token)).statusCode, 200);
});

test('新建租户的首个管理员登录后须改密，改完恢复正常', async () => {
  seq += 1;
  const username = `${PREFIX}tadmin${seq}`;
  const created = await app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: bearer(adminToken),
    payload: { name: `${PREFIX}租户${seq}`, admin: { username, password: INITIAL } },
  });
  assert.equal(created.statusCode, 201, created.body);
  const tenantId = created.json().id as string;
  try {
    const res = await login(username, INITIAL);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().user.passwordChangeRequired, true);
    const token = res.json().token as string;
    const blocked = await get('/api/model-targets', token);
    assert.equal(blocked.statusCode, 403, blocked.body);
    assert.equal(blocked.json().error.code, 'PASSWORD_CHANGE_REQUIRED');

    const change = await app.inject({
      method: 'POST',
      url: '/api/auth/me/password',
      headers: bearer(token),
      payload: { currentPassword: INITIAL, newPassword: CHANGED },
    });
    assert.equal(change.statusCode, 200, change.body);
    assert.equal((await get('/api/model-targets', token)).statusCode, 200);
  } finally {
    await prismaUnscoped.auditLog.deleteMany({ where: { tenantId } });
    await prismaUnscoped.user.deleteMany({ where: { tenantId } });
    await prismaUnscoped.tenant.delete({ where: { id: tenantId } });
  }
});

test('策略关闭时不拦截', async () => {
  const u = await adminCreatesUser();
  await patchSecurity({ forcePasswordChangeOnFirstLogin: false });
  try {
    const res = await login(u.username, INITIAL);
    assert.equal(res.json().user.passwordChangeRequired, false);
    const token = res.json().token as string;
    assert.equal((await get('/api/auth/me', token)).json().user.passwordChangeRequired, false);
    assert.equal((await get('/api/model-targets', token)).statusCode, 200);
  } finally {
    await patchSecurity({ forcePasswordChangeOnFirstLogin: true });
  }
});
