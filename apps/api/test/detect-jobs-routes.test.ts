import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { detectRecordHref } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { AppError } from '../src/lib/errors.js';
import { runInTenant } from '../src/lib/tenant-context.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import type { Launchers } from '../src/modules/detect-jobs/launchers.js';
import { itemRefError } from '../src/modules/detect-jobs/service.js';
import {
  advanceDetectJob,
  DETECT_JOB_LAUNCH_STALE_MS,
  recoverInterruptedDetectWork,
  tickDetectJobs,
} from '../src/modules/detect-jobs/orchestrator.js';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';

// B-4 组合任务（2.4.2 一键启动、2.4.9）：创建、启动、暂停、恢复、停止，按并发上限编排子任务。
// 启动函数注入假实现：评估类子任务建一条真实的评估任务记录，便于编排同步状态。

const P = '__p2bb_jobs_';
const TENANT_NAME = 'P2BB组合任务测试租户';
const PASSWORD = ['Detect', 'Jobs', '12345'].join('@');

let app: Awaited<ReturnType<typeof buildApp>>;
const tokens = { admin: '', auditor: '', operator: '', limited: '', tenantAdmin: '' };
let operatorId = '';
let operator2 = '';
let targetId = '';
let questionSetId = '';
let launches: Array<{ kind: string; title: string }> = [];
let launchDelayMs = 0;
const pauseCalls: string[] = [];
const cancelCalls: string[] = [];

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const fakeLaunchers: Partial<Launchers> = {
  eval_task: async (_params, ctx) => {
    launches.push({ kind: 'eval_task', title: ctx.title });
    if (launchDelayMs) await new Promise((r) => setTimeout(r, launchDelayMs));
    if (ctx.title.includes('启动失败')) throw new AppError(400, '所选评估对象已禁用', 'X');
    const task = await prisma.evalTask.create({
      data: { name: ctx.title, modelTargetId: targetId, createdById: ctx.user.id },
    });
    return { recordKind: 'eval_task', recordId: task.id };
  },
  model_file_scan: async (params, ctx) => {
    launches.push({ kind: 'model_file_scan', title: ctx.title });
    const scan = await prisma.modelFileScan.create({
      data: {
        source: 'DIRECTORY',
        path: `/models/${P}${ctx.title}`,
        status: 'PENDING',
        createdById: ctx.user.id,
      },
    });
    return { recordKind: 'model_file_scan', recordId: scan.id };
  },
};

function evalItem(title: string) {
  return {
    kind: 'eval_task',
    title: P + title,
    params: { modelTargetId: targetId, questionSetIds: [questionSetId] },
  };
}

