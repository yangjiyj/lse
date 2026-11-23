import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

/**
 * 评估对象被评估任务引用就删不掉，只能先逐个删任务。
 * DELETE /model-targets/:id?withTasks=true 连同名下任务一起删：要么全删，要么一个都不动。
 */
const PREFIX = '__del_with_tasks_';
const PASSWORD = ['Del', 'Tasks', '123'].join('!');
let app: FastifyInstance;
let adminJwt = '';
let targetOnlyJwt = '';
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function cleanup() {
  const targets = await prisma.modelTarget.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const ids = targets.map((t) => t.id);
  await prisma.evalPlan.deleteMany({ where: { targetId: { in: ids } } });
  const tasks = await prisma.evalTask.findMany({ where: { modelTargetId: { in: ids } }, select: { id: true } });
  for (const task of tasks) await app.inject({ method: 'DELETE', url: `/api/eval-tasks/${task.id}`, headers: bearer(adminJwt) });
  await prisma.evalTask.deleteMany({ where: { modelTargetId: { in: ids } } });
  await prisma.modelTarget.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' } }); // pragma: allowlist secret
  assert.equal(login.statusCode, 200, login.body);
  adminJwt = login.json().token;
  await cleanup();
  // 只有评估对象的读、删权限，没有评估任务的删除权限。
  const permissions = await prisma.permission.findMany({ where: { code: { in: ['model_target:read', 'model_target:delete'] } } });
  assert.equal(permissions.length, 2);
  const role = await prisma.role.create({ data: { name: `${PREFIX}target_only`,
    permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  const user = await prisma.user.create({ data: { username: `${PREFIX}target_only`, displayName: 'target only', isActive: true,
    passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }), roles: { create: { roleId: role.id } } } });
  const userLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: user.username, password: PASSWORD } });
  assert.equal(userLogin.statusCode, 200, userLogin.body);
  targetOnlyJwt = userLogin.json().token;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

