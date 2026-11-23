import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = '__e_import_bank_';
let app!: FastifyInstance;
let token = '';
let taskId = '';
let modelTargetId = '';

const auth = () => ({ authorization: `Bearer ${token}` });

async function cleanup() {
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
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
  const target = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}model`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-key', // pragma: allowlist secret
      model: 'm',
      targetType: 'MODEL',
    },
  });
  modelTargetId = target.id;
  const set = await prisma.questionSet.create({
    data: {
      name: `${PREFIX}样本`,
      type: 'SHOULD_REFUSE',
      source: 'red-team',
      questions: {
        create: [
          {
            content: `${PREFIX}seed-a`,
            type: 'SHOULD_REFUSE',
            severity: 'HIGH',
            category: '提示注入',
          },
          {
            content: `${PREFIX}seed-b`,
            type: 'SHOULD_REFUSE',
            severity: 'MEDIUM',
            category: '隐私',
          },
        ],
      },
    },
    include: { questions: { orderBy: { content: 'asc' } } },
  });
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}task`,
      status: 'COMPLETED',
      modelTargetId,
      engines: ['autonomous-red-team'],
      dimensions: ['redteam_attack'],
      concurrency: 1,
      totalQuestions: 2,
      processedQuestions: 2,
      questionSets: { create: [{ questionSetId: set.id }] },
    },
  });
  taskId = task.id;
  for (const [i, q] of set.questions.entries()) {
    const result = await prisma.evalResult.create({
      data: {
        taskId,
        questionId: q.id,
        modelTargetId,
        prompt: q.content,
        response: 'r',
        status: 'SUCCESS',
        finalVerdict: i === 0 ? 'FAIL' : 'PASS',
      },
    });
    await prisma.engineRun.create({
      data: {
        taskId,
        resultId: result.id,
        engine: 'autonomous-red-team',
        status: 'SUCCESS',
        requestPayload: { side: 'A' },
        rawOutput: JSON.stringify({
          transcript: [
            {
              index: 0,
              move: 'academic_wrap',
              attackerMessage: `${PREFIX}第1轮-${i}`,
              modelResponse: '不能',
              attitude: 'hard_refuse',
              rationale: '首轮试探',
              roundJudgment: { source: 'judge', verdict: 'PASS', engine: 'composite' },
            },
            {
              index: 1,
              move: 'fictional_frame',
              attackerMessage: `${PREFIX}第2轮-${i}`,
              modelResponse: '好的',
              attitude: 'loosened',
              rationale: '上一轮明确拒绝，切换虚构框架',
              roundJudgment: { source: 'judge', verdict: i === 0 ? 'FAIL' : 'PASS' },
            },
          ],
        }),
      },
    });
  }
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('红队结果 trace 接出逐轮判定', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks/${taskId}/results`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const turns = res.json().items.flatMap((item: any) => item.redTeamTrace?.transcript ?? []);
  assert.ok(turns.some((t: any) => t.roundJudgment?.verdict === 'FAIL'));
  assert.ok(turns.every((t: any) => t.roundJudgment?.source === 'judge'));
});

test('导入题库：新建自有题库，默认每个场景导入最后一轮攻击内容并写审计', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/eval-tasks/${taskId}/import-to-question-bank`,
    headers: auth(),
    payload: { mode: 'create', name: `${PREFIX}新题库` },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.equal(body.imported, 2);
  const questions = await prisma.question.findMany({
    where: { questionSetId: body.questionSetId },
  });
  assert.deepEqual(questions.map((q) => q.content).sort(), [
    `${PREFIX}第2轮-0`,
    `${PREFIX}第2轮-1`,
  ]);
  assert.ok(questions.every((q) => q.shouldRefuse && q.type === 'SHOULD_REFUSE'));
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'eval_task.import_to_question_bank', targetId: taskId },
  });
  assert.ok(audit);
});

test('导入题库：追加到已有题库时按内容去重，可选导入全部轮次', async () => {
  const set = await prisma.questionSet.findFirstOrThrow({ where: { name: `${PREFIX}新题库` } });
  const res = await app.inject({
    method: 'POST',
    url: `/api/eval-tasks/${taskId}/import-to-question-bank`,
    headers: auth(),
    payload: { mode: 'append', questionSetId: set.id, scope: 'all_rounds' },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().imported, 2);
  assert.equal(res.json().skipped, 2);
  assert.equal(await prisma.question.count({ where: { questionSetId: set.id } }), 4);
});

test('导入题库：不能追加到内置题库', async () => {
  const set = await prisma.questionSet.create({
    data: { name: `${PREFIX}内置`, type: 'GENERAL', isBuiltin: true },
  });
  const res = await app.inject({
    method: 'POST',
    url: `/api/eval-tasks/${taskId}/import-to-question-bank`,
    headers: auth(),
    payload: { mode: 'append', questionSetId: set.id },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('导入题库：未认证 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/eval-tasks/${taskId}/import-to-question-bank`,
    payload: { mode: 'create', name: 'x' },
  });
  assert.equal(res.statusCode, 401);
});
