import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = `__dashboard_todos_${randomUUID()}_`;
let app!: FastifyInstance;
let token = '';
let targetId = '';
let taskId = '';
let userId = '';
let roleId = '';
let restrictedToken = '';
let restrictedUserId = '';
let restrictedRoleId = '';

before(async () => {
  app = await buildApp();
  await app.ready();
  for (const code of ['eval_task:read', 'remediation:read', 'model_target:read']) await prisma.permission.upsert({ where: { code }, create: { code, name: code, group: '测试' }, update: {} });
  const role = await prisma.role.create({ data: { name: `${PREFIX}role`, permissions: { create: ['eval_task:read', 'remediation:read', 'model_target:read'].map((code) => ({ permission: { connect: { code } } })) } } });
  roleId = role.id;
  const user = await prisma.user.create({ data: { username: PREFIX.slice(0, 60), passwordHash: 'test-only', displayName: 'dashboard todos test', roles: { create: { roleId: role.id } } } });
  userId = user.id;
  token = app.jwt.sign({ sub: user.id, username: user.username });
  const target = await prisma.modelTarget.create({ data: { name: `${PREFIX}target`, provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-only', model: 'test-model', isActive: true, lastTestStatus: 'ERROR' } });
  targetId = target.id;
  const task = await prisma.evalTask.create({ data: { name: `${PREFIX}task`, modelTargetId: target.id, engines: [], dimensions: [], status: 'COMPLETED' } });
  taskId = task.id;
  await prisma.finding.create({ data: { taskId: task.id, engine: 'test', riskCategory: 'test', severity: 'HIGH', reviewStatus: 'NEEDS_REVIEW', remediationDueAt: new Date(Date.now() + 2 * 86400000), remediationStatus: 'OPEN' } });
  const limitedRole = await prisma.role.create({ data: { name: `${PREFIX}limited`, permissions: { create: { permission: { connect: { code: 'eval_task:read' } } } } } });
  restrictedRoleId = limitedRole.id;
  const limitedUser = await prisma.user.create({ data: { username: `${PREFIX}limited`.slice(0, 64), passwordHash: 'test-only', displayName: 'limited', roles: { create: { roleId: limitedRole.id } } } });
  restrictedUserId = limitedUser.id;
  restrictedToken = app.jwt.sign({ sub: limitedUser.id, username: limitedUser.username });
});

after(async () => {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { id: { in: [userId, restrictedUserId] } } });
  await prisma.role.deleteMany({ where: { id: { in: [roleId, restrictedRoleId] } } });
  await app.close();
  await prisma.$disconnect();
});

test('未登录访问待办返回 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/dashboard/todos' });
  assert.equal(res.statusCode, 401);
});

test('待办聚合真实返回待复核、到期整改和接入异常', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/dashboard/todos', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(body.review.items.some((item: { taskId: string }) => item.taskId === taskId));
  assert.ok(body.remediation.items.some((item: { taskId: string }) => item.taskId === taskId));
  assert.ok(body.connection.items.some((item: { targetId: string }) => item.targetId === targetId));
});

test('无整改与对象权限时待办接口不泄漏对应项目', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/dashboard/todos', headers: { authorization: `Bearer ${restrictedToken}` } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().gates.remediation, false);
  assert.equal(res.json().gates.connection, false);
  assert.deepEqual(res.json().remediation.items, []);
  assert.deepEqual(res.json().connection.items, []);
});

