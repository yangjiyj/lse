import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { triggerEvalPlan } from '../src/modules/eval-plans/service.js';
import type { PlanScheduler } from '../src/modules/eval-plans/scheduler.js';

const PREFIX = '__eval_plan_';
const AUDITOR = 'eval_plan_test_auditor';
const AUDITOR_PASSWORD = ['Plan', 'Audit', '12345'].join('!');

let app!: FastifyInstance;
let token = '';
let auditorToken = '';
let targetId = '';
let setId = '';
const schedulerCalls: string[] = [];

const fakeScheduler: PlanScheduler = {
  async sync(plan) {
    schedulerCalls.push(`${plan.enabled ? 'upsert' : 'remove'}:${plan.id}:${plan.cron}`);
  },
  async remove(planId) {
    schedulerCalls.push(`remove:${planId}`);
  },
};

const auth = (t = token) => ({ authorization: `Bearer ${t}` });

async function cleanup(): Promise<void> {
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.evalPlan.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { username: AUDITOR } });
}

before(async () => {
  app = await buildApp({ evalPlanScheduler: fakeScheduler });
  await app.ready();
  await cleanup();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: ['Admin', '@', '12345'].join('') },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'auditor' } });
  await prisma.user.create({
    data: {
      username: AUDITOR,
      passwordHash: await argon2.hash(AUDITOR_PASSWORD, { type: argon2.argon2id }),
      displayName: '评估计划测试审计员',
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  const al = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: AUDITOR, password: AUDITOR_PASSWORD },
  });
  assert.equal(al.statusCode, 200, al.body);
  auditorToken = al.json().token;
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
          { content: 'q1', type: 'COMPLIANCE', category: '违法违规' },
          { content: 'q2', type: 'COMPLIANCE', category: '隐私保护' },
        ],
      },
    },
  });
  setId = set.id;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

beforeEach(() => {
  schedulerCalls.length = 0;
});

function planPayload(extra: Record<string, unknown> = {}) {
  return {
    name: `${PREFIX}每日回归`,
    targetId,
    cron: '0 2 * * *',
    timezone: 'Asia/Shanghai',
    minIntervalMinutes: 60,
    templateParams: { questionSetIds: [setId], engines: ['rule-judge'], concurrency: 2 },
    ...extra,
  };
}

async function createPlan(extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/eval-plans',
    headers: auth(),
    payload: planPayload(extra),
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; enabled: boolean; nextRunAt: string | null };
}

test('新建计划：校验模板参数、写审计、注册调度并返回下次运行时间', async () => {
  const plan = await createPlan();
  assert.equal(plan.enabled, true);
  assert.ok(plan.nextRunAt, '应返回下次运行时间');
  assert.deepEqual(schedulerCalls, [`upsert:${plan.id}:0 2 * * *`]);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'eval_plan.create', targetId: plan.id },
  });
  assert.ok(audit, '应写入创建审计');
});

test('新建计划：模板参数不合法、cron 间隔小于最小间隔、cron 非法均返回 400', async () => {
  const bad = [
    planPayload({ templateParams: { questionSetIds: [] } }),
    planPayload({ cron: '*/10 * * * *' }),
    planPayload({ cron: 'not a cron' }),
    planPayload({ timezone: 'Mars/Base' }),
  ];
  for (const payload of bad) {
    const res = await app.inject({ method: 'POST', url: '/api/eval-plans', headers: auth(), payload });
    assert.equal(res.statusCode, 400, res.body);
  }
  assert.equal(schedulerCalls.length, 0);
});

test('权限：审计员可查看列表，不能新建或触发', async () => {
  const plan = await createPlan({ name: `${PREFIX}权限` });
  const list = await app.inject({ method: 'GET', url: '/api/eval-plans', headers: auth(auditorToken) });
  assert.equal(list.statusCode, 200, list.body);
  const create = await app.inject({
    method: 'POST',
    url: '/api/eval-plans',
    headers: auth(auditorToken),
    payload: planPayload(),
  });
  assert.equal(create.statusCode, 403, create.body);
  const trig = await app.inject({
    method: 'POST',
    url: `/api/eval-plans/${plan.id}/trigger`,
    headers: auth(auditorToken),
  });
  assert.equal(trig.statusCode, 403, trig.body);
});

