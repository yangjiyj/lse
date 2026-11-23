import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { hashPassword, verifyPassword } from '../src/lib/password.js';

// 自助改密：用独立测试用户，避免污染 admin 共享凭据（其它测试文件依赖 Admin@12345）。
const USERNAME = 'pwtest_selfservice';
const INITIAL = 'Initial@123'; // pragma: allowlist secret

let app!: FastifyInstance;
let userId = '';

async function login(username: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
}

async function changePassword(token: string | null, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/me/password',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload,
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await prisma.user.deleteMany({ where: { username: USERNAME } });
  const u = await prisma.user.create({
    data: {
      username: USERNAME,
      passwordHash: await hashPassword(INITIAL),
      displayName: '改密自助测试',
      isActive: true,
    },
  });
  userId = u.id;
});

after(async () => {
  await prisma.user.deleteMany({ where: { username: USERNAME } });
  await app.close();
  await prisma.$disconnect();
});

test('未登录改密返回 401', async () => {
  const res = await changePassword(null, {
    currentPassword: INITIAL,
    newPassword: 'New@12345', // pragma: allowlist secret
  });
  assert.equal(res.statusCode, 401, res.body);
});

test('当前密码错误返回 401 + INVALID_CURRENT_PASSWORD', async () => {
  const token = (await login(USERNAME, INITIAL)).json().token;
  const res = await changePassword(token, {
    currentPassword: 'wrong-password', // pragma: allowlist secret
    newPassword: 'New@12345', // pragma: allowlist secret
  });
  assert.equal(res.statusCode, 401, res.body);
  assert.equal(res.json().error.code, 'INVALID_CURRENT_PASSWORD');
});

test('新密码过短返回 400', async () => {
  const token = (await login(USERNAME, INITIAL)).json().token;
  const res = await changePassword(token, {
    currentPassword: INITIAL,
    newPassword: 'short', // pragma: allowlist secret
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('新密码与当前密码相同返回 400 + SAME_PASSWORD', async () => {
  const token = (await login(USERNAME, INITIAL)).json().token;
  const res = await changePassword(token, {
    currentPassword: INITIAL,
    newPassword: INITIAL,
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'SAME_PASSWORD');
});

test('改密成功后旧密码失效、新密码可登录、DB 哈希已更新', async () => {
  const token = (await login(USERNAME, INITIAL)).json().token;
  const NEWPW = 'Changed@456'; // pragma: allowlist secret
  const res = await changePassword(token, {
    currentPassword: INITIAL,
    newPassword: NEWPW,
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().ok, true);

  // 旧密码不再可登录
  assert.equal((await login(USERNAME, INITIAL)).statusCode, 401);
  // 新密码可登录
  assert.equal((await login(USERNAME, NEWPW)).statusCode, 200);
  // DB 哈希确实换成新密码
  const u = await prisma.user.findUnique({ where: { id: userId } });
  assert.equal(await verifyPassword(u!.passwordHash, NEWPW), true);
});
