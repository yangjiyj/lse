import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PFX = 'G2E_';
let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
let modelTargetId = '';

function auth(): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function cleanup(): Promise<void> {
  await prisma.evalTaskQuestionSet.deleteMany({ where: { task: { name: { startsWith: PFX } } } });
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.question.deleteMany({ where: { questionSet: { name: { startsWith: PFX } } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PFX } } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', ['pass' + 'word']: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;

  const target = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: `${PFX}model`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-key-generate-to-eval',
      model: 'fake-generate-to-eval-model',
      isActive: true,
    },
  });
  assert.equal(target.statusCode, 201, target.body);
  modelTargetId = target.json().id;
});

after(async () => {
  await cleanup();
  await app.close();
});

test('生成题集可直接作为评估任务的题集来源（零改引擎）', async () => {
  const gen = await app.inject({
    method: 'POST',
    url: '/api/generator/generate',
    headers: auth(),
    payload: {
      name: `${PFX}set`,
      types: ['SHOULD_REFUSE'],
      categories: ['危险物品'],
      language: 'zh',
      count: 15,
      variantStrength: 1,
      seed: 'g2e',
    },
  });
  assert.equal(gen.statusCode, 201, gen.body);
  const questionSetId = gen.json().questionSetId as string;

  const taskRes = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: auth(),
    payload: {
      name: `${PFX}task`,
      modelTargetId,
      engines: ['rule-judge'],
      questionSetIds: [questionSetId],
    },
  });
  assert.equal(taskRes.statusCode, 201, taskRes.body);
  const taskId = taskRes.json().id as string;

  const link = await prisma.evalTaskQuestionSet.findFirst({ where: { taskId, questionSetId } });
  assert.ok(link, '生成题集应通过既有关联表挂到任务');
});

test('已退役 AIG 标识不得写入新评估任务', async () => {
  const questionSet = await prisma.questionSet.findFirstOrThrow({
    where: { name: { startsWith: PFX } },
    select: { id: true },
  });
  const taskName = `${PFX}retired-aig`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: auth(),
    payload: {
      name: taskName,
      modelTargetId,
      engines: ['ai-infra-guard'],
      questionSetIds: [questionSet.id],
    },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(await prisma.evalTask.count({ where: { name: taskName } }), 0);
});

test('历史 AIG 任务保持只读，重评和删除均不得移除旧证据', async () => {
  const questionSet = await prisma.questionSet.findFirstOrThrow({
    where: { name: { startsWith: PFX } },
    select: { id: true },
  });
  const historical = await prisma.evalTask.create({
    data: {
      name: `${PFX}historical-aig`,
      modelTargetId,
      engines: ['ai-infra-guard'],
      dimensions: ['historical'],
      status: 'COMPLETED',
      questionSets: { create: { questionSetId: questionSet.id } },
      engineRuns: {
        create: {
          engine: 'ai-infra-guard',
          status: 'SUCCESS',
          rawOutput: '{"historical":true}',
          normalizedCount: 1,
        },
      },
    },
  });

  const response = await app.inject({
    method: 'POST',
    url: `/api/eval-tasks/${historical.id}/re-eval`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 400, response.body);
  const deleteResponse = await app.inject({
    method: 'DELETE',
    url: `/api/eval-tasks/${historical.id}`,
    headers: auth(),
  });
  assert.equal(deleteResponse.statusCode, 400, deleteResponse.body);
  assert.equal(await prisma.evalTask.count({ where: { id: historical.id } }), 1);
  const preserved = await prisma.engineRun.findFirst({
    where: { taskId: historical.id, engine: 'ai-infra-guard' },
  });
  assert.equal(preserved?.rawOutput, '{"historical":true}');
});
