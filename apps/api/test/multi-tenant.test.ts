import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import { runInTenant } from '../src/lib/tenant-context.js';
import { evaluateGateForTask } from '../src/modules/gates/service.js';
import { componentSecurityStats } from '../src/modules/dashboard/component-security.js';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';

// 多租户隔离：租户管理、登录态、按租户隔离的评估资产与日常评估、平台共享内容、数据库兜底。

const P = 'MT26-';
const PW = 'Tenant@12345'; // pragma: allowlist secret
const noopLimiter = { take: () => true };

let app!: FastifyInstance;
let adminJwt = '';
const T = {
  a: { id: '', jwt: '', adminId: '', username: `${P.toLowerCase()}a-admin` },
  b: { id: '', jwt: '', adminId: '', username: `${P.toLowerCase()}b-admin` },
};
const created: { aTarget: string; bTarget: string; aSet: string; bSet: string; aTask: string } = {
  aTarget: '',
  bTarget: '',
  aSet: '',
  bSet: '',
  aTask: '',
};

function h(jwt: string, tenant?: string): Record<string, string> {
  return { authorization: `Bearer ${jwt}`, ...(tenant ? { 'x-lse-tenant': tenant } : {}) };
}

function items<T = Record<string, unknown>>(body: unknown): T[] {
  const b = body as { items?: T[] } | T[];
  return Array.isArray(b) ? b : (b.items ?? []);
}

async function login(username: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
}

async function cleanup(): Promise<void> {
  const ts = await prisma.tenant.findMany({ where: { name: { startsWith: P } }, select: { id: true } });
  const ids = ts.map((t) => t.id);
  if (ids.length) {
    const many = async <T extends { id: string }>(rows: Promise<T[]>) => (await rows).map((r) => r.id);
    await prisma.fleetEvalJob.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.fleetEndpoint.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.fleetEnrollmentCode.deleteMany({ where: { tenantId: { in: ids } } });

    // 有 Restrict 外键的子表必须先清，否则删任务 / 删评估对象会被数据库拦住。
    const assuranceRunIds = await many(
      prisma.serviceAssuranceRun.findMany({ where: { tenantId: { in: ids } }, select: { id: true } }),
    );
    if (assuranceRunIds.length) {
      await prisma.vulnerabilityAssessment.deleteMany({ where: { runId: { in: assuranceRunIds } } });
      await prisma.serviceComponent.deleteMany({ where: { runId: { in: assuranceRunIds } } });
      await prisma.serviceAssuranceRun.deleteMany({ where: { id: { in: assuranceRunIds } } });
    }
    const runIds = await many(
      prisma.standardRun.findMany({ where: { tenantId: { in: ids } }, select: { id: true } }),
    );
    if (runIds.length) {
      await prisma.standardReport.deleteMany({ where: { standardRunId: { in: runIds } } });
      await prisma.standardSample.deleteMany({ where: { standardRunId: { in: runIds } } });
      await prisma.standardRun.deleteMany({ where: { id: { in: runIds } } });
    }
    const releaseIds = await many(
      prisma.standardBankRelease.findMany({ where: { tenantId: { in: ids } }, select: { id: true } }),
    );
    if (releaseIds.length) {
      await prisma.standardBankReleaseItem.deleteMany({ where: { releaseId: { in: releaseIds } } });
      await prisma.standardBankRelease.deleteMany({ where: { id: { in: releaseIds } } });
    }
    const taskIds = await many(
      prisma.evalTask.findMany({ where: { tenantId: { in: ids } }, select: { id: true } }),
    );
    const gateIds = await many(
      prisma.gateRule.findMany({ where: { tenantId: { in: ids } }, select: { id: true } }),
    );
    if (taskIds.length || gateIds.length) {
      await prisma.gateEvaluation.deleteMany({
        where: { OR: [{ taskId: { in: taskIds } }, { gateId: { in: gateIds } }] },
      });
    }
    await prisma.gateRule.deleteMany({ where: { tenantId: { in: ids } } });

    await prisma.evalTask.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.questionImport.deleteMany({ where: { filename: { startsWith: P } } });
    await prisma.questionSet.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.modelTarget.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.ragCorpus.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.testDomain.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.aiComponentToolBaseline.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.externalAssetAssessment.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.apiToken.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.user.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: P } } });
}

async function createTarget(jwt: string, name: string, tenant?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: h(jwt, tenant),
    payload: {
      name,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-multitenant-test-1234567890',
      model: 'fake-model',
    },
  });
}

