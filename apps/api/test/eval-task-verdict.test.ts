import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { EvalTaskStatus, FindingReviewStatus, Verdict } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { gatherReportData } from '../src/modules/reports/routes.js';
import { buildTaskReport } from '../src/modules/reports/report-builder.js';

const prefix = `__task_verdict_${randomUUID()}_`;
const finishedAt = new Date('2026-10-18T01:02:03.000Z');
let app: FastifyInstance;
let targetId: string;
let questionId: string;
let setId: string;
const actors: Record<string, { id: string; token: string }> = {};

before(async () => {
  app = await buildApp();
  await app.ready();
  for (const [name, permissions] of Object.entries({
    reader: ['eval_task:read', 'report:read'],
    connector: ['eval_task:read', 'report:read', 'platform_connector:restricted'],
    other: ['eval_task:read', 'report:read', 'platform_connector:restricted'],
    evalOnly: ['eval_task:read'],
    denied: ['platform_connector:restricted'],
    serviceReader: ['eval_task:read', 'report:read', 'service_assurance:read'],
  })) {
    const role = await prisma.role.create({
      data: {
        name: prefix + name,
        permissions: { create: permissions.map((code) => ({ permission: { connect: { code } } })) },
      },
    });
    const user = await prisma.user.create({
      data: {
        username: prefix + name,
        displayName: '任务结论测试账号',
        passwordHash: '不可用于登录的测试占位值',
        lastActiveAt: new Date(),
        roles: { create: { roleId: role.id } },
      },
    });
    actors[name] = { id: user.id, token: app.jwt.sign({ sub: user.id }) };
  }
  const target = await prisma.modelTarget.create({
    data: {
      name: prefix + '测试模型',
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: '',
      model: 'test',
      createdById: actors.connector.id,
    },
  });
  targetId = target.id;
  const set = await prisma.questionSet.create({
    data: {
      name: prefix + '测试题集',
      type: 'GENERAL',
      questions: { create: { content: '合成测试样本', type: 'GENERAL' } },
    },
    include: { questions: true },
  });
  setId = set.id;
  questionId = set.questions[0]!.id;
});

after(async () => {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.questionSet.deleteMany({ where: { id: setId } });
  await prisma.modelTarget.deleteMany({ where: { id: targetId } });
  await prisma.user.deleteMany({ where: { username: { startsWith: prefix } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: prefix } } });
  await app?.close();
  await prisma.$disconnect();
});

async function fixture(
  options: {
    verdicts?: Verdict[];
    status?: EvalTaskStatus;
    owner?: string | null;
    review?: FindingReviewStatus;
    engineStatus?: 'SUCCESS' | 'FAILED' | 'SKIPPED';
    missingEngine?: boolean;
  } = {},
) {
  const verdicts = options.verdicts ?? ['PASS'];
  const status = options.status ?? 'COMPLETED';
  const task = await prisma.evalTask.create({
    data: {
      name: prefix + randomUUID(),
      modelTargetId: targetId,
      createdById: options.owner === undefined ? actors.connector.id : options.owner,
      status,
      engines: ['rule-judge'],
      dimensions: [],
      totalQuestions: verdicts.length,
      processedQuestions: verdicts.length,
      passedCount: verdicts.filter((v) => v === 'PASS').length,
      failedCount: verdicts.filter((v) => v === 'FAIL').length,
      errorCount: verdicts.filter((v) => v === 'ERROR').length,
      finishedAt: ['COMPLETED', 'FAILED', 'CANCELED'].includes(status) ? finishedAt : null,
      questionSets: { create: { questionSetId: setId } },
    },
  });
  for (const verdict of verdicts) {
    const result = await prisma.evalResult.create({
      data: {
        taskId: task.id,
        modelTargetId: targetId,
        questionId,
        prompt: '合成测试输入',
        response: '合成测试输出',
        finalVerdict: verdict,
        status: verdict === 'ERROR' ? 'ERROR' : 'SUCCESS',
      },
    });
    if (verdict === 'FAIL') {
      await prisma.finding.create({
        data: {
          taskId: task.id,
          resultId: result.id,
          questionId,
          engine: 'rule-judge',
          riskCategory: 'forbidden_content',
          severity: 'HIGH',
          verdict: 'FAIL',
          reviewStatus: options.review ?? 'CONFIRMED',
          title: '合成风险',
          evidence: '合成证据',
        },
      });
    }
  }
  if (!options.missingEngine) {
    await prisma.engineRun.create({
      data: {
        taskId: task.id,
        engine: 'rule-judge',
        status: options.engineStatus ?? 'SUCCESS',
        normalizedCount: verdicts.length,
        skippedCount: options.engineStatus === 'SKIPPED' ? 1 : 0,
      },
    });
  }
  return task;
}

