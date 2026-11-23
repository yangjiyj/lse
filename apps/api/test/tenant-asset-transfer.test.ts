import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';

// 资产租户归属转移：预检、依赖级联、冲突阻塞、责任人处理、审计留痕。

const P = 'TX26-';
const PW = 'Tenant@12345'; // pragma: allowlist secret
const noopLimiter = { take: () => true };

let app!: FastifyInstance;
let adminJwt = '';
const T = {
  a: { id: '', jwt: '', adminJwt: '', username: `${P.toLowerCase()}a-admin` },
  b: { id: '', jwt: '', adminJwt: '', username: `${P.toLowerCase()}b-admin` },
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

async function createTarget(jwt: string, name: string, tenant?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: h(jwt, tenant),
    payload: {
      name,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-transfer-test-1234567890',
      model: 'fake-model',
    },
  });
}

async function cleanup(): Promise<void> {
  const tenants = await prisma.tenant.findMany({ where: { name: { startsWith: P } }, select: { id: true } });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const scope = { tenantId: { in: ids } };
  await prisma.fleetProbeReport.deleteMany({ where: scope });
  await prisma.fleetEvalJob.deleteMany({ where: scope });
  await prisma.fleetEndpoint.deleteMany({ where: scope });
  await prisma.vulnerabilityAssessment.deleteMany({ where: scope });
  await prisma.serviceAssuranceRun.deleteMany({ where: scope });
  await prisma.standardRun.deleteMany({ where: scope });
  await prisma.standardBankRelease.deleteMany({ where: scope });
  await prisma.wrongAnswer.deleteMany({ where: scope });
  await prisma.finding.deleteMany({ where: scope });
  await prisma.report.deleteMany({ where: scope });
  await prisma.policySuggestion.deleteMany({ where: scope });
  await prisma.ragEvalRun.deleteMany({ where: scope });
  await prisma.aiComponentFinding.deleteMany({ where: scope });
  await prisma.aiComponentScan.deleteMany({ where: scope });
  await prisma.evalResult.deleteMany({ where: scope });
  await prisma.gateRule.deleteMany({ where: scope });
  await prisma.evalTask.deleteMany({ where: scope });
  await prisma.evalPlan.deleteMany({ where: scope });
  await prisma.modelFileFinding.deleteMany({ where: scope });
  await prisma.modelFileScan.deleteMany({ where: scope });
  await prisma.modelFileUpload.deleteMany({ where: scope });
  await prisma.modelFingerprint.deleteMany({ where: scope });
  await prisma.question.deleteMany({ where: scope });
  await prisma.questionSet.deleteMany({ where: scope });
  await prisma.agentSampleTrial.deleteMany({ where: scope });
  await prisma.agentSample.deleteMany({ where: scope });
  await prisma.auditLog.deleteMany({ where: scope });
  await prisma.user.deleteMany({ where: scope });
  await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  app = await buildApp({ cancelEvalTask: async () => undefined, fleetAgent: { rateLimiters: { ip: noopLimiter, register: noopLimiter, endpoint: noopLimiter } } });
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
    const loginRes = await login(T[key].username, PW);
    assert.equal(loginRes.statusCode, 200, loginRes.body);
    T[key].jwt = loginRes.json().token;
  }
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('评估对象连同评估任务整体转移，原租户看不到、新租户能看到', async () => {
  const target = await createTarget(T.a.jwt, `${P}转移对象一`);
  assert.equal(target.statusCode, 201, target.body);
  const targetId = target.json().id as string;

  const builtin = await prisma.questionSet.findFirstOrThrow({ where: { isBuiltin: true, tenantId: null } });
  const task = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: h(T.a.jwt),
    payload: { name: `${P}转移任务一`, modelTargetId: targetId, questionSetIds: [builtin.id] },
  });
  assert.equal(task.statusCode, 201, task.body);
  const taskId = task.json().id as string;

  const preflight = await app.inject({
    method: 'POST',
    url: '/api/tenants/transfer/preflight',
    headers: h(adminJwt),
    payload: { kind: 'model-target', ids: [targetId], targetTenantId: T.b.id },
  });
  assert.equal(preflight.statusCode, 200, preflight.body);
  const plan = preflight.json();
  assert.equal(plan.canTransfer, true, JSON.stringify(plan.blockers));
  assert.equal(plan.counts.modelTarget.count, 1);
  assert.equal(plan.counts.evalTask.count, 1);
  assert.equal(plan.sourceTenant.id, T.a.id);
  assert.equal(plan.targetTenant.id, T.b.id);

  const applied = await app.inject({
    method: 'POST',
    url: '/api/tenants/transfer',
    headers: h(adminJwt),
    payload: { kind: 'model-target', ids: [targetId], targetTenantId: T.b.id },
  });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.ok(applied.json().totalRows >= 2);

  const row = await prisma.modelTarget.findUniqueOrThrow({ where: { id: targetId } });
  assert.equal(row.tenantId, T.b.id);
  const taskRow = await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } });
  assert.equal(taskRow.tenantId, T.b.id);

  const listA = items<{ id: string }>((await app.inject({ url: '/api/model-targets?pageSize=200', headers: h(T.a.jwt) })).json());
  assert.ok(!listA.some((t) => t.id === targetId), '原租户不应再看到');
  assert.equal((await app.inject({ url: `/api/model-targets/${targetId}`, headers: h(T.a.jwt) })).statusCode, 404);

  const listB = items<{ id: string }>((await app.inject({ url: '/api/model-targets?pageSize=200', headers: h(T.b.jwt) })).json());
  assert.ok(listB.some((t) => t.id === targetId), '目标租户应能看到');
  assert.equal((await app.inject({ url: `/api/model-targets/${targetId}`, headers: h(T.b.jwt) })).statusCode, 200);

  const tasksB = items<{ id: string }>((await app.inject({ url: '/api/eval-tasks?pageSize=200', headers: h(T.b.jwt) })).json());
  assert.ok(tasksB.some((t) => t.id === taskId), '任务跟着对象一起过去');
});

