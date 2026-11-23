import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

// 首页数字口径：
// - 「评估对象」与评估对象页同口径（不含 JUDGE 类型的系统判定模型）；
// - 「待测试」只统计可做连通性测试的类型（MODEL / AGENT_API / PLATFORM_APP）；
// - 「自有样本库」与样本库页同口径（question-sets/kind.ts），运行记录不算自有。
const PREFIX = `__dash_scope_${randomUUID().slice(0, 8)}_`;
let app!: FastifyInstance;
let token = '';
const targetIds: Record<string, string> = {};

async function makeTarget(
  label: string,
  data: {
    targetType:
      | 'MODEL'
      | 'AGENT_API'
      | 'ENDPOINT_AGENT'
      | 'PUBLIC_AGENT'
      | 'JUDGE'
      | 'PLATFORM_APP';
    lastTestStatus?: string | null;
  },
) {
  const t = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}${label}`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-only',
      model: 'test-model',
      isActive: true,
      lastTestStatus: data.lastTestStatus ?? null,
      targetType: data.targetType,
    },
  });
  targetIds[label] = t.id;
  return t.id;
}

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

before(async () => {
  app = await buildApp();
  await app.ready();
  token = (
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
    })
  ).json().token;
});

after(async () => {
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

test('评估对象数与评估对象页同口径：不含 JUDGE；待测试只算可连通性测试的类型', async () => {
  const beforeOv = (await get('/api/dashboard/overview?period=all')).json();
  const listBefore = (await get('/api/model-targets?pageSize=1')).json();
  assert.equal(
    beforeOv.counts.modelTargetCount,
    listBefore.total,
    '首页评估对象数 = 评估对象页默认列表总数',
  );

  await makeTarget('judge', { targetType: 'JUDGE' });
  await makeTarget('endpoint', { targetType: 'ENDPOINT_AGENT' });
  await makeTarget('public', { targetType: 'PUBLIC_AGENT' });
  await makeTarget('model-untested', { targetType: 'MODEL' });
  await makeTarget('agent-api-untested', { targetType: 'AGENT_API' });
  await makeTarget('model-tested', { targetType: 'MODEL', lastTestStatus: 'SUCCESS' });

  const afterOv = (await get('/api/dashboard/overview?period=all')).json();
  const listAfter = (await get('/api/model-targets?pageSize=1')).json();
  assert.equal(afterOv.counts.modelTargetCount, listAfter.total, '新增后仍与列表一致');
  // 新增 6 个对象里 JUDGE 不计入：+5
  assert.equal(afterOv.counts.modelTargetCount - beforeOv.counts.modelTargetCount, 5);
  // 待测试：只多出 MODEL + AGENT_API 两个可测试类型的未测试对象；终端/公开智能体不计
  assert.equal(afterOv.connectionIssues.untestedCount - beforeOv.connectionIssues.untestedCount, 2);
  const todos = (await get('/api/dashboard/todos')).json();
  assert.equal(todos.connection.count, afterOv.connectionIssues.count);
});

test('接入异常同样不含 JUDGE 类型', async () => {
  const before = (await get('/api/dashboard/overview?period=all')).json();
  await makeTarget('judge-failed', { targetType: 'JUDGE', lastTestStatus: 'ERROR' });
  const afterOv = (await get('/api/dashboard/overview?period=all')).json();
  assert.equal(afterOv.connectionIssues.count, before.connectionIssues.count);
});

test('自有样本库按 kind.ts 分类：与样本库页一致，运行记录单列', async () => {
  const beforeOv = (await get('/api/dashboard/overview?period=all')).json();
  const beforeStats = (await get('/api/question-sets/builtin/stats')).json();
  const ownBefore = (await get('/api/question-sets?kind=own&pageSize=1')).json().total;
  const runBefore = (await get('/api/question-sets?kind=run&pageSize=1')).json().total;
  assert.equal(beforeOv.counts.ownQuestionSetCount, ownBefore);
  assert.equal(beforeStats.ownSetCount, ownBefore);
  assert.equal(beforeOv.counts.runQuestionSetCount, runBefore);

  // 1 个自有（手工来源）+ 2 个运行记录（评估任务快照 / 验收名称）
  await prisma.questionSet.create({
    data: { name: `${PREFIX}own`, type: 'GENERAL', source: 'upload:custom.csv' },
  });
  await prisma.questionSet.create({
    data: { name: `${PREFIX}run1`, type: 'GENERAL', source: 'generator:abc' },
  });
  await prisma.questionSet.create({
    data: { name: `${PREFIX}上线验收集`, type: 'GENERAL', source: null },
  });

  const afterOv = (await get('/api/dashboard/overview?period=all')).json();
  const afterStats = (await get('/api/question-sets/builtin/stats')).json();
  assert.equal(afterOv.counts.ownQuestionSetCount - ownBefore, 1);
  assert.equal(afterOv.counts.runQuestionSetCount - runBefore, 2);
  assert.equal(afterStats.ownSetCount, afterOv.counts.ownQuestionSetCount, '两个接口同一个数');
  assert.equal(
    afterOv.counts.ownQuestionSetCount,
    (await get('/api/question-sets?kind=own&pageSize=1')).json().total,
    '与样本库页「自有样本库」页签总数一致',
  );
});
