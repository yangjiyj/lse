import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../db.js';
import { CHECK_CATALOG } from './check-catalog.js';

// 使用本车道独立测试库；沙箱内不运行此文件。
let app: FastifyInstance | undefined;
const userIds: string[] = [];
let readerJwt = '';
let nobodyJwt = '';
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
const previousEnabled = process.env.FLEET_AGENT_ENABLED;

before(async () => {
  process.env.FLEET_AGENT_ENABLED = 'true';
  app = await buildApp();
  await app.ready();
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'auditor' } });
  const passwordHash = await argon2.hash(randomUUID(), { type: argon2.argon2id });
  for (const reader of [true, false]) {
    const user = await prisma.user.create({
      data: {
        username: `__t3_catalog_${randomUUID()}`,
        displayName: '检测目录接口测试',
        passwordHash,
        passwordChangedAt: new Date(),
        lastActiveAt: new Date(),
        isActive: true,
        ...(reader ? { roles: { create: { roleId: role.id } } } : {}),
      },
    });
    userIds.push(user.id);
    const token = app.jwt.sign({ sub: user.id, username: user.username });
    if (reader) readerJwt = token;
    else nobodyJwt = token;
  }
});

after(async () => {
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app?.close();
  await prisma.$disconnect();
  if (previousEnabled === undefined) delete process.env.FLEET_AGENT_ENABLED;
  else process.env.FLEET_AGENT_ENABLED = previousEnabled;
});

test('目录接口沿用终端开关、登录认证与读取权限', async () => {
  assert.ok(app);
  const url = '/api/fleet/check-catalog';
  process.env.FLEET_AGENT_ENABLED = 'false';
  assert.equal((await app.inject({ url, headers: headers(readerJwt) })).statusCode, 404);
  process.env.FLEET_AGENT_ENABLED = 'true';
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: headers(nobodyJwt) })).statusCode, 403);
  const response = await app.inject({ url, headers: headers(readerJwt) });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), CHECK_CATALOG);
  assert.deepEqual(Object.keys(response.json()).sort(), [
    'categories',
    'live',
    'liveRiskTypes',
    'liveSummary',
    'posture',
  ]);
});