async function cleanup(): Promise<void> {
  const jobs = await prismaUnscoped.detectJob.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  const jobIds = jobs.map((j) => j.id);
  await prismaUnscoped.auditLog.deleteMany({ where: { targetId: { in: jobIds } } });
  await prismaUnscoped.detectJob.deleteMany({ where: { id: { in: jobIds } } });
  const tasks = await prismaUnscoped.evalTask.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  await prismaUnscoped.auditLog.deleteMany({
    where: { targetId: { in: tasks.map((t) => t.id) } },
  });
  await prismaUnscoped.evalTask.deleteMany({ where: { id: { in: tasks.map((t) => t.id) } } });
  await prismaUnscoped.modelFileScan.deleteMany({
    where: { path: { startsWith: `/models/${P}` } },
  });
  await prismaUnscoped.assetDiscoveryRun.deleteMany({ where: { createdByName: `${P}stale` } });
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
  await prismaUnscoped.role.deleteMany({ where: { name: { startsWith: P } } });
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

async function createUser(
  username: string,
  roleName: string,
): Promise<{ id: string; token: string }> {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  const user = await prisma.user.create({
    data: {
      username,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: username,
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  return { id: user.id, token: await login(username, PASSWORD) };
}

function post(url: string, payload?: unknown, token = tokens.admin) {
  return app.inject({ method: 'POST', url, headers: bearer(token), payload: payload as object });
}

async function createJob(
  payload: Record<string, unknown>,
  token = tokens.admin,
): Promise<{ id: string; body: any }> {
  const res = await post('/api/detect-jobs', payload, token);
  assert.equal(res.statusCode, 201, res.body);
  return { id: res.json().id, body: res.json() };
}

async function items(jobId: string) {
  return prisma.detectJobItem.findMany({ where: { jobId }, orderBy: { position: 'asc' } });
}

async function completeRecords(jobId: string): Promise<void> {
  const rows = await items(jobId);
  const ids = rows.filter((r) => r.recordId).map((r) => r.recordId!);
  await prisma.evalTask.updateMany({ where: { id: { in: ids } }, data: { status: 'COMPLETED' } });
}

const tick = () => tickDetectJobs({ launchers: fakeLaunchers });

before(async () => {
  app = await buildApp({
    detectJobs: { launchers: fakeLaunchers },
    pauseEvalTask: async (id) => {
      pauseCalls.push(id);
    },
    cancelEvalTask: async (id) => {
      cancelCalls.push(id);
    },
  });
  await app.ready();
  await cleanup();
  tokens.admin = await login('admin', ['Admin', '@', '12345'].join(''));
  tokens.auditor = (await createUser(`${P}au`, 'auditor')).token;
  const op = await createUser(`${P}op`, 'operator');
  tokens.operator = op.token;
  operatorId = op.id;
  operator2 = (await createUser(`${P}op2`, 'operator')).token;

  // 自建角色：能管组合任务、能发起评估，但不能发起语料扫描
  const perms = await prisma.permission.findMany({
    where: { code: { in: ['detect_task:read', 'detect_task:manage', 'eval_task:create'] } },
  });
  await prisma.role.create({
    data: {
      name: `${P}role`,
      description: '组合任务测试',
      permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
    },
  });
  tokens.limited = (await createUser(`${P}limited`, `${P}role`)).token;

  const tenant = await post('/api/tenants', {
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
        apiKey: 'dummy-jobs-key', // pragma: allowlist secret
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
  launches = [];
  launchDelayMs = 0;
});

// 每条用例结束把本文件还没结束的组合任务停掉，免得后面用例的 tick 又推进它们。
afterEach(async () => {
  await prismaUnscoped.detectJob.updateMany({
    where: { name: { startsWith: P }, status: { in: ['PENDING', 'RUNNING', 'PAUSED'] } },
    data: { status: 'CANCELED' },
  });
});

after(async () => {
  await cleanup();
  await app.close();
});

test('建任务：子任务 0 个或 21 个 400；第 2 项参数不合法 400；缺该类检测权限 403', async () => {
  const empty = await post('/api/detect-jobs', { name: `${P}空`, items: [] });
  assert.equal(empty.statusCode, 400, empty.body);
  const many = await post('/api/detect-jobs', {
    name: `${P}太多`,
    items: Array.from({ length: 21 }, (_, i) => evalItem(`第${i}`)),
  });
  assert.equal(many.statusCode, 400, many.body);

  const bad = await post('/api/detect-jobs', {
    name: `${P}参数不合法`,
    items: [evalItem('好'), { kind: 'asset_discovery', params: { targets: ['10.0.0.1'] } }],
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match(bad.json().error.message, /第 2 项/);

  const missingRef = await post('/api/detect-jobs', {
    name: `${P}对象不存在`,
    items: [
      {
        kind: 'eval_task',
        params: { modelTargetId: questionSetId, questionSetIds: [questionSetId] },
      },
    ],
  });
  assert.equal(missingRef.statusCode, 400, missingRef.body);
  assert.match(missingRef.json().error.message, /第 1 项/);

  const denied = await post(
    '/api/detect-jobs',
    {
      name: `${P}缺权限`,
      items: [evalItem('评估'), { kind: 'corpus_scan', params: { sourceScanId: questionSetId } }],
    },
    tokens.limited,
  );
  assert.equal(denied.statusCode, 403, denied.body);
  assert.match(denied.json().error.message, /第 2 项/);
  assert.equal(await prisma.detectJob.count({ where: { name: { startsWith: P } } }), 0);
});

test('一键启动：并发上限 2、4 个子任务，立即启动 2 个，组合任务执行中', async () => {
  const { id, body } = await createJob({
    name: `${P}一键启动`,
    maxParallel: 2,
    start: true,
    items: ['一', '二', '三', '四'].map((t) => evalItem(t)),
  });
  assert.equal(body.status, 'RUNNING');
  assert.equal(launches.length, 2);
  const job = await prisma.detectJob.findUniqueOrThrow({ where: { id } });
  assert.equal(job.status, 'RUNNING');
  assert.ok(job.startedAt);
  assert.equal(job.triggeredBy, 'manual');
  const rows = await items(id);
  assert.deepEqual(
    rows.map((r) => Boolean(r.recordId)),
    [true, true, false, false],
  );
});

test('编排：前两项完成后推进启动后两项；全部完成后组合任务已完成', async () => {
  const { id } = await createJob({
    name: `${P}编排`,
    maxParallel: 2,
    start: true,
    items: ['一', '二', '三', '四'].map((t) => evalItem(t)),
  });
  assert.equal(launches.length, 2);
  await completeRecords(id);
  await tick();
  assert.equal(launches.length, 4);
  let job = await prisma.detectJob.findUniqueOrThrow({ where: { id } });
  assert.equal(job.status, 'RUNNING');
  await completeRecords(id);
  await tick();
  job = await prisma.detectJob.findUniqueOrThrow({ where: { id } });
  assert.equal(job.status, 'COMPLETED');
  assert.ok(job.finishedAt);
  assert.ok((await items(id)).every((r) => r.status === 'COMPLETED'));
});

test('编排：一项启动失败，该项失败并记原因；其余完成后组合任务失败', async () => {
  const { id } = await createJob({
    name: `${P}部分失败`,
    maxParallel: 4,
    start: true,
    items: [evalItem('正常'), evalItem('启动失败')],
  });
  const rows = await items(id);
  assert.equal(rows[1]!.status, 'FAILED');
  assert.equal(rows[1]!.error, '所选评估对象已禁用');
  assert.equal(rows[1]!.recordId, null);
  await completeRecords(id);
  await tick();
  const job = await prisma.detectJob.findUniqueOrThrow({ where: { id } });
  assert.equal(job.status, 'FAILED');
  assert.ok(job.finishedAt);
});

test('暂停：不再启动新子任务，已启动的评估任务收到暂停；恢复后继续启动', async () => {
  const { id } = await createJob({
    name: `${P}暂停`,
    maxParallel: 1,
    start: true,
    items: [evalItem('一'), evalItem('二')],
  });
  assert.equal(launches.length, 1);
  const first = (await items(id))[0]!;
  const paused = await post(`/api/detect-jobs/${id}/pause`);
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(paused.json().status, 'PAUSED');
  assert.ok(pauseCalls.includes(first.recordId!));
  assert.equal(
    (await prisma.evalTask.findUniqueOrThrow({ where: { id: first.recordId! } })).status,
    'PAUSED',
  );
  await prisma.evalTask.update({ where: { id: first.recordId! }, data: { status: 'COMPLETED' } });
  await tick();
  await runInTenant(PLATFORM_TENANT_ID, () => advanceDetectJob(id, { launchers: fakeLaunchers }));
  assert.equal(launches.length, 1, '暂停后不再启动新子任务');
  assert.equal((await post(`/api/detect-jobs/${id}/pause`)).statusCode, 409);

  const resumed = await post(`/api/detect-jobs/${id}/resume`);
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(resumed.json().status, 'RUNNING');
  assert.equal(launches.length, 2, '恢复后继续启动');
});

test('暂停后恢复：已暂停的评估任务子任务一起恢复', async () => {
  const { id } = await createJob({
    name: `${P}恢复评估`,
    maxParallel: 1,
    start: true,
    items: [evalItem('一'), evalItem('二')],
  });
  const first = (await items(id))[0]!;
  assert.equal((await post(`/api/detect-jobs/${id}/pause`)).statusCode, 200);
  assert.equal((await post(`/api/detect-jobs/${id}/resume`)).statusCode, 200);
  assert.equal(
    (await prisma.evalTask.findUniqueOrThrow({ where: { id: first.recordId! } })).status,
    'PENDING',
  );
  assert.equal(launches.length, 1, '第一项还在排队，占着并发名额');
});

test('停止：没启动的子任务取消，已启动的评估任务停止，组合任务已停止；已结束的再停止 409', async () => {
  const { id } = await createJob({
    name: `${P}停止`,
    maxParallel: 1,
    start: true,
    items: [evalItem('一'), evalItem('二'), evalItem('三')],
  });
  const first = (await items(id))[0]!;
  const stopped = await post(`/api/detect-jobs/${id}/stop`);
  assert.equal(stopped.statusCode, 200, stopped.body);
  assert.equal(stopped.json().status, 'CANCELED');
  const job = await prisma.detectJob.findUniqueOrThrow({ where: { id } });
  assert.equal(job.status, 'CANCELED');
  assert.equal(job.stopRequested, true);
  assert.ok(job.finishedAt);
  const rows = await items(id);
  assert.deepEqual(
    rows.slice(1).map((r) => r.status),
    ['CANCELED', 'CANCELED'],
  );
  assert.ok(cancelCalls.includes(first.recordId!));
  assert.equal(
    (await prisma.evalTask.findUniqueOrThrow({ where: { id: first.recordId! } })).status,
    'CANCELED',
  );
  const again = await post(`/api/detect-jobs/${id}/stop`);
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().error.code, 'DETECT_JOB_STATE_CONFLICT');

  const pending = await createJob({ name: `${P}未启动就停止`, items: [evalItem('一')] });
  const s2 = await post(`/api/detect-jobs/${pending.id}/stop`);
  assert.equal(s2.statusCode, 200, s2.body);
  assert.equal((await items(pending.id))[0]!.status, 'CANCELED');
  assert.equal(launches.length, 1);
});

test('租约：两个并发推进只启动一批；租约过期后别的推进进来也不超过并发上限', async () => {
  const { id } = await createJob({
    name: `${P}租约`,
    maxParallel: 2,
    items: ['一', '二', '三', '四'].map((t) => evalItem(t)),
  });
  await prisma.detectJob.update({
    where: { id },
    data: { status: 'RUNNING', startedAt: new Date() },
  });
  launchDelayMs = 80;
  await runInTenant(PLATFORM_TENANT_ID, () =>
    Promise.all([
      advanceDetectJob(id, { launchers: fakeLaunchers }),
      advanceDetectJob(id, { launchers: fakeLaunchers }),
    ]),
  );
  assert.equal(launches.length, 2);
  let job = await prisma.detectJob.findUniqueOrThrow({ where: { id } });
  assert.equal(job.leaseUntil, null, '推进完释放租约');
  assert.equal(job.leaseOwner, null);

  // 单次启动超过租约时长：另一个推进拿到过期租约，也只能在剩余名额里启动
  const other = await createJob({
    name: `${P}租约过期`,
    maxParallel: 2,
    items: ['一', '二', '三', '四'].map((t) => evalItem(t)),
  });
  await prisma.detectJob.update({
    where: { id: other.id },
    data: { status: 'RUNNING', startedAt: new Date() },
  });
  launches = [];
  launchDelayMs = 300;
  const a = runInTenant(PLATFORM_TENANT_ID, () =>
    advanceDetectJob(other.id, { launchers: fakeLaunchers }),
  );
  await new Promise((r) => setTimeout(r, 100));
  await prisma.$executeRaw`UPDATE "detect_jobs" SET "leaseUntil" = now() - interval '1 second' WHERE id = ${other.id}`;
  const b = runInTenant(PLATFORM_TENANT_ID, () =>
    advanceDetectJob(other.id, { launchers: fakeLaunchers }),
  );
  await Promise.all([a, b]);
  const launched = await prisma.detectJobItem.count({
    where: { jobId: other.id, recordId: { not: null } },
  });
  assert.equal(launched, 2, '不超过并发上限');
  job = await prisma.detectJob.findUniqueOrThrow({ where: { id: other.id } });
  assert.equal(job.leaseUntil, null);
});

test('推进：发起人被停用时子任务失败，原因写明', async () => {
  const { id } = await createJob(
    { name: `${P}发起人停用`, items: [evalItem('一'), evalItem('二')] },
    tokens.operator,
  );
  await prisma.detectJob.update({
    where: { id },
    data: { status: 'RUNNING', startedAt: new Date() },
  });
  await prisma.user.update({ where: { id: operatorId }, data: { isActive: false } });
  try {
    await tick();
  } finally {
    await prisma.user.update({ where: { id: operatorId }, data: { isActive: true } });
  }
  assert.equal(launches.length, 0);
  const rows = await items(id);
  assert.ok(rows.every((r) => r.status === 'FAILED'));
  assert.ok(rows.every((r) => r.error === '发起人已停用'));
  const job = await prisma.detectJob.findUniqueOrThrow({ where: { id } });
  assert.equal(job.status, 'FAILED');
});

test('worker 推进：按发起人启动，子任务记录归组合任务的租户', async () => {
  const { id } = await createJob(
    { name: `${P}worker启动`, items: [evalItem('一')] },
    tokens.operator,
  );
  await prisma.detectJob.update({
    where: { id },
    data: { status: 'RUNNING', startedAt: new Date() },
  });
  await tick();
  assert.equal(launches.length, 1);
  const row = (await items(id))[0]!;
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: row.recordId! } });
  assert.equal(task.createdById, operatorId);
  assert.equal(task.tenantId, PLATFORM_TENANT_ID);
});

test('详情：子任务带链接、记录名称、统一状态和可用操作，状态从记录同步；列表带各状态数', async () => {
  const { id } = await createJob({
    name: `${P}详情`,
    maxParallel: 1,
    start: true,
    items: [evalItem('一'), evalItem('二')],
  });
  const first = (await items(id))[0]!;
  await prisma.evalTask.update({ where: { id: first.recordId! }, data: { status: 'RUNNING' } });
  const res = await app.inject({ url: `/api/detect-jobs/${id}`, headers: bearer(tokens.auditor) });
  assert.equal(res.statusCode, 200, res.body);
  const detail = res.json();
  const item = detail.items[0];
  assert.equal(item.status, 'RUNNING');
  assert.equal(item.recordKind, 'eval_task');
  assert.equal(item.href, detectRecordHref('eval_task', first.recordId!));
  assert.equal(item.recordName, `${P}一`);
  // 操作按查看人的权限给：审计员没有暂停、停止权限
  assert.deepEqual(item.actions, []);
  const asAdmin = await app.inject({ url: `/api/detect-jobs/${id}`, headers: bearer(tokens.admin) });
  assert.deepEqual(asAdmin.json().items[0].actions, ['pause', 'stop']);
  assert.equal(detail.items[1].status, 'PENDING');
  assert.equal(detail.items[1].href, null);
  assert.equal((await items(id))[0]!.status, 'RUNNING', '读详情时同步了状态');

  const list = await app.inject({
    url: '/api/detect-jobs?pageSize=100',
    headers: bearer(tokens.auditor),
  });
  assert.equal(list.statusCode, 200, list.body);
  const row = list.json().items.find((j: { id: string }) => j.id === id);
  assert.equal(row.itemCount, 2);
  assert.equal(row.itemCounts.RUNNING, 1);
  assert.equal(row.itemCounts.PENDING, 1);
});

test('另一个租户看不到、改不了；审计员写操作 403；删除只允许未启动或已结束；写审计', async () => {
  const { id } = await createJob({ name: `${P}隔离`, items: [evalItem('一')] });
  const t = tokens.tenantAdmin;
  assert.equal(
    (await app.inject({ url: `/api/detect-jobs/${id}`, headers: bearer(t) })).statusCode,
    404,
  );
  const list = await app.inject({ url: '/api/detect-jobs?pageSize=100', headers: bearer(t) });
  assert.ok(!list.json().items.some((j: { id: string }) => j.id === id));
  for (const action of ['start', 'pause', 'resume', 'stop']) {
    assert.equal((await post(`/api/detect-jobs/${id}/${action}`, {}, t)).statusCode, 404, action);
  }
  assert.equal(
    (await app.inject({ method: 'DELETE', url: `/api/detect-jobs/${id}`, headers: bearer(t) }))
      .statusCode,
    404,
  );
  // 别的租户的推进拿不到租约，也不会启动
  await runInTenant(
    (await prismaUnscoped.tenant.findFirstOrThrow({ where: { name: TENANT_NAME } })).id,
    () => advanceDetectJob(id, { launchers: fakeLaunchers }),
  );
  assert.equal(launches.length, 0);

  const denied = await post(
    '/api/detect-jobs',
    { name: `${P}审计员`, items: [evalItem('一')] },
    tokens.auditor,
  );
  assert.equal(denied.statusCode, 403);
  assert.equal((await post(`/api/detect-jobs/${id}/start`, {}, tokens.auditor)).statusCode, 403);

  assert.equal((await post(`/api/detect-jobs/${id}/start`)).statusCode, 200);
  assert.equal((await post(`/api/detect-jobs/${id}/start`)).statusCode, 409);
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/detect-jobs/${id}`,
        headers: bearer(tokens.admin),
      })
    ).statusCode,
    409,
    '执行中的不能删',
  );
  assert.equal((await post(`/api/detect-jobs/${id}/pause`)).statusCode, 200);
  assert.equal((await post(`/api/detect-jobs/${id}/resume`)).statusCode, 200);
  assert.equal((await post(`/api/detect-jobs/${id}/stop`)).statusCode, 200);
  const record = (await items(id))[0]!.recordId!;
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/detect-jobs/${id}`,
    headers: bearer(tokens.admin),
  });
  assert.equal(del.statusCode, 200, del.body);
  assert.equal(await prisma.detectJob.count({ where: { id } }), 0);
  assert.equal(await prisma.evalTask.count({ where: { id: record } }), 1, '不删子任务建出的记录');

  const audits = await prismaUnscoped.auditLog.findMany({
    where: { targetId: id },
    select: { action: true },
  });
  const actions = new Set(audits.map((a) => a.action));
  for (const a of [
    'detect_job.create',
    'detect_job.start',
    'detect_job.pause',
    'detect_job.resume',
    'detect_job.stop',
    'detect_job.delete',
  ]) {
    assert.ok(actions.has(a), a);
  }
});

// ---- 审查修复：启动中断、停止与启动并发、恢复时撤回暂停、创建人身份、启动维护、台账资产 ----

test('启动中断：已领取、没写回记录的子任务占着名额，超时后置失败并启动下一项', async () => {
  const { id } = await createJob({
    name: `${P}启动中断`,
    maxParallel: 1,
    start: true,
    items: [evalItem('一'), evalItem('二'), evalItem('三')],
  });
  const rows = await items(id);
  await prisma.evalTask.update({
    where: { id: rows[0]!.recordId! },
    data: { status: 'COMPLETED' },
  });
  // 模拟：第 2 项被某个进程领取后，进程在写回记录前重启
  await prisma.detectJobItem.update({
    where: { id: rows[1]!.id },
    data: { launchedAt: new Date() },
  });
  launches = [];
  await tick();
  assert.equal(launches.length, 0, '领取中的子任务占着名额');
  await prisma.detectJobItem.update({
    where: { id: rows[1]!.id },
    data: { launchedAt: new Date(Date.now() - DETECT_JOB_LAUNCH_STALE_MS - 60_000) },
  });
  await tick();
  const after = await items(id);
  assert.equal(after[1]!.status, 'FAILED');
  assert.match(after[1]!.error!, /启动中断/);
  assert.equal(launches.length, 1);
  assert.ok(after[2]!.recordId, '启动了下一项');
});

test('停止和启动并发：启动途中的子任务写回后跟着停止', async () => {
  const { id } = await createJob({ name: `${P}停止竞态`, maxParallel: 1, items: [evalItem('一')] });
  launchDelayMs = 300;
  const starting = post(`/api/detect-jobs/${id}/start`);
  await new Promise((r) => setTimeout(r, 120));
  const stop = await post(`/api/detect-jobs/${id}/stop`);
  assert.equal(stop.statusCode, 200, stop.body);
  await starting;
  const item = (await items(id))[0]!;
  assert.ok(item.recordId);
  assert.equal(item.status, 'CANCELED');
  assert.ok(cancelCalls.includes(item.recordId!));
  const record = await prisma.evalTask.findUniqueOrThrow({ where: { id: item.recordId! } });
  assert.equal(record.status, 'CANCELED');
});

test('恢复组合任务：暂停中（在途题没做完）的评估子任务撤回暂停请求', async () => {
  const { id } = await createJob({
    name: `${P}恢复撤回`,
    maxParallel: 1,
    start: true,
    items: [evalItem('一')],
  });
  const taskId = (await items(id))[0]!.recordId!;
  await prisma.evalTask.update({ where: { id: taskId }, data: { status: 'RUNNING' } });
  assert.equal((await post(`/api/detect-jobs/${id}/pause`)).statusCode, 200);
  let task = await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } });
  assert.ok(task.pauseRequestedAt, '执行中的子任务进入暂停中');
  assert.equal((await post(`/api/detect-jobs/${id}/resume`)).statusCode, 200);
  task = await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } });
  assert.equal(task.pauseRequestedAt, null, '恢复时撤回了暂停请求');
  assert.equal(task.status, 'RUNNING');
});