test('任务引用了原租户自建题集时阻塞，且一条数据都不动', async () => {
  const target = await createTarget(T.a.jwt, `${P}阻塞对象`);
  assert.equal(target.statusCode, 201, target.body);
  const targetId = target.json().id as string;

  const set = await prisma.questionSet.create({
    data: {
      tenantId: T.a.id,
      name: `${P}自建题集`,
      type: 'GENERAL',
      source: 'test',
      questions: { create: [{ content: `${P}问题`, type: 'GENERAL' }] },
    },
  });
  const task = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: h(T.a.jwt),
    payload: { name: `${P}阻塞任务`, modelTargetId: targetId, questionSetIds: [set.id] },
  });
  assert.equal(task.statusCode, 201, task.body);

  const preflight = await app.inject({
    method: 'POST',
    url: '/api/tenants/transfer/preflight',
    headers: h(adminJwt),
    payload: { kind: 'model-target', ids: [targetId], targetTenantId: T.b.id },
  });
  assert.equal(preflight.statusCode, 200, preflight.body);
  const plan = preflight.json();
  assert.equal(plan.canTransfer, false);
  assert.ok(
    plan.blockers.some((b: { code: string }) => b.code === 'FOREIGN_QUESTION_SET'),
    JSON.stringify(plan.blockers),
  );

  const applied = await app.inject({
    method: 'POST',
    url: '/api/tenants/transfer',
    headers: h(adminJwt),
    payload: { kind: 'model-target', ids: [targetId], targetTenantId: T.b.id },
  });
  assert.equal(applied.statusCode, 409, applied.body);
  assert.equal((await prisma.modelTarget.findUniqueOrThrow({ where: { id: targetId } })).tenantId, T.a.id);
  assert.equal((await prisma.questionSet.findUniqueOrThrow({ where: { id: set.id } })).tenantId, T.a.id);
});

test('目标租户有同名对象时阻塞', async () => {
  const name = `${P}同名冲突`;
  const a = await createTarget(T.a.jwt, name);
  const b = await createTarget(T.b.jwt, name);
  assert.equal(a.statusCode, 201, a.body);
  assert.equal(b.statusCode, 201, b.body);

  const preflight = await app.inject({
    method: 'POST',
    url: '/api/tenants/transfer/preflight',
    headers: h(adminJwt),
    payload: { kind: 'model-target', ids: [a.json().id], targetTenantId: T.b.id },
  });
  assert.equal(preflight.statusCode, 200, preflight.body);
  const plan = preflight.json();
  assert.equal(plan.canTransfer, false);
  assert.ok(plan.blockers.some((x: { code: string }) => x.code === 'NAME_CONFLICT'));
});

test('平台共享的对象不允许转移', async () => {
  const builtin = await prisma.questionSet.findFirstOrThrow({ where: { isBuiltin: true, tenantId: null } });
  const preflight = await app.inject({
    method: 'POST',
    url: '/api/tenants/transfer/preflight',
    headers: h(adminJwt),
    payload: { kind: 'question-set', ids: [builtin.id], targetTenantId: T.b.id },
  });
  assert.equal(preflight.statusCode, 200, preflight.body);
  const plan = preflight.json();
  assert.equal(plan.canTransfer, false);
  assert.ok(plan.blockers.some((x: { code: string }) => x.code === 'SHARED_OBJECT'));
});

