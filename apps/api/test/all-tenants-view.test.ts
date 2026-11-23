import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';

// 平台管理员「全部租户」只读汇总视角：
// /api/auth/me 的视角标记、列表汇总与 tenantId 筛选、写保护 409、平台级白名单、
// 租户管理风险统计、态势概览合计、以及单租户行为回归。

const P = 'ATV26-';
const PW = 'AllTenants@12345'; // pragma: allowlist secret
const noopLimiter = { take: () => true };

let app!: FastifyInstance;
let adminJwt = '';
const T = {
  a: { id: '', jwt: '', username: `${P.toLowerCase()}a-admin`, targetId: '', taskId: '' },
  b: { id: '', jwt: '', username: `${P.toLowerCase()}b-admin`, targetId: '', taskId: '' },
};
let platformTargetId = '';

function h(jwt: string, tenant?: string): Record<string, string> {
  return { authorization: `Bearer ${jwt}`, ...(tenant ? { 'x-lse-tenant': tenant } : {}) };
}
/** 平台管理员的「全部租户」请求头。 */
const all = () => h(adminJwt, 'all');

function items<T = Record<string, unknown>>(body: unknown): T[] {
  const b = body as { items?: T[] } | T[];
  return Array.isArray(b) ? b : (b.items ?? []);
}

async function login(username: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
}

function targetPayload(name: string) {
  return {
    name,
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'sk-all-tenants-test-1234567890',
    model: 'fake-model',
  };
}

async function createTarget(jwt: string, name: string, tenant?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: h(jwt, tenant),
    payload: targetPayload(name),
  });
}

/** 按外键顺序清理，避免 Restrict 约束挡住删租户。 */
async function cleanup(): Promise<void> {
  const ts = await prisma.tenant.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  const ids = ts.map((t) => t.id);
  const taskIds = (
    await prisma.evalTask.findMany({ where: { name: { startsWith: P } }, select: { id: true } })
  ).map((r) => r.id);
  if (taskIds.length) await prisma.finding.deleteMany({ where: { taskId: { in: taskIds } } });
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: P } } });
  if (ids.length) {
    await prisma.finding.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.fleetEvalJob.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.fleetEndpoint.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.fleetEnrollmentCode.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.gateEvaluation.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.gateRule.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.standardReport.deleteMany({ where: { standardRun: { tenantId: { in: ids } } } });
    await prisma.standardSample.deleteMany({ where: { standardRun: { tenantId: { in: ids } } } });
    await prisma.standardRun.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.questionImport.deleteMany({ where: { filename: { startsWith: P } } });
    await prisma.questionSet.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.ragCorpus.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.testDomain.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.apiToken.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.user.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  }
}

