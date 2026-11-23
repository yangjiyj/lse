import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { buildReadinessRow } from '../src/modules/dashboard/readiness.js';
import { targetConnectionState } from '../src/modules/dashboard/connection.js';

// 态势概览「接入异常」统一口径：按不重复评估对象计数，启用中且最近一次连通测试失败；
// 未做连通测试为「待测试」，不计入异常。/dashboard/todos 与 /dashboard/overview 必须一致。
const PREFIX = `__dash_conn_${randomUUID().slice(0, 8)}_`;
let app!: FastifyInstance;
let token = '';
let readerToken = '';
let failedId = '';
let untestedId = '';
let inactiveId = '';
const userIds: string[] = [];
const roleIds: string[] = [];

async function makeUser(label: string, codes: string[]) {
  for (const code of codes) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, name: code, group: '测试' },
      update: {},
    });
  }
  const role = await prisma.role.create({
    data: {
      name: `${PREFIX}${label}`,
      permissions: { create: codes.map((code) => ({ permission: { connect: { code } } })) },
    },
  });
  roleIds.push(role.id);
  const user = await prisma.user.create({
    data: {
      username: `${PREFIX}${label}`,
      passwordHash: 'test-only',
      displayName: label,
      roles: { create: { roleId: role.id } },
    },
  });
  userIds.push(user.id);
  return app.jwt.sign({ sub: user.id, username: user.username });
}

async function makeTarget(
  suffix: string,
  data: { isActive: boolean; lastTestStatus: string | null },
) {
  const t = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}${suffix}`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-only',
      model: 'test-model',
      ...data,
    },
  });
  return t.id;
}

before(async () => {
  app = await buildApp();
  await app.ready();
  token = await makeUser('full', ['eval_task:read', 'model_target:read']);
  readerToken = await makeUser('tasks_only', ['eval_task:read']);
  failedId = await makeTarget('failed', { isActive: true, lastTestStatus: 'ERROR' });
  untestedId = await makeTarget('untested', { isActive: true, lastTestStatus: null });
  inactiveId = await makeTarget('inactive', { isActive: false, lastTestStatus: 'ERROR' });
  // 同一个失败对象挂 3 个近期任务：异常数不得按任务重复计数
  for (let i = 0; i < 3; i += 1) {
    await prisma.evalTask.create({
      data: {
        name: `${PREFIX}failed_task_${i}`,
        modelTargetId: failedId,
        engines: [],
        dimensions: [],
        status: 'PENDING',
      },
    });
  }
  await prisma.evalTask.create({
    data: {
      name: `${PREFIX}untested_task`,
      modelTargetId: untestedId,
      engines: [],
      dimensions: [],
      status: 'PENDING',
    },
  });
});

after(async () => {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
  await app.close();
  await prisma.$disconnect();
});

const get = (url: string, jwt: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${jwt}` } });

test('targetConnectionState：未测试为待测试，失败仅限启用中对象', () => {
  assert.equal(targetConnectionState({ isActive: true, lastTestStatus: 'SUCCESS' }), 'ok');
  assert.equal(targetConnectionState({ isActive: true, lastTestStatus: 'ERROR' }), 'failed');
  assert.equal(targetConnectionState({ isActive: true, lastTestStatus: null }), 'untested');
  assert.equal(targetConnectionState({ isActive: false, lastTestStatus: 'ERROR' }), 'inactive');
});

test('就绪表：未做连通测试不再计为需关注/异常', () => {
  const row = buildReadinessRow({
    id: 't',
    name: 'n',
    status: 'PENDING',
    startedAt: null,
    totalQuestions: 0,
    questionSetCount: 0,
    reportCount: 0,
    findingCount: 0,
    pendingReviewCount: 0,
    modelTargetId: 'mt',
    modelTarget: { name: 'm', isActive: true, lastTestStatus: null },
  });
  assert.equal(row.stages[0]!.state, 'pending');
  assert.equal(row.stages[0]!.detail, '未做连通测试');
  assert.equal(row.modelTargetId, 'mt');
  assert.equal(row.connectionState, 'untested');
});

test('1 个失败对象多条任务：todos 与 overview 的接入异常数一致且按对象去重', async () => {
  const todos = await get('/api/dashboard/todos', token);
  const overview = await get('/api/dashboard/overview?period=all', token);
  assert.equal(todos.statusCode, 200, todos.body);
  assert.equal(overview.statusCode, 200, overview.body);
  const t = todos.json();
  const o = overview.json();
  assert.equal(o.connectionIssues.count, t.connection.count);
  const ids = t.connection.items.map((i: { targetId: string }) => i.targetId);
  assert.equal(ids.filter((id: string) => id === failedId).length, 1);
  assert.ok(!ids.includes(untestedId), '未测试对象不计入接入异常');
  assert.ok(!ids.includes(inactiveId), '已停用对象不计入接入异常');
  // 与独立查询的不重复对象数一致（不因 3 个任务变成 3）
  const expected = await prisma.modelTarget.count({
    where: {
      isActive: true,
      AND: [{ lastTestStatus: { not: null } }, { lastTestStatus: { not: 'SUCCESS' } }],
    },
  });
  assert.equal(t.connection.count, expected);
  assert.ok(o.connectionIssues.untestedCount >= 1);
  const untestedRow = o.readiness.find(
    (r: { modelTargetId: string }) => r.modelTargetId === untestedId,
  );
  assert.ok(untestedRow, '未测试对象的近期任务出现在就绪表');
  assert.equal(untestedRow.stages[0].state, 'pending');
  assert.equal(untestedRow.connectionState, 'untested');
  const failedRows = o.readiness.filter(
    (r: { modelTargetId: string }) => r.modelTargetId === failedId,
  );
  assert.equal(failedRows.length, 3);
  for (const r of failedRows) assert.equal(r.connectionState, 'failed');
});

test('无 model_target:read 时 overview 不返回接入异常统计', async () => {
  const res = await get('/api/dashboard/overview?period=all', readerToken);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().connectionIssues, null);
});
