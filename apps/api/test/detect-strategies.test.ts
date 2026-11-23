import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { runInTenant } from '../src/lib/tenant-context.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import type { Launchers } from '../src/modules/detect-jobs/launchers.js';
import { triggerDetectStrategy } from '../src/modules/detect-jobs/strategies.js';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';

// B-5 检测策略（2.4.3）：子任务清单（工具 + 规则）+ 执行周期；定时触发建组合任务并启动。

const P = '__p2bb_strat_';
const TENANT_NAME = 'P2BB检测策略测试租户';
const PASSWORD = ['Detect', 'Strategy', '12345'].join('@');

let app: Awaited<ReturnType<typeof buildApp>>;
const tokens = { admin: '', auditor: '', operator: '', tenantAdmin: '' };
let operatorId = '';
let targetId = '';
let questionSetId = '';
const schedulerCalls: string[] = [];
let launches = 0;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const fakeLaunchers: Partial<Launchers> = {
  eval_task: async (_params, ctx) => {
    launches += 1;
    const task = await prisma.evalTask.create({
      data: { name: P + ctx.title, modelTargetId: targetId, createdById: ctx.user.id },
    });
    return { recordKind: 'eval_task', recordId: task.id };
  },
};

const evalItems = () => [
  {
    kind: 'eval_task',
    title: '内容评估',
    params: { modelTargetId: targetId, questionSetIds: [questionSetId] },
  },
];

async function cleanup(): Promise<void> {
  const strategies = await prismaUnscoped.detectStrategy.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  const ids = strategies.map((s) => s.id);
  const jobs = await prismaUnscoped.detectJob.findMany({
    where: { OR: [{ strategyId: { in: ids } }, { name: { startsWith: P } }] },
    select: { id: true },
  });
  await prismaUnscoped.auditLog.deleteMany({
    where: { targetId: { in: [...ids, ...jobs.map((j) => j.id)] } },
  });
  await prismaUnscoped.detectJob.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } });
  await prismaUnscoped.detectStrategy.deleteMany({ where: { id: { in: ids } } });
  const tasks = await prismaUnscoped.evalTask.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  await prismaUnscoped.auditLog.deleteMany({ where: { targetId: { in: tasks.map((t) => t.id) } } });
  await prismaUnscoped.evalTask.deleteMany({ where: { id: { in: tasks.map((t) => t.id) } } });
  await prismaUnscoped.question.deleteMany({ where: { questionSet: { name: { startsWith: P } } } });
  await prismaUnscoped.questionSet.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.modelTarget.deleteMany({ where: { name: { startsWith: P } } });
  const tenants = await prismaUnscoped.tenant.findMany({
    where: { name: TENANT_NAME },
    select: { id: true },
  });
  const tenantIds = tenants.map((t) => t.id);
  await prismaUnscoped.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prismaUnscoped.user.deleteMany({
    where: { OR: [{ username: { startsWith: P } }, { tenantId: { in: tenantIds } }] },
  });
  await prismaUnscoped.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

async function createUser(username: string, roleName: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  const user = await prisma.user.create({
    data: {
      username,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: username,
      roles: { create: { roleId: role.id } },
    },
  });
  return { id: user.id, token: await login(username, PASSWORD) };
}

function send(
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  token = tokens.admin,
) {
  return app.inject({ method, url, headers: bearer(token), payload: payload as object });
}