test('立即触发：生成关联 planId 的真实任务；上次未结束则跳过并记原因；间隔不足也跳过', async () => {
  const plan = await createPlan({ name: `${PREFIX}触发` });
  const first = await app.inject({
    method: 'POST',
    url: `/api/eval-plans/${plan.id}/trigger`,
    headers: auth(),
  });
  assert.equal(first.statusCode, 200, first.body);
  const r1 = first.json() as { status: string; taskId?: string; runId?: string };
  assert.equal(r1.status, 'triggered');
  assert.ok(r1.runId, '响应应包含 runId');
  const run1 = await prisma.evalPlanRun.findUniqueOrThrow({ where: { id: r1.runId! } });
  assert.equal(run1.taskId, r1.taskId);
  const task = await prisma.evalTask.findUniqueOrThrow({
    where: { id: r1.taskId! },
    include: { questionSets: true },
  });
  assert.equal(task.planId, plan.id);
  assert.equal(task.modelTargetId, targetId);
  assert.equal(task.totalQuestions, 2);
  assert.deepEqual(task.engines, ['rule-judge']);
  assert.equal(task.questionSets[0]?.questionSetId, setId);

  const second = await triggerEvalPlan(prisma, plan.id, { triggeredBy: 'schedule', actorId: null });
  assert.equal(second.status, 'skipped');
  assert.match(second.reason ?? '', /未结束/);

  await prisma.evalTask.update({ where: { id: task.id }, data: { status: 'COMPLETED' } });
  const third = await triggerEvalPlan(prisma, plan.id, { triggeredBy: 'ci', actorId: null });
  assert.equal(third.status, 'skipped');
  assert.match(third.reason ?? '', /最小间隔/);

  await prisma.evalPlan.update({
    where: { id: plan.id },
    data: { lastTriggeredAt: new Date(Date.now() - 2 * 3600_000) },
  });
  const fourth = await triggerEvalPlan(prisma, plan.id, { triggeredBy: 'schedule', actorId: null });
  assert.equal(fourth.status, 'triggered');

  const runs = await app.inject({
    method: 'GET',
    url: `/api/eval-plans/${plan.id}/runs`,
    headers: auth(auditorToken),
  });
  assert.equal(runs.statusCode, 200, runs.body);
  const items = runs.json().items as Array<{ status: string; triggeredBy: string; reason: string | null }>;
  assert.deepEqual(
    items.map((i) => `${i.triggeredBy}:${i.status}`),
    ['schedule:triggered', 'ci:skipped', 'schedule:skipped', 'manual:triggered'],
  );
  const refreshed = await prisma.evalPlan.findUniqueOrThrow({ where: { id: plan.id } });
  assert.equal(refreshed.lastSkipReason, null);
  const audits = await prisma.auditLog.count({
    where: { action: 'eval_plan.trigger', targetId: plan.id },
  });
  assert.equal(audits, 4);
});

test('并发触发同一计划只生成一个任务', async () => {
  const plan = await createPlan({ name: `${PREFIX}并发` });
  const results = await Promise.all(
    [0, 1, 2].map(() => triggerEvalPlan(prisma, plan.id, { triggeredBy: 'schedule', actorId: null })),
  );
  assert.equal(results.filter((r) => r.status === 'triggered').length, 1);
  assert.equal(await prisma.evalTask.count({ where: { planId: plan.id } }), 1);
});

test('停用计划：移除调度，调度触发记为跳过', async () => {
  const plan = await createPlan({ name: `${PREFIX}停用` });
  schedulerCalls.length = 0;
  const res = await app.inject({
    method: 'POST',
    url: `/api/eval-plans/${plan.id}/toggle`,
    headers: auth(),
    payload: { enabled: false },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().enabled, false);
  assert.deepEqual(schedulerCalls, [`remove:${plan.id}:0 2 * * *`]);
  const r = await triggerEvalPlan(prisma, plan.id, { triggeredBy: 'schedule', actorId: null });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason ?? '', /停用/);
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'eval_plan.disable', targetId: plan.id } }));
});

