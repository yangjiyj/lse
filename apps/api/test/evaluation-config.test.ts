import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

// 配置管理：评测维度权重占比、单次评测题数、评测分数权重占比；综合评测得分。
let app!: FastifyInstance;
let token = '';
let saved: unknown = undefined;
let taskId = '';
let setId = '';
let targetId = '';

const auth = () => ({ authorization: `Bearer ${token}` });

before(async () => {
  app = await buildApp();
  await app.ready();
  saved = (await prisma.systemSetting.findUnique({ where: { key: 'evaluation' } }))?.value;
  await prisma.systemSetting.deleteMany({ where: { key: 'evaluation' } });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  token = res.json().token;

  const target = await prisma.modelTarget.create({
    data: {
      name: 'weight-score-target',
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1',
      model: 'm',
      apiKey: 'k',
    },
  });
  targetId = target.id;
  const set = await prisma.questionSet.create({ data: { name: 'weight-score-set' } });
  setId = set.id;
  const q = async (type: 'COMPLIANCE' | 'PROMPT_INJECTION', severity: 'CRITICAL' | null) =>
    prisma.question.create({ data: { questionSetId: set.id, content: 'q', type, severity } });
  // 完整完成的任务（4/4 已判定）才会出分；评估不完整时不出分见 eval-score-incomplete.test.ts
  const task = await prisma.evalTask.create({
    data: {
      name: 'weight-score-task',
      modelTargetId: target.id,
      status: 'COMPLETED',
      totalQuestions: 4,
      processedQuestions: 4,
      passedCount: 3,
      failedCount: 1,
      progress: 1,
    },
  });
  taskId = task.id;
  const add = async (questionId: string, finalVerdict: 'PASS' | 'FAIL' | 'ERROR') =>
    prisma.evalResult.create({
      data: { taskId, questionId, modelTargetId: target.id, prompt: 'q', finalVerdict },
    });
  // 合规性：2 题全过；提示注入：2 题 1 过 1 CRITICAL 风险
  await add((await q('COMPLIANCE', null)).id, 'PASS');
  await add((await q('COMPLIANCE', null)).id, 'PASS');
  await add((await q('PROMPT_INJECTION', null)).id, 'PASS');
  await add((await q('PROMPT_INJECTION', 'CRITICAL')).id, 'FAIL');
});

after(async () => {
  await prisma.evalTask.deleteMany({ where: { id: taskId } });
  await prisma.questionSet.deleteMany({ where: { id: setId } });
  await prisma.modelTarget.deleteMany({ where: { id: targetId } });
  if (saved === undefined) await prisma.systemSetting.deleteMany({ where: { key: 'evaluation' } });
  else
    await prisma.systemSetting.upsert({
      where: { key: 'evaluation' },
      update: { value: saved as object },
      create: { key: 'evaluation', value: saved as object },
    });
  await app.close();
  await prisma.$disconnect();
});

test('默认配置可读取，单次评测题数默认 80', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/evaluation-config', headers: auth() });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().questionCount, 80);
});

test('权重合计不为 100% 时拒绝保存', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: auth(),
    payload: { evaluation: { scoreWeights: { passRate: 60, severity: 30 } } },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('保存配置后单次评测题数与综合评测得分按新权重生效', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: auth(),
    payload: {
      evaluation: {
        questionCount: 120,
        dimensionWeights: { COMPLIANCE: 50, PROMPT_INJECTION: 50, SHOULD_REFUSE: 0, GENERAL: 0 },
        scoreWeights: { passRate: 50, severity: 50 },
      },
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().evaluation.questionCount, 120);
  const cfg = await app.inject({ method: 'GET', url: '/api/evaluation-config', headers: auth() });
  assert.equal(cfg.json().questionCount, 120);

  const score = await app.inject({
    method: 'GET',
    url: `/api/evaluation-config/tasks/${taskId}/score`,
    headers: auth(),
  });
  assert.equal(score.statusCode, 200, score.body);
  // 合规 100；注入：通过率 50，严重度 100-50=50 → 50；50:50 → 75
  assert.equal(score.json().score, 75);
  assert.equal(score.json().judgedCount, 4);
});
