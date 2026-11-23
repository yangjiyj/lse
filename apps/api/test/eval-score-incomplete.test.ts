import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { isEvaluationIncomplete } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { weightedScoresByTask } from '../src/lib/weighted-score.js';

/**
 * P0-04：存在未判定 / 异常 / 跳过引擎的任务（结论为「评估不完整」）不输出评估得分，
 * 否则「一半样本没结论」的任务会拿到满分 100，被客户当成「安全」。
 * 完整任务的得分口径保持不变。
 */

const PREFIX = '__eval_score_incomplete_';

let app!: FastifyInstance;
let token = '';
let targetId = '';
let questionSetId = '';
let savedEvaluation: unknown = undefined;
const ids: Record<string, string> = {};

const auth = () => ({ authorization: `Bearer ${token}` });

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

interface TaskSpec {
  status?: 'COMPLETED' | 'FAILED' | 'CANCELED';
  total: number;
  processed: number;
  passed: number;
  failed?: number;
  errors?: number;
  progress?: number;
  /** 实际落库的已判定结果：全部 PASS，条数 = judgedPass */
  judgedPass: number;
  skippedEngine?: boolean;
}

async function makeTask(key: string, spec: TaskSpec): Promise<string> {
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}${key}`,
      status: spec.status ?? 'COMPLETED',
      engines: [],
      dimensions: [],
      totalQuestions: spec.total,
      processedQuestions: spec.processed,
      passedCount: spec.passed,
      failedCount: spec.failed ?? 0,
      errorCount: spec.errors ?? 0,
      progress: spec.progress ?? 1,
      modelTargetId: targetId,
    },
  });
  for (let i = 0; i < spec.judgedPass; i += 1) {
    const q = await prisma.question.create({
      data: { questionSetId, content: `q${i}`, type: 'COMPLIANCE' },
    });
    await prisma.evalResult.create({
      data: {
        taskId: task.id,
        questionId: q.id,
        modelTargetId: targetId,
        prompt: 'q',
        finalVerdict: 'PASS',
      },
    });
  }
  if (spec.skippedEngine) {
    await prisma.engineRun.create({
      data: { taskId: task.id, engine: 'llm-judge', status: 'SKIPPED', skippedCount: 1 },
    });
  }
  ids[key] = task.id;
  return task.id;
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  // 默认权重，结束后恢复配置管理原值
  savedEvaluation = (await prisma.systemSetting.findUnique({ where: { key: 'evaluation' } }))
    ?.value;
  await prisma.systemSetting.deleteMany({ where: { key: 'evaluation' } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
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
  questionSetId = (await prisma.questionSet.create({ data: { name: `${PREFIX}set` } })).id;

  // 完整：4/4 全部通过 → 100 分，保持不变
  await makeTask('complete', { total: 4, processed: 4, passed: 4, judgedPass: 4 });
  // 体检同款：8 项里 4 项通过、4 项未判定（processed=8, passed=4）→ 以前也是 100 分
  await makeTask('unknown', { total: 8, processed: 8, passed: 4, judgedPass: 4 });
  // 有执行异常
  await makeTask('error', { total: 5, processed: 5, passed: 4, errors: 1, judgedPass: 4 });
  // 有被跳过的引擎（例如评审引擎不可用）
  await makeTask('skipped', {
    total: 4,
    processed: 4,
    passed: 4,
    judgedPass: 4,
    skippedEngine: true,
  });
  // 取消：只处理了一半
  await makeTask('canceled', {
    status: 'CANCELED',
    total: 8,
    processed: 4,
    passed: 4,
    progress: 0.5,
    judgedPass: 4,
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

const base = {
  status: 'COMPLETED',
  totalQuestions: 4,
  processedQuestions: 4,
  passedCount: 4,
  failedCount: 0,
  errorCount: 0,
  progress: 1,
};

test('isEvaluationIncomplete：完整的全通过任务不算不完整', () => {
  assert.equal(isEvaluationIncomplete(base), false);
  // 发现风险但执行与判定完整：同样是完整结论
  assert.equal(isEvaluationIncomplete({ ...base, passedCount: 3, failedCount: 1 }), false);
});

test('isEvaluationIncomplete：未判定 / 异常 / 跳过引擎 / 未跑完 / 非完成状态 都算不完整', () => {
  const cases: Array<[string, Parameters<typeof isEvaluationIncomplete>[0]]> = [
    ['未判定', { ...base, passedCount: 2 }],
    ['异常', { ...base, passedCount: 3, errorCount: 1 }],
    ['跳过引擎', { ...base, skippedEngineCount: 1 }],
    ['处理数不足', { ...base, processedQuestions: 3, passedCount: 3 }],
    ['处理数超出', { ...base, processedQuestions: 5, passedCount: 5 }],
    ['进度未满', { ...base, progress: 0.5 }],
    ['进度非数', { ...base, progress: Number.NaN }],
    ['无样本', { ...base, totalQuestions: 0, processedQuestions: 0, passedCount: 0 }],
    ['已取消', { ...base, status: 'CANCELED' }],
    ['失败', { ...base, status: 'FAILED' }],
    ['运行中', { ...base, status: 'RUNNING' }],
    ['已上报未判定数大于推导值', { ...base, unknownCount: 1 }],
    ['风险任务同时有未判定', { ...base, passedCount: 2, failedCount: 1 }],
  ];
  for (const [label, input] of cases) assert.equal(isEvaluationIncomplete(input), true, label);
});

test('weightedScoresByTask：不完整任务不出分，完整任务得分不变', async () => {
  const scores = await weightedScoresByTask(Object.values(ids));
  assert.equal(scores.get(ids.complete!), 100);
  assert.equal(scores.get(ids.unknown!), null, '4 项未判定不能拿满分');
  assert.equal(scores.get(ids.error!), null);
  assert.equal(scores.get(ids.skipped!), null);
  assert.equal(scores.get(ids.canceled!), null);
});

test('列表与详情：不完整任务 evalScore 为 null，完整任务仍为 100', async () => {
  const list = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks?keyword=${encodeURIComponent(PREFIX)}&pageSize=100`,
    headers: auth(),
  });
  assert.equal(list.statusCode, 200, list.body);
  const items = list.json().items as Array<{ id: string; evalScore: number | null }>;
  const scoreOf = (key: string) => items.find((t) => t.id === ids[key])!.evalScore;
  assert.equal(scoreOf('complete'), 100);
  for (const key of ['unknown', 'error', 'skipped', 'canceled'])
    assert.equal(scoreOf(key), null, key);

  for (const [key, expected] of [
    ['complete', 100],
    ['unknown', null],
  ] as const) {
    const detail = await app.inject({
      method: 'GET',
      url: `/api/eval-tasks/${ids[key]}`,
      headers: auth(),
    });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().evalScore, expected, key);
  }
});

