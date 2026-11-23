import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { alignRegression } from '../src/modules/eval-plans/regression.js';

const PREFIX = '__eval_regress_';
let app!: FastifyInstance;
let token = '';
let targetId = '';
let planId = '';
const qids: string[] = [];

const auth = () => ({ authorization: `Bearer ${token}` });

test('alignRegression 按题目对齐：新增失败/已修复/仍失败/类别变化', () => {
  const base = [
    { questionId: 'a', category: '隐私保护', verdict: 'PASS' },
    { questionId: 'b', category: '隐私保护', verdict: 'FAIL' },
    { questionId: 'c', category: '违法违规', verdict: 'FAIL' },
    { questionId: 'd', category: '违法违规', verdict: 'PASS' },
    { questionId: 'x', category: '违法违规', verdict: 'PASS' },
  ];
  const head = [
    { questionId: 'a', category: '隐私保护', verdict: 'FAIL' },
    { questionId: 'b', category: '隐私保护', verdict: 'PASS' },
    { questionId: 'c', category: '违法违规', verdict: 'ERROR' },
    { questionId: 'd', category: '违法违规', verdict: 'PASS' },
    { questionId: 'y', category: '违法违规', verdict: 'FAIL' },
  ];
  const r = alignRegression(base, head);
  assert.deepEqual(r.newlyFailed.map((i) => i.questionId), ['a']);
  assert.deepEqual(r.fixed.map((i) => i.questionId), ['b']);
  assert.deepEqual(r.stillFailing.map((i) => i.questionId), ['c']);
  assert.deepEqual(r.summary, { aligned: 4, onlyInBase: 1, onlyInHead: 1 });
  const privacy = r.categories.find((c) => c.category === '隐私保护')!;
  assert.equal(privacy.basePassRate, 0.5);
  assert.equal(privacy.headPassRate, 0.5);
  assert.equal(privacy.passRateDelta, 0);
  assert.equal(privacy.newlyFailed, 1);
  assert.equal(privacy.fixed, 1);
  const illegal = r.categories.find((c) => c.category === '违法违规')!;
  // 只统计对齐题目；ERROR 不计入通过率分母（与 computePassRate 口径一致）
  assert.equal(illegal.basePassRate, 0.5);
  assert.equal(illegal.headPassRate, 1);
  assert.equal(illegal.stillFailing, 1);
});

test('alignRegression 同题多条结果取最严重判定', () => {
  const r = alignRegression(
    [{ questionId: 'a', category: 'x', verdict: 'PASS' }],
    [
      { questionId: 'a', category: 'x', verdict: 'PASS' },
      { questionId: 'a', category: 'x', verdict: 'FAIL' },
    ],
  );
  assert.equal(r.newlyFailed.length, 1);
  assert.equal(r.summary.aligned, 1);
});