before(async () => {
  process.env.FLEET_AGENT_ENABLED = 'true';
  process.env.LSE_ENDPOINT_EVAL_ENABLED = 'true'; // 终端测评接口默认不上线，这里单独打开验租户隔离
  app = await buildApp({
    cancelEvalTask: async () => undefined,
    fleetAgent: { rateLimiters: { ip: noopLimiter, register: noopLimiter, endpoint: noopLimiter } },
  });
  await app.ready();
  await cleanup();
  const res = await login('admin', 'Admin@12345'); // pragma: allowlist secret
  assert.equal(res.statusCode, 200, res.body);
  adminJwt = res.json().token;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('平台管理员的登录态在平台租户、带租户管理权限', async () => {
  const me = await app.inject({ url: '/api/auth/me', headers: h(adminJwt) });
  assert.equal(me.statusCode, 200, me.body);
  const user = me.json().user;
  assert.equal(user.tenant.id, PLATFORM_TENANT_ID);
  assert.equal(user.tenant.isPlatform, true);
  assert.equal(user.isPlatformAdmin, true);
  assert.ok(user.permissions.includes('tenant:manage'));
});

test('平台管理员一次建好租户和它的管理员账号', async () => {
  for (const key of ['a', 'b'] as const) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers: h(adminJwt),
      payload: { name: `${P}租户${key}`, admin: { username: T[key].username, password: PW } },
    });
    assert.equal(res.statusCode, 201, res.body);
    T[key].id = res.json().id;
    assert.equal(res.json().userCount, 1);
    const admin = await prisma.user.findUniqueOrThrow({
      where: { username: T[key].username },
      include: { roles: { include: { role: true } } },
    });
    assert.equal(admin.tenantId, T[key].id);
    assert.equal(admin.isBuiltin, true);
    assert.deepEqual(admin.roles.map((r) => r.role.name), ['tenant_admin']);
    assert.equal(admin.mustChangePassword, true, '新建租户的首个管理员须改密');
    T[key].adminId = admin.id;
    const lg = await login(T[key].username, PW);
    assert.equal(lg.statusCode, 200, lg.body);
    assert.equal(lg.json().user.passwordChangeRequired, true);
    await skipFirstPasswordChange(T[key].username);
    T[key].jwt = lg.json().token;
  }
  const dup = await app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: h(adminJwt),
    payload: { name: `${P}租户a`, admin: { username: `${P.toLowerCase()}x`, password: PW } },
  });
  assert.equal(dup.statusCode, 409);
  const list = await app.inject({ url: '/api/tenants', headers: h(adminJwt) });
  assert.equal(list.statusCode, 200);
  const names = items<{ name: string; isPlatform: boolean }>(list.json());
  assert.equal(names[0]!.isPlatform, true);
  assert.ok(names.some((t) => t.name === `${P}租户a`));
});

test('租户管理员只在本租户、没有平台级权限', async () => {
  const me = (await app.inject({ url: '/api/auth/me', headers: h(T.a.jwt) })).json().user;
  assert.equal(me.tenant.id, T.a.id);
  assert.equal(me.isPlatformAdmin, false);
  for (const code of ['tenant:manage', 'license:update', 'platform_setting:update', 'role:create'])
    assert.equal(me.permissions.includes(code), false, code);
  for (const code of ['user:create', 'model_target:create', 'eval_task:create', 'audit_log:read'])
    assert.ok(me.permissions.includes(code), code);
  assert.equal((await app.inject({ url: '/api/tenants', headers: h(T.a.jwt) })).statusCode, 403);
  // 带别的租户的请求头也进不去
  const peek = await app.inject({ url: '/api/auth/me', headers: h(T.a.jwt, T.b.id) });
  assert.equal(peek.json().user.tenant.id, T.a.id);
});