async function createStrategy(payload: Record<string, unknown>, token = tokens.admin) {
  const res = await send(
    'POST',
    '/api/detect-strategies',
    { items: evalItems(), ...payload },
    token,
  );
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

const inPlatform = <T>(fn: () => Promise<T>) => runInTenant(PLATFORM_TENANT_ID, fn);

before(async () => {
  app = await buildApp({
    detectJobs: { launchers: fakeLaunchers },
    detectStrategyScheduler: {
      sync: async (s) => {
        schedulerCalls.push(`sync:${s.id}:${s.enabled && s.cron ? 'on' : 'off'}`);
      },
      remove: async (id) => {
        schedulerCalls.push(`remove:${id}`);
      },
    },
  });
  await app.ready();
  await cleanup();
  tokens.admin = await login('admin', ['Admin', '@', '12345'].join(''));
  tokens.auditor = (await createUser(`${P}au`, 'auditor')).token;
  const op = await createUser(`${P}op`, 'operator');
  tokens.operator = op.token;
  operatorId = op.id;
  const tenant = await send('POST', '/api/tenants', {
    name: TENANT_NAME,
    admin: { username: `${P}tadmin`, password: PASSWORD },
  });
  assert.equal(tenant.statusCode, 201, tenant.body);
  await skipFirstPasswordChange(`${P}tadmin`);
  tokens.tenantAdmin = await login(`${P}tadmin`, PASSWORD);
  targetId = (
    await prisma.modelTarget.create({
      data: {
        name: `${P}target`,
        provider: 'openai-compatible',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'dummy-strategy-key', // pragma: allowlist secret
        model: 'fake-model',
      },
    })
  ).id;
  questionSetId = (
    await prisma.questionSet.create({
      data: { name: `${P}样本库`, questions: { create: [{ content: '题目' }] } },
    })
  ).id;
});

beforeEach(() => {
  schedulerCalls.length = 0;
  launches = 0;
});

afterEach(async () => {
  await prismaUnscoped.detectJob.updateMany({
    where: {
      strategy: { name: { startsWith: P } },
      status: { in: ['PENDING', 'RUNNING', 'PAUSED'] },
    },
    data: { status: 'CANCELED' },
  });
});

after(async () => {
  await cleanup();
  await app.close();
});

test('建、改、启停、删、列表；各步都同步调度', async () => {
  const s = await createStrategy({ name: `${P}每天`, cron: '0 3 * * *', maxParallel: 2 });
  assert.equal(s.cron, '0 3 * * *');
  assert.equal(s.timezone, 'Asia/Shanghai');
  assert.equal(s.maxParallel, 2);
  assert.equal(s.items.length, 1);
  assert.ok(s.nextRunAt);
  assert.deepEqual(schedulerCalls, [`sync:${s.id}:on`]);

  const patched = await send('PATCH', `/api/detect-strategies/${s.id}`, {
    name: `${P}每天改`,
    description: '凌晨跑',
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().name, `${P}每天改`);
  const off = await send('PATCH', `/api/detect-strategies/${s.id}`, { enabled: false });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().enabled, false);
  assert.equal(off.json().nextRunAt, null);

  const list = await app.inject({ url: '/api/detect-strategies', headers: bearer(tokens.auditor) });
  assert.equal(list.statusCode, 200, list.body);
  assert.ok(list.json().items.some((x: { id: string }) => x.id === s.id));
  const one = await app.inject({
    url: `/api/detect-strategies/${s.id}`,
    headers: bearer(tokens.auditor),
  });
  assert.equal(one.statusCode, 200);

  const manual = await createStrategy({ name: `${P}手动`, cron: null });
  assert.equal(manual.nextRunAt, null);
  const dup = await send('POST', '/api/detect-strategies', {
    name: `${P}手动`,
    items: evalItems(),
  });
  assert.equal(dup.statusCode, 409, dup.body);

  const del = await send('DELETE', `/api/detect-strategies/${s.id}`);
  assert.equal(del.statusCode, 200, del.body);
  assert.deepEqual(schedulerCalls, [
    `sync:${s.id}:on`,
    `sync:${s.id}:on`,
    `sync:${s.id}:off`,
    `sync:${manual.id}:off`,
    `remove:${s.id}`,
  ]);
  const audits = await prismaUnscoped.auditLog.findMany({
    where: { targetId: s.id },
    select: { action: true },
  });
  assert.deepEqual([...new Set(audits.map((a) => a.action))].sort(), [
    'detect_strategy.create',
    'detect_strategy.delete',
    'detect_strategy.update',
  ]);
});

test('cron 无效、间隔太短、时区无效都是 400；子任务不合法 400', async () => {
  const bad = await send('POST', '/api/detect-strategies', {
    name: `${P}坏`,
    items: evalItems(),
    cron: 'not a cron',
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().error.code, 'EVAL_PLAN_CRON_INVALID');
  const short = await send('POST', '/api/detect-strategies', {
    name: `${P}太密`,
    items: evalItems(),
    cron: '*/5 * * * *',
    minIntervalMinutes: 60,
  });
  assert.equal(short.statusCode, 400, short.body);
  assert.equal(short.json().error.code, 'EVAL_PLAN_INTERVAL_TOO_SHORT');
  const tz = await send('POST', '/api/detect-strategies', {
    name: `${P}时区`,
    items: evalItems(),
    cron: '0 3 * * *',
    timezone: 'Mars/Base',
  });
  assert.equal(tz.statusCode, 400, tz.body);
  assert.equal(tz.json().error.code, 'EVAL_PLAN_TIMEZONE_INVALID');
  const item = await send('POST', '/api/detect-strategies', {
    name: `${P}子任务坏`,
    items: [{ kind: 'asset_discovery', params: { targets: ['10.0.0.1'] } }],
  });
  assert.equal(item.statusCode, 400, item.body);
  assert.match(item.json().error.message, /第 1 项/);
});

test('立即执行：建出属于该策略的组合任务并启动', async () => {
  const s = await createStrategy({ name: `${P}立即执行`, cron: null });
  const res = await send('POST', `/api/detect-strategies/${s.id}/run`);
  assert.equal(res.statusCode, 201, res.body);
  const job = await prisma.detectJob.findUniqueOrThrow({ where: { id: res.json().id } });
  assert.equal(job.strategyId, s.id);
  assert.equal(job.status, 'RUNNING');
  assert.equal(job.triggeredBy, 'manual');
  assert.equal(launches, 1);
  const jobs = await app.inject({
    url: `/api/detect-strategies/${s.id}/jobs`,
    headers: bearer(tokens.auditor),
  });
  assert.equal(jobs.statusCode, 200, jobs.body);
  assert.deepEqual(
    jobs.json().items.map((j: { id: string }) => j.id),
    [job.id],
  );
  const row = await prisma.detectStrategy.findUniqueOrThrow({ where: { id: s.id } });
  assert.ok(row.lastTriggeredAt);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'detect_strategy.trigger', targetId: s.id },
  });
  assert.ok(audit);
});