test('评分接口：不完整任务 score 为 null 并标记 incomplete，完整任务不变', async () => {
  const fetchScore = async (key: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/evaluation-config/tasks/${ids[key]}/score`,
      headers: auth(),
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { score: number | null; incomplete: boolean };
  };
  const complete = await fetchScore('complete');
  assert.equal(complete.score, 100);
  assert.equal(complete.incomplete, false);
  const unknown = await fetchScore('unknown');
  assert.equal(unknown.score, null);
  assert.equal(unknown.incomplete, true);
});

test('首页高风险排行：不完整任务的得分为 null（与列表同一来源）', async () => {
  // 给不完整任务造一条高危 finding，使其进入「高风险任务排行」
  await prisma.finding.create({
    data: {
      taskId: ids.unknown!,
      engine: 'rule-judge',
      riskCategory: 't',
      severity: 'HIGH',
      verdict: 'FAIL',
    },
  });
  const res = await app.inject({ method: 'GET', url: '/api/dashboard/overview', headers: auth() });
  assert.equal(res.statusCode, 200, res.body);
  const top = (res.json().topHighRiskTasks as Array<{ id: string; evalScore: number | null }>).find(
    (t) => t.id === ids.unknown,
  );
  assert.ok(top, '不完整任务应出现在排行里');
  assert.equal(top.evalScore, null);
});
