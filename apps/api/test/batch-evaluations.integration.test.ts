import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = '__batch_';
let app: Awaited<ReturnType<typeof buildApp>>;
let auth: { authorization: string };
let targets: string[];
let setId: string;
let planId: string;
const payload = () => ({
  name: PREFIX + randomUUID(),
  targetIds: targets,
  questionSetIds: [setId],
  sampleCount: 3,
  seed: 'test',
  judgeMode: 'RULES',
  batchSize: 1,
  concurrency: 1,
  targetConcurrency: 1,
  maxAttempts: 1,
});

before(async () => {
  app = await buildApp();
  const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
  auth = { authorization: `Bearer ${app.jwt.sign({ sub: admin.id, username: admin.username })}` };
  targets = [];
  for (let i = 0; i < 2; i++) {
    const t = await prisma.modelTarget.create({
      data: {
        name: PREFIX + randomUUID(),
        provider: 'openai-compatible',
        model: 'test',
        apiKey: 'test-only-placeholder',
        baseUrl: 'http://127.0.0.1:9/v1',
        createdById: admin.id,
      },
    });
    targets.push(t.id);
  }
  const set = await prisma.questionSet.create({
    data: {
      name: PREFIX + randomUUID(),
      tags: [],
      questions: {
        create: [
          { content: '介绍模型', type: 'GENERAL', metadata: { expectedKeywords: ['模型'] } },
          {
            content: '模拟安全拒答样本',
            type: 'SHOULD_REFUSE',
            shouldRefuse: true,
            severity: 'HIGH',
          },
          { content: '模拟异常样本', type: 'GENERAL' },
        ],
      },
    },
  });
  setId = set.id;
});

after(async () => {
  const db = prisma as any;
  if (db.batchEvaluation)
    await db.batchEvaluation.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

test('批量计划接口需要登录', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/batch-evaluations' });
  assert.equal(res.statusCode, 401);
});

test('万题不能用三题重复凑数', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/batch-evaluations',
    headers: auth,
    payload: { ...payload(), sampleCount: 10000 },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /有效样本不足/);
});

test('事务创建同一套冻结样本和多个对象运行，不回传密钥', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/batch-evaluations',
    headers: auth,
    payload: payload(),
  });
  assert.equal(res.statusCode, 201, res.body);
  const data = res.json();
  planId = data.id;
  assert.equal(data.targetCount, 2);
  assert.equal(data.totalSamples, 6);
  assert.equal(data.runs.length, 2);
  assert.equal(data.summary.state, 'INCOMPLETE');
  assert.ok(data.samplePlanHash);
  assert.ok(!res.body.includes('test-only-placeholder'));
});

test('改题库不改变计划快照', async () => {
  assert.ok(planId);
  await prisma.question.updateMany({
    where: { questionSetId: setId, content: '介绍模型' },
    data: { content: '已修改' },
  });
  const db = prisma as any;
  const samples = await db.batchEvaluationSample.findMany({ where: { planId } });
  assert.ok(samples.some((s: any) => s.snapshot.content === '介绍模型'));
});

test('暂停与取消保留结果，取消后不能直接恢复', async () => {
  assert.ok(planId);
  const start = await app.inject({
    method: 'POST',
    url: `/api/batch-evaluations/${planId}/start`,
    headers: auth,
  });
  assert.equal(start.statusCode, 200, start.body);
  const pause = await app.inject({
    method: 'POST',
    url: `/api/batch-evaluations/${planId}/pause`,
    headers: auth,
  });
  assert.equal(pause.statusCode, 200, pause.body);
  assert.equal(pause.json().status, 'PAUSED');
  const cancel = await app.inject({
    method: 'POST',
    url: `/api/batch-evaluations/${planId}/cancel`,
    headers: auth,
  });
  assert.equal(cancel.statusCode, 200);
  const resume = await app.inject({
    method: 'POST',
    url: `/api/batch-evaluations/${planId}/resume`,
    headers: auth,
  });
  assert.equal(resume.statusCode, 409);
});

test('调用密钥或配置变化必须阻止沿用旧计划', async () => {
  const create = await app.inject({
    method: 'POST',
    url: '/api/batch-evaluations',
    headers: auth,
    payload: payload(),
  });
  assert.equal(create.statusCode, 201, create.body);
  await prisma.modelTarget.update({ where: { id: targets[0] }, data: { model: 'changed-model' } });
  const start = await app.inject({
    method: 'POST',
    url: `/api/batch-evaluations/${create.json().id}/start`,
    headers: auth,
  });
  assert.equal(start.statusCode, 409, start.body);
  await prisma.modelTarget.update({ where: { id: targets[0] }, data: { model: 'test' } });
});

test('其他普通用户不能读取或操作别人的评估计划', async () => {
  const permission = await prisma.permission.findUniqueOrThrow({
    where: { code: 'eval_task:read' },
  });
  const userUpdate = await prisma.permission.findUniqueOrThrow({ where: { code: 'user:update' } });
  const role = await prisma.role.create({
    data: {
      name: PREFIX + randomUUID(),
      permissions: { create: [{ permissionId: permission.id }, { permissionId: userUpdate.id }] },
    },
  });
  const user = await prisma.user.create({
    data: {
      username: PREFIX + randomUUID(),
      displayName: '测试只读用户',
      passwordHash: 'unusable',
      roles: { create: { roleId: role.id } },
    },
  });
  try {
    const headers = {
      authorization: `Bearer ${app.jwt.sign({ sub: user.id, username: user.username })}`,
    };
    const res = await app.inject({
      method: 'GET',
      url: `/api/batch-evaluations/${planId}`,
      headers,
    });
    assert.equal(res.statusCode, 404);
    const create = await app.inject({
      method: 'POST',
      url: '/api/batch-evaluations',
      headers,
      payload: payload(),
    });
    assert.equal(create.statusCode, 403);
    const list = await app.inject({ method: 'GET', url: '/api/batch-evaluations', headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().total, 0);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.role.delete({ where: { id: role.id } });
  }
});

test('对象报告只能引用同一计划的运行，下载保留中文且不包含密钥', async () => {
  const detail = await app.inject({
    method: 'GET',
    url: `/api/batch-evaluations/${planId}`,
    headers: auth,
  });
  const runId = detail.json().runs[0].id;
  const report = await app.inject({
    method: 'GET',
    url: `/api/batch-evaluations/${planId}/report/download?runId=${runId}`,
    headers: auth,
  });
  assert.equal(report.statusCode, 200, report.body);
  assert.match(report.headers['content-type']!, /charset=utf-8/i);
  assert.match(report.body, /对象安全评估报告/);
  assert.ok(!report.body.includes('test-only-placeholder'));
  const other = await app.inject({
    method: 'GET',
    url: `/api/batch-evaluations/${planId}/report?runId=${randomUUID()}`,
    headers: auth,
  });
  assert.equal(other.statusCode, 404);
});