test('编辑计划：重新校验并同步调度；删除计划保留历史任务', async () => {
  const plan = await createPlan({ name: `${PREFIX}编辑` });
  schedulerCalls.length = 0;
  const bad = await app.inject({
    method: 'PATCH',
    url: `/api/eval-plans/${plan.id}`,
    headers: auth(),
    payload: { cron: '*/5 * * * *' },
  });
  assert.equal(bad.statusCode, 400, bad.body);
  const ok = await app.inject({
    method: 'PATCH',
    url: `/api/eval-plans/${plan.id}`,
    headers: auth(),
    payload: { cron: '30 3 * * 1', templateParams: { questionSetIds: [setId], sampleSize: 1 } },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const body = ok.json() as { templateParams: { sampleSize: number; sampleSeed?: string } };
  assert.equal(body.templateParams.sampleSize, 1);
  assert.ok(body.templateParams.sampleSeed, '抽样计划应固定种子，保证各次运行题目一致');
  assert.deepEqual(schedulerCalls, [`upsert:${plan.id}:30 3 * * 1`]);

  const r = await triggerEvalPlan(prisma, plan.id, { triggeredBy: 'manual', actorId: null });
  assert.equal(r.status, 'triggered');
  const del = await app.inject({ method: 'DELETE', url: `/api/eval-plans/${plan.id}`, headers: auth() });
  assert.equal(del.statusCode, 200, del.body);
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: r.taskId! } });
  assert.equal(task.planId, null);
  assert.ok(schedulerCalls.includes(`remove:${plan.id}`));
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'eval_plan.delete', targetId: plan.id } }));
});

test('评估对象停用时触发记为跳过', async () => {
  const plan = await createPlan({ name: `${PREFIX}对象停用` });
  await prisma.modelTarget.update({ where: { id: targetId }, data: { isActive: false } });
  try {
    const r = await triggerEvalPlan(prisma, plan.id, { triggeredBy: 'schedule', actorId: null });
    assert.equal(r.status, 'skipped');
    assert.match(r.reason ?? '', /评估对象/);
  } finally {
    await prisma.modelTarget.update({ where: { id: targetId }, data: { isActive: true } });
  }
});

async function createApiToken(scopes: string[]): Promise<{ token: string; id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/api-tokens',
    headers: auth(),
    payload: { name: `${PREFIX}ci_${scopes.join('_')}`, scopes, expiresInDays: 7 },
  });
  assert.equal(res.statusCode, 201, res.body);
  return { token: res.json().token, id: res.json().item.id };
}

test('CI 触发：scope 正确的 API 令牌生成任务并返回 taskId/runId；跳过返回 409', async () => {
  const plan = await createPlan({ name: `${PREFIX}CI` });
  const { token: ciToken } = await createApiToken(['eval-plans:trigger']);
  const res = await app.inject({
    method: 'POST',
    url: `/api/eval-plans/${plan.id}/trigger`,
    headers: auth(ciToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { status: string; taskId: string; runId: string };
  assert.equal(body.status, 'triggered');
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: body.taskId } });
  assert.equal(task.planId, plan.id);
  const run = await prisma.evalPlanRun.findUniqueOrThrow({ where: { id: body.runId } });
  assert.equal(run.triggeredBy, 'ci');
  assert.equal(run.taskId, body.taskId);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'eval_plan.trigger', targetId: plan.id },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(audit?.actorName?.startsWith('api_token:'), '审计应记录令牌名');
  assert.ok(!JSON.stringify(audit?.detail ?? {}).includes(ciToken), '审计不得包含令牌明文');

  const again = await app.inject({
    method: 'POST',
    url: `/api/eval-plans/${plan.id}/trigger`,
    headers: auth(ciToken),
  });
  assert.equal(again.statusCode, 409, again.body);
  const skipped = again.json() as { status: string; runId: string; taskId: null; reason: string };
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.taskId, null);
  assert.ok(skipped.runId);
  assert.match(skipped.reason, /未结束/);
});