const makeTarget = (name: string) => prisma.modelTarget.create({ data: { name: `${PREFIX}${name}-${randomUUID().slice(0, 8)}`,
  provider: 'openai-compatible', targetType: 'MODEL', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-key', model: 'test-model' } });
const makeTask = (modelTargetId: string, name: string, data: { status?: 'COMPLETED' | 'RUNNING' | 'PENDING'; engines?: string[] } = {}) =>
  prisma.evalTask.create({ data: { name, modelTargetId, engines: data.engines ?? [], dimensions: [], status: data.status ?? 'COMPLETED' } });
const remove = (id: string, query = '?withTasks=true', jwt = adminJwt) =>
  app.inject({ method: 'DELETE', url: `/api/model-targets/${id}${query}`, headers: bearer(jwt) });
const remaining = async (targetId: string) => ({
  target: await prisma.modelTarget.count({ where: { id: targetId } }),
  tasks: await prisma.evalTask.count({ where: { modelTargetId: targetId } }),
});

test('withTasks：连同名下评估任务及其结果一起删除，审计记下删掉的任务数量和名称', async () => {
  const target = await makeTarget('ok');
  const first = await makeTask(target.id, '任务甲');
  const second = await makeTask(target.id, '任务乙', { status: 'PENDING' });
  await prisma.evalTaskLog.create({ data: { taskId: first.id, level: 'INFO', message: 'log' } });
  await prisma.report.create({ data: { taskId: second.id, title: '报告', content: '正文', evaluatedTargetId: target.id } });

  const response = await remove(target.id);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(await remaining(target.id), { target: 0, tasks: 0 });
  assert.equal(await prisma.evalTaskLog.count({ where: { taskId: first.id } }), 0);
  assert.equal(await prisma.report.count({ where: { taskId: second.id } }), 0);
  const audit = await prisma.auditLog.findFirst({ where: { action: 'model_target.delete', targetId: target.id } });
  assert.ok(audit);
  const detail = audit.detail as { name: string; deletedTasks: { count: number; names: string[] } };
  assert.equal(detail.name, target.name);
  assert.equal(detail.deletedTasks.count, 2);
  assert.deepEqual([...detail.deletedTasks.names].sort(), ['任务乙', '任务甲']);
});

test('withTasks：标准专项和服务核验的任务一并收尾（和单独删任务同一套逻辑）', async () => {
  const target = await makeTarget('standard');
  const created = await app.inject({ method: 'POST', url: '/api/eval-tasks/standard-compliance', headers: bearer(adminJwt),
    payload: { modelTargetId: target.id, seed: `with-tasks-${randomUUID().slice(0, 8)}`,
      counts: { MANUAL_SAFETY: 2, TECHNICAL_SAFETY: 2, SHOULD_REFUSE: 1, NON_REFUSAL: 1 } } });
  assert.equal(created.statusCode, 201, created.body);
  const { taskId, runId } = created.json() as { taskId: string; runId: string };
  await prisma.evalTask.update({ where: { id: taskId }, data: { status: 'COMPLETED' } });
  const assuranceTask = await makeTask(target.id, '服务核验任务');
  const run = await prisma.serviceAssuranceRun.create({ data: { taskId: assuranceTask.id, mode: 'SAFE', targetKind: 'ENDPOINT',
    targetName: 'svc', scopePolicyRef: 'policy/test', requestBudget: { maxRequests: 1 } } });
  await prisma.serviceAsset.create({ data: { runId: run.id, customerName: '资产', normalizedAddress: 'https://127.0.0.1:9',
    assetKey: `asset-${randomUUID().slice(0, 8)}` } });

  const response = await remove(target.id);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(await remaining(target.id), { target: 0, tasks: 0 });
  assert.equal(await prisma.standardRun.count({ where: { id: runId } }), 0);
  assert.equal(await prisma.standardSample.count({ where: { standardRunId: runId } }), 0);
  assert.equal(await prisma.serviceAssuranceRun.count({ where: { id: run.id } }), 0);
  assert.equal(await prisma.serviceAsset.count({ where: { runId: run.id } }), 0);
});

test('withTasks：名下有任务在运行时整体拒绝并点名，什么都不删', async () => {
  const target = await makeTarget('running');
  await makeTask(target.id, '已完成的任务');
  await makeTask(target.id, '还在跑的任务', { status: 'RUNNING' });
  const response = await remove(target.id);
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error.code, 'EVAL_TASK_RUNNING');
  assert.match(response.json().error.message, /还在跑的任务/);
  assert.match(response.json().error.message, /运行/);
  assert.deepEqual(await remaining(target.id), { target: 1, tasks: 2 });
});

test('withTasks：名下有只读的历史 AIG 任务时整体拒绝并点名，什么都不删', async () => {
  const target = await makeTarget('aig');
  await makeTask(target.id, '普通任务');
  await makeTask(target.id, '历史 AIG 扫描', { engines: ['ai-infra-guard'] });
  const response = await remove(target.id);
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error.code, 'AIG_HISTORY_READ_ONLY');
  assert.match(response.json().error.message, /历史 AIG 扫描/);
  assert.deepEqual(await remaining(target.id), { target: 1, tasks: 2 });
});

test('withTasks：还被评估计划引用时拒绝并说明，不级联', async () => {
  const target = await makeTarget('plan');
  await makeTask(target.id, '普通任务');
  const plan = await prisma.evalPlan.create({ data: { name: `${PREFIX}plan`, targetId: target.id, templateParams: {}, cron: '0 3 * * *' } });
  const response = await remove(target.id);
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error.code, 'MODEL_TARGET_IN_USE');
  assert.match(response.json().error.message, /1 个评估计划/);
  assert.deepEqual(await remaining(target.id), { target: 1, tasks: 1 });
  assert.equal(await prisma.evalPlan.count({ where: { id: plan.id } }), 1);
});

test('withTasks：同时需要评估对象删除权限和评估任务删除权限', async () => {
  const target = await makeTarget('perm');
  await makeTask(target.id, '普通任务');
  const denied = await remove(target.id, '?withTasks=true', targetOnlyJwt);
  assert.equal(denied.statusCode, 403, denied.body);
  assert.deepEqual(await remaining(target.id), { target: 1, tasks: 1 });
  // 不带 withTasks 时行为不变：有引用仍是原来的拒绝提示。
  const plain = await remove(target.id, '', targetOnlyJwt);
  assert.equal(plain.statusCode, 400, plain.body);
  assert.equal(plain.json().error.code, 'MODEL_TARGET_IN_USE');
  assert.deepEqual(await remaining(target.id), { target: 1, tasks: 1 });
});

test('withTasks：没有引用的对象照常删除', async () => {
  const target = await makeTarget('empty');
  const response = await remove(target.id);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(await remaining(target.id), { target: 0, tasks: 0 });
});