function getVerdict(id: string, actor = 'connector') {
  return app.inject({
    method: 'GET',
    url: `/api/eval-tasks/${id}/verdict`,
    headers: { authorization: `Bearer ${actors[actor]!.token}` },
  });
}

for (const scenario of [
  { name: '全部通过', verdicts: ['PASS'], expected: 'pass' },
  { name: '存在活跃风险', verdicts: ['PASS', 'FAIL'], expected: 'fail' },
  { name: '活跃风险与覆盖缺口并存仍判失败', verdicts: ['FAIL', 'ERROR'], expected: 'fail' },
  { name: '有错误和未判定结果', verdicts: ['PASS', 'ERROR', 'UNKNOWN'], expected: 'incomplete' },
  {
    name: '人工排除的失败不再阻断',
    verdicts: ['FAIL'],
    review: 'FALSE_POSITIVE',
    expected: 'pass',
  },
  { name: '接受风险仍算风险', verdicts: ['FAIL'], review: 'ACCEPTED_RISK', expected: 'fail' },
  { name: '空范围', verdicts: [], expected: 'incomplete' },
  { name: '引擎失败', verdicts: ['PASS'], engineStatus: 'FAILED', expected: 'incomplete' },
  { name: '引擎跳过', verdicts: ['PASS'], engineStatus: 'SKIPPED', expected: 'incomplete' },
  { name: '缺少引擎回执', verdicts: ['PASS'], missingEngine: true, expected: 'incomplete' },
] as const) {
  test(`任务结论与报告快照一致：${scenario.name}`, async (t) => {
    const task = await fixture({ ...scenario, verdicts: [...scenario.verdicts] });
    const { data } = await gatherReportData(prisma, task.id, new Date());
    const snapshot = buildTaskReport(data).summary.conclusionSnapshot!;
    assert.equal(snapshot.source, 'DETERMINISTIC_RULE');
    assert.ok(snapshot.counts);
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('结论查询不得调用模型');
    });
    const before = await prisma.evalTask.findUniqueOrThrow({ where: { id: task.id } });
    const reportCount = await prisma.report.count();
    const auditCount = await prisma.auditLog.count();
    const res = await getVerdict(task.id);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), {
      task_id: task.id,
      status: 'COMPLETED',
      verdict: scenario.expected,
      reason_codes: snapshot.reasonCodes,
      policy_version: snapshot.policyVersion,
      pass_count: snapshot.counts.pass,
      fail_count: snapshot.counts.fail,
      active_fail_count: snapshot.counts.activeFailCount,
      unknown_count: snapshot.counts.unknown,
      error_count: snapshot.counts.error,
      finished_at: finishedAt.toISOString(),
      report_id: null,
    });
    const mapping = { NO_RISK_OBSERVED: 'pass', RISK_DETECTED: 'fail', INCOMPLETE: 'incomplete' };
    assert.equal(res.json().verdict, mapping[snapshot.state]);
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(await prisma.report.count(), reportCount);
    assert.equal(await prisma.auditLog.count(), auditCount);
    assert.deepEqual(await prisma.evalTask.findUniqueOrThrow({ where: { id: task.id } }), before);
  });
}

