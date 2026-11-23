import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIONS } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';

before(async () => {
  app = await buildApp();
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: ['Admin', '@', '12345'].join('') },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
});

after(async () => {
  await app.close();
});

const auth = () => ({ authorization: `Bearer ${token}` });

test('权限目录包含二期新增权限', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/permissions', headers: auth() });
  assert.equal(res.statusCode, 200, res.body);

  const body = res.json();
  assert.equal(body.all.length, PERMISSIONS.length);
  const codes = body.all.map((p: { code: string }) => p.code);
  assert.ok(codes.includes('generator:llm'));
  assert.ok(codes.includes('engine:scan'));
  assert.ok(codes.includes('report:generate'));
  assert.ok(codes.includes('service_assurance:read'));
  assert.ok(codes.includes('service_assurance:scan'));
  assert.ok(codes.includes('service_assurance:verify'));
  assert.ok(codes.includes('service_assurance:review'));
});

test('auditor 不包含二期写权限', async () => {
  const role = await prisma.role.findUnique({
    where: { name: 'auditor' },
    include: { permissions: { include: { permission: true } } },
  });
  assert.ok(role);
  const codes = new Set(role.permissions.map((p) => p.permission.code));
  assert.equal(codes.has('generator:llm'), false);
  assert.equal(codes.has('engine:scan'), false);
  assert.equal(codes.has('report:generate'), false);
  assert.equal(codes.has('service_assurance:read'), true);
  assert.equal(codes.has('service_assurance:scan'), false);
  assert.equal(codes.has('service_assurance:verify'), false);
  assert.equal(codes.has('service_assurance:review'), false);
});