test('评估对象按租户隔离，不同租户可以同名', async () => {
  const a = await createTarget(T.a.jwt, `${P}同名对象`);
  assert.equal(a.statusCode, 201, a.body);
  const b = await createTarget(T.b.jwt, `${P}同名对象`);
  assert.equal(b.statusCode, 201, b.body);
  created.aTarget = a.json().id;
  created.bTarget = b.json().id;
  assert.equal((await createTarget(T.a.jwt, `${P}同名对象`)).statusCode, 409);
  const rowA = await prisma.modelTarget.findUniqueOrThrow({ where: { id: created.aTarget } });
  assert.equal(rowA.tenantId, T.a.id);

  const listA = items<{ id: string }>((await app.inject({ url: '/api/model-targets?pageSize=100', headers: h(T.a.jwt) })).json());
  assert.ok(listA.some((t) => t.id === created.aTarget));
  assert.ok(!listA.some((t) => t.id === created.bTarget));
  assert.equal((await app.inject({ url: `/api/model-targets/${created.bTarget}`, headers: h(T.a.jwt) })).statusCode, 404);
  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/model-targets/${created.bTarget}`,
    headers: h(T.a.jwt),
    payload: { name: `${P}改名` },
  });
  assert.equal(patch.statusCode, 404);
  const del = await app.inject({ method: 'DELETE', url: `/api/model-targets/${created.bTarget}`, headers: h(T.a.jwt) });
  assert.equal(del.statusCode, 404);
  const rowB = await prisma.modelTarget.findUniqueOrThrow({ where: { id: created.bTarget } });
  assert.equal(rowB.name, `${P}同名对象`);
});

test('题集与评估任务按租户隔离，平台内置题集各租户共用', async () => {
  for (const key of ['a', 'b'] as const) {
    const set = await prisma.questionSet.create({
      data: {
        tenantId: T[key].id,
        name: `${P}私有题集${key}`,
        type: 'GENERAL',
        source: 'test',
        questions: { create: [{ content: `${P}良性问题`, type: 'GENERAL' }] },
      },
      include: { questions: true },
    });
    assert.equal(set.questions[0]!.tenantId, T[key].id, '题目继承题集的租户');
    if (key === 'a') created.aSet = set.id;
    else created.bSet = set.id;
  }
  const builtin = await prisma.questionSet.findFirstOrThrow({ where: { isBuiltin: true } });
  assert.equal(builtin.tenantId, null);

  const setsA = items<{ id: string }>((await app.inject({ url: '/api/question-sets?pageSize=200', headers: h(T.a.jwt) })).json());
  assert.ok(setsA.some((s) => s.id === created.aSet));
  assert.ok(!setsA.some((s) => s.id === created.bSet));
  assert.ok(setsA.some((s) => s.id === builtin.id), '内置题集可见');
  assert.equal((await app.inject({ url: `/api/question-sets/${created.bSet}`, headers: h(T.a.jwt) })).statusCode, 404);

  const task = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: h(T.a.jwt),
    payload: { name: `${P}日常评估`, modelTargetId: created.aTarget, questionSetIds: [created.aSet, builtin.id] },
  });
  assert.equal(task.statusCode, 201, task.body);
  created.aTask = task.json().id;
  assert.equal((await prisma.evalTask.findUniqueOrThrow({ where: { id: created.aTask } })).tenantId, T.a.id);

  // 用别的租户的评估对象 / 私有题集建任务：拿不到
  const foreignTarget = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: h(T.a.jwt),
    payload: { name: `${P}越权1`, modelTargetId: created.bTarget, questionSetIds: [created.aSet] },
  });
  assert.ok(foreignTarget.statusCode >= 400 && foreignTarget.statusCode < 500, foreignTarget.body);
  const foreignSet = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: h(T.a.jwt),
    payload: { name: `${P}越权2`, modelTargetId: created.aTarget, questionSetIds: [created.bSet] },
  });
  assert.ok(foreignSet.statusCode >= 400 && foreignSet.statusCode < 500, foreignSet.body);
  assert.equal(await prisma.evalTask.count({ where: { name: { startsWith: `${P}越权` } } }), 0);

  const tasksB = items<{ id: string }>((await app.inject({ url: '/api/eval-tasks?pageSize=100', headers: h(T.b.jwt) })).json());
  assert.ok(!tasksB.some((t) => t.id === created.aTask));
  assert.equal((await app.inject({ url: `/api/eval-tasks/${created.aTask}`, headers: h(T.b.jwt) })).statusCode, 404);
  const tasksA = items<{ id: string }>((await app.inject({ url: '/api/eval-tasks?pageSize=100', headers: h(T.a.jwt) })).json());
  assert.ok(tasksA.some((t) => t.id === created.aTask));
});

test('用户管理只在本租户内，平台管理员角色分配不出去', async () => {
  const users = items<{ username: string }>((await app.inject({ url: '/api/users?pageSize=200', headers: h(T.a.jwt) })).json());
  assert.deepEqual(users.map((u) => u.username), [T.a.username]);
  const roles = items<{ id: string; name: string }>((await app.inject({ url: '/api/roles', headers: h(T.a.jwt) })).json());
  assert.ok(!roles.some((r) => r.name === 'admin'));
  const operator = roles.find((r) => r.name === 'operator')!;
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'admin' } });
  const ok = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: h(T.a.jwt),
    payload: { username: `${P.toLowerCase()}a-op`, password: PW, displayName: '甲操作员', roleIds: [operator.id] },
  });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { username: `${P.toLowerCase()}a-op` } })).tenantId, T.a.id);
  const bad = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: h(T.a.jwt),
    payload: { username: `${P.toLowerCase()}a-bad`, password: PW, displayName: '越权', roleIds: [adminRole.id] },
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal((await app.inject({ url: `/api/users/${T.b.adminId}`, headers: h(T.a.jwt) })).statusCode, 404);
  const reset = await app.inject({
    method: 'POST',
    url: `/api/users/${T.b.adminId}/reset-password`,
    headers: h(T.a.jwt),
    payload: { password: 'Hijack@12345' }, // pragma: allowlist secret
  });
  assert.equal(reset.statusCode, 404);
});

test('平台管理员切换进入租户后看到的是该租户的数据', async () => {
  const inA = await app.inject({ url: '/api/auth/me', headers: h(adminJwt, T.a.id) });
  assert.equal(inA.json().user.tenant.id, T.a.id);
  const listInA = items<{ id: string }>((await app.inject({ url: '/api/model-targets?pageSize=100', headers: h(adminJwt, T.a.id) })).json());
  assert.ok(listInA.some((t) => t.id === created.aTarget));
  assert.ok(!listInA.some((t) => t.id === created.bTarget));
  const listHome = items<{ id: string }>((await app.inject({ url: '/api/model-targets?pageSize=100', headers: h(adminJwt) })).json());
  assert.ok(!listHome.some((t) => t.id === created.aTarget));
  // 代管时新建的数据归目标租户
  const t = await createTarget(adminJwt, `${P}代建对象`, T.a.id);
  assert.equal(t.statusCode, 201, t.body);
  assert.equal((await prisma.modelTarget.findUniqueOrThrow({ where: { id: t.json().id } })).tenantId, T.a.id);
  const users = items<{ username: string }>((await app.inject({ url: '/api/users?pageSize=200', headers: h(adminJwt, T.a.id) })).json());
  assert.ok(users.some((u) => u.username === T.a.username));
  assert.ok(!users.some((u) => u.username === 'admin'));
  const missing = await app.inject({ url: '/api/auth/me', headers: h(adminJwt, randomUUID()) });
  assert.equal(missing.statusCode, 403);
  assert.equal(missing.json().error.code, 'TENANT_NOT_FOUND');
});

test('终端用哪个租户的接入码登记，就归哪个租户', async () => {
  const code = await app.inject({
    method: 'POST',
    url: '/api/fleet/enrollment-codes',
    headers: h(T.a.jwt),
    payload: { label: `${P}甲接入码` },
  });
  assert.equal(code.statusCode, 201, code.body);
  const reg = await app.inject({
    method: 'POST',
    url: '/agent/v1/endpoints/register',
    headers: { authorization: `Bearer ${code.json().code}` },
    payload: {
      machine_id: '43d1c24cc41541068f2318c4e5462ff9',
      installation_id: randomUUID(),
      hostname: `${P.toLowerCase()}host`,
      os: 'linux',
      os_version: 'Ubuntu 26.04 LTS',
      arch: 'amd64',
      os_user: 'yj',
      agent_product: 'aiprobe',
      agent_version: 'a'.repeat(40),
      adapter_name: 'platform-inventory',
      adapter_version: 'b'.repeat(40),
      capabilities: ['asset_snapshot', 'config_change'],
    },
  });
  assert.equal(reg.statusCode, 200, reg.body);
  const ep = await prisma.fleetEndpoint.findUniqueOrThrow({ where: { publicId: reg.json().endpoint_id } });
  assert.equal(ep.tenantId, T.a.id);
  const listA = await app.inject({ url: '/api/fleet/endpoints', headers: h(T.a.jwt) });
  assert.ok(listA.body.includes(ep.publicId));
  const listB = await app.inject({ url: '/api/fleet/endpoints', headers: h(T.b.jwt) });
  assert.equal(listB.statusCode, 200);
  assert.ok(!listB.body.includes(ep.publicId));
  const codesB = await app.inject({ url: '/api/fleet/enrollment-codes', headers: h(T.b.jwt) });
  assert.ok(!codesB.body.includes(`${P}甲接入码`));
});

test('操作日志按租户隔离', async () => {
  const logsA = await app.inject({ url: '/api/audit-logs?pageSize=100', headers: h(T.a.jwt) });
  assert.equal(logsA.statusCode, 200, logsA.body);
  assert.ok(logsA.body.includes(T.a.username));
  assert.ok(!logsA.body.includes(T.b.username));
  // 租户管理这类平台级操作记在平台租户
  const platform = await app.inject({ url: '/api/audit-logs?pageSize=100&action=tenant.create', headers: h(adminJwt) });
  assert.equal(platform.statusCode, 200);
  assert.ok(platform.body.includes(T.a.id));
  const inA = await app.inject({ url: '/api/audit-logs?pageSize=100&action=tenant.create', headers: h(T.a.jwt) });
  assert.ok(!inA.body.includes(T.a.id));
});

test('API 令牌只在所属租户内生效', async () => {
  const tok = await app.inject({
    method: 'POST',
    url: '/api/api-tokens',
    headers: h(T.b.jwt),
    payload: { name: `${P}乙令牌`, scopes: ['eval-tasks:read'], expiresInDays: 1 },
  });
  assert.equal(tok.statusCode, 201, tok.body);
  const plain = tok.json().token as string;
  const foreign = await app.inject({ url: `/api/eval-tasks/${created.aTask}/export`, headers: { authorization: `Bearer ${plain}` } });
  assert.equal(foreign.statusCode, 404, foreign.body);
});

// ─────────────────── 审计修复的回归用例 ───────────────────
// 每条对应交接文档第 4 节的一处缺口：两个租户互相越权访问，断言 404 / 看不到 / 改不到。
// 放在「停用租户」之前：那条用例会停用再启用乙租户，后面继续用乙的登录态不踏实。

/** 没有租户上下文地建任务：租户从评估对象继承（模拟后台 worker）。 */
async function backgroundTask(targetId: string, suffix: string) {
  return prisma.evalTask.create({
    data: { name: `${P}后台${suffix}`, modelTargetId: targetId },
  });
}

test('门禁判定只匹配本租户的门禁，跨租户判定写不进去', async () => {
  const gateA = await prisma.gateRule.create({
    data: { tenantId: T.a.id, name: `${P}甲门禁`, rules: { minScore: 0 }, enabled: true },
  });
  const gateB = await prisma.gateRule.create({
    data: { tenantId: T.b.id, name: `${P}乙门禁`, rules: { minScore: 0 }, enabled: true },
  });
  await prisma.evalTask.update({
    where: { id: created.aTask },
    data: { status: 'COMPLETED', finishedAt: new Date() },
  });
  // 模拟 worker：没有租户上下文，只有任务自身的 tenantId 可用
  const judged = await evaluateGateForTask(created.aTask);
  assert.deepEqual(judged.map((row) => row.gateId), [gateA.id], '只能看到本租户的门禁');
  assert.equal(await prisma.gateEvaluation.count({ where: { gateId: gateB.id } }), 0);

  const bTask = await backgroundTask(created.bTarget, '乙任务');
  assert.equal(bTask.tenantId, T.b.id);
  await assert.rejects(
    prisma.gateEvaluation.create({
      data: { gateId: gateA.id, taskId: bTask.id, passed: true, reasons: [] },
    }),
    /LSE_CROSS_TENANT_REFERENCE/,
  );
});

test('态势概览趋势按租户统计，别家的风险回复不计入', async () => {
  const sumOf = (body: { points: Array<{ findings: number }> }) =>
    body.points.reduce((acc, p) => acc + p.findings, 0);
  const baseA = sumOf((await app.inject({ url: '/api/dashboard/trend?days=30', headers: h(T.a.jwt) })).json());

  const bTask = await backgroundTask(created.bTarget, '乙发现');
  await prisma.finding.create({
    data: {
      taskId: bTask.id,
      engine: 'multitenant-test',
      riskCategory: `${P}乙类`,
      severity: 'HIGH',
    },
  });

  const afterA = (await app.inject({ url: '/api/dashboard/trend?days=30', headers: h(T.a.jwt) })).json();
  assert.equal(sumOf(afterA), baseA, '甲租户的趋势不受乙租户新增风险回复影响');
  const inB = (await app.inject({ url: '/api/dashboard/trend?days=30', headers: h(T.b.jwt) })).json();
  assert.ok(sumOf(inB) >= 1, '乙租户能看到自己的风险回复');
});

test('组件安全统计只数本租户的服务核验记录', async () => {
  const run = await prisma.serviceAssuranceRun.create({
    data: {
      tenantId: T.a.id,
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      targetName: `${P}服务`,
      scopePolicyRef: 'default',
      requestBudget: {},
    },
  });
  await prisma.serviceComponent.create({
    data: {
      runId: run.id,
      name: `${P}组件`,
      source: 'test',
      evidenceLevel: 'CONFIG_MATCH',
      componentKey: `${P}component`,
    },
  });
  const inA = await runInTenant(T.a.id, () => componentSecurityStats());
  const inB = await runInTenant(T.b.id, () => componentSecurityStats());
  assert.ok(inA.componentCount >= 1);
  assert.equal(inB.componentCount, 0, '乙租户不数甲租户的组件');
});

test('RAG 文档与切片按所属知识库校验租户', async () => {
  const corpus = await prisma.ragCorpus.create({ data: { tenantId: T.a.id, name: `${P}甲知识库` } });
  const doc = await prisma.ragDocument.create({
    data: {
      corpusId: corpus.id,
      filename: `${P}a.txt`,
      format: 'txt',
      sizeBytes: 12,
      sha256: 'a'.repeat(64),
      textLength: 12,
      chunkCount: 1,
    },
  });
  await prisma.ragChunk.create({
    data: { corpusId: corpus.id, documentId: doc.id, seq: 1, content: `${P}切片`, charStart: 0, charEnd: 12 },
  });
  assert.equal(
    (await app.inject({ url: `/api/rag-eval/documents/${doc.id}/chunks`, headers: h(T.a.jwt) })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: `/api/rag-eval/documents/${doc.id}/chunks`, headers: h(T.b.jwt) })).statusCode,
    404,
  );
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/rag-eval/documents/${doc.id}`,
    headers: h(T.b.jwt),
  });
  assert.equal(del.statusCode, 404, del.body);
  assert.equal(await prisma.ragDocument.count({ where: { id: doc.id } }), 1);
});