test('调度触发：上一个没结束、停用、不足最小间隔、发起人缺权限都跳过；正常时按调度建任务', async () => {
  const s = await createStrategy(
    { name: `${P}调度`, cron: '0 3 * * *', minIntervalMinutes: 60 },
    tokens.operator,
  );
  const fire = () => inPlatform(() => triggerDetectStrategy(s.id, { triggeredBy: 'schedule' }));

  const first = await fire();
  assert.equal(first.status, 'triggered');
  const job = await prisma.detectJob.findUniqueOrThrow({ where: { id: first.jobId! } });
  assert.equal(job.triggeredBy, 'schedule');
  assert.equal(job.strategyId, s.id);
  assert.equal(job.status, 'RUNNING');
  assert.equal(job.createdById, operatorId);

  const busy = await fire();
  assert.equal(busy.status, 'skipped');
  assert.match(busy.reason!, /未结束/);
  let row = await prisma.detectStrategy.findUniqueOrThrow({ where: { id: s.id } });
  assert.match(row.lastSkipReason!, /未结束/);

  await prisma.detectJob.update({ where: { id: job.id }, data: { status: 'COMPLETED' } });
  const tooSoon = await fire();
  assert.equal(tooSoon.status, 'skipped');
  assert.match(tooSoon.reason!, /最小间隔/);

  await prisma.detectStrategy.update({
    where: { id: s.id },
    data: { lastTriggeredAt: new Date(Date.now() - 2 * 3600_000) },
  });
  await prisma.detectStrategy.update({ where: { id: s.id }, data: { enabled: false } });
  const disabled = await fire();
  assert.equal(disabled.status, 'skipped');
  assert.match(disabled.reason!, /停用/);

  await prisma.detectStrategy.update({ where: { id: s.id }, data: { enabled: true } });
  await prisma.user.update({ where: { id: operatorId }, data: { isActive: false } });
  try {
    const noPerm = await fire();
    assert.equal(noPerm.status, 'skipped');
    assert.equal(noPerm.reason, '发起人已停用');
  } finally {
    await prisma.user.update({ where: { id: operatorId }, data: { isActive: true } });
  }

  const again = await fire();
  assert.equal(again.status, 'triggered');
  row = await prisma.detectStrategy.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(row.lastSkipReason, null);
  assert.equal(await prisma.detectJob.count({ where: { strategyId: s.id } }), 2);
});