before(async () => {
  process.env.FLEET_AGENT_ENABLED = 'true';
  process.env.LSE_ENDPOINT_EVAL_ENABLED = 'true';
  app = await buildApp({
    cancelEvalTask: async () => undefined,
    fleetAgent: { rateLimiters: { ip: noopLimiter, register: noopLimiter, endpoint: noopLimiter } },
  });
  await app.ready();
  await cleanup();

  const res = await login('admin', 'Admin@12345'); // pragma: allowlist secret
  assert.equal(res.statusCode, 200, res.body);
  adminJwt = res.json().token;

  for (const key of ['a', 'b'] as const) {
    const created = await app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers: h(adminJwt),
      payload: { name: `${P}租户${key}`, admin: { username: T[key].username, password: PW } },
    });
    assert.equal(created.statusCode, 201, created.body);
    T[key].id = created.json().id;
    await skipFirstPasswordChange(T[key].username);
    const lg = await login(T[key].username, PW);
    assert.equal(lg.statusCode, 200, lg.body);
    T[key].jwt = lg.json().token;

    const target = await createTarget(T[key].jwt, `${P}对象${key}`);
    assert.equal(target.statusCode, 201, target.body);
    T[key].targetId = target.json().id;

    // 每个租户一个任务，用来挂风险发现，验证租户管理的风险数/高危数。
    const task = await prisma.evalTask.create({
      data: {
        tenantId: T[key].id,
        name: `${P}任务${key}`,
        status: 'COMPLETED',
        engines: ['rule-judge'],
        dimensions: ['safety'],
        totalQuestions: 10,
        processedQuestions: 10,
        passedCount: 10,
        failedCount: 0,
        progress: 1,
        modelTargetId: T[key].targetId,
      },
    });
    T[key].taskId = task.id;
  }

  // 甲：CRITICAL / HIGH / MEDIUM 三条有效风险（高危 2），外加一条误报 HIGH 不计入。
  await prisma.finding.createMany({
    data: [
      { severity: 'CRITICAL' },
      { severity: 'HIGH' },
      { severity: 'MEDIUM' },
      { severity: 'HIGH', reviewStatus: 'FALSE_POSITIVE' },
    ].map((f) => ({
      tenantId: T.a.id,
      taskId: T.a.taskId,
      engine: 'rule-judge',
      riskCategory: 'test',
      verdict: 'FAIL',
      reviewStatus: 'NEEDS_REVIEW',
      ...f,
    })),
  });
  // 乙：一条 LOW 有效风险，一条 severity 为空（不是有效风险）。
  await prisma.finding.createMany({
    data: [{ severity: 'LOW' as const }, { severity: null }].map((f) => ({
      tenantId: T.b.id,
      taskId: T.b.taskId,
      engine: 'rule-judge',
      riskCategory: 'test',
      verdict: 'FAIL',
      reviewStatus: 'NEEDS_REVIEW',
      ...f,
    })),
  });

  // 平台租户也放一个对象，验证全局视角连平台租户的数据一起汇总。
  const pt = await createTarget(adminJwt, `${P}平台对象`);
  assert.equal(pt.statusCode, 201, pt.body);
  platformTargetId = pt.json().id;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('平台管理员不带 all 头时仍是原来的平台租户视角', async () => {
  const me = await app.inject({ url: '/api/auth/me', headers: h(adminJwt) });
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().user.tenant.id, PLATFORM_TENANT_ID);
  assert.notEqual(me.json().user.allTenants, true);
});

test('x-lse-tenant: all 时 /api/auth/me 返回全部租户视角', async () => {
  const res = await app.inject({ url: '/api/auth/me', headers: all() });
  assert.equal(res.statusCode, 200, res.body);
  const u = res.json().user;
  assert.equal(u.allTenants, true);
  assert.equal(u.tenant.id, 'all');
  assert.equal(u.tenant.name, '全部租户');
  assert.equal(u.tenant.isPlatform, true);
  assert.equal(u.isPlatformAdmin, true);
});

test('租户管理员带 all 头被忽略，仍只读自己租户', async () => {
  const me = await app.inject({ url: '/api/auth/me', headers: h(T.a.jwt, 'all') });
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().user.tenant.id, T.a.id);
  assert.notEqual(me.json().user.allTenants, true);
  const list = await app.inject({
    url: '/api/model-targets?pageSize=100',
    headers: h(T.a.jwt, 'all'),
  });
  const rows = items<{ id: string }>(list.json());
  assert.ok(rows.some((r) => r.id === T.a.targetId));
  assert.ok(!rows.some((r) => r.id === T.b.targetId));
});