test('子任务以组合任务创建人的身份启动；别的管理员停止时也以创建人身份停掉', async () => {
  const { id } = await createJob(
    {
      name: `${P}创建人身份`,
      items: [
        {
          kind: 'model_file_scan',
          title: '目录',
          params: { source: 'directory', path: '/models/a' },
        },
      ],
    },
    tokens.operator,
  );
  // 平台管理员点启动：记录仍以创建人（操作员）的身份建
  assert.equal((await post(`/api/detect-jobs/${id}/start`)).statusCode, 200);
  const scanId = (await items(id))[0]!.recordId!;
  const scan = await prisma.modelFileScan.findUniqueOrThrow({ where: { id: scanId } });
  assert.equal(scan.createdById, operatorId);
  // 另一个操作员停止：模型文件「只能停止自己发起的」也停得掉
  const stop = await post(`/api/detect-jobs/${id}/stop`, {}, operator2);
  assert.equal(stop.statusCode, 200, stop.body);
  const after = await prisma.modelFileScan.findUniqueOrThrow({ where: { id: scanId } });
  assert.equal(after.status, 'CANCELLED');
  const audit = await prismaUnscoped.auditLog.findFirst({
    where: { action: 'model_file_scan.cancel', targetId: scanId },
  });
  assert.equal(audit?.actorName, `${P}op2`, '审计记实际点按钮的人');
});

