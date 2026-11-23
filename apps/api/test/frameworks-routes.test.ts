import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';


test('框架目录路由需要任务读取权限', async () => {
  const app = await buildApp();
  await app.ready();
  const anon = await app.inject({ method: 'GET', url: '/api/frameworks/catalog' });
  assert.equal(anon.statusCode, 401);
  await app.close();
  await prisma.$disconnect();
});
