import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import {
  computeJudgeCalibration,
  humanLabelOf,
  MIN_CALIBRATION_SAMPLES,
} from '../src/modules/eval-tasks/judge-calibration.js';

const rows = (
  spec: Array<[verdict: string, reviewStatus: string, n: number]>,
): Array<{ verdict: string; reviewStatus: string }> =>
  spec.flatMap(([verdict, reviewStatus, n]) =>
    Array.from({ length: n }, () => ({ verdict, reviewStatus })),
  );

describe('judge calibration 纯函数', () => {
  test('复核状态映射', () => {
    assert.equal(humanLabelOf('CONFIRMED'), 'FAIL');
    assert.equal(humanLabelOf('ACCEPTED_RISK'), 'FAIL');
    assert.equal(humanLabelOf('FALSE_POSITIVE'), 'PASS');
    assert.equal(humanLabelOf('UNREVIEWED'), null);
    assert.equal(humanLabelOf('NEEDS_REVIEW'), null);
  });

  test('样本不足时返回数据不足而不硬算', () => {
    const r = computeJudgeCalibration(rows([['FAIL', 'CONFIRMED', MIN_CALIBRATION_SAMPLES - 1]]));
    assert.equal(r.status, 'INSUFFICIENT');
    assert.equal(r.agreementRate, null);
    assert.equal(r.kappa, null);
    assert.match(r.message, /数据不足/);
  });

  test('混淆矩阵、一致率、kappa、误判方向', () => {
    const r = computeJudgeCalibration(
      rows([
        ['FAIL', 'CONFIRMED', 40], // tp
        ['FAIL', 'FALSE_POSITIVE', 10], // 误报
        ['PASS', 'CONFIRMED', 5], // 漏报
        ['PASS', 'FALSE_POSITIVE', 45], // tn
        ['UNKNOWN', 'CONFIRMED', 3], // 排除
        ['FAIL', 'UNREVIEWED', 7], // 待抽检
        ['PASS', 'NEEDS_REVIEW', 2], // 待抽检
      ]),
    );
    assert.equal(r.status, 'OK');
    assert.equal(r.reviewedCount, 100);
    assert.equal(r.excludedReviewedCount, 3);
    assert.equal(r.pendingCount, 9);
    assert.equal(r.falseAlarmCount, 10);
    assert.equal(r.missedRiskCount, 5);
    assert.ok(Math.abs(r.agreementRate! - 0.85) < 1e-9);
    assert.ok(Math.abs(r.kappa! - 0.7) < 1e-9);
    assert.equal(r.kappaLevel, '较强');
    assert.ok(r.agreementLower! < 0.85 && r.agreementUpper! > 0.85);
  });

  test('人工结论全部同类时 kappa 为空并给出说明', () => {
    const r = computeJudgeCalibration(rows([['FAIL', 'CONFIRMED', 12]]));
    assert.equal(r.status, 'OK');
    assert.equal(r.kappa, null);
    assert.equal(r.agreementRate, 1);
    assert.match(r.message, /无法扣除/);
  });
});

const PREFIX = '__judge_cal_';
let app!: FastifyInstance;
let token = '';
let taskId = '';
let targetId = '';
let setId = '';

const auth = () => ({ authorization: `Bearer ${token}` });

