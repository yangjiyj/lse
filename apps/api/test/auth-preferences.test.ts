import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';

const USERNAME = 'pref_test_user';
const PASSWORD = 'Pref@12345';

let app!: FastifyInstance;
let token = '';

async function login() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: USERNAME, password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

function bearer() {
  return { authorization: `Bearer ${token}` };
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await prisma.user.deleteMany({ where: { username: USERNAME } });
  await prisma.user.create({
    data: {
      username: USERNAME,
      passwordHash: await hashPassword(PASSWORD),
      displayName: '偏好测试',
      isActive: true,
    },
  });
  token = await login();
});

after(async () => {
  await prisma.user.deleteMany({ where: { username: USERNAME } });
  await app.close();
  await prisma.$disconnect();
});

test('PATCH /api/auth/me/preferences 写入 viewMode 并回读（任务 3）', async () => {
  const patch = await app.inject({
    method: 'PATCH',
    url: '/api/auth/me/preferences',
    headers: bearer(),
    payload: { viewMode: 'demo' },
  });
  assert.equal(patch.statusCode, 200, patch.body);

  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer() });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.preferences.viewMode, 'demo');
});

test('PATCH /api/auth/me/preferences 拒绝非法 viewMode（任务 3）', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/auth/me/preferences',
    headers: bearer(),
    payload: { viewMode: 'invalid' },
  });
  assert.equal(res.statusCode, 400);
});
