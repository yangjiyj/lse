import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { sampleReport } from './fleet-admin-fixtures.js';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';

// 终端资产台账：终端责任人、按终端分组的智能体清单（资产与风险汇总、按终端分页、按责任人搜索）、租户隔离。

const P = 'own26-';
const PW = 'Owner@12345'; // pragma: allowlist secret
let app!: FastifyInstance;
let adminJwt = '';
let otherJwt = '';
let otherTenantId = '';
const eps: string[] = [];
const previousFlag = process.env.FLEET_AGENT_ENABLED;

const h = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token;
}

async function endpointWithReport(hostname: string, report = sampleReport({ bypass: true })) {
  const endpoint = await prisma.fleetEndpoint.create({
    data: {
      publicId: `ep_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      installationId: randomUUID(),
      machineId: 'm'.repeat(32),
      hostname,
      os: 'linux',
      osUser: 'root',
      tokenHash: randomUUID(),
      lastSeenAt: new Date(),
    },
  });
  await prisma.fleetProbeReport.create({
    data: {
      endpointId: endpoint.id,
      reportId: `pr_${randomUUID()}`,
      scannedAt: new Date(),
      status: 'complete',
      assetCount: 1,
      bodyHash: 'x',
      body: report,
    },
  });
  eps.push(endpoint.id);
  return endpoint;
}

async function cleanup() {
  await prisma.fleetEndpoint.deleteMany({ where: { hostname: { startsWith: P } } });
  const tenants = await prisma.tenant.findMany({ where: { name: { startsWith: P } }, select: { id: true } });
  const ids = tenants.map((t) => t.id);
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.user.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  }
}

before(async () => {
  process.env.FLEET_AGENT_ENABLED = 'true';
  app = await buildApp();
  await app.ready();
  await cleanup();
  adminJwt = await login('admin', 'Admin@12345'); // pragma: allowlist secret
  const tenant = await app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: h(adminJwt),
    payload: { name: `${P}乙单位`, admin: { username: `${P}b-admin`, password: PW } },
  });
  assert.equal(tenant.statusCode, 201, tenant.body);
  otherTenantId = tenant.json().id;
  await skipFirstPasswordChange(`${P}b-admin`);
  otherJwt = await login(`${P}b-admin`, PW);
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
  if (previousFlag === undefined) delete process.env.FLEET_AGENT_ENABLED;
  else process.env.FLEET_AGENT_ENABLED = previousFlag;
});

test('按终端分组：分组头带资产与风险汇总，智能体行带自己的资产数', async () => {
  const ep = await endpointWithReport(`${P}host-a`);
  const res = await app.inject({ url: `/api/fleet/agents?groupBy=endpoint&q=${P}host-a`, headers: h(adminJwt) });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.total, 1);
  const group = body.groups.find((g: { endpointId: string }) => g.endpointId === ep.id);
  assert.ok(group, res.body);
  assert.equal(group.source, 'jiandun');
  assert.equal(group.owner, null);
  assert.deepEqual(group.assets, { agents: 1, skills: 0, mcp: 1, platforms: 0 });
  assert.ok(group.risks.open >= 1, '越权模式的配置风险计入');
  const row = body.items.find((r: { endpointId: string; agentKey: string }) => r.endpointId === ep.id && r.agentKey === 'claude-code');
  assert.deepEqual(row.assets, { skills: 0, mcp: 1 });
  assert.equal(row.ownerText, undefined, '内部搜索字段不外露');
});

test('设置、修改、清除责任人；能按责任人和部门搜索；写操作日志', async () => {
  const ep = await endpointWithReport(`${P}host-b`);
  const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
  const set = await app.inject({
    method: 'PATCH',
    url: `/api/fleet/endpoints/${ep.id}/owner`,
    headers: h(adminJwt),
    payload: { name: '张三', department: '研发部', userId: admin.id },
  });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(set.json().owner.name, '张三');
  assert.equal(set.json().owner.userId, admin.id);

  const byDept = await app.inject({ url: '/api/fleet/agents?groupBy=endpoint&q=研发部', headers: h(adminJwt) });
  const group = byDept.json().groups.find((g: { endpointId: string }) => g.endpointId === ep.id);
  assert.equal(group.owner.name, '张三');
  assert.equal(group.owner.department, '研发部');
  assert.equal(group.ownerSource, 'manual');

  const list = await app.inject({ url: `/api/fleet/endpoints?q=${P}host-b`, headers: h(adminJwt) });
  assert.equal(list.json().items[0].owner.name, '张三', '终端列表也带责任人');

  const clear = await app.inject({
    method: 'PATCH',
    url: `/api/fleet/endpoints/${ep.id}/owner`,
    headers: h(adminJwt),
    payload: { name: '' },
  });
  assert.equal(clear.statusCode, 200);
  assert.equal(clear.json().owner, null);
  const row = await prisma.fleetEndpoint.findUniqueOrThrow({ where: { id: ep.id } });
  assert.equal(row.ownerName, null);
  assert.equal(row.ownerDepartment, null);
  assert.equal(await prisma.auditLog.count({ where: { action: 'fleet.endpoint.owner', targetId: ep.id } }), 2);

  const badUser = await app.inject({
    method: 'PATCH',
    url: `/api/fleet/endpoints/${ep.id}/owner`,
    headers: h(adminJwt),
    payload: { name: '李四', userId: randomUUID() },
  });
  assert.equal(badUser.statusCode, 400);
});

test('按终端分页：一台终端的智能体不拆页', async () => {
  const report = sampleReport();
  report.assets.push({ ...report.assets[0]!, name: 'codex', display_name: 'Codex' });
  await endpointWithReport(`${P}page-1`, report);
  await endpointWithReport(`${P}page-2`, report);
  const first = await app.inject({ url: `/api/fleet/agents?groupBy=endpoint&pageSize=1&q=${P}page-`, headers: h(adminJwt) });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().total, 2, '按终端计数');
  assert.equal(first.json().groups.length, 1);
  const ids = new Set(first.json().items.map((r: { endpointId: string }) => r.endpointId));
  assert.equal(ids.size, 1, '这一页只有一台终端');
  assert.equal(first.json().items.length, 2, '这台终端的两个智能体都在这一页');
});

test('别的租户看不到、也设不了这台终端的责任人', async () => {
  const ep = await endpointWithReport(`${P}host-c`);
  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/fleet/endpoints/${ep.id}/owner`,
    headers: h(otherJwt),
    payload: { name: '越权' },
  });
  assert.equal(patch.statusCode, 404, patch.body);
  const list = await app.inject({ url: `/api/fleet/agents?groupBy=endpoint&q=${P}host-c`, headers: h(otherJwt) });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().total, 0);
  // 关联用户只能选本租户的人
  const otherAdmin = await prisma.user.findFirstOrThrow({ where: { tenantId: otherTenantId } });
  const foreignUser = await app.inject({
    method: 'PATCH',
    url: `/api/fleet/endpoints/${ep.id}/owner`,
    headers: h(adminJwt),
    payload: { name: '乙方的人', userId: otherAdmin.id },
  });
  assert.equal(foreignUser.statusCode, 400);
});