// —— 门禁未过（W3 接入）：来源为 gate_evaluations 中每个启用门禁的最新判定 ——
async function gateUser(label: string, codes: string[]) {
  for (const code of codes) await prisma.permission.upsert({ where: { code }, create: { code, name: code, group: '测试' }, update: {} });
  const role = await prisma.role.create({ data: { name: `${PREFIX}${label}`, permissions: { create: codes.map((code) => ({ permission: { connect: { code } } })) } } });
  const user = await prisma.user.create({ data: { username: `${PREFIX}${label}`.slice(0, 64), passwordHash: 'test-only', displayName: label, roles: { create: { roleId: role.id } } } });
  extraRoleIds.push(role.id);
  extraUserIds.push(user.id);
  return app.jwt.sign({ sub: user.id, username: user.username });
}
const extraRoleIds: string[] = [];
const extraUserIds: string[] = [];
const gateIds: string[] = [];
async function makeGate(label: string, enabled = true) {
  const g = await prisma.gateRule.create({ data: { name: `${PREFIX}${label}`, modelTargetId: targetId, rules: { maxHighRisk: 0 }, enabled } });
  gateIds.push(g.id);
  return g.id;
}
async function expectedFailingCount() {
  const gates = await prisma.gateRule.findMany({ where: { enabled: true }, select: { id: true } });
  let n = 0;
  for (const g of gates) {
    const latest = await prisma.gateEvaluation.findFirst({ where: { gateId: g.id }, orderBy: { createdAt: 'desc' } });
    if (latest && !latest.passed) n++;
  }
  return n;
}
const getTodos = (jwt: string) => app.inject({ method: 'GET', url: '/api/dashboard/todos', headers: { authorization: `Bearer ${jwt}` } });

after(async () => {
  await prisma.gateRule.deleteMany({ where: { id: { in: gateIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: [userId, restrictedUserId, ...extraUserIds] }, action: 'dashboard.todos.read' } });
  await prisma.user.deleteMany({ where: { id: { in: extraUserIds } } });
  await prisma.role.deleteMany({ where: { id: { in: extraRoleIds } } });
});

test('门禁未过：无失败判定时不列出（未判定、已通过、已停用的门禁都不算）', async () => {
  const jwt = await gateUser('gate_empty', ['eval_task:read', 'gate:read']);
  const neverEvaluated = await makeGate('never');
  const passed = await makeGate('passed');
  await prisma.gateEvaluation.create({ data: { gateId: passed, taskId, passed: true, reasons: [] } });
  const disabled = await makeGate('disabled', false);
  await prisma.gateEvaluation.create({ data: { gateId: disabled, taskId, passed: false, reasons: ['高风险数超过门槛'] } });
  const res = await getTodos(jwt);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.gates.planning, true);
  const ids = body.gate.items.map((i: { gateId: string }) => i.gateId);
  for (const id of [neverEvaluated, passed, disabled]) assert.ok(!ids.includes(id), id);
  assert.equal(body.gate.count, await expectedFailingCount());
});

test('门禁未过：有 gate:read 时返回最新判定未通过的门禁及原因', async () => {
  const jwt = await gateUser('gate_reader', ['eval_task:read', 'gate:read']);
  const failing = await makeGate('failing');
  await prisma.gateEvaluation.create({ data: { gateId: failing, taskId, passed: true, reasons: [], createdAt: new Date(Date.now() - 60000) } });
  await prisma.gateEvaluation.create({ data: { gateId: failing, taskId, passed: false, reasons: ['高风险数超过门槛'] } });
  const res = await getTodos(jwt);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  const item = body.gate.items.find((i: { gateId: string }) => i.gateId === failing);
  assert.ok(item, '应列出最新判定未通过的门禁');
  assert.equal(item.gateName, `${PREFIX}failing`);
  assert.equal(item.taskId, taskId);
  assert.equal(item.taskName, `${PREFIX}task`);
  assert.deepEqual(item.reasons, ['高风险数超过门槛']);
  assert.equal(body.gate.count, await expectedFailingCount());
  const manager = await gateUser('gate_manager', ['eval_task:read', 'gate:manage']);
  const res2 = await getTodos(manager);
  assert.ok(res2.json().gate.items.some((i: { gateId: string }) => i.gateId === failing), 'gate:manage 同样可见');
});

test('门禁未过：无 gate 权限时不返回门禁数据且不报错', async () => {
  const failing = await makeGate('hidden');
  await prisma.gateEvaluation.create({ data: { gateId: failing, taskId, passed: false, reasons: ['高风险数超过门槛'] } });
  const res = await getTodos(restrictedToken);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.gates.planning, false);
  assert.deepEqual(body.gate, { count: 0, items: [] });
  assert.doesNotMatch(res.body, /hidden/);
});