test('启动维护：启动中断的子任务、被打断的资产测绘都置为失败', async () => {
  const { id } = await createJob({ name: `${P}启动维护`, items: [evalItem('一')] });
  const row = (await items(id))[0]!;
  await prisma.detectJobItem.update({
    where: { id: row.id },
    data: { launchedAt: new Date(Date.now() - DETECT_JOB_LAUNCH_STALE_MS - 60_000) },
  });
  const run = await prisma.assetDiscoveryRun.create({
    data: {
      targets: ['10.0.0.1'],
      ports: [80],
      hostCount: 1,
      portCount: 1,
      status: 'RUNNING',
      createdByName: `${P}stale`,
    },
  });
  await prisma.$executeRaw`UPDATE "asset_discovery_runs" SET "updatedAt" = now() - interval '31 minutes' WHERE id = ${run.id}`;
  const out = await recoverInterruptedDetectWork();
  assert.ok(out.launches >= 1);
  assert.equal((await items(id))[0]!.status, 'FAILED');
  const after = await prisma.assetDiscoveryRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(after.status, 'FAILED');
});

test('子任务关联的台账资产不存在：400 并指出第几项', async () => {
  const res = await post('/api/detect-jobs', {
    name: `${P}台账资产`,
    items: [{ ...evalItem('一'), ledgerAssetId: '00000000-0000-4000-8000-0000000000aa' }],
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'DETECT_JOB_ITEM_REF_NOT_FOUND');
  assert.match(res.json().error.message, /第 1 项/);
});

test('插入时撞外键或租户守卫（台账资产在校验后被删、不属于本租户）：翻成 400，不冒成 500', async () => {
  const items = [
    { kind: 'eval_task' as const, params: {} },
    {
      kind: 'corpus_scan' as const,
      params: {},
      ledgerAssetId: '00000000-0000-4000-8000-0000000000cc',
    },
  ];
  const fk = new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
    code: 'P2003',
    clientVersion: 'test',
    meta: { field_name: 'detect_job_items_ledgerAssetId_fkey (index)' },
  });
  const a = await itemRefError(fk, items);
  assert.ok(a instanceof AppError);
  assert.equal(a.statusCode, 400);
  assert.equal(a.code, 'DETECT_JOB_ITEM_REF_NOT_FOUND');
  assert.match(a.message, /第 2 项/);
  const guard = new Error(
    'LSE_CROSS_TENANT_REFERENCE detect_job_items.ledgerAssetId -> ledger_assets',
  );
  const b = await itemRefError(guard, items);
  assert.ok(b instanceof AppError);
  assert.equal(b.code, 'DETECT_JOB_ITEM_REF_NOT_FOUND');
  assert.match(b.message, /第 2 项/);
  assert.equal(await itemRefError(new Error('别的错误'), items), null);
});
