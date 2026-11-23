// 2.7.4 从规则反查检测结果：GET /api/question-sets/:setId/questions/:questionId/results
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import {
  adminToken,
  bearer,
  cleanupFixtures,
  limitedUserToken,
  tenantAdmin,
} from './helpers/w4-fixtures.js';

const P = 'w4qresults_';
let app!: FastifyInstance;
let admin = '';
let setId = '';
let questionId = '';
let otherQuestionId = '';
let tenant = { tenantId: '', token: '' };
const taskIds: Record<string, string> = {};

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: P } } });
  await cleanupFixtures(P);
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: P } } });
}

async function createTarget(name: string, tenantId: string): Promise<string> {
  const t = await prisma.modelTarget.create({
    data: {
      tenantId,
      name,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-dummy',
      model: 'fake-model',
    },
  });
  return t.id;
}

async function taskWithResult(opts: {
  key: string;
  tenantId: string;
  targetId: string;
  verdict: 'PASS' | 'FAIL' | 'ERROR';
  at: string;
  severity?: 'HIGH' | 'CRITICAL';
  question?: string;
}): Promise<void> {
  const task = await prisma.evalTask.create({
    data: {
      tenantId: opts.tenantId,
      name: `${P}${opts.key}`,
      status: 'COMPLETED',
      engines: [],
      dimensions: [],
      modelTargetId: opts.targetId,
    },
  });
  taskIds[opts.key] = task.id;
  const result = await prisma.evalResult.create({
    data: {
      tenantId: opts.tenantId,
      taskId: task.id,
      questionId: opts.question ?? questionId,
      modelTargetId: opts.targetId,
      prompt: 'p',
      finalVerdict: opts.verdict,
      createdAt: new Date(opts.at),
    },
  });
  if (opts.severity) {
    await prisma.finding.create({
      data: {
        tenantId: opts.tenantId,
        taskId: task.id,
        resultId: result.id,
        questionId: opts.question ?? questionId,
        engine: 'rule-judge',
        riskCategory: 'test',
        verdict: 'FAIL',
        severity: opts.severity,
      },
    });
  }
}

const url = (sid: string, qid: string, query = '') =>
  `/api/question-sets/${sid}/questions/${qid}/results${query}`;

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  admin = await adminToken(app);
  // 内置题库的题目各租户都能用，用它验证只返回本租户的检测结果。
  const set = await prisma.questionSet.create({
    data: {
      name: `${P}内置`,
      type: 'GENERAL',
      isBuiltin: true,
      tags: [],
      questions: {
        create: [
          { content: `${P}题目`, type: 'GENERAL' },
          { content: `${P}别的题目`, type: 'GENERAL' },
        ],
      },
    },
    include: { questions: { orderBy: { content: 'asc' } } },
  });
  setId = set.id;
  otherQuestionId = set.questions.find((q) => q.content === `${P}别的题目`)!.id;
  questionId = set.questions.find((q) => q.content === `${P}题目`)!.id;

  const platformTarget = await createTarget(`${P}平台对象`, PLATFORM_TENANT_ID);
  await taskWithResult({
    key: '早',
    tenantId: PLATFORM_TENANT_ID,
    targetId: platformTarget,
    verdict: 'PASS',
    at: '2026-11-01T00:00:00Z',
  });
  await taskWithResult({
    key: '晚',
    tenantId: PLATFORM_TENANT_ID,
    targetId: platformTarget,
    verdict: 'FAIL',
    severity: 'HIGH',
    at: '2026-11-03T00:00:00Z',
  });
  await taskWithResult({
    key: '别的题',
    tenantId: PLATFORM_TENANT_ID,
    targetId: platformTarget,
    verdict: 'FAIL',
    at: '2026-11-04T00:00:00Z',
    question: otherQuestionId,
  });

  tenant = await tenantAdmin(app, admin, `${P}t_`);
  const tenantTarget = await createTarget(`${P}租户对象`, tenant.tenantId);
  await taskWithResult({
    key: '租户',
    tenantId: tenant.tenantId,
    targetId: tenantTarget,
    verdict: 'ERROR',
    at: '2026-11-02T00:00:00Z',
  });
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('返回这道题在各任务里的结果，按时间倒序，只含当前租户', async () => {
  const res = await app.inject({
    method: 'GET',
    url: url(setId, questionId),
    headers: bearer(admin),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { items: Array<Record<string, unknown>>; total: number };
  assert.equal(body.total, 2);
  assert.deepEqual(body.items, [
    {
      taskId: taskIds['晚'],
      taskName: `${P}晚`,
      targetName: `${P}平台对象`,
      verdict: 'FAIL',
      severity: 'HIGH',
      createdAt: '2026-11-03T00:00:00.000Z',
    },
    {
      taskId: taskIds['早'],
      taskName: `${P}早`,
      targetName: `${P}平台对象`,
      verdict: 'PASS',
      severity: null,
      createdAt: '2026-11-01T00:00:00.000Z',
    },
  ]);
});

test('其他租户只看到自己的结果', async () => {
  const res = await app.inject({
    method: 'GET',
    url: url(setId, questionId),
    headers: bearer(tenant.token),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    (res.json().items as Array<{ taskName: string; verdict: string }>).map((r) => [
      r.taskName,
      r.verdict,
    ]),
    [[`${P}租户`, 'ERROR']],
  );
});

test('limit 限制条数', async () => {
  const res = await app.inject({
    method: 'GET',
    url: url(setId, questionId, '?limit=1'),
    headers: bearer(admin),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().items.length, 1);
  assert.equal(res.json().total, 2);
  const bad = await app.inject({
    method: 'GET',
    url: url(setId, questionId, '?limit=0'),
    headers: bearer(admin),
  });
  assert.equal(bad.statusCode, 400, bad.body);
});

test('题目不属于该样本库返回 404', async () => {
  const other = await prisma.questionSet.create({
    data: { tenantId: PLATFORM_TENANT_ID, name: `${P}别的库`, type: 'GENERAL', tags: [] },
  });
  const res = await app.inject({
    method: 'GET',
    url: url(other.id, questionId),
    headers: bearer(admin),
  });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().error.message, '测试样本不存在');
});

test('没有查看任务权限返回 403', async () => {
  const token = await limitedUserToken(app, `${P}qread_`, ['question:read', 'question_set:read']);
  const res = await app.inject({
    method: 'GET',
    url: url(setId, questionId),
    headers: bearer(token),
  });
  assert.equal(res.statusCode, 403, res.body);
});
