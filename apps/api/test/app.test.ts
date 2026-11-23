import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { PERMISSIONS } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

let app!: FastifyInstance;
let token = '';

before(async () => {
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test('GET /api/health is open', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
});

test('login with seeded admin succeeds', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(body.token);
  assert.equal(body.user.username, 'admin');
  assert.ok(body.user.permissions.length >= 35);
  token = body.token;
});

test('login with wrong password is 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'nope' }, // pragma: allowlist secret
  });
  assert.equal(res.statusCode, 401);
});

test('GET /api/auth/me without token is 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
  assert.equal(res.statusCode, 401);
});

test('GET /api/auth/me with token returns current user', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().user.username, 'admin');
});

test('admin can list users', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/users',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().items));
  assert.ok(res.json().total >= 1);
});

test('permission catalog returns grouped entries', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/permissions',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().groups.length > 0);
  assert.equal(res.json().all.length, PERMISSIONS.length);
});

test('roles list only exposes customer-facing builtin roles', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/roles',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const names = res.json().items.map((r: { name: string }) => r.name);
  assert.deepEqual(names, ['admin', 'operator', 'auditor', 'tenant_admin']);
  assert.equal(names.includes('super_admin'), false);
});

test('license status endpoint omits binding fingerprints; diagnostic endpoint reports fingerprint', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/license',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().fingerprint, undefined);
  assert.equal(res.json().fingerprints, undefined);

  const diagnostic = await app.inject({
    method: 'GET',
    url: '/api/license/fingerprint',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(diagnostic.statusCode, 200);
  assert.match(diagnostic.json().fingerprint, /^[0-9a-f]{64}$/);
});

// 回归测试：Fastify v5 错误处理器封装问题
// 若 setErrorHandler 在路由 register 之后注册，封装子上下文不会继承它，
// ZodError 会回退到默认处理器返回 500（而非 400），且错误体为扁平默认结构。
// 本组测试锁定 ZodError→400 自定义结构 + 404 自定义结构，防止注册顺序回退。
test('empty login body returns 400 VALIDATION_ERROR (error-handler regression)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {},
  });
  assert.equal(res.statusCode, 400, res.body);
  const body = res.json();
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.message, '参数校验失败');
  assert.ok(Array.isArray(body.error.issues));
  assert.ok(body.error.issues.length >= 1);
});

test('unknown route returns custom 404 NOT_FOUND shape', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/__no_such_route__' });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().error.code, 'NOT_FOUND');
});
