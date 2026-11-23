import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';

// 安全设置：密码策略、登录失败锁定、密码强制更新、超时登出。用独立测试用户，不动 admin 凭据。
const USERNAME = 'sectest_policy';
const INITIAL = 'Initial@123'; // pragma: allowlist secret

let app!: FastifyInstance;
let adminToken = '';
let userId = '';
let savedSecurity: unknown = undefined;

async function login(username: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
}

async function patchSecurity(security: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { security },
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const row = await prisma.systemSetting.findUnique({ where: { key: 'security' } });
  savedSecurity = row?.value;
  await prisma.user.deleteMany({ where: { username: USERNAME } });
  const u = await prisma.user.create({
    data: {
      username: USERNAME,
      passwordHash: await hashPassword(INITIAL),
      displayName: '安全设置测试',
      isActive: true,
    },
  });
  userId = u.id;
  adminToken = (await login('admin', 'Admin@12345')).json().token; // pragma: allowlist secret
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
  await prisma.user.deleteMany({ where: { username: USERNAME } });
  await app.close();
  await prisma.$disconnect();
});

test('安全设置可读取默认值，保存后写审计', async () => {
  const get = await app.inject({
    method: 'GET',
    url: '/api/system-settings',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(get.statusCode, 200, get.body);
  assert.equal(typeof get.json().security.passwordMinLength, 'number');

  const startedAt = new Date(Date.now() - 1000);
  const res = await patchSecurity({ maxFailedLoginAttempts: 3, lockoutMinutes: 10 });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().security.maxFailedLoginAttempts, 3);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'system_setting.update', createdAt: { gte: startedAt } },
  });
  assert.ok(audit, '保存安全设置写审计');
});

test('保存安全设置时审计只记变化字段的前后值', async () => {
  const current = (
    await app.inject({
      method: 'GET',
      url: '/api/system-settings',
      headers: { authorization: `Bearer ${adminToken}` },
    })
  ).json().security as Record<string, number>;
  const nextIdle = current.idleTimeoutMinutes === 45 ? 46 : 45;
  const startedAt = new Date(Date.now() - 1000);
  const res = await patchSecurity({
    idleTimeoutMinutes: nextIdle,
    passwordMinLength: current.passwordMinLength,
  });
  assert.equal(res.statusCode, 200, res.body);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'system_setting.update', createdAt: { gte: startedAt } },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(audit, '保存安全设置写审计');
  const detail = audit.detail as { changes?: { security?: unknown } };
  assert.deepEqual(detail.changes?.security, {
    idleTimeoutMinutes: { before: current.idleTimeoutMinutes, after: nextIdle },
  });
});

test('非法安全设置返回 400', async () => {
  const res = await patchSecurity({ passwordMinLength: 3 });
  assert.equal(res.statusCode, 400, res.body);
});

test('连续非法登录达到最大次数后锁定账户，并提示剩余锁定时间', async () => {
  assert.equal((await login(USERNAME, 'wrong-1')).statusCode, 401); // pragma: allowlist secret
  assert.equal((await login(USERNAME, 'wrong-2')).statusCode, 401); // pragma: allowlist secret
  const third = await login(USERNAME, 'wrong-3'); // pragma: allowlist secret
  assert.equal(third.statusCode, 403, third.body);
  assert.equal(third.json().error.code, 'ACCOUNT_LOCKED');
  assert.match(third.json().error.message, /剩余锁定时间/);

  const correct = await login(USERNAME, INITIAL);
  assert.equal(correct.statusCode, 403, '锁定期间正确密码也不能登录');
  assert.match(correct.json().error.message, /剩余锁定时间 (9|10) 分/);
  const locked = await prisma.auditLog.findFirst({
    where: { action: 'auth.account_locked', targetId: userId },
  });
  assert.ok(locked, '锁定写审计');
});

test('锁定到期后可正常登录，失败计数清零', async () => {
  await prisma.user.update({
    where: { id: userId },
    data: { lockedUntil: new Date(Date.now() - 1000) },
  });
  const res = await login(USERNAME, INITIAL);
  assert.equal(res.statusCode, 200, res.body);
  const u = await prisma.user.findUnique({ where: { id: userId } });
  assert.equal(u!.failedLoginCount, 0);
  assert.equal(u!.lockedUntil, null);
});

test('改密按密码长度与强度要求校验', async () => {
  const saved = await patchSecurity({
    passwordMinLength: 10,
    passwordRequireUppercase: true,
    passwordRequireDigit: true,
    passwordRequireSpecial: true,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const token = (await login(USERNAME, INITIAL)).json().token;
  const weak = await app.inject({
    method: 'POST',
    url: '/api/auth/me/password',
    headers: { authorization: `Bearer ${token}` },
    payload: { currentPassword: INITIAL, newPassword: 'abcdefghij1' }, // pragma: allowlist secret
  });
  assert.equal(weak.statusCode, 400, weak.body);
  assert.equal(weak.json().error.code, 'PASSWORD_POLICY');
  assert.match(weak.json().error.message, /大写字母/);

  const policy = await app.inject({
    method: 'GET',
    url: '/api/auth/password-policy',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(policy.statusCode, 200, policy.body);
  assert.equal(policy.json().passwordMinLength, 10);
});

test('密码超过强制更新时间后只能改密，改密后恢复访问', async () => {
  await patchSecurity({ passwordExpireDays: 1 });
  await prisma.user.update({
    where: { id: userId },
    data: { passwordChangedAt: new Date(Date.now() - 2 * 86_400_000) },
  });
  const res = await login(USERNAME, INITIAL);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().user.passwordExpired, true);
  const token = res.json().token;
  const auth = { authorization: `Bearer ${token}` };

  const blocked = await app.inject({ method: 'GET', url: '/api/eval-tasks', headers: auth });
  assert.equal(blocked.statusCode, 403, blocked.body);
  assert.equal(blocked.json().error.code, 'PASSWORD_EXPIRED');
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth })).statusCode,
    200,
  );

  const NEWPW = 'Renewed@2026x'; // pragma: allowlist secret
  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/me/password',
    headers: auth,
    payload: { currentPassword: INITIAL, newPassword: NEWPW },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth });
  assert.equal(me.json().user.passwordExpired, false);
  // 恢复初始密码，便于后续用例
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(INITIAL), passwordChangedAt: new Date() },
  });
});

test('超过超时登出时间未操作，后端拒绝会话', async () => {
  await patchSecurity({ idleTimeoutMinutes: 1, passwordExpireDays: 0 });
  const token = (await login(USERNAME, INITIAL)).json().token;
  const auth = { authorization: `Bearer ${token}` };
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth })).statusCode,
    200,
  );
  await prisma.user.update({
    where: { id: userId },
    data: { lastActiveAt: new Date(Date.now() - 5 * 60_000) },
  });
  const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth });
  assert.equal(res.statusCode, 401, res.body);
  assert.equal(res.json().error.code, 'SESSION_IDLE_TIMEOUT');
});
