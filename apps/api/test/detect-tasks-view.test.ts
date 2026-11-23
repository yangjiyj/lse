import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { detectRecordHref } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';

// B-6 统一任务视图（2.4.1、2.4.4）：各类检测记录按四类汇总统计、筛选、下钻，状态归一成六种。
// 断言总数的夹具都建在测试里新建的租户中，用该租户管理员调接口。

const P = '__p2bb_view_';
const TENANT_NAME = 'P2BB统一任务视图测试租户';
const PASSWORD = ['Detect', 'View', '12345'].join('@');

let app: Awaited<ReturnType<typeof buildApp>>;
let tenantId = '';
const tokens = { admin: '', tenantAdmin: '', limited: '' };
const ids: Record<string, string> = {};
const pauseCalls: string[] = [];
let platformTaskId = '';

const bearer = (token: string, tenant?: string) => ({
  authorization: `Bearer ${token}`,
  ...(tenant ? { 'x-lse-tenant': tenant } : {}),
});

async function cleanup(): Promise<void> {
  const tenants = await prismaUnscoped.tenant.findMany({
    where: { name: TENANT_NAME },
    select: { id: true },
  });
  const tenantIds = tenants.map((t) => t.id);
  const where = { tenantId: { in: tenantIds } };
  await prismaUnscoped.detectJob.deleteMany({ where });
  await prismaUnscoped.detectJob.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.standardRun.deleteMany({ where: { task: { name: { startsWith: P } } } });
  await prismaUnscoped.evalTask.deleteMany({ where });
  await prismaUnscoped.evalTask.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.ragCorpus.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.standardBankRelease.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.modelFileScan.deleteMany({ where });
  await prismaUnscoped.modelFileScan.deleteMany({ where: { path: { startsWith: `/models/${P}` } } });
  await prismaUnscoped.corpusScan.deleteMany({ where });
  await prismaUnscoped.assetDiscoveryRun.deleteMany({ where });
  await prismaUnscoped.serviceAssuranceRun.deleteMany({ where });
  await prismaUnscoped.aiComponentScan.deleteMany({ where });
  await prismaUnscoped.modelTarget.deleteMany({ where });
  await prismaUnscoped.modelTarget.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.auditLog.deleteMany({ where });
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

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 0, minutes));