for (const status of ['PENDING', 'RUNNING', 'PAUSED', 'FAILED', 'CANCELED'] as const) {
  test(`${status} 任务固定为不完整，直接返回计数且不读取评测明细`, async (t) => {
    const task = await fixture({ status, verdicts: ['PASS', 'FAIL', 'UNKNOWN', 'ERROR'] });
    // Prisma 的模型代理没有普通方法描述符，只能在统一查询入口观测。
    // 注意 prisma 现在是按租户改写参数的扩展客户端（$extends），真正的查询最终落到 prismaUnscoped：
    // 只挂扩展客户端会漏掉认证、事务这类走底层客户端的查询，观测点必须在两个客户端上都挂。
    type RequestFn = (args: { model?: string }) => Promise<unknown>;
    const clients = [prisma, prismaUnscoped] as unknown as Array<{ _request: RequestFn }>;
    const originals = clients.map((client) => client._request);
    const detailModels = new Set(['EvalResult', 'Finding', 'EngineRun', 'WrongAnswer']);
    const models: string[] = [];
    clients.forEach((client, index) => {
      const original = originals[index]!;
      client._request = function (args) {
        if (args.model) models.push(args.model);
        if (detailModels.has(args.model ?? '')) throw new Error('不得读取评测明细');
        return original.call(this, args);
      };
    });
    t.after(() => {
      clients.forEach((client, index) => {
        client._request = originals[index]!;
      });
    });
    // 先证明观测点对事务内查询也有效，防止“不重算”断言空跑。
    await assert.rejects(
      prisma.$transaction((tx) => tx.evalResult.count()),
      /不得读取评测明细/,
    );
    models.length = 0;
    const res = await getVerdict(task.id);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), {
      task_id: task.id,
      status,
      verdict: 'incomplete',
      reason_codes: ['TASK_NOT_COMPLETED'],
      policy_version: 'report-conclusion-v1',
      pass_count: 1,
      fail_count: 1,
      active_fail_count: null,
      unknown_count: 1,
      error_count: 1,
      finished_at: task.finishedAt?.toISOString() ?? null,
      report_id: null,
    });
    assert.ok(models.includes('User'), '必须实际观测到认证查询');
    assert.deepEqual(
      models.filter((model) => detailModels.has(model)),
      [],
    );
  });
}

test('任务结论沿用认证与读取权限，连接器不能查询其他账号或无主任务', async () => {
  const own = await fixture();
  const noAuth = await app.inject({ method: 'GET', url: `/api/eval-tasks/${own.id}/verdict` });
  assert.equal(noAuth.statusCode, 401);
  await prisma.evalTask.update({ where: { id: own.id }, data: { createdById: actors.denied.id } });
  assert.equal((await getVerdict(own.id, 'denied')).statusCode, 403);
  for (const owner of [actors.other.id, null]) {
    const task = await fixture({ owner });
    const res = await getVerdict(task.id);
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().error.code, 'CONNECTOR_RESOURCE_NOT_FOUND');
    assert.equal(res.json().error.message, '连接器资源不存在');
    // 普通产品账号继续沿用原来的任务读取权限。
    assert.equal((await getVerdict(task.id, 'reader')).statusCode, 200);
  }
  const missing = await getVerdict(randomUUID(), 'reader');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.message, '评估任务不存在');
  assert.equal((await getVerdict(randomUUID())).statusCode, 404);
});

test('报告编号只取该任务最新且调用者可见的报告', async () => {
  const task = await fixture({ owner: actors.serviceReader.id });
  const old = await prisma.report.create({
    data: {
      taskId: task.id,
      title: '较早的可见报告',
      content: '',
      createdAt: new Date('2026-10-16'),
    },
  });
  const visible = await prisma.report.create({
    data: {
      taskId: task.id,
      title: '最新可见报告',
      content: '',
      createdAt: new Date('2026-10-17'),
    },
  });
  const hidden = await prisma.report.create({
    data: {
      taskId: task.id,
      title: '服务安全报告',
      content: '',
      kind: 'service_assurance',
      createdAt: finishedAt,
    },
  });
  assert.equal((await getVerdict(task.id, 'reader')).json().report_id, visible.id);
  const evalOnly = await getVerdict(task.id, 'evalOnly');
  assert.equal(evalOnly.statusCode, 200, evalOnly.body);
  assert.equal(evalOnly.json().report_id, null);
  assert.equal((await getVerdict(task.id, 'serviceReader')).json().report_id, hidden.id);
  await prisma.report.deleteMany({ where: { id: { in: [old.id, visible.id] } } });
  assert.equal((await getVerdict(task.id, 'reader')).json().report_id, null);
  await prisma.evalTask.update({
    where: { id: task.id },
    data: { createdById: actors.connector.id },
  });
  assert.equal((await getVerdict(task.id)).json().report_id, hidden.id);
  const other = await fixture();
  assert.equal((await getVerdict(other.id)).json().report_id, null);
});

test('版本能力无需登录可读，连接器带令牌也可探测', async () => {
  for (const headers of [{}, { authorization: `Bearer ${actors.connector.token}` }]) {
    const res = await app.inject({ method: 'GET', url: '/api/version', headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().product, 'llm-safety-eval-platform');
    assert.equal(typeof res.json().version, 'string');
    assert.equal(typeof res.json().sourceCommit, 'string');
    assert.ok(Array.isArray(res.json().capabilities), '版本接口需要返回能力数组');
    assert.ok(res.json().capabilities.includes('eval_task_verdict'));
  }
});