async function cleanup() {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

describe('judge-calibration 接口与任务统计字段', () => {
  before(async () => {
    app = await buildApp();
    await app.ready();
    await cleanup();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'Admin@12345' },
    });
    token = login.json().token;
    const target = await prisma.modelTarget.create({
      data: {
        name: `${PREFIX}model`,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-test-dummy',
        model: 'fake',
      },
    });
    targetId = target.id;
    const set = await prisma.questionSet.create({
      data: { name: `${PREFIX}set`, type: 'COMPLIANCE' },
    });
    setId = set.id;
    const task = await prisma.evalTask.create({
      data: {
        name: `${PREFIX}task`,
        modelTargetId: targetId,
        status: 'COMPLETED',
        totalQuestions: 20,
        processedQuestions: 20,
        passedCount: 10,
        failedCount: 6,
        errorCount: 1,
      },
    });
    taskId = task.id;
    // 20 个 FAIL 发现：前 12 个已人工复核（8 确认 + 4 误报），其余待复核；均进入风险样本
    for (let i = 0; i < 20; i += 1) {
      const q = await prisma.question.create({
        data: { content: `q${i}`, type: 'COMPLIANCE', category: '违法违规', questionSetId: setId },
      });
      const res = await prisma.evalResult.create({
        data: {
          taskId,
          questionId: q.id,
          modelTargetId: targetId,
          prompt: 'p',
          response: 'r',
          finalVerdict: 'FAIL',
        },
      });
      await prisma.wrongAnswer.create({
        data: { taskId, resultId: res.id, questionContent: `q${i}`, verdict: 'FAIL' },
      });
      await prisma.finding.create({
        data: {
          taskId,
          resultId: res.id,
          questionId: q.id,
          engine: 'rule',
          riskCategory: 'x',
          verdict: 'FAIL',
          reviewStatus: i < 8 ? 'CONFIRMED' : i < 12 ? 'FALSE_POSITIVE' : 'UNREVIEWED',
          reviewReason: i < 12 ? '人工复核' : null,
        },
      });
    }
  });

  after(async () => {
    await cleanup();
    await app.close();
    await prisma.$disconnect();
  });

  test('任务详情包含 statistics，且不改动既有计数', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/eval-tasks/${taskId}`,
      headers: auth(),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.passedCount, 10);
    assert.equal(body.failedCount, 6);
    assert.equal(body.unknownCount, 3);
    const s = body.statistics;
    assert.equal(s.sampleSize, 19); // 10 + 6 + 3，不含执行异常
    assert.equal(s.unknownCount, 3);
    assert.ok(Math.abs(s.failRate - 6 / 19) < 1e-9);
    assert.ok(s.failRateLower < s.failRate && s.failRateUpper > s.failRate);
    assert.deepEqual(s.warningCodes, ['FEW']);
  });

  test('判定校准接口：数据足够时返回一致率与误报计数', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/eval-tasks/${taskId}/judge-calibration`,
      headers: auth(),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.status, 'OK');
    assert.equal(body.reviewedCount, 12);
    assert.equal(body.falseAlarmCount, 4);
    assert.equal(body.missedRiskCount, 0);
    assert.equal(body.pendingCount, 8);
    assert.ok(Math.abs(body.agreementRate - 8 / 12) < 1e-9);
  });

  test('抽检清单：同种子可复现，只含待复核项', async () => {
    const url = `/api/eval-tasks/${taskId}/judge-calibration/sample?size=5&seed=abc`;
    const a = (await app.inject({ method: 'GET', url, headers: auth() })).json();
    const b = (await app.inject({ method: 'GET', url, headers: auth() })).json();
    assert.equal(a.items.length, 5);
    assert.equal(a.poolSize, 8);
    assert.deepEqual(a.items, b.items);
    assert.ok(a.items.every((i: { reviewStatus: string }) => i.reviewStatus === 'UNREVIEWED'));
  });

  test('任务不存在返回 404，未登录返回 401', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/eval-tasks/00000000-0000-4000-8000-000000000000/judge-calibration',
      headers: auth(),
    });
    assert.equal(missing.statusCode, 404);
    const anon = await app.inject({
      method: 'GET',
      url: `/api/eval-tasks/${taskId}/judge-calibration`,
    });
    assert.equal(anon.statusCode, 401);
  });

  test('门禁结果附带样本量警告，不影响判定', async () => {
    const gate = await prisma.gateRule.create({
      data: { name: `${PREFIX}gate`, rules: { minScore: 60 } },
    });
    await prisma.gateEvaluation.create({
      data: { gateId: gate.id, taskId, passed: true, reasons: [], metrics: { score: 80 } },
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/gates', headers: auth() });
      assert.equal(res.statusCode, 200, res.body);
      const item = res.json().items.find((g: { id: string }) => g.id === gate.id);
      assert.equal(item.latest.passed, true);
      assert.equal(item.latest.sampleSize, 19);
      assert.match(item.latest.sampleWarning, /样本偏少/);
    } finally {
      await prisma.gateRule.delete({ where: { id: gate.id } });
    }
  });

  test('多模型对比接口返回 statistics 与差异提示', async () => {
    const t2 = await prisma.evalTask.create({
      data: {
        name: `${PREFIX}task2`,
        modelTargetId: targetId,
        status: 'COMPLETED',
        processedQuestions: 20,
        passedCount: 4,
        failedCount: 16,
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/eval-tasks/compare?ids=${taskId},${t2.id}`,
      headers: auth(),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.items.length, 2);
    assert.ok(body.items.every((i: { statistics: unknown }) => i.statistics));
    assert.equal(body.differences.length, 1);
    assert.ok(
      ['within_noise', 'beyond_noise', 'insufficient'].includes(body.differences[0].verdict),
    );
  });
});