before(async () => {
  app = await buildApp({
    pauseEvalTask: async (id) => {
      pauseCalls.push(id);
    },
  });
  await app.ready();
  await cleanup();
  tokens.admin = await login('admin', ['Admin', '@', '12345'].join(''));
  const tenant = await app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: bearer(tokens.admin),
    payload: { name: TENANT_NAME, admin: { username: `${P}tadmin`, password: PASSWORD } },
  });
  assert.equal(tenant.statusCode, 201, tenant.body);
  tenantId = tenant.json().id ?? tenant.json().tenant?.id;
  if (!tenantId) {
    tenantId = (await prismaUnscoped.tenant.findFirstOrThrow({ where: { name: TENANT_NAME } })).id;
  }
  await skipFirstPasswordChange(`${P}tadmin`);
  tokens.tenantAdmin = await login(`${P}tadmin`, PASSWORD);
  const tadmin = await prismaUnscoped.user.findUniqueOrThrow({ where: { username: `${P}tadmin` } });

  // 只能看评估、语料、服务核验的角色：没有 engine:scan、remediation:read、platform_setting:read
  const perms = await prismaUnscoped.permission.findMany({
    where: {
      code: {
        in: ['detect_task:read', 'eval_task:read', 'corpus_scan:read', 'service_assurance:read'],
      },
    },
  });
  const role = await prismaUnscoped.role.create({
    data: {
      name: `${P}role`,
      permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
    },
  });
  await prismaUnscoped.user.create({
    data: {
      tenantId,
      username: `${P}limited`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: 'limited',
      roles: { create: { roleId: role.id } },
    },
  });
  tokens.limited = await login(`${P}limited`, PASSWORD);

  const target = await prismaUnscoped.modelTarget.create({
    data: {
      tenantId,
      name: `${P}target`,
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'dummy-view-key', // pragma: allowlist secret
      model: 'fake-model',
    },
  });
  const base = { tenantId, modelTargetId: target.id, createdById: tadmin.id };
  ids.content = (
    await prismaUnscoped.evalTask.create({
      data: { ...base, name: `${P}内容评估`, status: 'RUNNING', createdAt: at(1) },
    })
  ).id;
  ids.agent = (
    await prismaUnscoped.evalTask.create({
      data: {
        ...base,
        name: `${P}智能体评估`,
        status: 'COMPLETED',
        dimensions: ['agent_tool_call'],
        createdAt: at(2),
      },
    })
  ).id;
  ids.paused = (
    await prismaUnscoped.evalTask.create({
      data: { ...base, name: `${P}百分%号`, status: 'PAUSED', createdAt: at(3) },
    })
  ).id;
  ids.modelFile = (
    await prismaUnscoped.modelFileScan.create({
      data: {
        tenantId,
        source: 'DIRECTORY',
        path: `/models/${P}`,
        status: 'CANCELLED',
        createdById: tadmin.id,
        createdAt: at(4),
      },
    })
  ).id;
  ids.corpus = (
    await prismaUnscoped.corpusScan.create({
      data: {
        tenantId,
        fileName: `${P}语料.jsonl`,
        storageKey: randomUUID(),
        bytes: 10n,
        sha256: 'x',
        status: 'PENDING',
        createdById: tadmin.id,
        createdAt: at(5),
      },
    })
  ).id;
  ids.discovery = (
    await prismaUnscoped.assetDiscoveryRun.create({
      data: {
        tenantId,
        targets: ['10.0.0.1', '10.0.0.2'],
        ports: [11434],
        hostCount: 2,
        portCount: 1,
        status: 'COMPLETED',
        createdById: tadmin.id,
        createdAt: at(6),
      },
    })
  ).id;
  ids.assurance = (
    await prismaUnscoped.serviceAssuranceRun.create({
      data: {
        tenantId,
        mode: 'SAFE',
        targetKind: 'ENDPOINT',
        targetName: `${P}服务核验`,
        scopePolicyRef: 'x',
        requestBudget: {},
        status: 'PARTIAL',
        createdById: tadmin.id,
        createdAt: at(7),
      },
    })
  ).id;
  ids.component = (
    await prismaUnscoped.aiComponentScan.create({
      data: {
        tenantId,
        assetName: `${P}组件`,
        assetType: 'MCP',
        assetKey: 'k',
        sourceType: 'UPLOAD',
        status: 'FAILED',
        createdById: tadmin.id,
        createdAt: at(8),
      },
    })
  ).id;
  const job = await prismaUnscoped.detectJob.create({
    data: {
      tenantId,
      name: `${P}组合任务`,
      status: 'RUNNING',
      items: {
        create: [
          {
            tenantId,
            position: 0,
            kind: 'eval_task',
            title: '内容评估',
            params: {},
            status: 'RUNNING',
            recordKind: 'eval_task',
            recordId: ids.content,
          },
        ],
      },
    },
  });
  ids.job = job.id;

  const platformTarget = await prisma.modelTarget.create({
    data: {
      name: `${P}平台对象`,
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'dummy-view-key', // pragma: allowlist secret
      model: 'fake-model',
    },
  });
  platformTaskId = (
    await prisma.evalTask.create({
      data: { name: `${P}平台任务`, modelTargetId: platformTarget.id },
    })
  ).id;
});

after(async () => {
  await cleanup();
  await app.close();
});

function get(url: string, token = tokens.tenantAdmin, tenant?: string) {
  return app.inject({ url, headers: bearer(token, tenant) });
}

test('统计：按六种状态和四类汇总', async () => {
  const res = await get('/api/detect-tasks/stats');
  assert.equal(res.statusCode, 200, res.body);
  const s = res.json();
  assert.equal(s.total, 8);
  assert.equal(s.byStatus.RUNNING, 1);
  assert.equal(s.byStatus.PAUSED, 1);
  assert.equal(s.byStatus.CANCELED, 1);
  assert.equal(s.byStatus.COMPLETED, 3);
  assert.equal(s.byStatus.PENDING, 1);
  assert.equal(s.byStatus.FAILED, 1);
  assert.equal(s.byCategory.app_env.total, 4);
  assert.equal(s.byCategory.model.total, 1);
  assert.equal(s.byCategory.data.total, 1);
  assert.equal(s.byCategory.content.total, 2);
  assert.equal(s.byCategory.content.byStatus.RUNNING, 1);
  assert.equal(s.byKind.eval_task, 3);
  assert.equal(s.byKind.service_assurance, 1);
  assert.ok(s.kinds.includes('model_file_scan'));
});

