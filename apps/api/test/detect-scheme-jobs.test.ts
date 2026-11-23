import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped as db } from '../src/db.js';
import type { Launchers } from '../src/modules/detect-jobs/launchers.js';
import {
  bearer,
  cleanupSchemeTenants,
  createUser,
  fleetEndpoint,
  ledgerAsset,
  loginAs,
  modelTarget,
  setupSchemeTenants,
  type SchemeFixture,
} from './helpers/scheme-fixtures.js';

// 2.8.4 方案与任务关联、按台账快速建任务：清单项就绪判断、一键建组合任务、方案状态、快速建任务、
// 资产相关任务、外键置空、权限与租户隔离。启动函数注入假实现，建一条评估任务记录。

const TENANT_PREFIX = 'C7方案任务测试';
const USER_PREFIX = '__c7_jobs_';
const ROLE_NAME = `${USER_PREFIX}role`;
const READER_ROLE = `${USER_PREFIX}reader_role`;
/** 北京时间的今天（组合任务默认名称用它）。 */
const beijingToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

let app: Awaited<ReturnType<typeof buildApp>>;
let f: SchemeFixture;
let limitedA = '';
let targetId = '';
let questionSetId = '';
let endpointId = '';
let modelAsset = '';
let serverAsset = '';
let launches: string[] = [];
/** 启动子任务时，方案的建任务审计是否已经写了（启动失败也不漏审计）。 */
let watchSchemeId = '';
let createJobAuditsAtLaunch: number | null = null;

const fakeLaunchers: Partial<Launchers> = {
  eval_task: async (_params, ctx) => {
    launches.push('eval_task');
    const task = await prisma.evalTask.create({
      data: { name: ctx.title, modelTargetId: targetId, createdById: ctx.user.id },
    });
    return { recordKind: 'eval_task', recordId: task.id };
  },
  fleet_posture: async (_params, ctx) => {
    launches.push('fleet_posture');
    if (watchSchemeId) {
      createJobAuditsAtLaunch = await db.auditLog.count({
        where: { action: 'detect_scheme.create_job', targetId: watchSchemeId },
      });
    }
    const task = await prisma.evalTask.create({
      data: { name: ctx.title, modelTargetId: targetId, createdById: ctx.user.id },
    });
    return { recordKind: 'fleet_eval_job', recordId: task.id };
  },
};

interface Item {
  id: string;
  entryKey: string;
  mode: string;
  jobKind: string | null;
  title: string;
  params: Record<string, unknown>;
  ready: boolean | null;
  missing: string[];
}