test('全局视角列表汇总所有租户，且每行带 tenantId', async () => {
  const res = await app.inject({ url: '/api/model-targets?pageSize=100', headers: all() });
  assert.equal(res.statusCode, 200, res.body);
  const rows = items<{ id: string; tenantId?: string | null }>(res.json());
  for (const key of ['a', 'b'] as const) {
    const row = rows.find((r) => r.id === T[key].targetId);
    assert.ok(row, `应看到租户 ${key} 的评估对象`);
    assert.equal(row!.tenantId, T[key].id);
  }
  assert.ok(
    rows.some((r) => r.id === platformTargetId),
    '也应看到平台租户的评估对象',
  );

  const users = await app.inject({ url: '/api/users?pageSize=100', headers: all() });
  assert.equal(users.statusCode, 200, users.body);
  const userRows = items<{ username: string; tenantId?: string | null }>(users.json());
  assert.equal(userRows.find((u) => u.username === T.a.username)?.tenantId, T.a.id);
  assert.equal(userRows.find((u) => u.username === T.b.username)?.tenantId, T.b.id);
});

test('全局视角 ?tenantId= 筛选只返回目标租户，普通用户不能借此越权', async () => {
  for (const key of ['a', 'b'] as const) {
    const res = await app.inject({
      url: `/api/model-targets?pageSize=100&tenantId=${T[key].id}`,
      headers: all(),
    });
    assert.equal(res.statusCode, 200, res.body);
    const rows = items<{ id: string }>(res.json());
    assert.ok(
      rows.some((r) => r.id === T[key].targetId),
      `筛选 ${key} 应含本租户对象`,
    );
    const other = key === 'a' ? T.b.targetId : T.a.targetId;
    assert.ok(!rows.some((r) => r.id === other), `筛选 ${key} 不应含另一租户对象`);
    assert.ok(!rows.some((r) => r.id === platformTargetId), `筛选 ${key} 不应含平台租户对象`);
  }
  // 租户管理员带 tenantId 指定别人：applyTenantFilter 只在全局视角生效，仍只看自己。
  const peek = await app.inject({
    url: `/api/model-targets?pageSize=100&tenantId=${T.b.id}`,
    headers: h(T.a.jwt),
  });
  assert.equal(peek.statusCode, 200, peek.body);
  assert.ok(!items<{ id: string }>(peek.json()).some((r) => r.id === T.b.targetId));
});

test('全局视角拒绝写操作：409 TENANT_REQUIRED / 请先进入具体租户再操作', async () => {
  const post = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: all(),
    payload: targetPayload(`${P}不该被创建`),
  });
  assert.equal(post.statusCode, 409, post.body);
  assert.equal(post.json().error.code, 'TENANT_REQUIRED');
  assert.match(post.json().error.message, /请先进入具体租户再操作/);

  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/model-targets/${T.a.targetId}`,
    headers: all(),
    payload: { name: `${P}不该被改名` },
  });
  assert.equal(patch.statusCode, 409, patch.body);
  assert.equal(patch.json().error.code, 'TENANT_REQUIRED');

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/model-targets/${T.a.targetId}`,
    headers: all(),
  });
  assert.equal(del.statusCode, 409, del.body);
  assert.equal(del.json().error.code, 'TENANT_REQUIRED');

  const row = await prisma.modelTarget.findUniqueOrThrow({ where: { id: T.a.targetId } });
  assert.equal(row.name, `${P}对象a`, '被拒的写操作不能改动数据');
});

test('全局视角白名单：平台级接口（租户管理）仍可写', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: all(),
    payload: {
      name: `${P}白名单租户`,
      admin: { username: `${P.toLowerCase()}c-admin`, password: PW },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const list = await app.inject({ url: '/api/tenants', headers: all() });
  assert.equal(list.statusCode, 200, list.body);
  assert.ok(items<{ name: string }>(list.json()).some((t) => t.name === `${P}白名单租户`));
});

test('进入具体租户后可正常写，且数据落在目标租户', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: h(adminJwt, T.a.id),
    payload: targetPayload(`${P}代管创建`),
  });
  assert.equal(res.statusCode, 201, res.body);
  const row = await prisma.modelTarget.findUniqueOrThrow({ where: { id: res.json().id } });
  assert.equal(row.tenantId, T.a.id);
});

