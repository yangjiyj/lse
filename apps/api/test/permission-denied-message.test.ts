import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

// 403 提示面向最终用户：不在 message 里暴露英文权限码，权限码只放在 details.required。
const PREFIX = `__perm_denied_${randomUUID().slice(0, 8)}_`;
let app!: FastifyInstance;
let token = '';
let userId = '';
let roleId = '';

before(async () => {
  app = await buildApp();
  await app.ready();
  await prisma.permission.upsert({
    where: { code: 'remediation:read' },
    create: { code: 'remediation:read', name: 'remediation:read', group: '测试' },
    update: {},
  });
  const role = await prisma.role.create({
    data: {
      name: `${PREFIX}role`,
      permissions: { create: { permission: { connect: { code: 'remediation:read' } } } },
    },
  });
  roleId = role.id;
  const user = await prisma.user.create({
    data: {
      username: `${PREFIX}user`,
      passwordHash: 'test-only',
      displayName: '只读测试',
      roles: { create: { roleId } },
    },
  });
  userId = user.id;
  token = app.jwt.sign({ sub: user.id, username: user.username });
});

after(async () => {
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.role.deleteMany({ where: { id: roleId } });
  await app.close();
  await prisma.$disconnect();
});

test('缺少写权限返回 403，message 为中文友好提示且不含权限码', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/policy-suggestions/generate',
    headers: { authorization: `Bearer ${token}` },
    payload: { taskId: randomUUID() },
  });
  assert.equal(res.statusCode, 403, res.body);
  const err = res.json().error;
  assert.equal(err.code, 'FORBIDDEN');
  assert.equal(err.message, '当前账号无此操作权限');
  assert.ok(!err.message.includes('remediation'), err.message);
  assert.deepEqual(err.details, { required: ['remediation:update'] });
});

test('多权限码（OR）的 403 同样只返回中文提示', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  });
  assert.equal(res.statusCode, 403, res.body);
  assert.ok(!/[a-z_]+:[a-z_]+/.test(res.json().error.message), res.json().error.message);
});