function call(method: string, token: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as 'GET',
    url,
    headers: { ...bearer(token), 'user-agent': 'c7-jobs-agent' },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

async function newScheme(name: string, categories: string[], assetIds: string[]) {
  const res = await call('POST', f.adminA, '/api/detect-schemes', {
    name,
    requirement: { objective: '建任务测试', categories, assetIds },
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().id as string;
  const gen = await call('POST', f.adminA, `/api/detect-schemes/${id}/generate`);
  assert.equal(gen.statusCode, 200, gen.body);
  return { id, items: gen.json().items as Item[] };
}

async function schemeDetail(id: string, token = f.adminA) {
  const res = await call('GET', token, `/api/detect-schemes/${id}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { status: string; jobCount: number; items: Item[] };
}

/** 给内容评估项补上样本库。 */
async function fillQuestionSet(schemeId: string, item: Item) {
  const res = await call('PATCH', f.adminA, `/api/detect-schemes/${schemeId}/items/${item.id}`, {
    params: { ...item.params, questionSetIds: [questionSetId] },
  });
  assert.equal(res.statusCode, 200, res.body);
}

before(async () => {
  app = await buildApp({ detectJobs: { launchers: fakeLaunchers } });
  await app.ready();
  await db.role.deleteMany({ where: { name: ROLE_NAME } });
  f = await setupSchemeTenants(app, TENANT_PREFIX, USER_PREFIX, 'c7-jobs');
  // 自建角色：能维护方案、看台账、发起评估，但没有组合任务的管理权限
  const perms = await db.permission.findMany({
    where: {
      code: {
        in: ['scheme:read', 'scheme:manage', 'ledger:read', 'eval_task:create', 'detect_task:read'],
      },
    },
  });
  await db.role.create({
    data: {
      name: ROLE_NAME,
      description: 'C7 测试',
      permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
    },
  });
  await createUser(f.tenantA, `${USER_PREFIX}limited`, ROLE_NAME);
  limitedA = await loginAs(app, `${USER_PREFIX}limited`);

  targetId = (await modelTarget(f.tenantA, 'C7模型对象', 'MODEL')).id;
  questionSetId = (
    await db.questionSet.create({
      data: {
        tenantId: f.tenantA,
        name: 'C7样本库',
        questions: { create: [{ tenantId: f.tenantA, content: '题目' }] },
      },
    })
  ).id;
  endpointId = (await fleetEndpoint(f.tenantA, 'c7-host')).id;
  modelAsset = (
    await ledgerAsset(f.tenantA, { type: 'model', name: 'C7模型', modelTargetId: targetId })
  ).id;
  serverAsset = (
    await ledgerAsset(f.tenantA, {
      type: 'server',
      name: 'C7服务器',
      fleetEndpointId: endpointId,
      attrs: { ip: '10.40.0.8' },
    })
  ).id;
});

beforeEach(() => {
  launches = [];
});

after(async () => {
  await cleanupSchemeTenants(TENANT_PREFIX, USER_PREFIX);
  await db.role.deleteMany({ where: { name: { in: [ROLE_NAME, READER_ROLE] } } });
  await app.close();
});

test('auto 项带 ready；R1 缺样本库；有未就绪项建任务 400 并列出；补齐后建任务，关联方案和资产并写审计', async () => {
  const { id, items } = await newScheme('一键建任务', ['content'], [modelAsset]);
  const r1 = items.find((i) => i.entryKey === 'content-eval')!;
  const r2 = items.find((i) => i.entryKey === 'red-team')!;
  assert.equal(r1.mode, 'auto');
  assert.equal(r1.ready, false);
  assert.ok(r1.missing.includes('样本库'), JSON.stringify(r1.missing));
  assert.equal(r2.ready, null);
  assert.deepEqual(r2.missing, []);

  const notReady = await call('POST', f.adminA, `/api/detect-schemes/${id}/jobs`, {});
  assert.equal(notReady.statusCode, 400, notReady.body);
  const err = notReady.json().error;
  assert.equal(err.code, 'SCHEME_ITEMS_NOT_READY');
  assert.deepEqual(err.details.items, [{ id: r1.id, title: r1.title, missing: r1.missing }]);
  assert.ok(err.message.includes(r1.title));

  await fillQuestionSet(id, r1);
  const ready = (await schemeDetail(id)).items.find((i) => i.id === r1.id)!;
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.missing, []);

  const created = await call('POST', f.operatorA, `/api/detect-schemes/${id}/jobs`, {});
  assert.equal(created.statusCode, 201, created.body);
  const jobId = created.json().id as string;
  const job = await db.detectJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { items: true },
  });
  assert.equal(job.schemeId, id);
  assert.equal(job.triggeredBy, 'scheme');
  assert.equal(job.status, 'PENDING');
  assert.equal(job.tenantId, f.tenantA);
  assert.equal(job.name, `一键建任务 · ${beijingToday()}`);
  assert.deepEqual(
    job.items.map((i) => [i.kind, i.ledgerAssetId, i.title]),
    [['eval_task', modelAsset, r1.title]],
  );
  assert.deepEqual(launches, [], '没要求启动时不启动');
  for (const action of ['detect_job.create', 'detect_scheme.create_job']) {
    const audit = await db.auditLog.findFirst({
      where: { action, targetId: action === 'detect_job.create' ? jobId : id },
    });
    assert.ok(audit, `缺审计 ${action}`);
    assert.equal(audit.tenantId, f.tenantA);
  }

  const detail = await schemeDetail(id);
  assert.equal(detail.status, 'executing');
  assert.equal(detail.jobCount, 1);
  const jobs = await call('GET', f.auditorA, `/api/detect-schemes/${id}/jobs`);
  assert.equal(jobs.statusCode, 200, jobs.body);
  assert.deepEqual(
    jobs
      .json()
      .items.map((j: { id: string; status: string; itemCount: number }) => [
        j.id,
        j.status,
        j.itemCount,
      ]),
    [[jobId, 'PENDING', 1]],
  );

  // 有关联任务时删除方案 409
  const del = await call('DELETE', f.adminA, `/api/detect-schemes/${id}`);
  assert.equal(del.statusCode, 409, del.body);
  assert.equal(del.json().error.code, 'SCHEME_HAS_JOBS');
});

test('start: true 时组合任务执行中、方案执行中，任务结束后方案已完成；itemIds 只取所选项', async () => {
  const { id, items } = await newScheme(
    '建任务并启动',
    ['content', 'app_env'],
    [modelAsset, serverAsset],
  );
  const posture = items.find((i) => i.entryKey === 'fleet-posture')!;
  assert.equal(posture.jobKind, 'fleet_posture');
  assert.equal(posture.ready, true);
  const manual = items.find((i) => i.mode === 'manual');

  if (manual) {
    const bad = await call('POST', f.adminA, `/api/detect-schemes/${id}/jobs`, {
      itemIds: [manual.id],
    });
    assert.equal(bad.statusCode, 400, bad.body);
    assert.equal(bad.json().error.code, 'SCHEME_ITEMS_INVALID');
  }

  watchSchemeId = id;
  const res = await call('POST', f.adminA, `/api/detect-schemes/${id}/jobs`, {
    itemIds: [posture.id],
    start: true,
    name: '只体检',
    maxParallel: 2,
  });
  watchSchemeId = '';
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(createJobAuditsAtLaunch, 1, '启动子任务前已写方案的建任务审计');
  const job = await db.detectJob.findUniqueOrThrow({
    where: { id: res.json().id },
    include: { items: true },
  });
  assert.equal(job.name, '只体检');
  assert.equal(job.maxParallel, 2);
  assert.equal(job.status, 'RUNNING');
  assert.deepEqual(
    job.items.map((i) => [i.kind, i.ledgerAssetId]),
    [['fleet_posture', serverAsset]],
  );
  assert.deepEqual(launches, ['fleet_posture']);
  assert.equal((await schemeDetail(id)).status, 'executing');

  await db.detectJob.update({
    where: { id: job.id },
    data: { status: 'COMPLETED', finishedAt: new Date() },
  });
  assert.equal((await schemeDetail(id)).status, 'done');
  const list = await call('GET', f.adminA, '/api/detect-schemes?pageSize=200');
  const row = list.json().items.find((s: { id: string }) => s.id === id);
  assert.equal(row.status, 'done');
  assert.equal(row.jobCount, 1);

  // 停用的项不进组合任务；没有可执行项 400
  const { id: emptyId } = await newScheme('无自动项', ['data'], [modelAsset]);
  const none = await call('POST', f.adminA, `/api/detect-schemes/${emptyId}/jobs`, {});
  assert.equal(none.statusCode, 400, none.body);
  assert.equal(none.json().error.code, 'SCHEME_NO_AUTO_ITEMS');
});

test('快速建任务：quick-items 对关联了终端的服务器返回就绪的配置体检；quick-job 建出 quick 组合任务；资产详情有相关任务', async () => {
  const quick = await call('GET', f.auditorA, `/api/ledger/assets/${serverAsset}/quick-items`);
  assert.equal(quick.statusCode, 200, quick.body);
  const body = quick.json() as {
    auto: Array<{
      jobKind: string;
      ready: boolean;
      missing: string[];
      params: Record<string, unknown>;
      title: string;
    }>;
    manual: Array<{ entryKey: string; createPath: string }>;
  };
  const posture = body.auto.find((i) => i.jobKind === 'fleet_posture')!;
  assert.equal(posture.ready, true);
  assert.deepEqual(posture.params, { endpointId });
  const modelQuick = (
    await call('GET', f.adminA, `/api/ledger/assets/${modelAsset}/quick-items`)
  ).json();
  const redTeam = modelQuick.manual.find((i: { entryKey: string }) => i.entryKey === 'red-team');
  assert.equal(redTeam.createPath, '/eval-tasks?launch=redteam');
  const evalItem = modelQuick.auto.find((i: { jobKind: string }) => i.jobKind === 'eval_task');
  assert.equal(evalItem.ready, false);
  assert.ok(evalItem.missing.includes('样本库'));

  const res = await call('POST', f.operatorA, `/api/ledger/assets/${serverAsset}/quick-job`, {
    items: [{ jobKind: 'fleet_posture', title: posture.title, params: posture.params }],
    start: true,
  });
  assert.equal(res.statusCode, 201, res.body);
  const job = await db.detectJob.findUniqueOrThrow({
    where: { id: res.json().id },
    include: { items: true },
  });
  assert.equal(job.triggeredBy, 'quick');
  assert.equal(job.schemeId, null);
  assert.equal(job.status, 'RUNNING');
  assert.deepEqual(
    job.items.map((i) => i.ledgerAssetId),
    [serverAsset],
  );
  assert.ok(
    await db.auditLog.findFirst({ where: { action: 'detect_job.create', targetId: job.id } }),
  );

  const bad = await call('POST', f.operatorA, `/api/ledger/assets/${serverAsset}/quick-job`, {
    items: [{ jobKind: 'eval_task', title: '缺样本库', params: { modelTargetId: targetId } }],
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().error.code, 'DETECT_JOB_ITEM_INVALID');

  const detail = await call('GET', f.auditorA, `/api/ledger/assets/${serverAsset}`);
  const related = detail.json().jobItems as Array<{
    jobId: string;
    title: string;
    status: string;
    href: string | null;
  }>;
  const hit = related.find((r) => r.jobId === job.id);
  assert.ok(hit, '资产详情的相关任务应含该子任务');
  assert.equal(hit.title, posture.title);
  assert.ok(hit.href?.startsWith('/eval-tasks/'), String(hit.href));
});

test('删除方案（无任务）、删除方案或资产后组合任务的关联置空不报错', async () => {
  const { id: emptyScheme } = await newScheme('可直接删', ['content'], [modelAsset]);
  assert.equal(
    (await call('DELETE', f.adminA, `/api/detect-schemes/${emptyScheme}`)).statusCode,
    200,
  );

  const extra = await ledgerAsset(f.tenantA, {
    type: 'server',
    name: 'C7将删服务器',
    fleetEndpointId: (await fleetEndpoint(f.tenantA, 'c7-gone')).id,
  });
  const { id, items } = await newScheme('将删方案', ['app_env'], [extra.id]);
  const posture = items.find((i) => i.entryKey === 'fleet-posture')!;
  const created = await call('POST', f.adminA, `/api/detect-schemes/${id}/jobs`, {
    itemIds: [posture.id],
  });
  assert.equal(created.statusCode, 201, created.body);
  const jobId = created.json().id as string;

  const delAsset = await call('DELETE', f.adminA, `/api/ledger/assets/${extra.id}`);
  assert.equal(delAsset.statusCode, 200, delAsset.body);
  await db.detectScheme.delete({ where: { id } });
  const job = await db.detectJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { items: true },
  });
  assert.equal(job.schemeId, null);
  assert.equal(job.items[0]!.ledgerAssetId, null);
});

test('权限与隔离：缺 detect_task:manage 的自建角色 403；auditor 403；另一个租户 404；跨租户关联被触发器拒绝', async () => {
  const { id, items } = await newScheme('权限隔离', ['app_env'], [serverAsset]);
  const posture = items.find((i) => i.entryKey === 'fleet-posture')!;
  const quickBody = { items: [{ jobKind: 'fleet_posture', title: 'x', params: { endpointId } }] };

  const limited = await call('POST', limitedA, `/api/detect-schemes/${id}/jobs`, {
    itemIds: [posture.id],
  });
  assert.equal(limited.statusCode, 403, limited.body);
  const limitedQuick = await call(
    'POST',
    limitedA,
    `/api/ledger/assets/${serverAsset}/quick-job`,
    quickBody,
  );
  assert.equal(limitedQuick.statusCode, 403, limitedQuick.body);
  assert.equal(
    (await call('GET', limitedA, `/api/ledger/assets/${serverAsset}/quick-items`)).statusCode,
    200,
  );

  assert.equal(
    (await call('POST', f.auditorA, `/api/detect-schemes/${id}/jobs`, {})).statusCode,
    403,
  );
  assert.equal(
    (await call('POST', f.auditorA, `/api/ledger/assets/${serverAsset}/quick-job`, quickBody))
      .statusCode,
    403,
  );

  for (const [method, url, payload] of [
    ['POST', `/api/detect-schemes/${id}/jobs`, {}],
    ['GET', `/api/detect-schemes/${id}/jobs`, undefined],
    ['GET', `/api/ledger/assets/${serverAsset}/quick-items`, undefined],
    ['POST', `/api/ledger/assets/${serverAsset}/quick-job`, quickBody],
  ] as const) {
    const res = await call(method, f.adminB, url, payload);
    assert.equal(res.statusCode, 404, `${method} ${url} ${res.body}`);
  }

  await assert.rejects(
    db.detectJob.create({ data: { tenantId: f.tenantB, name: 'C7跨租户', schemeId: id } }),
    /LSE_CROSS_TENANT_REFERENCE/,
  );
  const jobB = await db.detectJob.create({ data: { tenantId: f.tenantB, name: 'C7乙任务' } });
  await assert.rejects(
    db.detectJobItem.create({
      data: {
        jobId: jobB.id,
        position: 0,
        kind: 'fleet_posture',
        title: 'x',
        params: {},
        ledgerAssetId: serverAsset,
      },
    }),
    /LSE_CROSS_TENANT_REFERENCE/,
  );
});

test('可自动执行的项超过 20 个时返回 SCHEME_TOO_MANY_ITEMS，勾选不超过 20 项可以建', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 21; i += 1) {
    ids.push(
      (
        await ledgerAsset(f.tenantA, {
          type: 'platform',
          name: `C7大方案平台${i}`,
          attrs: { url: `https://c7-big-${i}.example.com` },
        })
      ).id,
    );
  }
  const { id, items } = await newScheme('超过二十项', ['app_env'], ids);
  const auto = items.filter((i) => i.mode === 'auto');
  assert.equal(auto.length, 21);
  const res = await call('POST', f.adminA, `/api/detect-schemes/${id}/jobs`, {});
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'SCHEME_TOO_MANY_ITEMS');
  assert.deepEqual(res.json().error.details, { count: 21, max: 20 });
  assert.match(res.json().error.message, /分批/);
  const part = await call('POST', f.adminA, `/api/detect-schemes/${id}/jobs`, {
    itemIds: auto.slice(0, 20).map((i) => i.id),
  });
  assert.equal(part.statusCode, 201, part.body);
});