test('租户管理返回风险数/高危数（有效风险口径，误报与空等级不计）', async () => {
  const res = await app.inject({ url: '/api/tenants', headers: all() });
  assert.equal(res.statusCode, 200, res.body);
  const rows = items<{ id: string; riskCount: number; highRiskCount: number }>(res.json());
  const a = rows.find((t) => t.id === T.a.id);
  const b = rows.find((t) => t.id === T.b.id);
  assert.ok(a && b);
  assert.equal(a!.riskCount, 3);
  assert.equal(a!.highRiskCount, 2);
  assert.equal(b!.riskCount, 1);
  assert.equal(b!.highRiskCount, 0);
});

test('态势概览在全局视角是全体租户合计，不是单租户口径', async () => {
  const targetCount = async (tenant?: string) => {
    const r = await app.inject({
      url: '/api/dashboard/overview?period=all',
      headers: h(adminJwt, tenant),
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().counts.modelTargetCount as number;
  };
  const allCount = await targetCount('all');
  const aCount = await targetCount(T.a.id);
  const bCount = await targetCount(T.b.id);
  assert.ok(allCount >= 3, '全局视角至少含本次创建的三个评估对象');
  assert.ok(allCount > aCount, '全局视角应比甲租户多');
  assert.ok(allCount > bCount, '全局视角应比乙租户多');
});

test('单租户回归：租户管理员视角与租户管理权限不受影响', async () => {
  const res = await app.inject({ url: '/api/model-targets?pageSize=100', headers: h(T.a.jwt) });
  assert.equal(res.statusCode, 200, res.body);
  const rows = items<{ id: string }>(res.json());
  assert.ok(rows.some((r) => r.id === T.a.targetId));
  assert.ok(!rows.some((r) => r.id === T.b.targetId));
  assert.ok(!rows.some((r) => r.id === platformTargetId));
  assert.equal((await app.inject({ url: '/api/tenants', headers: h(T.a.jwt) })).statusCode, 403);
});

test('全局视角风险问题按租户拆分，不同租户的同类风险不合并；单租户视角分组不变', async () => {
  const url = '/api/wrong-answers/groups?status=全部&pageSize=100';
  type G = { id: string; tenantId: string | null; sampleCount: number };
  const gs = await app.inject({ url, headers: all() });
  assert.equal(gs.statusCode, 200, gs.body);
  const mine = items<G>(gs.json()).filter((g) => g.tenantId === T.a.id || g.tenantId === T.b.id);
  const sum = (id: string, rows: G[]) => rows.filter((g) => g.tenantId === id).reduce((n, g) => n + g.sampleCount, 0);
  // 甲有 4 条、乙有 2 条发现，风险身份相同；全局视角下按租户各自成组，样本数不串
  assert.equal(sum(T.a.id, mine), 4);
  assert.equal(sum(T.b.id, mine), 2);
  assert.equal(new Set(mine.map((g) => g.id)).size, mine.length);
  for (const g of mine) {
    const d = await app.inject({ url: `/api/wrong-answers/groups/${g.id}`, headers: all() });
    assert.equal(d.statusCode, 200, d.body);
    assert.equal(d.json().tenantId, g.tenantId);
    assert.equal(d.json().members.total, g.sampleCount);
  }
  // 租户管理员：只看到自己租户，分组沿用不带租户前缀的旧 id
  const own = await app.inject({ url, headers: h(T.a.jwt) });
  assert.equal(own.statusCode, 200, own.body);
  const ownRows = items<G>(own.json());
  assert.ok(ownRows.every((g) => g.tenantId === T.a.id));
  assert.equal(sum(T.a.id, ownRows), 4);
  assert.ok(!ownRows.some((g) => mine.some((m) => m.id === g.id)));
  // 平台管理员不带 all 头：平台租户视角，看不到甲乙租户的问题
  const plat = await app.inject({ url, headers: h(adminJwt) });
  assert.equal(plat.statusCode, 200, plat.body);
  assert.ok(!items<G>(plat.json()).some((g) => g.tenantId === T.a.id || g.tenantId === T.b.id));
});