test('列表：按创建时间倒序；类别筛选；按状态下钻与统计一致；每行链接正确', async () => {
  const all = (await get('/api/detect-tasks?pageSize=100')).json();
  assert.equal(all.total, 8);
  assert.deepEqual(
    all.items.map((r: { id: string }) => r.id),
    [
      ids.component,
      ids.assurance,
      ids.discovery,
      ids.corpus,
      ids.modelFile,
      ids.paused,
      ids.agent,
      ids.content,
    ],
  );
  for (const row of all.items) {
    assert.equal(row.href, detectRecordHref(row.kind, row.id));
  }
  const discovery = all.items.find((r: { id: string }) => r.id === ids.discovery);
  assert.equal(discovery.name, '10.0.0.1、10.0.0.2');
  assert.equal(discovery.category, 'app_env');
  assert.equal(discovery.createdBy.username, `${P}tadmin`);
  const assurance = all.items.find((r: { id: string }) => r.id === ids.assurance);
  assert.equal(assurance.status, 'COMPLETED');
  assert.equal(assurance.rawStatus, 'PARTIAL');

  const appEnv = (await get('/api/detect-tasks?category=app_env&pageSize=100')).json();
  assert.equal(appEnv.total, 4);
  assert.ok(appEnv.items.every((r: { category: string }) => r.category === 'app_env'));

  const stats = (await get('/api/detect-tasks/stats')).json();
  const running = (await get('/api/detect-tasks?status=RUNNING')).json();
  assert.equal(running.total, stats.byStatus.RUNNING);
  assert.equal(running.items[0].id, ids.content);
  assert.deepEqual(running.items[0].actions, ['pause', 'stop']);

  const page2 = (await get('/api/detect-tasks?page=2&pageSize=3')).json();
  assert.equal(page2.items.length, 3);
  assert.equal(page2.items[0].id, ids.corpus);
});

test('组合任务建出的记录带所属组合任务；按组合任务筛选', async () => {
  const all = (await get('/api/detect-tasks?pageSize=100')).json();
  const row = all.items.find((r: { id: string }) => r.id === ids.content);
  assert.deepEqual(row.job, { id: ids.job, name: `${P}组合任务` });
  assert.equal(all.items.find((r: { id: string }) => r.id === ids.agent).job, null);
  const byJob = (await get(`/api/detect-tasks?jobId=${ids.job}`)).json();
  assert.equal(byJob.total, 1);
  assert.equal(byJob.items[0].id, ids.content);
});

test('权限：看不到没有查看权限的记录类型（列表、统计、类型清单都不含）', async () => {
  // 组件扫描按 engine:scan 或 eval_task:read 任一可看（与组件扫描列表接口一致），这个角色有 eval_task:read。
  const hidden = ['model_file_scan', 'asset_discovery'];
  const stats = (await get('/api/detect-tasks/stats', tokens.limited)).json();
  for (const k of hidden) {
    assert.ok(!stats.kinds.includes(k), k);
    assert.equal(stats.byKind[k] ?? 0, 0, k);
  }
  assert.ok(stats.kinds.includes('ai_component_scan'));
  assert.equal(stats.total, 6);
  assert.equal(stats.byCategory.model.total, 0);
  const list = (await get('/api/detect-tasks?pageSize=100', tokens.limited)).json();
  assert.equal(list.total, 6);
  assert.ok(!list.items.some((r: { kind: string }) => hidden.includes(r.kind)));
  const forced = (await get('/api/detect-tasks?kind=model_file_scan', tokens.limited)).json();
  assert.equal(forced.total, 0);
});

test('名称搜索：% 按字面匹配', async () => {
  const res = (await get(`/api/detect-tasks?q=${encodeURIComponent('%')}`)).json();
  assert.equal(res.total, 1);
  assert.equal(res.items[0].id, ids.paused);
  const under = (await get(`/api/detect-tasks?q=${encodeURIComponent('_')}`)).json();
  assert.ok(under.items.every((r: { name: string }) => r.name.includes('_')));
});

test('租户隔离：别的租户的记录不出现；全部租户视角带 tenantId 只看该租户', async () => {
  const mine = (await get('/api/detect-tasks?pageSize=100')).json();
  assert.ok(!mine.items.some((r: { id: string }) => r.id === platformTaskId));
  const platform = (await get('/api/detect-tasks?pageSize=100', tokens.admin)).json();
  assert.ok(platform.items.some((r: { id: string }) => r.id === platformTaskId));
  assert.ok(!platform.items.some((r: { id: string }) => r.id === ids.content));
  const scoped = (
    await get(`/api/detect-tasks?tenantId=${tenantId}&pageSize=100`, tokens.admin, 'all')
  ).json();
  assert.equal(scoped.total, 8);
  const scopedStats = (
    await get(`/api/detect-tasks/stats?tenantId=${tenantId}`, tokens.admin, 'all')
  ).json();
  assert.equal(scopedStats.total, 8);
  // 非全局视角下带 tenantId 不生效
  const ignored = (
    await get(`/api/detect-tasks?tenantId=${tenantId}&pageSize=100`, tokens.admin)
  ).json();
  assert.ok(!ignored.items.some((r: { id: string }) => r.id === ids.content));
  // 别的租户对记录做操作：404
  const foreign = await app.inject({
    method: 'POST',
    url: `/api/detect-tasks/eval_task/${ids.content}/pause`,
    headers: bearer(tokens.admin),
  });
  assert.equal(foreign.statusCode, 404, foreign.body);
});

