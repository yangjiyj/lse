import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = '__eval_tasks_analytics_';

let app!: FastifyInstance;
let token = '';
let targetId = '';
const ids: Record<string, string> = {};
let savedEvaluation: unknown = undefined;

function auth(): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

async function makeTask(
  key: string,
  data: {
    status: 'COMPLETED' | 'FAILED';
    passed: number;
    failed: number;
    errors: number;
    startedAt: Date;
  },
) {
  const t = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}${key}`,
      status: data.status,
      engines: [],
      dimensions: [],
      totalQuestions: data.passed + data.failed + data.errors,
      processedQuestions: data.passed + data.failed + data.errors,
      passedCount: data.passed,
      failedCount: data.failed,
      errorCount: data.errors,
      progress: 1,
      startedAt: data.startedAt,
      modelTargetId: targetId,
    },
  });
  ids[key] = t.id;
  return t.id;
}

async function list(query: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks?keyword=${encodeURIComponent(PREFIX)}&pageSize=100&${query}`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { total: number; items: Array<Record<string, unknown>> };
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  // 使用默认权重，结束后恢复配置管理原值
  savedEvaluation = (await prisma.systemSetting.findUnique({ where: { key: 'evaluation' } }))
    ?.value;
  await prisma.systemSetting.deleteMany({ where: { key: 'evaluation' } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  token = login.json().token;
  const target = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}target`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-dummy',
      model: 'fake-model',
    },
  });
  targetId = target.id;
  const riskId = await makeTask('risk', {
    status: 'COMPLETED',
    passed: 8,
    failed: 2,
    errors: 0,
    startedAt: new Date('2026-09-10T03:00:00Z'),
  });
  // 逐题判定：合规性 5 过 + 1 CRITICAL 风险；提示注入 3 过 + 1 MEDIUM 风险（另 1 题执行异常不计）
  const set = await prisma.questionSet.create({ data: { name: `${PREFIX}set` } });
  const addResult = async (
    type: 'COMPLIANCE' | 'PROMPT_INJECTION',
    severity: 'CRITICAL' | 'MEDIUM' | null,
    finalVerdict: 'PASS' | 'FAIL' | 'ERROR',
  ) => {
    const q = await prisma.question.create({
      data: { questionSetId: set.id, content: 'q', type, severity },
    });
    await prisma.evalResult.create({
      data: { taskId: riskId, questionId: q.id, modelTargetId: targetId, prompt: 'q', finalVerdict },
    });
  };
  for (let i = 0; i < 5; i++) await addResult('COMPLIANCE', null, 'PASS');
  await addResult('COMPLIANCE', 'CRITICAL', 'FAIL');
  for (let i = 0; i < 3; i++) await addResult('PROMPT_INJECTION', null, 'PASS');
  await addResult('PROMPT_INJECTION', 'MEDIUM', 'FAIL');
  await addResult('PROMPT_INJECTION', null, 'ERROR');
  await prisma.finding.createMany({
    data: [
      {
        taskId: riskId,
        engine: 'rule-judge',
        riskCategory: 't',
        severity: 'CRITICAL',
        verdict: 'FAIL',
      },
      {
        taskId: riskId,
        engine: 'rule-judge',
        riskCategory: 't',
        severity: 'MEDIUM',
        verdict: 'FAIL',
        reviewStatus: 'CONFIRMED',
      },
    ],
  });
  await makeTask('pass', {
    status: 'COMPLETED',
    passed: 5,
    failed: 0,
    errors: 0,
    startedAt: new Date('2026-09-20T03:00:00Z'),
  });
  await makeTask('error', {
    status: 'FAILED',
    passed: 0,
    failed: 0,
    errors: 3,
    startedAt: new Date('2026-09-25T03:00:00Z'),
  });
});

after(async () => {
  await cleanup();
  if (savedEvaluation === undefined) {
    await prisma.systemSetting.deleteMany({ where: { key: 'evaluation' } });
  } else {
    await prisma.systemSetting.upsert({
      where: { key: 'evaluation' },
      update: { value: savedEvaluation as object },
      create: { key: 'evaluation', value: savedEvaluation as object },
    });
  }
  await app.close();
  await prisma.$disconnect();
});

test('运行结果筛选：risk / pass / error', async () => {
  assert.deepEqual(
    (await list('result=risk')).items.map((t) => t.id),
    [ids.risk],
  );
  assert.deepEqual(
    (await list('result=pass')).items.map((t) => t.id),
    [ids.pass],
  );
  assert.deepEqual(
    (await list('result=error')).items.map((t) => t.id),
    [ids.error],
  );
});

test('执行时间筛选：按东八区日期闭区间', async () => {
  const body = await list('startFrom=2026-09-15&startTo=2026-09-25');
  assert.deepEqual(new Set(body.items.map((t) => t.id)), new Set([ids.pass, ids.error]));
  const bad = await app.inject({
    method: 'GET',
    url: '/api/eval-tasks?startFrom=2026/09/01',
    headers: auth(),
  });
  assert.equal(bad.statusCode, 400);
});

test('评测模型 + 运行结果组合筛选', async () => {
  const body = await list(`modelTargetId=${targetId}&result=risk`);
  assert.equal(body.total, 1);
});

test('列表与详情返回评测得分与高中低风险数', async () => {
  const body = await list('result=risk');
  const item = body.items[0] as { evalScore: number; riskLevels: Record<string, number> };
  // 默认权重：合规 83.33（40%）、提示注入 0.7×75+0.3×87.5=78.75（30%）→ 81.4
  assert.equal(item.evalScore, 81.4);
  assert.deepEqual(item.riskLevels, { HIGH: 1, MEDIUM: 1, LOW: 0 });
  const empty = (await list('result=error')).items[0] as { evalScore: number | null };
  assert.equal(empty.evalScore, null);

  const detail = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks/${ids.risk}`,
    headers: auth(),
  });
  const d = detail.json();
  assert.equal(d.evalScore, 81.4);
  assert.equal(d.findingCount, 2);
  assert.equal(d.pendingReviewCount, 1);
});

test('评测得分同一口径：列表、详情、配置管理得分接口一致，并随权重变化', async () => {
  const scores = async () => {
    const item = (await list('result=risk')).items[0] as { evalScore: number | null };
    const detail = await app.inject({
      method: 'GET',
      url: `/api/eval-tasks/${ids.risk}`,
      headers: auth(),
    });
    const weighted = await app.inject({
      method: 'GET',
      url: `/api/evaluation-config/tasks/${ids.risk}/score`,
      headers: auth(),
    });
    assert.equal(weighted.statusCode, 200, weighted.body);
    return [item.evalScore, detail.json().evalScore, weighted.json().score];
  };
  assert.deepEqual(await scores(), [81.4, 81.4, 81.4]);

  const patch = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: auth(),
    payload: {
      evaluation: {
        dimensionWeights: { COMPLIANCE: 0, PROMPT_INJECTION: 100, SHOULD_REFUSE: 0, GENERAL: 0 },
        scoreWeights: { passRate: 100, severity: 0 },
      },
    },
  });
  assert.equal(patch.statusCode, 200, patch.body);
  // 只看提示注入通过率 3/4 → 75
  assert.deepEqual(await scores(), [75, 75, 75]);
});
