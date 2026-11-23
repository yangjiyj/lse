import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { runInTenant } from '../src/lib/tenant-context.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import { executeRun } from '../src/modules/asset-discovery/service.js';
import type { Launchers } from '../src/modules/detect-jobs/launchers.js';
import {
  LAUNCH_INTERRUPTED_MESSAGE,
  recoverInterruptedDetectWork,
  tickDetectJobs,
} from '../src/modules/detect-jobs/orchestrator.js';
import { triggerDetectStrategy } from '../src/modules/detect-jobs/strategies.js';

// 组合任务编排的审查修复：停止时创建人缺权限改用点按钮的人、启动写回带条件、资产测绘心跳与周期收尾、
// 策略定时触发的错误写进跳过原因、工具编号校验、评估子任务补必选引擎。

const P = '__p2bb_hard_';
const PASSWORD = ['Hard', 'Ening', '12345'].join('@');
let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';
let creatorToken = '';
let creatorId = '';
let clickerToken = '';
let creatorRoleId = '';
let targetId = '';
let questionSetId = '';
let launchDelayMs = 0;
let onLaunch: (() => Promise<void>) | null = null;
const cancelCalls: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fakeLaunchers: Partial<Launchers> = {
  eval_task: async (_params, ctx) => {
    if (launchDelayMs) await sleep(launchDelayMs);
    if (onLaunch) await onLaunch();
    const task = await prisma.evalTask.create({
      data: { name: ctx.title, modelTargetId: targetId, createdById: ctx.user.id },
    });
    return { recordKind: 'eval_task', recordId: task.id };
  },
};

const evalItem = (title: string, extra: Record<string, unknown> = {}) => ({
  kind: 'eval_task',
  title: P + title,
  params: { modelTargetId: targetId, questionSetIds: [questionSetId] },
  ...extra,
});

function post(url: string, payload?: unknown, token = adminToken) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as object,
  });
}

async function login(username: string, password: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

async function cleanup() {
  const jobs = await prismaUnscoped.detectJob.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  await prismaUnscoped.detectJob.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } });
  await prismaUnscoped.detectStrategy.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.evalTask.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.assetDiscoveryRun.deleteMany({ where: { createdByName: P } });
  await prismaUnscoped.question.deleteMany({ where: { questionSet: { name: { startsWith: P } } } });
  await prismaUnscoped.questionSet.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.modelTarget.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.tool.deleteMany({ where: { code: { startsWith: 'p2bb-hard-' } } });
  const users = await prismaUnscoped.user.findMany({
    where: { username: { startsWith: P } },
    select: { id: true },
  });
  await prismaUnscoped.auditLog.deleteMany({ where: { actorId: { in: users.map((u) => u.id) } } });
  await prismaUnscoped.user.deleteMany({ where: { username: { startsWith: P } } });
  await prismaUnscoped.role.deleteMany({ where: { name: { startsWith: P } } });
}