test('CI 触发：scope 错误 403、吊销令牌 401、令牌不能访问计划其他接口', async () => {
  const plan = await createPlan({ name: `${PREFIX}CI权限` });
  const wrong = await createApiToken(['gates:read']);
  const r1 = await app.inject({
    method: 'POST',
    url: `/api/eval-plans/${plan.id}/trigger`,
    headers: auth(wrong.token),
  });
  assert.equal(r1.statusCode, 403, r1.body);

  const revoked = await createApiToken(['eval-plans:trigger', 'gates:read']);
  const rv = await app.inject({
    method: 'POST',
    url: `/api/api-tokens/${revoked.id}/revoke`,
    headers: auth(),
  });
  assert.equal(rv.statusCode, 200, rv.body);
  const r2 = await app.inject({
    method: 'POST',
    url: `/api/eval-plans/${plan.id}/trigger`,
    headers: auth(revoked.token),
  });
  assert.equal(r2.statusCode, 401, r2.body);
  assert.equal(await prisma.evalTask.count({ where: { planId: plan.id } }), 0);

  const good = await createApiToken(['eval-plans:trigger']);
  for (const [method, url] of [
    ['GET', '/api/eval-plans'],
    ['GET', `/api/eval-plans/${plan.id}/runs`],
    ['DELETE', `/api/eval-plans/${plan.id}`],
  ] as const) {
    const r = await app.inject({ method, url, headers: auth(good.token) });
    assert.equal(r.statusCode, 401, `${method} ${url} ${r.body}`);
  }
  const anon = await app.inject({ method: 'POST', url: `/api/eval-plans/${plan.id}/trigger` });
  assert.equal(anon.statusCode, 401);
});

test('门禁关联计划：planId 须为存在的计划；删除计划后门禁 planId 置空', async () => {
  const plan = await createPlan({ name: `${PREFIX}门禁关联` });
  const bad = await app.inject({
    method: 'POST',
    url: '/api/gates',
    headers: auth(),
    payload: { name: `${PREFIX}gate_bad`, planId: '00000000-0000-4000-8000-000000000000', rules: { minScore: 60 } },
  });
  assert.equal(bad.statusCode, 400, bad.body);
  const ok = await app.inject({
    method: 'POST',
    url: '/api/gates',
    headers: auth(),
    payload: { name: `${PREFIX}gate`, planId: plan.id, rules: { minScore: 60 } },
  });
  assert.equal(ok.statusCode, 201, ok.body);
  const gateId = ok.json().id as string;
  try {
    const del = await app.inject({ method: 'DELETE', url: `/api/eval-plans/${plan.id}`, headers: auth() });
    assert.equal(del.statusCode, 200, del.body);
    const gate = await prisma.gateRule.findUniqueOrThrow({ where: { id: gateId } });
    assert.equal(gate.planId, null);
  } finally {
    await prisma.gateRule.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }
});

test('平台开关关闭时计划触发返回 403，不能创建平台任务', async () => {
  const previous = process.env.LSE_PLATFORM_APP_ENABLED;
  process.env.LSE_PLATFORM_APP_ENABLED = 'false';
  const platform = await prisma.modelTarget.create({data:{name:`${PREFIX}platform`,targetType:'PLATFORM_APP',provider:'dify',baseUrl:'https://example.com/v1',apiKey:'app-test',model:'platform-app'}});
  const plan = await prisma.evalPlan.create({data:{name:`${PREFIX}platform_plan`,targetId:platform.id,cron:'0 * * * *',templateParams:{questionSetIds:[setId]},minIntervalMinutes:5}});
  try {
    const before = await prisma.evalTask.count();
    await assert.rejects(triggerEvalPlan(prisma,plan.id,{triggeredBy:'manual',actorId:null}), (error: any) => error.statusCode === 403 && error.code === 'PLATFORM_APP_DISABLED');
    assert.equal(await prisma.evalTask.count(),before);
  } finally { if(previous === undefined) delete process.env.LSE_PLATFORM_APP_ENABLED; else process.env.LSE_PLATFORM_APP_ENABLED=previous; }
});