test('国标技术判定与报告先校验标准专项任务的租户', async () => {
  const release = await prisma.standardBankRelease.create({
    data: {
      profileId: 'gb-test',
      profileVersion: 'v1',
      name: `${P}样本集`,
      language: 'zh',
      modalities: ['text'],
      status: 'PUBLISHED',
    },
  });
  const run = await prisma.standardRun.create({
    data: {
      tenantId: T.a.id,
      taskId: created.aTask,
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
  const asB = await app.inject({
    method: 'POST',
    url: `/api/standard-evaluations/${run.id}/technical-judge`,
    headers: h(T.b.jwt),
  });
  assert.equal(asB.statusCode, 404, asB.body);
  const asA = await app.inject({
    method: 'POST',
    url: `/api/standard-evaluations/${run.id}/technical-judge`,
    headers: h(T.a.jwt),
  });
  assert.equal(asA.statusCode, 400, asA.body);
  assert.equal(
    (await app.inject({ url: `/api/standard-evaluations/${run.id}/report`, headers: h(T.b.jwt) })).statusCode,
    404,
  );
});

test('题集导入记录只给本租户', async () => {
  const builtin = await prisma.questionSet.findFirstOrThrow({ where: { isBuiltin: true } });
  const imp = await prisma.questionImport.create({
    data: {
      questionSetId: builtin.id,
      filename: `${P}import.csv`,
      format: 'csv',
      templateType: 'general',
      uploadedById: T.a.adminId,
    },
  });
  const listA = await app.inject({ url: '/api/question-sets/imports?pageSize=100', headers: h(T.a.jwt) });
  assert.equal(listA.statusCode, 200, listA.body);
  assert.ok(listA.body.includes(imp.id));
  const listB = await app.inject({ url: '/api/question-sets/imports?pageSize=100', headers: h(T.b.jwt) });
  assert.equal(listB.statusCode, 200);
  assert.ok(!listB.body.includes(imp.id));
  assert.equal(
    (await app.inject({ url: `/api/question-sets/imports/${imp.id}`, headers: h(T.b.jwt) })).statusCode,
    404,
  );
  // 内置题集的关联计数也按租户：甲有 1 条导入，乙没有
  const setsA = (await app.inject({ url: '/api/question-sets?pageSize=200', headers: h(T.a.jwt) })).json();
  const setsB = (await app.inject({ url: '/api/question-sets?pageSize=200', headers: h(T.b.jwt) })).json();
  const countOf = (body: { items: Array<{ id: string; importCount: number }> }) =>
    body.items.find((s) => s.id === builtin.id)?.importCount ?? 0;
  assert.ok(countOf(setsA) >= 1, '甲租户看到自己的导入次数');
  assert.equal(countOf(setsB), 0, '乙租户不数甲租户的导入次数');
});

test('平台租户也看不到别的租户的导入记录；代管时看得到', async () => {
  // 导入到甲自己的题集、以及没有挂上题集的导入（例如解析失败），都属于甲。
  const intoOwn = await prisma.questionImport.create({
    data: { questionSetId: created.aSet, filename: `${P}own.csv`, format: 'csv', templateType: 'general', uploadedById: T.a.adminId },
  });
  const orphan = await prisma.questionImport.create({
    data: { filename: `${P}orphan.csv`, format: 'csv', templateType: 'general', uploadedById: T.a.adminId },
  });
  const listA = await app.inject({ url: '/api/question-sets/imports?pageSize=100', headers: h(T.a.jwt) });
  assert.ok(listA.body.includes(intoOwn.id) && listA.body.includes(orphan.id), listA.body);

  const listPlatform = await app.inject({ url: '/api/question-sets/imports?pageSize=100', headers: h(adminJwt) });
  assert.equal(listPlatform.statusCode, 200, listPlatform.body);
  assert.ok(!listPlatform.body.includes(intoOwn.id), '平台租户列表不含甲的导入');
  assert.ok(!listPlatform.body.includes(orphan.id), '平台租户列表不含甲没挂题集的导入');
  for (const id of [intoOwn.id, orphan.id])
    assert.equal((await app.inject({ url: `/api/question-sets/imports/${id}`, headers: h(adminJwt) })).statusCode, 404);
  // 按别的租户的题集筛选：空结果，不报错
  const bySet = await app.inject({ url: `/api/question-sets/imports?questionSetId=${created.aSet}`, headers: h(T.b.jwt) });
  assert.equal(bySet.statusCode, 200);
  assert.equal(bySet.json().total, 0);
  // 平台管理员代管甲时能看到甲题集上的导入
  const managing = await app.inject({ url: `/api/question-sets/imports/${intoOwn.id}`, headers: h(adminJwt, T.a.id) });
  assert.equal(managing.statusCode, 200, managing.body);
});

test('靶场回执只给本租户的任务', async () => {
  const bTask = await backgroundTask(created.bTarget, '乙回执');
  await prisma.evalTaskLog.create({ data: { taskId: bTask.id, message: '终端诱饵接收' } });
  const inA = (await app.inject({ url: '/api/agent-samples/range', headers: h(T.a.jwt) })).json();
  assert.ok(!inA.recentReceipts.some((row: { taskId: string }) => row.taskId === bTask.id));
  const inB = (await app.inject({ url: '/api/agent-samples/range', headers: h(T.b.jwt) })).json();
  assert.ok(inB.recentReceipts.some((row: { taskId: string }) => row.taskId === bTask.id));
});

test('引擎运行记录按任务归属校验', async () => {
  const bTask = await backgroundTask(created.bTarget, '乙运行');
  for (const url of [
    `/api/engines/ai-asset/runs?taskId=${bTask.id}`,
    `/api/engines/relay-audit/runs?taskId=${bTask.id}`,
  ]) {
    const res = await app.inject({ url, headers: h(T.a.jwt) });
    assert.equal(res.statusCode, 404, `${url} ${res.body}`);
  }
});

test('平台共享的裁判模型各租户只读，看不到也改不到', async () => {
  const platformAdmin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
  const judge = await prisma.modelTarget.create({
    data: {
      tenantId: null,
      name: `${P}平台裁判`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-judge-shared-1234567890',
      model: 'judge-model',
      targetType: 'JUDGE',
      createdById: platformAdmin.id,
    },
  });
  assert.equal(judge.tenantId, null, '平台管理员建的裁判模型是平台共享');
  // 裁判模型属于默认不出现在评估对象列表里的系统对象，要显式带上 includeSystem
  const listA = (
    await app.inject({ url: '/api/model-targets?pageSize=200&includeSystem=true', headers: h(T.a.jwt) })
  ).json();
  assert.ok(
    items<{ id: string }>(listA).some((t) => t.id === judge.id),
    '租户能看到平台共享裁判模型',
  );
  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/model-targets/${judge.id}`,
    headers: h(T.a.jwt),
    payload: { name: `${P}改名` },
  });
  assert.equal(patch.statusCode, 403, patch.body);
  assert.equal(patch.json().error.code, 'PLATFORM_TARGET_READONLY');
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/model-targets/${judge.id}`,
    headers: h(T.a.jwt),
  });
  assert.equal(del.statusCode, 403, del.body);
  // 平台管理员在平台租户里可以改
  const asPlatform = await app.inject({
    method: 'PATCH',
    url: `/api/model-targets/${judge.id}`,
    headers: h(adminJwt),
    payload: { name: `${P}平台裁判2` },
  });
  assert.equal(asPlatform.statusCode, 200, asPlatform.body);
  await prisma.modelTarget.delete({ where: { id: judge.id } });
});

test('测试领域与工具基线按租户，不再跨租户撞唯一键', async () => {
  const [domainA, domainB] = await Promise.all([
    prisma.testDomain.create({ data: { tenantId: T.a.id, name: `${P}同名领域` } }),
    prisma.testDomain.create({ data: { tenantId: T.b.id, name: `${P}同名领域` } }),
  ]);
  assert.notEqual(domainA.id, domainB.id);
  const domainsB = (
    await app.inject({ url: '/api/question-sets/attack-seeds/domains', headers: h(T.b.jwt) })
  ).json();
  assert.ok(!domainsB.items.some((d: { id: string }) => d.id === domainA.id), '看不到别家的领域');

  const scan = { firstScanId: `${P}scan-1`, lastScanId: `${P}scan-1` };
  const baseA = await prisma.aiComponentToolBaseline.create({
    data: {
      tenantId: T.a.id,
      assetKey: `${P}asset`,
      toolName: 'search',
      descriptionHash: 'h1',
      description: '甲',
      ...scan,
    },
  });
  const baseB = await prisma.aiComponentToolBaseline.create({
    data: {
      tenantId: T.b.id,
      assetKey: `${P}asset`,
      toolName: 'search',
      descriptionHash: 'h2',
      description: '乙',
      ...scan,
    },
  });
  assert.notEqual(baseA.id, baseB.id);
});

test('外部资产的来源请求号改为租户内唯一', async () => {
  const common = {
    sourceRequestId: `${P}req-1`,
    sourceTenantId: 'src-tenant',
    sourceAssetId: 'src-asset',
    sourceInstanceId: 'src-instance',
    assetType: 'skill',
    contentHash: 'h',
    rulesetVersion: 'v1',
    coverage: 'full',
    verdict: 'PASS',
    findings: [],
    report: {},
  };
  const rowA = await prisma.externalAssetAssessment.create({
    data: { ...common, tenantId: T.a.id, createdById: T.a.adminId },
  });
  const rowB = await prisma.externalAssetAssessment.create({
    data: { ...common, tenantId: T.b.id, createdById: T.b.adminId },
  });
  assert.notEqual(rowA.id, rowB.id);
});

test('网关集成与策略下发只给平台租户', async () => {
  const analyze = await app.inject({
    method: 'POST',
    url: '/api/gateway-logs/analyze',
    headers: h(T.a.jwt),
    payload: {},
  });
  assert.equal(analyze.statusCode, 403, analyze.body);
  assert.equal(analyze.json().error.code, 'PLATFORM_TENANT_ONLY');

  const dispatch = await app.inject({
    method: 'POST',
    url: '/api/policy-suggestions/dispatch',
    headers: h(T.a.jwt),
    payload: { ids: [] },
  });
  assert.equal(dispatch.statusCode, 403, dispatch.body);
  assert.equal(dispatch.json().error.code, 'PLATFORM_TENANT_ONLY');

  const endpoints = await app.inject({ url: '/api/endpoint-evals/endpoints', headers: h(T.a.jwt) });
  assert.equal(endpoints.statusCode, 200, endpoints.body);
  assert.deepEqual(endpoints.json(), [], 'AgentShield 终端清单不发给租户');
});

test('安全网关关联与网关联动只在平台租户：租户不能绑网关、看不到网关线索与联动', async () => {
  const bound = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: h(T.a.jwt),
    payload: {
      name: `${P}绑网关`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-multitenant-test-1234567890',
      model: 'fake-model',
      accessConfig: { gatewayBaseUrl: 'http://127.0.0.1:3000', tenantId: 'tenant_default' },
    },
  });
  assert.equal(bound.statusCode, 403, bound.body);
  assert.equal(bound.json().error.code, 'PLATFORM_TENANT_ONLY');

  const clues = await app.inject({ url: '/api/asset-discovery/gateway-clues', headers: h(T.a.jwt) });
  assert.equal(clues.statusCode, 200, clues.body);
  assert.equal(clues.json().status, 'NOT_CONNECTED');
  assert.deepEqual(clues.json().clues, []);

  // 平台开了网关联动：租户任务详情仍不显示联动（执行器同口径，不去查共用网关）
  const before = await prisma.systemSetting.findUnique({ where: { key: 'gateway' } });
  const value = { ...((before?.value as Record<string, unknown> | null) ?? {}), gatewayLinkageEnabled: true };
  await prisma.systemSetting.upsert({ where: { key: 'gateway' }, create: { key: 'gateway', value }, update: { value } });
  try {
    const detail = await app.inject({ url: `/api/eval-tasks/${created.aTask}`, headers: h(T.a.jwt) });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().gatewayLinkageEnabled, false);
  } finally {
    if (before) await prisma.systemSetting.update({ where: { key: 'gateway' }, data: { value: before.value as object } });
    else await prisma.systemSetting.delete({ where: { key: 'gateway' } });
  }
});

