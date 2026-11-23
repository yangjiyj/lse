// 2.7.3 自建样本库禁用：PATCH enabled；禁用的样本库不出现在建任务的可选列表，也不能用来建任务；已有任务不受影响。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import { adminToken, bearer } from './helpers/w4-fixtures.js';

const P = 'w4qsenabled_';
let app!: FastifyInstance;
let admin = '';
let ownSetId = '';
let builtinSetId = '';
let targetId = '';
let targetId2 = '';

async function cleanup(): Promise<void> {
  await prisma.evalPlan.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: P } } });
}

async function createTarget(name: string): Promise<string> {
  const t = await prisma.modelTarget.create({
    data: {
      name,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-dummy',
      model: 'fake-model',
    },
  });
  return t.id;
}

const patchSet = (id: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/api/question-sets/${id}`,
    headers: bearer(admin),
    payload,
  });

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  admin = await adminToken(app);
  targetId = await createTarget(`${P}对象甲`);
  targetId2 = await createTarget(`${P}对象乙`);
  const own = await prisma.questionSet.create({
    data: {
      tenantId: PLATFORM_TENANT_ID,
      name: `${P}自建`,
      type: 'GENERAL',
      tags: [],
      questions: { create: [{ content: `${P}问题`, type: 'GENERAL' }] },
    },
  });
  ownSetId = own.id;
  const builtin = await prisma.questionSet.create({
    data: {
      name: `${P}内置`,
      type: 'GENERAL',
      isBuiltin: true,
      tags: [],
      questions: { create: [{ content: `${P}内置问题`, type: 'GENERAL' }] },
    },
  });
  builtinSetId = builtin.id;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('PATCH 可以禁用和重新启用自建样本库', async () => {
  const off = await patchSet(ownSetId, { enabled: false });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().enabled, false);
  const detail = await app.inject({
    method: 'GET',
    url: `/api/question-sets/${ownSetId}`,
    headers: bearer(admin),
  });
  assert.equal(detail.json().enabled, false);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'question_set.update', targetId: ownSetId },
    orderBy: { createdAt: 'desc' },
  });
  assert.deepEqual((audit?.detail as { fields?: string[] }).fields, ['enabled']);

  const on = await patchSet(ownSetId, { enabled: true });
  assert.equal(on.statusCode, 200, on.body);
  assert.equal(on.json().enabled, true);
});

test('内置样本库不能禁用，返回 400', async () => {
  const res = await patchSet(builtinSetId, { enabled: false });
  assert.equal(res.statusCode, 400, res.body);
  const set = await prisma.questionSet.findUniqueOrThrow({ where: { id: builtinSetId } });
  assert.equal(set.enabled, true);
});

test('建任务的可选样本库（enabled=true）不含禁用的样本库，管理列表仍能看到', async () => {
  await patchSet(ownSetId, { enabled: false });
  const selectable = await app.inject({
    method: 'GET',
    url: `/api/question-sets?enabled=true&keyword=${P}&pageSize=100`,
    headers: bearer(admin),
  });
  assert.equal(selectable.statusCode, 200, selectable.body);
  const ids = (selectable.json().items as Array<{ id: string }>).map((s) => s.id);
  assert.ok(!ids.includes(ownSetId), '可选列表不应含禁用的样本库');
  assert.ok(ids.includes(builtinSetId));

  const all = await app.inject({
    method: 'GET',
    url: `/api/question-sets?keyword=${P}&pageSize=100`,
    headers: bearer(admin),
  });
  const own = (all.json().items as Array<{ id: string; enabled: boolean }>).find(
    (s) => s.id === ownSetId,
  );
  assert.equal(own?.enabled, false);
});

test('用禁用的样本库建任务返回 400（单模型、多模型、评估计划）', async () => {
  await patchSet(ownSetId, { enabled: false });
  const single = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: bearer(admin),
    payload: { name: `${P}单模型`, modelTargetId: targetId, questionSetIds: [ownSetId] },
  });
  assert.equal(single.statusCode, 400, single.body);
  assert.equal(single.json().error.code, 'QUESTION_SET_DISABLED');

  const batch = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks/batch',
    headers: bearer(admin),
    payload: {
      name: `${P}多模型`,
      modelTargetIds: [targetId, targetId2],
      questionSetIds: [ownSetId],
    },
  });
  assert.equal(batch.statusCode, 400, batch.body);
  assert.equal(batch.json().error.code, 'QUESTION_SET_DISABLED');

  const plan = await app.inject({
    method: 'POST',
    url: '/api/eval-plans',
    headers: bearer(admin),
    payload: {
      name: `${P}计划`,
      targetId,
      cron: '0 2 * * *',
      timezone: 'Asia/Shanghai',
      minIntervalMinutes: 60,
      templateParams: { questionSetIds: [ownSetId], engines: ['rule-judge'], concurrency: 2 },
    },
  });
  assert.equal(plan.statusCode, 400, plan.body);
  assert.equal(plan.json().error.code, 'QUESTION_SET_DISABLED');
  assert.equal(await prisma.evalTask.count({ where: { name: { startsWith: P } } }), 0);
});

test('已有任务不受影响：详情照常显示样本库，可以重新评估', async () => {
  await patchSet(ownSetId, { enabled: true });
  const task = await prisma.evalTask.create({
    data: {
      name: `${P}已有任务`,
      status: 'COMPLETED',
      engines: [],
      dimensions: [],
      totalQuestions: 1,
      modelTargetId: targetId,
      questionSets: { create: [{ questionSetId: ownSetId }] },
    },
  });
  await patchSet(ownSetId, { enabled: false });
  const detail = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks/${task.id}`,
    headers: bearer(admin),
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(
    (detail.json().questionSets as Array<{ id: string }>).map((s) => s.id),
    [ownSetId],
  );
  const reEval = await app.inject({
    method: 'POST',
    url: `/api/eval-tasks/${task.id}/re-eval`,
    headers: bearer(admin),
  });
  assert.equal(reEval.statusCode, 200, reEval.body);
});
