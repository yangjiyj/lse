import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { LEDGER_ASSET_TYPES, LEDGER_ATTR_FIELDS } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prismaUnscoped as db } from '../src/db.js';
import { LEDGER_ATTR_SCHEMAS } from '../src/modules/ledger/attrs.js';

// 2.8.1 应用台账接口：六类资产的维护、专有字段校验、关联规则、筛选、导入终端和评估对象、关系、
// 详情（关系与硬件）、权限、租户隔离与审计。

const TENANT_PREFIX = 'C2台账接口测试';
const USER_PREFIX = '__c2_ledger_';
const HOST_PREFIX = 'c2-ledger-';
const PASSWORD = ['Ledger', 'Test', '12345'].join('@');

let app: Awaited<ReturnType<typeof buildApp>>;
let tenantA = '';
let tenantB = '';
let adminA = '';
let adminB = '';
let operatorA = '';
let auditorA = '';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function cleanup(): Promise<void> {
  const tenants = await db.tenant.findMany({
    where: { name: { startsWith: TENANT_PREFIX } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  await db.ledgerAsset.deleteMany({ where: { tenantId: { in: ids } } });
  await db.fleetEndpoint.deleteMany({ where: { tenantId: { in: ids } } });
  await db.modelTarget.deleteMany({ where: { tenantId: { in: ids } } });
  await db.user.updateMany({ where: { tenantId: { in: ids } }, data: { organizationId: null } });
  for (let i = 0; i < 5; i += 1) {
    await db.organization.deleteMany({ where: { tenantId: { in: ids }, children: { none: {} } } });
  }
  await db.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
  await db.user.deleteMany({ where: { username: { startsWith: USER_PREFIX } } });
  await db.tenant.deleteMany({ where: { id: { in: ids } } });
}

async function login(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

async function createUser(tenantId: string, name: string, roleName: string): Promise<void> {
  const role = await db.role.findUniqueOrThrow({ where: { name: roleName } });
  await db.user.create({
    data: {
      tenantId,
      username: `${USER_PREFIX}${name}`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: name,
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
}

async function endpoint(tenantId: string, hostname: string, host?: Record<string, unknown>) {
  const ep = await db.fleetEndpoint.create({
    data: {
      tenantId,
      publicId: `ep_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      installationId: randomUUID(),
      machineId: 'm'.repeat(32),
      hostname: `${HOST_PREFIX}${hostname}`,
      os: 'linux',
      tokenHash: randomUUID(),
      lastSeenAt: new Date(),
    },
  });
  if (host) {
    await db.fleetProbeReport.create({
      data: {
        endpointId: ep.id,
        reportId: `pr_${randomUUID()}`,
        scannedAt: new Date(),
        status: 'complete',
        assetCount: 0,
        bodyHash: 'h',
        body: { host },
      },
    });
  }
  return ep;
}

async function target(tenantId: string, name: string, targetType: string) {
  return db.modelTarget.create({
    data: {
      tenantId,
      name,
      provider: 'openai-compatible',
      targetType: targetType as never,
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'x',
      model: `${name}-model`,
    },
  });
}

function post(token: string, url: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: `/api/ledger${url}`,
    headers: bearer(token),
    payload: payload as object,
  });
}
function get(token: string, url: string) {
  return app.inject({ method: 'GET', url: `/api/ledger${url}`, headers: bearer(token) });
}

async function mustCreate(token: string, payload: Record<string, unknown>) {
  const res = await post(token, '/assets', payload);
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  tenantA = (await db.tenant.create({ data: { name: `${TENANT_PREFIX}A`, code: 'c2-ledger-a' } }))
    .id;
  tenantB = (await db.tenant.create({ data: { name: `${TENANT_PREFIX}B`, code: 'c2-ledger-b' } }))
    .id;
  await createUser(tenantA, 'admin_a', 'tenant_admin');
  await createUser(tenantB, 'admin_b', 'tenant_admin');
  await createUser(tenantA, 'operator_a', 'operator');
  await createUser(tenantA, 'auditor_a', 'auditor');
  adminA = await login(`${USER_PREFIX}admin_a`);
  adminB = await login(`${USER_PREFIX}admin_b`);
  operatorA = await login(`${USER_PREFIX}operator_a`);
  auditorA = await login(`${USER_PREFIX}auditor_a`);
});

after(async () => {
  await cleanup();
  await app.close();
});

test('attrs.ts 各类型的键集合、下拉选项与 LEDGER_ATTR_FIELDS 一致', () => {
  for (const type of LEDGER_ASSET_TYPES) {
    const schema = LEDGER_ATTR_SCHEMAS[type];
    assert.deepEqual(
      Object.keys(schema.shape).sort(),
      LEDGER_ATTR_FIELDS[type].map((f) => f.key).sort(),
      type,
    );
    for (const field of LEDGER_ATTR_FIELDS[type]) {
      if (field.input !== 'select') continue;
      const inner = (schema.shape as Record<string, { unwrap(): { options: string[] } }>)[
        field.key
      ]!.unwrap();
      assert.deepEqual(
        inner.options,
        field.options!.map((o) => o.value),
        `${type}.${field.key}`,
      );
    }
  }
});

test('每类建一条；IP、地址格式不对或有未知键时 400；写审计', async () => {
  const payloads: Record<string, Record<string, unknown>> = {
    platform: {
      url: 'https://app.example.com/chat',
      deploymentMode: 'third_party_api',
      environment: 'prod',
    },
    server: { ip: '10.0.0.8', os: 'Ubuntu 22.04', memoryGB: 256, purpose: 'inference' },
    endpoint: { ip: 'pc-01.corp.local', user: '张三' },
    software: { vendor: 'Oracle', version: '19c', category: 'database' },
    model: { modelName: 'qwen2.5-72b', modality: 'text', modelPath: '/data/models/qwen' },
    component: { componentType: 'vector_db', version: '2.4', endpointUrl: 'http://10.0.0.9:19530' },
  };
  for (const type of LEDGER_ASSET_TYPES) {
    const created = await mustCreate(adminA, {
      type,
      name: `六类-${type}`,
      attrs: { ...payloads[type], ...(type === 'server' ? { gpu: '' } : {}) },
      tags: ['核心', '核心'],
    });
    assert.equal(created.type, type);
    assert.deepEqual(created.attrs, payloads[type], `${type} 的 attrs 原样保存，空值不入库`);
    assert.deepEqual(created.tags, ['核心']);
    const audit = await db.auditLog.findFirst({
      where: { action: 'ledger.asset_create', targetId: created.id },
    });
    assert.ok(audit, `${type} 缺审计`);
    assert.equal(audit.tenantId, tenantA);
  }

  const badIp = await post(adminA, '/assets', {
    type: 'server',
    name: '坏 IP',
    attrs: { ip: '1.2.3' },
  });
  assert.equal(badIp.statusCode, 400, badIp.body);
  const badUrl = await post(adminA, '/assets', {
    type: 'platform',
    name: '坏地址',
    attrs: { url: 'javascript:1' },
  });
  assert.equal(badUrl.statusCode, 400, badUrl.body);
  const unknown = await post(adminA, '/assets', {
    type: 'software',
    name: '未知键',
    attrs: { vendor: 'x', ip: '10.0.0.1' },
  });
  assert.equal(unknown.statusCode, 400, unknown.body);
  const badSelect = await post(adminA, '/assets', {
    type: 'server',
    name: '坏用途',
    attrs: { purpose: 'mining' },
  });
  assert.equal(badSelect.statusCode, 400, badSelect.body);

  const dup = await post(adminA, '/assets', { type: 'server', name: '六类-server' });
  assert.equal(dup.statusCode, 409, dup.body);
  assert.equal(dup.json().error.code, 'LEDGER_NAME_TAKEN');
});

test('关联规则：AI 模型关联智能体类评估对象、关联别的租户的终端、软件关联终端都 400', async () => {
  const agent = await target(tenantA, 'C2智能体', 'AGENT');
  const model = await target(tenantA, 'C2模型', 'MODEL');
  const wrong = await post(adminA, '/assets', {
    type: 'model',
    name: '错关联模型',
    modelTargetId: agent.id,
  });
  assert.equal(wrong.statusCode, 400, wrong.body);
  assert.equal(wrong.json().error.code, 'LEDGER_LINK_INVALID');
  const right = await mustCreate(adminA, {
    type: 'model',
    name: '模型别名',
    modelTargetId: model.id,
  });
  // 显示名一律用资产名称；关联的评估对象名单独给
  assert.equal(right.displayName, '模型别名');
  assert.equal(right.name, '模型别名');
  assert.equal(right.target.name, 'C2模型');
  assert.equal(right.target.targetType, 'MODEL');
  const platform = await mustCreate(adminA, {
    type: 'platform',
    name: '智能体平台',
    modelTargetId: agent.id,
  });
  assert.equal(platform.target.id, agent.id);
  const serverWithTarget = await post(adminA, '/assets', {
    type: 'server',
    name: '服务器关联评估对象',
    modelTargetId: model.id,
  });
  assert.equal(serverWithTarget.json().error.code, 'LEDGER_LINK_INVALID');

  const epB = await endpoint(tenantB, 'b-host');
  const cross = await post(adminA, '/assets', {
    type: 'endpoint',
    name: '跨租户终端',
    fleetEndpointId: epB.id,
  });
  assert.equal(cross.statusCode, 400, cross.body);
  assert.equal(cross.json().error.code, 'LEDGER_LINK_INVALID');
  const epA = await endpoint(tenantA, 'sw-host');
  const sw = await post(adminA, '/assets', {
    type: 'software',
    name: '软件关联终端',
    fleetEndpointId: epA.id,
  });
  assert.equal(sw.json().error.code, 'LEDGER_LINK_INVALID');
  await db.fleetEndpoint.update({ where: { id: epA.id }, data: { removedAt: new Date() } });
  const removed = await post(adminA, '/assets', {
    type: 'server',
    name: '已移除终端',
    fleetEndpointId: epA.id,
  });
  assert.equal(removed.json().error.code, 'LEDGER_LINK_INVALID');

  // 改：评估对象换成别的模型、换成智能体类 400
  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/ledger/assets/${right.id}`,
    headers: bearer(adminA),
    payload: { modelTargetId: agent.id },
  });
  assert.equal(patched.statusCode, 400, patched.body);
});

test('列表按类型、关键字（名称、编号、IP）、组织（含下级）筛选；关联终端的行显示主机名', async () => {
  const root = await db.organization.create({ data: { tenantId: tenantA, name: 'C2总部' } });
  const child = await db.organization.create({
    data: { tenantId: tenantA, parentId: root.id, name: 'C2研发' },
  });
  const ep = await endpoint(tenantA, 'list-host');
  const s1 = await mustCreate(adminA, {
    type: 'server',
    name: '筛选服务器',
    code: 'SRV-筛选-01',
    attrs: { ip: '172.16.9.31' },
    organizationId: child.id,
    fleetEndpointId: ep.id,
  });
  const e1 = await mustCreate(adminA, {
    type: 'endpoint',
    name: '筛选终端别名',
    fleetEndpointId: (await endpoint(tenantA, 'list-pc')).id,
    organizationId: root.id,
  });

  const list = async (qs: string) => {
    const res = await get(operatorA, `/assets?pageSize=200&${qs}`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as {
      items: Array<Record<string, any>>;
      total: number;
      counts: Record<string, number>;
    };
  };
  const servers = await list('type=server');
  assert.ok(servers.items.every((i) => i.type === 'server'));
  assert.ok(servers.items.some((i) => i.id === s1.id));
  assert.ok(servers.counts.server >= 1 && servers.counts.endpoint >= 1, '计数按类型分组');

  assert.deepEqual(
    (await list('q=SRV-筛选')).items.map((i) => i.id),
    [s1.id],
  );
  assert.deepEqual(
    (await list('q=172.16.9')).items.map((i) => i.id),
    [s1.id],
  );
  assert.ok((await list('q=筛选服务')).items.some((i) => i.id === s1.id));

  const own = await list(`organizationId=${root.id}`);
  assert.deepEqual(
    own.items.map((i) => i.id),
    [e1.id],
  );
  const withChildren = await list(`organizationId=${root.id}&includeDescendants=true`);
  assert.deepEqual(withChildren.items.map((i) => i.id).sort(), [s1.id, e1.id].sort());
  assert.equal(withChildren.items.find((i) => i.id === s1.id)!.organizationPath, 'C2总部 / C2研发');

  const row = (await list('type=endpoint')).items.find((i) => i.id === e1.id)!;
  assert.equal(row.displayName, '筛选终端别名');
  assert.equal(row.name, '筛选终端别名');
  assert.equal(row.endpoint.hostname, `${HOST_PREFIX}list-pc`);
  assert.ok(row.endpoint.lastSeenAt);
  const srvRow = (await list('type=server')).items.find((i) => i.id === s1.id)!;
  assert.equal(srvRow.endpoint.hostname, `${HOST_PREFIX}list-host`);
});

test('导入终端执行两次第二次 created = 0，重名加序号；导入评估对象跳过裁判、网关日志、终端智能体类', async () => {
  const ep1 = await endpoint(tenantA, 'import-1');
  await endpoint(tenantA, 'import-2');
  const gone = await endpoint(tenantA, 'import-gone');
  await db.fleetEndpoint.update({ where: { id: gone.id }, data: { removedAt: new Date() } });
  await mustCreate(adminA, { type: 'endpoint', name: `${HOST_PREFIX}import-1` });

  const first = await post(operatorA, '/assets/import-endpoints', {});
  assert.equal(first.statusCode, 200, first.body);
  assert.ok(first.json().created >= 2, first.body);
  const imported = await db.ledgerAsset.findFirstOrThrow({ where: { fleetEndpointId: ep1.id } });
  assert.equal(imported.name, `${HOST_PREFIX}import-1 (2)`);
  assert.equal(imported.tenantId, tenantA);
  assert.equal(
    await db.ledgerAsset.count({ where: { fleetEndpointId: gone.id } }),
    0,
    '已移除的终端不导入',
  );
  const second = await post(operatorA, '/assets/import-endpoints', {});
  assert.equal(second.json().created, 0);
  assert.ok(second.json().skipped >= 2);
  // 只导入指定的；别的租户的终端 id 不会导入
  const epB = await endpoint(tenantB, 'import-b');
  const targeted = await post(operatorA, '/assets/import-endpoints', { endpointIds: [epB.id] });
  assert.deepEqual(targeted.json(), { created: 0, skipped: 1 });
  assert.equal(await db.ledgerAsset.count({ where: { fleetEndpointId: epB.id } }), 0);

  const m = await target(tenantA, 'C2导入模型', 'MODEL');
  const p = await target(tenantA, 'C2导入应用', 'PLATFORM_APP');
  const judge = await target(tenantA, 'C2导入裁判', 'JUDGE');
  const gw = await target(tenantA, 'C2导入网关', 'GATEWAY_LOG');
  const res = await post(adminA, '/assets/import-targets', {
    targetIds: [m.id, p.id, judge.id, gw.id],
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { created: 2, skipped: 2 });
  const rows = await db.ledgerAsset.findMany({
    where: { modelTargetId: { in: [m.id, p.id, judge.id, gw.id] } },
    orderBy: { type: 'asc' },
  });
  assert.deepEqual(
    rows.map((r) => [r.type, r.modelTargetId]),
    [
      ['model', m.id],
      ['platform', p.id],
    ],
  );
  assert.deepEqual(rows[0]!.attrs, { modelName: 'C2导入模型-model' });
  const again = await post(adminA, '/assets/import-targets', {});
  assert.equal(again.json().created, 0);

  const audits = await db.auditLog.findMany({
    where: {
      tenantId: tenantA,
      action: { in: ['ledger.import_endpoints', 'ledger.import_targets'] },
    },
  });
  assert.ok(audits.some((a) => a.action === 'ledger.import_endpoints'));
  assert.ok(audits.some((a) => a.action === 'ledger.import_targets'));
});

test('关系：允许的组合、不允许的 400、重复 409、自己指向自己 400；详情的 incoming、outgoing 与硬件', async () => {
  const ep = await endpoint(tenantA, 'gpu-host', {
    os: 'linux',
    cpu_model: 'Intel Xeon',
    accelerators: [
      { vendor: 'nvidia', model: 'NVIDIA A800', memory_mb: 81920, source: 'nvidia-smi' },
    ],
  });
  const platform = await mustCreate(adminA, { type: 'platform', name: '关系平台' });
  const model = await mustCreate(adminA, { type: 'model', name: '关系模型' });
  const server = await mustCreate(adminA, {
    type: 'server',
    name: '关系服务器',
    fleetEndpointId: ep.id,
  });
  const bare = await mustCreate(adminA, { type: 'server', name: '无终端服务器' });

  const rel = (payload: Record<string, unknown>, token = adminA) =>
    post(token, '/relations', payload);
  const uses = await rel({ fromId: platform.id, toId: model.id, kind: 'uses' });
  assert.equal(uses.statusCode, 201, uses.body);
  const deployed = await rel({ fromId: model.id, toId: server.id, kind: 'deployed_on' });
  assert.equal(deployed.statusCode, 201, deployed.body);

  const invalid = await rel({ fromId: server.id, toId: model.id, kind: 'uses' });
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.equal(invalid.json().error.code, 'LEDGER_RELATION_INVALID');
  const dup = await rel({ fromId: platform.id, toId: model.id, kind: 'uses' });
  assert.equal(dup.statusCode, 409, dup.body);
  const self = await rel({ fromId: platform.id, toId: platform.id, kind: 'contains' });
  assert.equal(self.statusCode, 400, self.body);

  const detail = (await get(auditorA, `/assets/${model.id}`)).json();
  assert.deepEqual(
    detail.incoming.map((r: any) => [r.kind, r.asset.id, r.asset.name, r.asset.type]),
    [['uses', platform.id, '关系平台', 'platform']],
  );
  assert.deepEqual(
    detail.outgoing.map((r: any) => [r.kind, r.asset.id, r.asset.type]),
    [['deployed_on', server.id, 'server']],
  );
  assert.equal(detail.relationCount, 2);
  assert.equal(detail.hardware, null, '没关联终端时没有硬件');

  const srv = (await get(auditorA, `/assets/${server.id}`)).json();
  assert.equal(srv.hardware.cpuModel, 'Intel Xeon');
  assert.equal(srv.hardware.accelerators[0].model, 'NVIDIA A800');
  assert.equal((await get(auditorA, `/assets/${bare.id}`)).json().hardware, null);

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/ledger/relations/${uses.json().id}`,
    headers: bearer(operatorA),
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal((await get(auditorA, `/assets/${model.id}`)).json().incoming.length, 0);

  // 删资产时关系一起删
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/ledger/assets/${server.id}`,
    headers: bearer(adminA),
  });
  assert.equal(del.statusCode, 200, del.body);
  assert.equal(await db.ledgerRelation.count({ where: { toId: server.id } }), 0);
});

test('auditor 写 403；另一个租户看不到、改不了；审计动作齐全', async () => {
  const mine = await mustCreate(operatorA, {
    type: 'software',
    name: '隔离软件',
    attrs: { vendor: 'A' },
  });
  const other = await mustCreate(adminA, { type: 'server', name: '隔离服务器' });

  for (const [url, payload] of [
    ['/assets', { type: 'software', name: '审计员建' }],
    ['/assets/import-endpoints', {}],
    ['/assets/import-targets', {}],
    ['/relations', { fromId: mine.id, toId: other.id, kind: 'deployed_on' }],
  ] as const) {
    const res = await post(auditorA, url, payload);
    assert.equal(res.statusCode, 403, `${url} ${res.body}`);
  }
  const patchByAuditor = await app.inject({
    method: 'PATCH',
    url: `/api/ledger/assets/${mine.id}`,
    headers: bearer(auditorA),
    payload: { name: 'x' },
  });
  assert.equal(patchByAuditor.statusCode, 403);
  const delByAuditor = await app.inject({
    method: 'DELETE',
    url: `/api/ledger/assets/${mine.id}`,
    headers: bearer(auditorA),
  });
  assert.equal(delByAuditor.statusCode, 403);

  // 另一个租户
  assert.equal((await get(adminB, `/assets/${mine.id}`)).statusCode, 404);
  const listB = (await get(adminB, '/assets?pageSize=200')).json();
  assert.ok(!listB.items.some((i: any) => i.id === mine.id));
  assert.equal(listB.counts.software, 0);
  const patchB = await app.inject({
    method: 'PATCH',
    url: `/api/ledger/assets/${mine.id}`,
    headers: bearer(adminB),
    payload: { name: '改别人的' },
  });
  assert.equal(patchB.statusCode, 404, patchB.body);
  const delB = await app.inject({
    method: 'DELETE',
    url: `/api/ledger/assets/${mine.id}`,
    headers: bearer(adminB),
  });
  assert.equal(delB.statusCode, 404);
  const relB = await post(adminB, '/relations', {
    fromId: mine.id,
    toId: other.id,
    kind: 'deployed_on',
  });
  assert.equal(relB.statusCode, 404, relB.body);
  const bOwn = await mustCreate(adminB, { type: 'software', name: 'B 的软件' });
  const crossRel = await post(adminA, '/relations', {
    fromId: mine.id,
    toId: bOwn.id,
    kind: 'deployed_on',
  });
  assert.equal(crossRel.statusCode, 404, crossRel.body);
  const okRel = await post(adminA, '/relations', {
    fromId: mine.id,
    toId: other.id,
    kind: 'deployed_on',
  });
  assert.equal(okRel.statusCode, 201, okRel.body);
  const delRelB = await app.inject({
    method: 'DELETE',
    url: `/api/ledger/relations/${okRel.json().id}`,
    headers: bearer(adminB),
  });
  assert.equal(delRelB.statusCode, 404);

  // 改、删写审计
  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/ledger/assets/${mine.id}`,
    headers: bearer(operatorA),
    payload: { name: '隔离软件改名', attrs: { vendor: 'B', version: '1.0' }, code: 'SW-01' },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().name, '隔离软件改名');
  assert.deepEqual(patched.json().attrs, { vendor: 'B', version: '1.0' });
  const delRel = await app.inject({
    method: 'DELETE',
    url: `/api/ledger/relations/${okRel.json().id}`,
    headers: bearer(operatorA),
  });
  assert.equal(delRel.statusCode, 200);
  const delOwn = await app.inject({
    method: 'DELETE',
    url: `/api/ledger/assets/${mine.id}`,
    headers: bearer(operatorA),
  });
  assert.equal(delOwn.statusCode, 200);

  const actions = new Set(
    (
      await db.auditLog.findMany({
        where: { tenantId: tenantA, action: { startsWith: 'ledger.' } },
      })
    ).map((a) => a.action),
  );
  for (const action of [
    'ledger.asset_create',
    'ledger.asset_update',
    'ledger.asset_delete',
    'ledger.import_endpoints',
    'ledger.import_targets',
    'ledger.relation_create',
    'ledger.relation_delete',
  ]) {
    assert.ok(actions.has(action), `缺审计 ${action}`);
  }
});