test('记录操作：评估任务暂停转到暂停逻辑；语料停止 409；写审计', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/detect-tasks/eval_task/${ids.content}/pause`,
    headers: bearer(tokens.tenantAdmin),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().pauseRequested, true);
  assert.ok(pauseCalls.includes(ids.content));
  const corpus = await app.inject({
    method: 'POST',
    url: `/api/detect-tasks/corpus_scan/${ids.corpus}/stop`,
    headers: bearer(tokens.tenantAdmin),
  });
  assert.equal(corpus.statusCode, 409, corpus.body);
  assert.equal(corpus.json().error.code, 'DETECT_ACTION_UNSUPPORTED');
  const bad = await app.inject({
    method: 'POST',
    url: `/api/detect-tasks/nope/${ids.corpus}/stop`,
    headers: bearer(tokens.tenantAdmin),
  });
  assert.equal(bad.statusCode, 400, bad.body);
  const audit = await prismaUnscoped.auditLog.findFirst({
    where: { action: 'detect_task.pause', targetId: ids.content },
  });
  assert.ok(audit);
});

test('操作按权限给：只读账号行上没有暂停、停止；行带租户编号和「暂停中」', async () => {
  const limited = (await get('/api/detect-tasks?pageSize=100', tokens.limited)).json();
  const row = limited.items.find((r: { id: string }) => r.id === ids.content);
  assert.deepEqual(row.actions, [], '没有 eval_task:re_eval、eval_task:delete');
  assert.equal(row.tenantId, tenantId);
  // 上一条测试已对它请求暂停：管理员看到暂停中，可撤销暂停或停止
  const admin = (await get('/api/detect-tasks?pageSize=100')).json();
  const mine = admin.items.find((r: { id: string }) => r.id === ids.content);
  assert.equal(mine.pauseRequested, true);
  assert.deepEqual(mine.actions, ['resume', 'stop']);
});

test('统计按类型筛选：状态数与列表对得上', async () => {
  const stats = (await get('/api/detect-tasks/stats?kind=model_file_scan')).json();
  const list = (await get('/api/detect-tasks?kind=model_file_scan')).json();
  assert.equal(stats.total, list.total);
  assert.equal(stats.byStatus.CANCELED, 1);
  assert.equal(stats.byStatus.RUNNING, 0);
});

test('模型文件扫描：别人发起的不给「停止」，自己发起的给（内置管理员不限）', async () => {
  const tadmin = await prismaUnscoped.user.findUniqueOrThrow({ where: { username: `${P}tadmin` } });
  const perms = await prismaUnscoped.permission.findMany({
    where: { code: { in: ['detect_task:read', 'engine:scan'] } },
  });
  const role = await prismaUnscoped.role.create({
    data: {
      name: `${P}scanner`,
      permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
    },
  });
  const scanner = await prismaUnscoped.user.create({
    data: {
      tenantId,
      username: `${P}scanner`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: 'scanner',
      roles: { create: { roleId: role.id } },
    },
  });
  const token = await login(`${P}scanner`, PASSWORD);
  const scan = (createdById: string, path: string) =>
    prismaUnscoped.modelFileScan.create({
      data: { tenantId, source: 'DIRECTORY', path, status: 'RUNNING', createdById },
    });
  const own = await scan(scanner.id, `/models/${P}own`);
  const other = await scan(tadmin.id, `/models/${P}other`);
  const list = (await get('/api/detect-tasks?kind=model_file_scan&pageSize=100', token)).json();
  const find = (id: string) => list.items.find((r: { id: string }) => r.id === id);
  assert.deepEqual(find(own.id).actions, ['stop']);
  assert.deepEqual(find(other.id).actions, []);
});

test('停止分派：国标专项走国标的停止（写回计数、证据不完整），RAG 走 RAG 的停止，各要本模块的运行权限', async () => {
  const target = await prisma.modelTarget.create({
    data: {
      name: `${P}分派对象`,
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'dummy-view-key', // pragma: allowlist secret
      model: 'fake-model',
    },
  });
  const gbtTask = await prisma.evalTask.create({
    data: { name: `${P}国标专项`, modelTargetId: target.id, status: 'RUNNING' },
  });
  const release = await prisma.standardBankRelease.create({
    data: {
      profileId: 'gb-test',
      profileVersion: 'v1',
      name: `${P}国标样本集`,
      language: 'zh',
      modalities: ['text'],
      status: 'PUBLISHED',
    },
  });
  const run = await prisma.standardRun.create({
    data: {
      taskId: gbtTask.id,
      bankReleaseId: release.id,
      profileSnapshot: {},
      modelSnapshot: {},
      boundary: 'test',
      language: 'zh',
      modality: 'text',
      samplePlan: {},
      samplePlanHash: 'x',
    },
  });
  const post = (url: string, token = tokens.admin) =>
    app.inject({ method: 'POST', url, headers: bearer(token) });
  // 国标专项不能暂停
  assert.equal((await post(`/api/detect-tasks/standard_run/${gbtTask.id}/pause`)).statusCode, 409);
  const stop = await post(`/api/detect-tasks/standard_run/${gbtTask.id}/stop`);
  assert.equal(stop.statusCode, 200, stop.body);
  assert.equal(stop.json().status, 'CANCELED');
  const runAfter = await prisma.standardRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(runAfter.status, 'CANCELED');
  assert.equal(runAfter.evidenceCompleteness, 'PARTIAL');
  assert.ok(
    await prismaUnscoped.auditLog.findFirst({
      where: { action: 'standard_evaluation.cancel', targetId: run.id },
    }),
  );

  const corpus = await prisma.ragCorpus.create({ data: { name: `${P}语料库` } });
  const testSet = await prisma.ragTestSet.create({
    data: {
      corpusId: corpus.id,
      name: `${P}测试集`,
      seed: 's',
      promptVersion: 'v1',
      poisonDocument: 'p',
      poisonCanary: 'c',
      sentinelDocument: 'd',
      sentinelToken: 't',
    },
  });
  const ragTask = await prisma.evalTask.create({
    data: { name: `${P}RAG 评估`, modelTargetId: target.id, status: 'PENDING' },
  });
  const ragRun = await prisma.ragEvalRun.create({
    data: { taskId: ragTask.id, testSetId: testSet.id, modelTargetId: target.id },
  });
  const ragStop = await post(`/api/detect-tasks/rag_eval/${ragTask.id}/stop`);
  assert.equal(ragStop.statusCode, 200, ragStop.body);
  assert.equal(ragStop.json().status, 'CANCELED');
  const ragAfter = await prisma.ragEvalRun.findUniqueOrThrow({ where: { id: ragRun.id } });
  assert.equal(ragAfter.status, 'CANCELED');
  assert.ok(
    await prismaUnscoped.auditLog.findFirst({
      where: { action: 'rag_eval.run.cancel', targetId: ragRun.id },
    }),
  );
});

test('组合任务详情按查看人的权限：没有读权限的记录类型只显示类型和状态；没有操作权限不给操作', async () => {
  const job = await prismaUnscoped.detectJob.create({
    data: {
      tenantId,
      name: `${P}权限组合任务`,
      status: 'RUNNING',
      items: {
        create: [
          {
            tenantId,
            position: 0,
            kind: 'eval_task',
            title: '内容评估',
            params: {},
            status: 'RUNNING',
            recordKind: 'eval_task',
            recordId: ids.content,
          },
          {
            tenantId,
            position: 1,
            kind: 'model_file_scan',
            title: '模型目录 /models/secret',
            params: { source: 'directory', path: '/models/secret' },
            status: 'COMPLETED',
            recordKind: 'model_file_scan',
            recordId: ids.modelFile,
          },
        ],
      },
    },
  });
  const detail = (await get(`/api/detect-jobs/${job.id}`, tokens.limited)).json();
  const [evalItem, fileItem] = detail.items;
  assert.equal(evalItem.restricted, false);
  assert.ok(evalItem.href);
  assert.deepEqual(evalItem.actions, []);
  assert.equal(fileItem.restricted, true);
  assert.equal(fileItem.title, '模型文件扫描');
  assert.deepEqual(fileItem.params, {});
  assert.equal(fileItem.recordName, null);
  assert.equal(fileItem.href, null);
  assert.equal(fileItem.status, 'COMPLETED');
  const admin = (await get(`/api/detect-jobs/${job.id}`)).json();
  assert.equal(admin.items[1].restricted, false);
  assert.equal(admin.items[1].title, '模型目录 /models/secret');
});