async function cleanup() {
  await prisma.evalPlan.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

async function makeTask(name: string, verdicts: string[], createdAt: Date, withPlan = true) {
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}${name}`,
      status: 'COMPLETED',
      modelTargetId: targetId,
      planId: withPlan ? planId : null,
      createdAt,
      totalQuestions: verdicts.length,
      processedQuestions: verdicts.length,
      passedCount: verdicts.filter((v) => v === 'PASS').length,
      failedCount: verdicts.filter((v) => v === 'FAIL').length,
    },
  });
  for (const [i, v] of verdicts.entries()) {
    await prisma.evalResult.create({
      data: {
        taskId: task.id,
        questionId: qids[i]!,
        modelTargetId: targetId,
        prompt: `p${i}`,
        finalVerdict: v as 'PASS' | 'FAIL' | 'ERROR',
      },
    });
  }
  return task.id;
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: ['Admin', '@', '12345'].join('') },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
  const target = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}model`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-dummy', // pragma: allowlist secret
      model: 'fake',
    },
  });
  targetId = target.id;
  const set = await prisma.questionSet.create({
    data: {
      name: `${PREFIX}set`,
      type: 'COMPLIANCE',
      questions: {
        create: [
          { content: 'q0', type: 'COMPLIANCE', category: '隐私保护', externalId: 'E0' },
          { content: 'q1', type: 'COMPLIANCE', category: '隐私保护', externalId: 'E1' },
          { content: 'q2', type: 'COMPLIANCE', category: '违法违规', externalId: 'E2' },
        ],
      },
    },
    include: { questions: { orderBy: { externalId: 'asc' } } },
  });
  qids.push(...set.questions.map((q) => q.id));
  const plan = await prisma.evalPlan.create({
    data: {
      name: `${PREFIX}plan`,
      targetId,
      templateParams: { questionSetIds: [set.id] },
      cron: '0 2 * * *',
    },
  });
  planId = plan.id;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('GET /eval-plans/regression：计划相邻两次、指定本次运行、任选两任务，参数错误 400', async () => {
  const get = (qs: string) =>
    app.inject({ method: 'GET', url: `/api/eval-plans/regression?${qs}`, headers: auth() });

  const t1 = await makeTask('r1', ['PASS', 'FAIL', 'FAIL'], new Date('2026-09-01T00:00:00Z'));
  const onlyOne = await get(`planId=${planId}`);
  assert.equal(onlyOne.statusCode, 400, onlyOne.body);
  assert.equal(onlyOne.json().error.code, 'REGRESSION_NOT_ENOUGH_RUNS');

  const t2 = await makeTask('r2', ['FAIL', 'PASS', 'FAIL'], new Date('2026-09-02T00:00:00Z'));
  const t3 = await makeTask('r3', ['FAIL', 'PASS', 'PASS'], new Date('2026-09-03T00:00:00Z'));

  const latest = await get(`planId=${planId}`);
  assert.equal(latest.statusCode, 200, latest.body);
  const lb = latest.json();
  assert.equal(lb.base.id, t2);
  assert.equal(lb.head.id, t3);
  assert.equal(lb.fixed.length, 1);
  assert.equal(lb.fixed[0].externalId, 'E2');

  const byHead = await get(`planId=${planId}&headTaskId=${t2}`);
  assert.equal(byHead.statusCode, 200, byHead.body);
  const body = byHead.json();
  assert.equal(body.base.id, t1);
  assert.equal(body.head.id, t2);
  assert.equal(body.newlyFailed.length, 1);
  assert.equal(body.newlyFailed[0].externalId, 'E0');
  assert.equal(body.newlyFailed[0].content, 'q0');
  assert.equal(body.newlyFailed[0].baseVerdict, 'PASS');
  assert.equal(body.newlyFailed[0].headVerdict, 'FAIL');
  assert.equal(body.fixed.length, 1);
  assert.equal(body.stillFailing.length, 1);
  assert.equal(body.summary.newlyFailed, 1);
  assert.equal(body.summary.aligned, 3);
  assert.equal(body.summary.passRateDelta, 0);
  assert.ok('scoreDelta' in body.summary);
  assert.equal(body.categories.length, 2);

  const byIds = await get(`baseTaskId=${t2}&headTaskId=${t1}`);
  assert.equal(byIds.statusCode, 200, byIds.body);
  assert.equal(byIds.json().fixed[0].externalId, 'E0');

  for (const qs of [`baseTaskId=${t1}`, `baseTaskId=${t1}&headTaskId=${t1}`, 'planId=bad']) {
    const res = await get(qs);
    assert.equal(res.statusCode, 400, `${qs} ${res.body}`);
  }

  const tasks = await app.inject({ method: 'GET', url: `/api/eval-plans/${planId}/tasks`, headers: auth() });
  assert.equal(tasks.statusCode, 200, tasks.body);
  const items = tasks.json().items as Array<{ id: string; passRate: number | null }>;
  assert.deepEqual(items.map((i) => i.id), [t3, t2, t1]);
  assert.equal(items[0]!.passRate, 2 / 3);
});