test('withTasks：任务自带的图片集一并清除，还有别的任务在用的图片集不动', async () => {
  const target = await makeTarget('byo');
  const other = await makeTarget('byo-other');
  const task = await makeTask(target.id, '自带图片任务');
  const otherTask = await makeTask(other.id, '别的对象的任务');
  const makeSet = async (name: string, taskIds: string[]) => {
    const set = await prisma.questionSet.create({ data: { name: `${PREFIX}${name}-${randomUUID().slice(0, 8)}`,
      source: 'multimodal-jailbreak:byo', taskLinks: { create: taskIds.map((taskId) => ({ taskId })) } } });
    await prisma.byoImage.create({ data: { questionSetId: set.id, name: 'a.png', mimeType: 'image/png',
      sha256: 'a'.repeat(64), sizeBytes: 3, data: Buffer.from([1, 2, 3]) } });
    return set;
  };
  const own = await makeSet('own', [task.id]);
  const shared = await makeSet('shared', [task.id, otherTask.id]);
  try {
    const response = await remove(target.id);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(await remaining(target.id), { target: 0, tasks: 0 });
    assert.equal(await prisma.byoImage.count({ where: { questionSetId: own.id } }), 0);
    assert.equal(await prisma.questionSet.count({ where: { id: own.id } }), 0);
    assert.equal(await prisma.byoImage.count({ where: { questionSetId: shared.id } }), 1);
    assert.equal(await prisma.questionSet.count({ where: { id: shared.id } }), 1);
  } finally {
    await prisma.questionSet.deleteMany({ where: { id: { in: [own.id, shared.id] } } });
  }
});

test('withTasks：自带图片集清理出错时，对象和任务已删，审计照样写下', async () => {
  const target = await makeTarget('purge-fail');
  const task = await makeTask(target.id, '清理会出错的任务');
  const set = await prisma.questionSet.create({ data: { name: `${PREFIX}purge-fail-${randomUUID().slice(0, 8)}`,
    source: 'multimodal-jailbreak:byo', taskLinks: { create: [{ taskId: task.id }] } } });
  await prisma.byoImage.create({ data: { questionSetId: set.id, name: 'a.png', mimeType: 'image/png',
    sha256: 'b'.repeat(64), sizeBytes: 3, data: Buffer.from([1, 2, 3]) } });
  // 让图片清理这一步失败（清理发生在删除事务提交之后）。
  const delegate = prisma.byoImage;
  const original = delegate.findMany;
  Reflect.set(delegate, 'findMany', () => Promise.reject(new Error('byo purge failed')));
  try {
    const response = await remove(target.id);
    assert.equal(response.statusCode, 200, response.body);
  } finally {
    Reflect.set(delegate, 'findMany', original);
    await prisma.questionSet.deleteMany({ where: { id: set.id } });
  }
  assert.deepEqual(await remaining(target.id), { target: 0, tasks: 0 });
  const audit = await prisma.auditLog.findFirst({ where: { action: 'model_target.delete', targetId: target.id } });
  assert.ok(audit, '数据已删就必须有审计');
  assert.equal((audit.detail as { deletedTasks: { count: number } }).deletedTasks.count, 1);
});

test('withTasks：名下有 RAG 评估时拒绝并说明，不级联；先单独删掉那个任务后就能删', async () => {
  const target = await makeTarget('rag');
  await makeTask(target.id, '普通任务');
  const ragTask = await makeTask(target.id, 'RAG 评估任务');
  const corpus = await prisma.ragCorpus.create({ data: { name: `${PREFIX}corpus-${randomUUID().slice(0, 8)}` } });
  const testSet = await prisma.ragTestSet.create({ data: { corpusId: corpus.id, name: `${PREFIX}set`, seed: 's', promptVersion: 'v1',
    poisonDocument: 'p', poisonCanary: 'c', sentinelDocument: 'd', sentinelToken: 't' } });
  const run = await prisma.ragEvalRun.create({ data: { taskId: ragTask.id, testSetId: testSet.id, modelTargetId: target.id } });
  try {
    const response = await remove(target.id);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'MODEL_TARGET_IN_USE');
    assert.match(response.json().error.message, /1 次 RAG 评估/);
    assert.deepEqual(await remaining(target.id), { target: 1, tasks: 2 });
    assert.equal(await prisma.ragEvalRun.count({ where: { id: run.id } }), 1);
    // 出路：单独删掉 RAG 评估任务（它的运行记录随任务删除），再连同其余任务删对象。
    const single = await app.inject({ method: 'DELETE', url: `/api/eval-tasks/${ragTask.id}`, headers: bearer(adminJwt) });
    assert.equal(single.statusCode, 200, single.body);
    const retry = await remove(target.id);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(await remaining(target.id), { target: 0, tasks: 0 });
  } finally {
    await prisma.ragEvalRun.deleteMany({ where: { id: run.id } });
    await prisma.ragCorpus.deleteMany({ where: { id: corpus.id } });
  }
});