test('没有 detect_task:read：方案的关联任务列表 403，资产详情不带相关任务', async () => {
  const perms = await db.permission.findMany({
    where: { code: { in: ['scheme:read', 'ledger:read'] } },
  });
  await db.role.deleteMany({ where: { name: READER_ROLE } });
  await db.role.create({
    data: {
      name: READER_ROLE,
      description: 'C7 测试',
      permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
    },
  });
  await createUser(f.tenantA, `${USER_PREFIX}reader`, READER_ROLE);
  const reader = await loginAs(app, `${USER_PREFIX}reader`);
  const { id } = await newScheme('只读方案', ['app_env'], [serverAsset]);
  assert.equal((await call('GET', reader, `/api/detect-schemes/${id}`)).statusCode, 200);
  assert.equal((await call('GET', reader, `/api/detect-schemes/${id}/jobs`)).statusCode, 403);
  const detail = await call('GET', reader, `/api/ledger/assets/${serverAsset}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.ok(!('jobItems' in detail.json()));
  const withJobs = await call('GET', f.auditorA, `/api/ledger/assets/${serverAsset}`);
  assert.ok(Array.isArray(withJobs.json().jobItems));
});

test('资产在建任务过程中被删：方案建任务返回 400 而不是 500', async () => {
  const ep = await fleetEndpoint(f.tenantA, 'c7-race');
  const asset = await ledgerAsset(f.tenantA, {
    type: 'server',
    name: 'C7竞态服务器',
    fleetEndpointId: ep.id,
  });
  const { id, items } = await newScheme('竞态方案', ['app_env'], [asset.id]);
  const posture = items.find((i) => i.entryKey === 'fleet-posture')!;
  // 删除资产的事务先锁住资产行不提交：建任务时读到的清单项还带着资产，插入子任务要等这把锁，
  // 等删除提交后外键已失效。
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deleting = db.$transaction(
    async (tx) => {
      await tx.ledgerAsset.delete({ where: { id: asset.id } });
      await gate;
    },
    { timeout: 30_000 },
  );
  await new Promise((r) => setTimeout(r, 300));
  const pending = call('POST', f.adminA, `/api/detect-schemes/${id}/jobs`, {
    itemIds: [posture.id],
  });
  await new Promise((r) => setTimeout(r, 1500));
  release();
  await deleting;
  const res = await pending;
  assert.equal(res.statusCode, 400, res.body);
});