test('另一个租户看不到、改不了；审计员写 403', async () => {
  const s = await createStrategy({ name: `${P}隔离`, cron: null });
  const t = tokens.tenantAdmin;
  assert.equal(
    (await app.inject({ url: `/api/detect-strategies/${s.id}`, headers: bearer(t) })).statusCode,
    404,
  );
  const list = await app.inject({ url: '/api/detect-strategies', headers: bearer(t) });
  assert.ok(!list.json().items.some((x: { id: string }) => x.id === s.id));
  assert.equal(
    (await send('PATCH', `/api/detect-strategies/${s.id}`, { name: 'x' }, t)).statusCode,
    404,
  );
  assert.equal((await send('POST', `/api/detect-strategies/${s.id}/run`, {}, t)).statusCode, 404);
  assert.equal(
    (await send('DELETE', `/api/detect-strategies/${s.id}`, undefined, t)).statusCode,
    404,
  );
  // 别的租户的子任务引用不到本租户的评估对象
  const cross = await send(
    'POST',
    '/api/detect-strategies',
    { name: `${P}跨租户`, items: evalItems() },
    t,
  );
  assert.equal(cross.statusCode, 400, cross.body);

  const au = tokens.auditor;
  assert.equal(
    (await send('POST', '/api/detect-strategies', { name: `${P}审计员`, items: evalItems() }, au))
      .statusCode,
    403,
  );
  assert.equal(
    (await send('PATCH', `/api/detect-strategies/${s.id}`, { name: 'x' }, au)).statusCode,
    403,
  );
  assert.equal((await send('POST', `/api/detect-strategies/${s.id}/run`, {}, au)).statusCode, 403);
  assert.equal(
    (await send('DELETE', `/api/detect-strategies/${s.id}`, undefined, au)).statusCode,
    403,
  );
});

test('调度触发：子任务关联的台账资产已不存在时去掉关联照常建任务', async () => {
  const s = await prisma.detectStrategy.create({
    data: {
      name: `${P}台账失效`,
      createdById: operatorId,
      cron: '0 3 * * *',
      items: [
        {
          kind: 'eval_task',
          title: '内容评估',
          params: { modelTargetId: targetId, questionSetIds: [questionSetId] },
          ledgerAssetId: '00000000-0000-4000-8000-0000000000bb',
        },
      ],
    },
  });
  const out = await inPlatform(() => triggerDetectStrategy(s.id, { triggeredBy: 'schedule' }));
  assert.equal(out.status, 'triggered', JSON.stringify(out));
  assert.equal(out.droppedLedgerAssets, 1);
  const item = await prisma.detectJobItem.findFirstOrThrow({ where: { jobId: out.jobId! } });
  assert.equal(item.ledgerAssetId, null);
});