test('平台管理员代管其他租户时没有平台设置写权限', async () => {
  const asTenant = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: h(adminJwt, T.b.id),
    payload: {},
  });
  assert.equal(asTenant.statusCode, 403, asTenant.body);
  // 回到平台租户后仍然是平台管理员（不是把权限永久改掉）
  const me = (await app.inject({ url: '/api/auth/me', headers: h(adminJwt) })).json().user;
  assert.ok(me.permissions.includes('platform_setting:update'));
});

test('停用租户：账号不能登录、已登录的会话失效；平台租户不能停用', async () => {
  const off = await app.inject({ method: 'PATCH', url: `/api/tenants/${T.b.id}`, headers: h(adminJwt), payload: { isActive: false } });
  assert.equal(off.statusCode, 200, off.body);
  const lg = await login(T.b.username, PW);
  assert.equal(lg.statusCode, 403);
  assert.equal(lg.json().error.code, 'TENANT_DISABLED');
  const me = await app.inject({ url: '/api/auth/me', headers: h(T.b.jwt) });
  assert.equal(me.statusCode, 403);
  // 平台管理员仍可进入已停用的租户处理
  assert.equal((await app.inject({ url: '/api/auth/me', headers: h(adminJwt, T.b.id) })).statusCode, 200);
  const platformOff = await app.inject({ method: 'PATCH', url: `/api/tenants/${PLATFORM_TENANT_ID}`, headers: h(adminJwt), payload: { isActive: false } });
  assert.equal(platformOff.statusCode, 403);
  const on = await app.inject({ method: 'PATCH', url: `/api/tenants/${T.b.id}`, headers: h(adminJwt), payload: { isActive: true } });
  assert.equal(on.statusCode, 200);
  assert.equal((await login(T.b.username, PW)).statusCode, 200);
});

test('数据库兜底：后台写入继承父对象租户，跨租户引用直接拒绝', async () => {
  // 没有租户上下文（后台任务）建任务：从评估对象继承租户
  const bg = await prisma.evalTask.create({ data: { name: `${P}后台任务`, modelTargetId: created.bTarget } });
  assert.equal(bg.tenantId, T.b.id);
  await assert.rejects(
    prisma.evalTask.create({ data: { name: `${P}跨租户`, modelTargetId: created.bTarget, tenantId: T.a.id } }),
    /LSE_CROSS_TENANT_REFERENCE/,
  );
  await assert.rejects(
    prisma.evalTaskQuestionSet.create({ data: { taskId: bg.id, questionSetId: created.aSet } }),
    /LSE_CROSS_TENANT_REFERENCE/,
  );
});