async function userWithPerms(name: string, codes: string[]) {
  const perms = await prisma.permission.findMany({ where: { code: { in: codes } } });
  const role = await prisma.role.create({
    data: {
      name: `${P}${name}`,
      permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
    },
  });
  const user = await prisma.user.create({
    data: {
      username: `${P}${name}`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: name,
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  return { roleId: role.id, userId: user.id, token: await login(`${P}${name}`, PASSWORD) };
}

async function setCreatorCanDelete(on: boolean) {
  const del = await prisma.permission.findUniqueOrThrow({ where: { code: 'eval_task:delete' } });
  await prisma.rolePermission.deleteMany({
    where: { roleId: creatorRoleId, permissionId: del.id },
  });
  if (on) {
    await prisma.rolePermission.create({ data: { roleId: creatorRoleId, permissionId: del.id } });
  }
}

before(async () => {
  app = await buildApp({
    detectJobs: { launchers: fakeLaunchers },
    pauseEvalTask: async () => undefined,
    cancelEvalTask: async (id) => {
      cancelCalls.push(id);
    },
  });
  await app.ready();
  await cleanup();
  adminToken = await login('admin', ['Admin', '@', '12345'].join(''));
  const creator = await userWithPerms('creator', [
    'detect_task:read',
    'detect_task:manage',
    'eval_task:create',
    'eval_task:read',
    'eval_task:delete',
    'eval_task:re_eval',
  ]);
  creatorToken = creator.token;
  creatorId = creator.userId;
  creatorRoleId = creator.roleId;
  clickerToken = (await userWithPerms('clicker', ['detect_task:read', 'detect_task:manage'])).token;
  targetId = (
    await prisma.modelTarget.create({
      data: {
        name: `${P}target`,
        provider: 'openai-compatible',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'dummy', // pragma: allowlist secret
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
  launchDelayMs = 0;
  onLaunch = null;
});

after(async () => {
  await cleanup();
  await app.close();
});

async function startedJob(name: string) {
  const res = await post(
    '/api/detect-jobs',
    { name: `${P}${name}`, maxParallel: 1, start: true, items: [evalItem(name)] },
    creatorToken,
  );
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().id as string;
  const item = (await prisma.detectJobItem.findMany({ where: { jobId: id } }))[0]!;
  assert.ok(item.recordId);
  return { id, item };
}

test('停止：创建人后来没了停止权限，改用点按钮的人停止评估子任务', async () => {
  const { id, item } = await startedJob('创建人降权');
  await setCreatorCanDelete(false);
  try {
    const stop = await post(`/api/detect-jobs/${id}/stop`);
    assert.equal(stop.statusCode, 200, stop.body);
    const rec = await prisma.evalTask.findUniqueOrThrow({ where: { id: item.recordId! } });
    assert.equal(rec.status, 'CANCELED', '评估子任务停下了');
    const it = await prisma.detectJobItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(it.status, 'CANCELED');
  } finally {
    await setCreatorCanDelete(true);
  }
});

test('停止：创建人和点按钮的人都没有停止权限，返回 409 列出没停的项，原因写进子任务', async () => {
  const { id, item } = await startedJob('都没权限');
  await setCreatorCanDelete(false);
  try {
    const stop = await post(`/api/detect-jobs/${id}/stop`, undefined, clickerToken);
    assert.equal(stop.statusCode, 409, stop.body);
    const err = stop.json().error;
    assert.equal(err.code, 'DETECT_JOB_STOP_PARTIAL');
    assert.match(err.message, /第 1 项/);
    assert.equal(err.details.items[0].index, 0);
    const job = await prisma.detectJob.findUniqueOrThrow({ where: { id } });
    assert.equal(job.status, 'CANCELED', '组合任务已停止，不再启动新的');
    const it = await prisma.detectJobItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.match(it.error ?? '', /^停止失败：/);
    const rec = await prisma.evalTask.findUniqueOrThrow({ where: { id: item.recordId! } });
    assert.equal(rec.status, 'PENDING');
  } finally {
    await setCreatorCanDelete(true);
  }
});

test('启动超过 10 分钟被别的推进者置为启动中断后，原启动者才写回：不覆盖，新建的记录被停掉', async () => {
  const res = await post(
    '/api/detect-jobs',
    { name: `${P}写回竞态`, maxParallel: 1, items: [evalItem('写回竞态')] },
    creatorToken,
  );
  const id = res.json().id as string;
  const item = (await prisma.detectJobItem.findMany({ where: { jobId: id } }))[0]!;
  // 启动途中：别的推进者看到已领取超时，置为启动中断
  onLaunch = async () => {
    await prisma.detectJobItem.update({
      where: { id: item.id },
      data: { status: 'FAILED', error: LAUNCH_INTERRUPTED_MESSAGE, finishedAt: new Date() },
    });
  };
  const start = await post(`/api/detect-jobs/${id}/start`, undefined, creatorToken);
  assert.equal(start.statusCode, 200, start.body);
  const after = await prisma.detectJobItem.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(after.status, 'FAILED');
  assert.equal(after.recordId, null, '没有覆盖成新记录');
  const orphan = await prisma.evalTask.findFirstOrThrow({ where: { name: `${P}写回竞态` } });
  assert.equal(orphan.status, 'CANCELED', '新建的记录无人跟踪，被停掉');
  assert.ok(cancelCalls.includes(orphan.id));
});

test('评估子任务被用户单独暂停：组合任务不自动恢复，详情里给「恢复」', async () => {
  const { id, item } = await startedJob('单独暂停');
  await prisma.evalTask.update({
    where: { id: item.recordId! },
    data: { status: 'PAUSED', pausedAt: new Date() },
  });
  for (let i = 0; i < 2; i++) await tickDetectJobs({ launchers: fakeLaunchers });
  const detail = (
    await app.inject({
      url: `/api/detect-jobs/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    })
  ).json();
  assert.equal(detail.status, 'RUNNING');
  assert.equal(detail.items[0].status, 'PAUSED');
  assert.deepEqual(detail.items[0].actions, ['resume', 'stop']);
  const rec = await prisma.evalTask.findUniqueOrThrow({ where: { id: item.recordId! } });
  assert.equal(rec.status, 'PAUSED', '编排器没有自动恢复');
});

test('资产测绘：执行进程没了、心跳超过 3 分钟，启动维护和周期 tick 都会收尾，组合任务能结束', async () => {
  const run = await prisma.assetDiscoveryRun.create({
    data: {
      targets: ['10.9.9.9'],
      ports: [11434],
      hostCount: 1,
      portCount: 1,
      status: 'RUNNING',
      startedAt: new Date(),
      createdByName: P,
    },
  });
  await prisma.$executeRaw`UPDATE "asset_discovery_runs" SET "updatedAt" = now() - interval '5 minutes' WHERE id = ${run.id}`;
  const job = await prisma.detectJob.create({
    data: {
      name: `${P}测绘`,
      status: 'RUNNING',
      startedAt: new Date(),
      items: {
        create: [
          {
            position: 0,
            kind: 'asset_discovery',
            title: 'a',
            params: {},
            status: 'RUNNING',
            recordKind: 'asset_discovery',
            recordId: run.id,
            launchedAt: new Date(),
          },
        ],
      },
    },
  });
  await recoverInterruptedDetectWork();
  await tickDetectJobs();
  const r = await prisma.assetDiscoveryRun.findUniqueOrThrow({ where: { id: run.id } });
  const j = await prisma.detectJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(r.status, 'FAILED');
  assert.equal(j.status, 'FAILED');
  assert.ok(j.finishedAt);
});

test('资产测绘：执行中按心跳刷新 updatedAt，不会被当成中断', async () => {
  const run = await prisma.assetDiscoveryRun.create({
    data: {
      targets: ['slow.invalid'],
      ports: [1],
      hostCount: 1,
      portCount: 1,
      status: 'PENDING',
      createdByName: P,
    },
  });
  const done = executeRun(
    run.id,
    [{ scheme: 'http', host: 'slow.invalid', port: 1, basePath: '' }],
    {
      heartbeatMs: 50,
      probe: {
        timeoutMs: 200,
        lookup: async () => {
          await sleep(600);
          return '127.0.0.1';
        },
      },
    },
  );
  await sleep(150);
  const first = (await prisma.assetDiscoveryRun.findUniqueOrThrow({ where: { id: run.id } }))
    .updatedAt;
  await sleep(250);
  const second = (await prisma.assetDiscoveryRun.findUniqueOrThrow({ where: { id: run.id } }))
    .updatedAt;
  await done;
  assert.ok(second.getTime() > first.getTime(), '心跳在刷新');
});

test('检测策略定时触发：非业务错误（如数据库报错）也写进上次跳过原因，不往外抛', async () => {
  const s = await prisma.detectStrategy.create({
    data: {
      name: `${P}zzfail 策略`,
      createdById: creatorId,
      cron: '0 3 * * *',
      items: [evalItem('策略')],
    },
  });
  // 只在本测试库里加一个约束，让建组合任务时数据库报错
  await prismaUnscoped.$executeRawUnsafe(
    `ALTER TABLE "detect_jobs" ADD CONSTRAINT "zz_p2bb_hard_fail" CHECK (position('zzfail' in "name") = 0)`,
  );
  try {
    const out = await runInTenant(PLATFORM_TENANT_ID, () =>
      triggerDetectStrategy(s.id, { triggeredBy: 'schedule' }),
    );
    assert.equal(out.status, 'skipped');
    assert.match(out.reason ?? '', /^触发失败：/);
    const row = await prisma.detectStrategy.findUniqueOrThrow({ where: { id: s.id } });
    assert.match(row.lastSkipReason ?? '', /^触发失败：/);
  } finally {
    await prismaUnscoped.$executeRawUnsafe(
      `ALTER TABLE "detect_jobs" DROP CONSTRAINT IF EXISTS "zz_p2bb_hard_fail"`,
    );
  }
});

test('子任务工具编号：要是 uuid，且是工具中心里存在的工具', async () => {
  const create = (toolId: string) =>
    post('/api/detect-jobs', { name: `${P}工具`, items: [evalItem('工具', { toolId })] });
  assert.equal((await create('not-a-uuid')).statusCode, 400);
  const missing = await create('00000000-0000-4000-8000-0000000000aa');
  assert.equal(missing.statusCode, 400, missing.body);
  assert.equal(missing.json().error.code, 'DETECT_JOB_ITEM_REF_NOT_FOUND');
  const tool = await prisma.tool.create({
    data: {
      code: 'p2bb-hard-tool',
      name: `${P}工具`,
      category: 'content',
      taskEntry: 'content-eval',
    },
  });
  const ok = await create(tool.id);
  assert.equal(ok.statusCode, 201, ok.body);
});

test('评估子任务参数补上内置引擎（规则判定、敏感信息）', async () => {
  const res = await post('/api/detect-jobs', {
    name: `${P}引擎`,
    items: [
      {
        kind: 'eval_task',
        params: {
          modelTargetId: targetId,
          questionSetIds: [questionSetId],
          engines: ['llm-judge'],
        },
      },
    ],
  });
  assert.equal(res.statusCode, 201, res.body);
  const item = (await prisma.detectJobItem.findMany({ where: { jobId: res.json().id } }))[0]!;
  const engines = (item.params as { engines: string[] }).engines;
  assert.deepEqual([...engines].sort(), ['llm-judge', 'rule-judge', 'sensitive-info']);
});
