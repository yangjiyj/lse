import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = '__eval_tasks_list_filter_';

let app!: FastifyInstance;
let token = '';

function auth(): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function createTarget(suffix: string): Promise<string> {
  const t = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}${suffix}`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-dummy',
      model: 'fake-model',
    },
  });
  return t.id;
}

async function createTask(suffix: string, modelTargetId: string): Promise<string> {
  const set = await prisma.questionSet.create({
    data: {
      name: `${PREFIX}set_${suffix}`,
      type: 'PROMPT_INJECTION',
      source: 'test',
      questions: {
        create: [
          {
            content: `${PREFIX}question_${suffix}`,
            type: 'GENERAL',
          },
        ],
      },
    },
  });
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}task_${suffix}`,
      status: 'PENDING',
      engines: [],
      dimensions: [],
      concurrency: 1,
      totalQuestions: 1,
      modelTargetId,
      questionSets: { create: [{ questionSetId: set.id }] },
    },
  });
  return task.id;
}

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('用例1：modelTargetId 过滤生效——只返回对象A的任务，不混入对象B的任务', async () => {
  const targetAId = await createTarget('A');
  const targetBId = await createTarget('B');

  // A 建 2 个任务，B 建 1 个任务
  await createTask('A1', targetAId);
  await createTask('A2', targetAId);
  await createTask('B1', targetBId);

  const res = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks?modelTargetId=${targetAId}&pageSize=100`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();

  // 只返回 A 的 2 个任务
  assert.equal(body.total, 2, `期望 total=2，实际 total=${body.total}`);
  assert.equal(body.items.length, 2);
  for (const item of body.items) {
    assert.equal(
      item.modelTarget.id,
      targetAId,
      `期望 modelTarget.id=${targetAId}，实际=${item.modelTarget.id}`,
    );
  }
});

test('用例2：不传 modelTargetId 时回归不破——keyword 搜索能找到本次建的全部任务', async () => {
  // 注意：此测试在实现前就应 PASS（证明回归不破）
  // PREFIX 前缀搜索应能找回 A1/A2/B1（在用例1中已建）
  const res = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks?keyword=${encodeURIComponent(PREFIX)}&pageSize=100`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(body.total >= 3, `期望 total>=3，实际 total=${body.total}`);
});

test('用例3：无引用边界——对象C没有任务，过滤结果为空', async () => {
  const targetCId = await createTarget('C');

  const res = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks?modelTargetId=${targetCId}`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.total, 0, `期望 total=0，实际 total=${body.total}`);
  assert.equal(body.items.length, 0);
});
