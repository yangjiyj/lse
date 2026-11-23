import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = 'WAF-';
let app!: FastifyInstance;
let token = '';
let taskId = '';

async function cleanup() {
  const tasks = await prisma.evalTask.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = tasks.map((t) => t.id);
  if (ids.length) {
    await prisma.wrongAnswer.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.evalResult.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.evalTask.deleteMany({ where: { id: { in: ids } } });
  }
  const sets = await prisma.questionSet.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const setIds = sets.map((s) => s.id);
  if (setIds.length) await prisma.question.deleteMany({ where: { questionSetId: { in: setIds } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();

  token = (
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
    })
  ).json().token;

  const model = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}模型`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-waf-test', // pragma: allowlist secret
      model: 'fake',
    },
  });
  const set = await prisma.questionSet.create({ data: { name: `${PREFIX}题集`, type: 'GENERAL' } });
  const q = await prisma.question.create({
    data: { questionSetId: set.id, content: `${PREFIX}题目`, type: 'GENERAL', severity: 'HIGH' },
  });
  const task = await prisma.evalTask.create({
    data: { name: `${PREFIX}任务`, modelTargetId: model.id },
  });
  taskId = task.id;
  const result = await prisma.evalResult.create({
    data: {
      taskId: task.id,
      questionId: q.id,
      modelTargetId: model.id,
      prompt: 'p',
      response: 'r',
      status: 'SUCCESS',
      finalVerdict: 'FAIL',
    },
  });
  for (const sev of ['HIGH', 'MEDIUM', 'LOW'] as const) {
    await prisma.wrongAnswer.create({
      data: {
        taskId: task.id,
        resultId: result.id,
        questionId: q.id,
        questionContent: `${PREFIX}样本-${sev}`,
        severity: sev,
        verdict: 'FAIL',
        riskCategory: 'test',
        engine: 'rule-judge',
        reason: 'r',
      },
    });
  }
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

function list(extra: string) {
  return app.inject({
    method: 'GET',
    url: `/api/wrong-answers?taskId=${taskId}${extra}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

test('findingIds 只返回关联评估结果的风险样本', async () => {
  const result = await prisma.evalResult.findFirstOrThrow({ where: { taskId } });
  const finding = await prisma.finding.create({ data: {
    taskId, resultId: result.id, questionId: result.questionId,
    engine: 'test', riskCategory: 'test', verdict: 'FAIL',
  } });
  const res = await list(`&findingIds=${finding.id}`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().total, 3);
  await prisma.finding.delete({ where: { id: finding.id } });
});

test('不带 severity 返回全部 3 条', async () => {
  const res = await list('');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().total, 3);
});

test('severity=HIGH 只返回 1 条', async () => {
  const res = await list('&severity=HIGH');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().total, 1);
  assert.equal(res.json().items[0].severity, 'HIGH');
});

test('severity=HIGH,LOW 逗号多选返回 2 条', async () => {
  const res = await list('&severity=HIGH,LOW');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().total, 2);
  const sevs = (res.json().items as Array<{ severity: string }>).map((i) => i.severity).sort();
  assert.deepEqual(sevs, ['HIGH', 'LOW']);
});

test('非法 severity 返回 400', async () => {
  const res = await list('&severity=BOGUS');
  assert.equal(res.statusCode, 400, res.body);
});

test('agentRisk=true 只返回智能体风险类别/引擎的样本', async () => {
  const base = await prisma.wrongAnswer.findFirst({ where: { taskId } });
  const agentRow = await prisma.wrongAnswer.create({
    data: {
      taskId,
      resultId: base!.resultId,
      questionId: base!.questionId,
      questionContent: `${PREFIX}智能体风险样本`,
      severity: 'HIGH',
      verdict: 'FAIL',
      riskCategory: 'agent_tool_abuse',
      engine: 'agent-tool-guard',
      reason: 'r',
    },
  });
  try {
    const res = await list('&agentRisk=true');
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().total, 1);
    assert.equal(res.json().items[0].riskCategory, 'agent_tool_abuse');
    assert.equal((await list('')).json().total, 4);
  } finally {
    await prisma.wrongAnswer.delete({ where: { id: agentRow.id } });
  }
});

test('导出 severity=HIGH 返回 200 + xlsx', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/wrong-answers/export?taskId=${taskId}&severity=HIGH`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['content-type']), /spreadsheetml/);
});
