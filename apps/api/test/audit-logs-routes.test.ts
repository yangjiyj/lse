import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = '__audit_logs_test_';
const AUDITOR_USERNAME = `${PREFIX}auditor`;
const OPERATOR_USERNAME = `${PREFIX}operator`;
const AUDITOR_PASSWORD = ['Audit', 'Log', '123'].join('!');
const OPERATOR_PASSWORD = ['Operator', 'No', 'Perm', '123'].join('!');
const TEST_ACTION = `${PREFIX}action`;

let app: Awaited<ReturnType<typeof buildApp>>;
let auditorToken = '';
let operatorToken = '';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function createLog(
  overrides: Partial<{
    action: string;
    actorName: string;
    targetType: string;
    createdAt: Date;
  }> = {},
): Promise<string> {
  const row = await prisma.auditLog.create({
    data: {
      action: overrides.action ?? TEST_ACTION,
      actorName: overrides.actorName ?? `${PREFIX}user`,
      targetType: overrides.targetType ?? 'system_setting',
      detail: { hint: PREFIX },
    },
  });
  return row.id;
}

async function cleanup(): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: { OR: [{ action: { startsWith: PREFIX } }, { actorName: { startsWith: PREFIX } }] },
  });
  await prisma.user.deleteMany({
    where: { username: { in: [AUDITOR_USERNAME, OPERATOR_USERNAME] } },
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();

  const auditorRole = await prisma.role.findUniqueOrThrow({ where: { name: 'auditor' } });
  const operatorRole = await prisma.role.findUniqueOrThrow({ where: { name: 'operator' } });

  for (const [username, roleId] of [
    [AUDITOR_USERNAME, auditorRole.id],
    [OPERATOR_USERNAME, operatorRole.id],
  ] as const) {
    await prisma.user.create({
      data: {
        username,
        passwordHash: await argon2.hash(
          username === AUDITOR_USERNAME ? AUDITOR_PASSWORD : OPERATOR_PASSWORD,
          { type: argon2.argon2id },
        ),
        displayName: username,
        isActive: true,
        roles: { create: { roleId } },
      },
    });
  }

  const auditorLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: AUDITOR_USERNAME, password: AUDITOR_PASSWORD },
  });
  assert.equal(auditorLogin.statusCode, 200, auditorLogin.body);
  auditorToken = auditorLogin.json().token;

  const operatorLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: OPERATOR_USERNAME, password: OPERATOR_PASSWORD },
  });
  assert.equal(operatorLogin.statusCode, 200, operatorLogin.body);
  operatorToken = operatorLogin.json().token;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('未认证返回 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/audit-logs' });
  assert.equal(res.statusCode, 401);
});

test('auditor（有 audit_log:read）可以读取列表', async () => {
  const id = await createLog({ actorName: `${PREFIX}list_one` });
  const res = await app.inject({
    method: 'GET',
    url: '/api/audit-logs',
    headers: bearer(auditorToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.page, 1);
  assert.equal(body.pageSize, 20);
  assert.ok(body.total >= 1);
  assert.ok(body.items.some((it: { id: string }) => it.id === id));
});

test('无权限的 operator 返回 403', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/audit-logs',
    headers: bearer(operatorToken),
  });
  assert.equal(res.statusCode, 403);
});

test('分页参数 page/pageSize 生效', async () => {
  for (let i = 0; i < 3; i++) {
    await createLog({ actorName: `${PREFIX}page_${i}` });
  }
  const res = await app.inject({
    method: 'GET',
    url: '/api/audit-logs?page=1&pageSize=2',
    headers: bearer(auditorToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.pageSize, 2);
  assert.equal(body.items.length, 2);

  const res2 = await app.inject({
    method: 'GET',
    url: `/api/audit-logs?page=2&pageSize=2&action=${encodeURIComponent(TEST_ACTION)}`,
    headers: bearer(auditorToken),
  });
  assert.equal(res2.statusCode, 200, res2.body);
  assert.equal(res2.json().page, 2);
});

test('action 精确筛选生效', async () => {
  await createLog({ action: `${PREFIX}other_action` });
  const res = await app.inject({
    method: 'GET',
    url: `/api/audit-logs?action=${encodeURIComponent(`${PREFIX}other_action`)}`,
    headers: bearer(auditorToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(body.items.length >= 1);
  for (const it of body.items) {
    assert.equal(it.action, `${PREFIX}other_action`);
  }
});

test('actorName 模糊筛选生效', async () => {
  await createLog({ actorName: `${PREFIX}alice_unique` });
  const res = await app.inject({
    method: 'GET',
    url: `/api/audit-logs?actorName=${encodeURIComponent('alice_unique')}`,
    headers: bearer(auditorToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(
    body.items.some((it: { actorName: string }) => it.actorName === `${PREFIX}alice_unique`),
  );
});

test('targetType 精确筛选生效', async () => {
  await createLog({ targetType: `${PREFIX}custom_target` });
  const res = await app.inject({
    method: 'GET',
    url: `/api/audit-logs?targetType=${encodeURIComponent(`${PREFIX}custom_target`)}`,
    headers: bearer(auditorToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(body.items.length >= 1);
  for (const it of body.items) {
    assert.equal(it.targetType, `${PREFIX}custom_target`);
  }
});

test('start/end 时间范围筛选生效', async () => {
  const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await createLog({});
  const res = await app.inject({
    method: 'GET',
    url: `/api/audit-logs?action=${encodeURIComponent(TEST_ACTION)}&start=${past.toISOString()}&end=${future.toISOString()}`,
    headers: bearer(auditorToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(body.total >= 1);
  for (const it of body.items) {
    const t = new Date(it.createdAt).getTime();
    assert.ok(t >= past.getTime() && t <= future.getTime());
  }

  const empty = await app.inject({
    method: 'GET',
    url: `/api/audit-logs?action=${encodeURIComponent(TEST_ACTION)}&start=${new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()}`,
    headers: bearer(auditorToken),
  });
  assert.equal(empty.statusCode, 200, empty.body);
  assert.equal(empty.json().total, 0);
});

test('单条详情：找得到', async () => {
  const id = await createLog({ actorName: `${PREFIX}detail` });
  const res = await app.inject({
    method: 'GET',
    url: `/api/audit-logs/${id}`,
    headers: bearer(auditorToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().id, id);
});

test('单条详情：找不到返回 404', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/audit-logs/00000000-0000-0000-0000-000000000000',
    headers: bearer(auditorToken),
  });
  assert.equal(res.statusCode, 404);
});
