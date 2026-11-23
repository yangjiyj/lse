import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { runEvalTask } from '../src/modules/eval-tasks/executor.js';
import { evaluateGateForTask } from '../src/modules/gates/service.js';

const PREFIX = '__gates_test_';

let app: Awaited<ReturnType<typeof buildApp>>;
let adminJwt = '';
let targetId = '';
let otherTargetId = '';
let setId = '';
let questionIds: string[] = [];

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function cleanup(): Promise<void> {
  const gates = await prisma.gateRule.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  await prisma.auditLog.deleteMany({ where: { targetId: { in: gates.map((g) => g.id) } } });
  await prisma.gateRule.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const tokens = await prisma.apiToken.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  await prisma.auditLog.deleteMany({ where: { targetId: { in: tokens.map((t) => t.id) } } });
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

/** 造一个已完成任务：verdicts[i] 对应第 i 题判定；highRisk 个 HIGH 发现。 */
async function makeCompletedTask(
  name: string,
  verdicts: Array<'PASS' | 'FAIL'>,
  opts: { highRisk?: number; finishedAt?: Date; modelTargetId?: string } = {},
): Promise<string> {
  const mt = opts.modelTargetId ?? targetId;
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}${name}`,
      status: 'COMPLETED',
      modelTargetId: mt,
      finishedAt: opts.finishedAt ?? new Date(),
      // 完整完成的任务：总数 = 已处理 = 已判定，进度 1（评估不完整的任务不出分，门禁取不到分）
      totalQuestions: verdicts.length,
      processedQuestions: verdicts.length,
      progress: 1,
      passedCount: verdicts.filter((v) => v === 'PASS').length,
      failedCount: verdicts.filter((v) => v === 'FAIL').length,
    },
  });
  for (let i = 0; i < verdicts.length; i++) {
    const r = await prisma.evalResult.create({
      data: {
        taskId: task.id,
        questionId: questionIds[i]!,
        modelTargetId: mt,
        prompt: 'p',
        response: 'r',
        finalVerdict: verdicts[i],
      },
    });
    if (i < (opts.highRisk ?? 0)) {
      await prisma.finding.create({
        data: {
          taskId: task.id,
          resultId: r.id,
          engine: 'test',
          riskCategory: 'x',
          severity: 'HIGH',
          verdict: 'FAIL',
        },
      });
    }
  }
  return task.id;
}

async function createGate(payload: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/gates',
    headers: bearer(adminJwt),
    payload,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id;
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
  adminJwt = login.json().token;
  const base = {
    provider: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'dummy-gate-key',
    model: 'm',
  }; // pragma: allowlist secret
  targetId = (await prisma.modelTarget.create({ data: { name: `${PREFIX}target`, ...base } })).id;
  otherTargetId = (await prisma.modelTarget.create({ data: { name: `${PREFIX}other`, ...base } }))
    .id;
  const set = await prisma.questionSet.create({
    data: {
      name: `${PREFIX}set`,
      questions: {
        create: [
          { content: `${PREFIX}q1`, category: '违法内容', type: 'COMPLIANCE' },
          { content: `${PREFIX}q2`, category: '违法内容', type: 'COMPLIANCE' },
          { content: `${PREFIX}q3`, category: '隐私泄露', type: 'COMPLIANCE' },
          { content: `${PREFIX}q4`, category: '隐私泄露', type: 'COMPLIANCE' },
        ],
      },
    },
    include: { questions: { orderBy: { content: 'asc' } } },
  });
  setId = set.id;
  questionIds = set.questions.map((q) => q.id);
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('门禁管理：非法规则 400；未指定适用范围 400；无权限 401', async () => {
  const anon = await app.inject({ method: 'GET', url: '/api/gates' });
  assert.equal(anon.statusCode, 401);
  const empty = await app.inject({
    method: 'POST',
    url: '/api/gates',
    headers: bearer(adminJwt),
    payload: { name: `${PREFIX}bad`, modelTargetId: targetId, rules: {} },
  });
  assert.equal(empty.statusCode, 400);
  const badRate = await app.inject({
    method: 'POST',
    url: '/api/gates',
    headers: bearer(adminJwt),
    payload: {
      name: `${PREFIX}bad`,
      modelTargetId: targetId,
      rules: { categoryMaxFailRate: { 违法内容: 2 } },
    },
  });
  assert.equal(badRate.statusCode, 400);
  const noScope = await app.inject({
    method: 'POST',
    url: '/api/gates',
    headers: bearer(adminJwt),
    payload: { name: `${PREFIX}bad`, rules: { minScore: 60 } },
  });
  assert.equal(noScope.statusCode, 400);
});

test('evaluateGateForTask：按评估对象匹配启用门禁，存档理由；分类失败率/高风险/回归都生效', async () => {
  const strict = await createGate({
    name: `${PREFIX}strict`,
    modelTargetId: targetId,
    rules: {
      minScore: 90,
      maxHighRisk: 0,
      categoryMaxFailRate: { 违法内容: 0.4 },
      noRegression: true,
    },
  });
  const loose = await createGate({
    name: `${PREFIX}loose`,
    modelTargetId: targetId,
    rules: { maxHighRisk: 5 },
  });
  const disabled = await createGate({
    name: `${PREFIX}off`,
    modelTargetId: targetId,
    rules: { minScore: 99 },
    enabled: false,
  });
  const other = await createGate({
    name: `${PREFIX}other`,
    modelTargetId: otherTargetId,
    rules: { minScore: 1 },
  });

  await makeCompletedTask('prev', ['PASS', 'PASS', 'PASS', 'PASS'], {
    finishedAt: new Date(Date.now() - 60_000),
  });
  const cur = await makeCompletedTask('cur', ['FAIL', 'PASS', 'PASS', 'PASS'], { highRisk: 1 });

  const results = await evaluateGateForTask(cur);
  assert.deepEqual(results.map((r) => r.gateId).sort(), [strict, loose].sort());

  const s = await prisma.gateEvaluation.findFirstOrThrow({
    where: { gateId: strict, taskId: cur },
  });
  assert.equal(s.passed, false);
  const reasons = s.reasons as string[];
  assert.ok(reasons.includes('总体得分低于门槛'), JSON.stringify(reasons));
  assert.ok(reasons.includes('高风险数超过门槛'));
  assert.ok(reasons.includes('类别失败率超过门槛：违法内容'));
  assert.ok(reasons.includes('相对上次运行退化'));
  assert.ok(s.previousTaskId);
  const metrics = s.metrics as {
    categoryFailureRates: Record<string, number>;
    highRiskCount: number;
  };
  assert.equal(metrics.categoryFailureRates['违法内容'], 0.5);
  assert.equal(metrics.categoryFailureRates['隐私泄露'], 0);
  assert.equal(metrics.highRiskCount, 1);

  const l = await prisma.gateEvaluation.findFirstOrThrow({ where: { gateId: loose, taskId: cur } });
  assert.equal(l.passed, true);
  assert.equal(
    await prisma.gateEvaluation.count({ where: { gateId: { in: [disabled, other] } } }),
    0,
  );

  // 重复判定覆盖旧存档
  await evaluateGateForTask(cur);
  assert.equal(await prisma.gateEvaluation.count({ where: { gateId: strict, taskId: cur } }), 1);
});

test('runEvalTask 完成后自动判定门禁；判定抛错不影响任务完成', async () => {
  const gate = await createGate({
    name: `${PREFIX}auto`,
    modelTargetId: otherTargetId,
    rules: { minScore: 60 },
  });
  const emptySet = await prisma.questionSet.create({ data: { name: `${PREFIX}empty-set` } });
  const mk = async (name: string) =>
    (
      await prisma.evalTask.create({
        data: {
          name: `${PREFIX}${name}`,
          modelTargetId: otherTargetId,
          questionSets: { create: { questionSetId: emptySet.id } },
        },
      })
    ).id;

  const t1 = await mk('auto-1');
  await runEvalTask(t1, { judgeTarget: null });
  assert.equal(
    (await prisma.evalTask.findUniqueOrThrow({ where: { id: t1 } })).status,
    'COMPLETED',
  );
  const e = await prisma.gateEvaluation.findFirstOrThrow({ where: { gateId: gate, taskId: t1 } });
  assert.equal(e.passed, false);
  assert.deepEqual(e.reasons, ['总体得分低于门槛']);

  const t2 = await mk('auto-2');
  await runEvalTask(t2, {
    judgeTarget: null,
    evaluateGates: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(
    (await prisma.evalTask.findUniqueOrThrow({ where: { id: t2 } })).status,
    'COMPLETED',
  );
  void setId;
});

test('GET /gates/:id/latest：API 令牌（gates:read）可读，scope 不符 403；/gates/failing 列出未通过门禁', async () => {
  const gate = await createGate({
    name: `${PREFIX}ci`,
    modelTargetId: targetId,
    rules: { maxHighRisk: 0 },
  });
  const before = await app.inject({
    method: 'GET',
    url: `/api/gates/${gate}/latest`,
    headers: bearer(adminJwt),
  });
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(before.json().evaluated, false);

  const task = await makeCompletedTask('ci-task', ['FAIL'], { highRisk: 1 });
  await evaluateGateForTask(task);

  const mkToken = async (scopes: string[]) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/api-tokens',
      headers: bearer(adminJwt),
      payload: { name: `${PREFIX}${scopes.join('+')}`, scopes, expiresInDays: 1 },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().token as string;
  };
  const readToken = await mkToken(['gates:read']);
  const res = await app.inject({
    method: 'GET',
    url: `/api/gates/${gate}/latest`,
    headers: bearer(readToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.passed, false);
  assert.equal(body.taskId, task);
  assert.deepEqual(body.reasons, ['高风险数超过门槛']);

  const triggerToken = await mkToken(['eval-plans:trigger']);
  const denied = await app.inject({
    method: 'GET',
    url: `/api/gates/${gate}/latest`,
    headers: bearer(triggerToken),
  });
  assert.equal(denied.statusCode, 403);
  // 令牌不能访问门禁的其他接口
  const list = await app.inject({ method: 'GET', url: '/api/gates', headers: bearer(readToken) });
  assert.equal(list.statusCode, 401);

  const failing = await app.inject({
    method: 'GET',
    url: '/api/gates/failing',
    headers: bearer(adminJwt),
  });
  assert.equal(failing.statusCode, 200, failing.body);
  const item = failing.json().items.find((i: { gateId: string }) => i.gateId === gate);
  assert.ok(item);
  assert.equal(item.taskId, task);
  assert.equal(item.taskName, `${PREFIX}ci-task`);

  // 通过后不再出现在 failing
  const passTask = await makeCompletedTask('ci-pass', ['PASS']);
  await evaluateGateForTask(passTask);
  const failing2 = await app.inject({
    method: 'GET',
    url: '/api/gates/failing',
    headers: bearer(adminJwt),
  });
  assert.ok(!failing2.json().items.some((i: { gateId: string }) => i.gateId === gate));
});

test('门禁编辑/删除写审计', async () => {
  const gate = await createGate({
    name: `${PREFIX}edit`,
    modelTargetId: targetId,
    rules: { minScore: 50 },
  });
  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/gates/${gate}`,
    headers: bearer(adminJwt),
    payload: { enabled: false, rules: { minScore: 70, noRegression: true } },
  });
  assert.equal(patch.statusCode, 200, patch.body);
  assert.equal(patch.json().enabled, false);
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/gates/${gate}`,
    headers: bearer(adminJwt),
  });
  assert.equal(del.statusCode, 204);
  for (const action of ['gate.create', 'gate.update', 'gate.delete']) {
    assert.ok(await prisma.auditLog.findFirst({ where: { action, targetId: gate } }), action);
  }
});