test('终端转移：探针报告与作业跟走，跨租户责任人被清空', async () => {
  const owner = await prisma.user.findFirstOrThrow({ where: { tenantId: T.a.id } });
  const endpoint = await prisma.fleetEndpoint.create({
    data: {
      tenantId: T.a.id,
      publicId: `ep_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      installationId: randomUUID(),
      machineId: randomUUID(),
      hostname: `${P}tx-host`,
      os: 'linux',
      tokenHash: randomUUID(),
      ownerName: `${P}责任人`,
      ownerDepartment: `${P}研发部`,
      ownerUserId: owner.id,
      ownerUpdatedAt: new Date(),
    },
  });
  const report = await prisma.fleetProbeReport.create({
    data: {
      tenantId: T.a.id,
      endpointId: endpoint.id,
      reportId: `rep_${randomUUID()}`,
      scannedAt: new Date(),
      status: 'OK',
      bodyHash: 'hash',
      body: { assets: [] },
    },
  });

  const preflight = await app.inject({
    method: 'POST',
    url: '/api/tenants/transfer/preflight',
    headers: h(adminJwt),
    payload: { kind: 'fleet-endpoint', ids: [endpoint.id], targetTenantId: T.b.id },
  });
  assert.equal(preflight.statusCode, 200, preflight.body);
  const plan = preflight.json();
  assert.equal(plan.canTransfer, true, JSON.stringify(plan.blockers));
  assert.equal(plan.counts.fleetProbeReport.count, 1);
  assert.ok(plan.warnings.some((w: { code: string }) => w.code === 'OWNER_CLEARED'));

  const applied = await app.inject({
    method: 'POST',
    url: '/api/tenants/transfer',
    headers: h(adminJwt),
    payload: { kind: 'fleet-endpoint', ids: [endpoint.id], targetTenantId: T.b.id },
  });
  assert.equal(applied.statusCode, 200, applied.body);

  const movedEndpoint = await prisma.fleetEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
  assert.equal(movedEndpoint.tenantId, T.b.id);
  assert.equal(movedEndpoint.ownerUserId, null);
  assert.equal(movedEndpoint.ownerName, null);
  assert.equal((await prisma.fleetProbeReport.findUniqueOrThrow({ where: { id: report.id } })).tenantId, T.b.id);
});

test('转移在源租户与目标租户各留一条审计', async () => {
  const target = await createTarget(T.a.jwt, `${P}审计对象`);
  assert.equal(target.statusCode, 201, target.body);
  const targetId = target.json().id as string;

  const applied = await app.inject({
    method: 'POST',
    url: '/api/tenants/transfer',
    headers: h(adminJwt),
    payload: { kind: 'model-target', ids: [targetId], targetTenantId: T.b.id },
  });
  assert.equal(applied.statusCode, 200, applied.body);

  const inbound = await prisma.auditLog.findFirst({
    where: { action: 'tenant.asset.transfer-in', tenantId: T.b.id, targetId: T.b.id },
    orderBy: { createdAt: 'desc' },
  });
  const outbound = await prisma.auditLog.findFirst({
    where: { action: 'tenant.asset.transfer-out', tenantId: T.a.id, targetId: T.a.id },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(inbound, '目标租户有一条转入记录');
  assert.ok(outbound, '源租户有一条转出记录');
});

test('租户管理员不能调用转移接口', async () => {
  const target = await createTarget(T.a.jwt, `${P}越权对象`);
  assert.equal(target.statusCode, 201, target.body);
  const res = await app.inject({
    method: 'POST',
    url: '/api/tenants/transfer/preflight',
    headers: h(T.a.jwt),
    payload: { kind: 'model-target', ids: [target.json().id], targetTenantId: T.b.id },
  });
  assert.equal(res.statusCode, 403, res.body);
});

test('平台管理员在「全部租户」视角下也能执行转移', async () => {
  const target = await createTarget(T.a.jwt, `${P}全局视角对象`);
  assert.equal(target.statusCode, 201, target.body);
  const res = await app.inject({
    method: 'POST',
    url: '/api/tenants/transfer',
    headers: h(adminJwt, 'all'),
    payload: { kind: 'model-target', ids: [target.json().id], targetTenantId: T.b.id },
  });
  assert.equal(res.statusCode, 200, res.body);
});

test('数据库层：把子对象的归属先改掉会被触发器拒绝（这就是必须父先子后的原因）', async () => {
  const target = await createTarget(T.a.jwt, `${P}顺序对象`);
  assert.equal(target.statusCode, 201, target.body);
  const targetId = target.json().id as string;
  const builtin = await prisma.questionSet.findFirstOrThrow({ where: { isBuiltin: true, tenantId: null } });
  const task = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: h(T.a.jwt),
    payload: { name: `${P}顺序任务`, modelTargetId: targetId, questionSetIds: [builtin.id] },
  });
  assert.equal(task.statusCode, 201, task.body);

  await assert.rejects(
    () =>
      prismaUnscoped.$executeRawUnsafe(
        'UPDATE "eval_tasks" SET "tenantId" = $1 WHERE "id" = $2',
        T.b.id,
        task.json().id,
      ),
    (err: Error) => /CROSS_TENANT|42501|foreign key|约束/i.test(err.message),
  );
  assert.equal((await prisma.evalTask.findUniqueOrThrow({ where: { id: task.json().id } })).tenantId, T.a.id);
});
