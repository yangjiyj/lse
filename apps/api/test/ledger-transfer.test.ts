import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { prismaUnscoped as db } from '../src/db.js';
import { executeTransfer, planTransfer } from '../src/lib/tenant-transfer.js';
import {
  bearer,
  cleanupSchemeTenants,
  fleetEndpoint,
  ledgerAsset,
  modelTarget,
  setupSchemeTenants,
  type SchemeFixture,
} from './helpers/scheme-fixtures.js';

// 应用台账与租户转移（审查第 1 条）：终端、评估对象转到别的租户后，原租户台账的关联解除并预警；
// 关联对象租户和资产不一致时（兜底）当没关联，读不到别家的主机名、模型名。

const TENANT_PREFIX = 'C台账转移测试';
const USER_PREFIX = '__c_ledger_xfer_';
const SHARED_TARGET = `C台账共享模型-${randomUUID().slice(0, 8)}`;

let app: Awaited<ReturnType<typeof buildApp>>;
let f: SchemeFixture;

function get(token: string, url: string) {
  return app.inject({ method: 'GET', url, headers: bearer(token) });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  f = await setupSchemeTenants(app, TENANT_PREFIX, USER_PREFIX, 'c-ledger-xfer');
});

after(async () => {
  await db.ledgerAsset.deleteMany({ where: { modelTarget: { name: SHARED_TARGET } } });
  await db.modelTarget.deleteMany({ where: { name: SHARED_TARGET, tenantId: null } });
  await cleanupSchemeTenants(TENANT_PREFIX, USER_PREFIX);
  await app.close();
});

test('终端转到别的租户：预检提示 LEDGER_UNLINKED，转移后原租户台账解除关联，新租户能登记', async () => {
  const ep = await fleetEndpoint(f.tenantA, 'c-xfer-host');
  const asset = await ledgerAsset(f.tenantA, {
    type: 'server',
    name: 'C转移服务器',
    fleetEndpointId: ep.id,
  });
  const input = { kind: 'fleet-endpoint' as const, ids: [ep.id], targetTenantId: f.tenantB };
  const plan = await planTransfer(input);
  assert.ok(plan.canTransfer, JSON.stringify(plan.blockers));
  const warning = plan.warnings.find((w) => w.code === 'LEDGER_UNLINKED');
  assert.ok(warning, '缺 LEDGER_UNLINKED 预警');
  assert.match(warning.message, /1 个应用台账资产/);

  await executeTransfer(input);
  const row = await db.ledgerAsset.findUniqueOrThrow({ where: { id: asset.id } });
  assert.equal(row.tenantId, f.tenantA, '台账资产本身留在原租户');
  assert.equal(row.fleetEndpointId, null);
  await db.fleetEndpoint.update({ where: { id: ep.id }, data: { hostname: 'c-xfer-host-in-b' } });
  const detail = (await get(f.adminA, `/api/ledger/assets/${asset.id}`)).json();
  assert.equal(detail.endpoint, null);
  assert.ok(!JSON.stringify(detail).includes('c-xfer-host-in-b'));

  const imported = await app.inject({
    method: 'POST',
    url: '/api/ledger/assets/import-endpoints',
    headers: bearer(f.adminB),
    payload: { endpointIds: [ep.id] },
  });
  assert.deepEqual(imported.json(), { created: 1, skipped: 0 });
});

test('评估对象转到别的租户：原租户台账解除关联，看不到新租户改的名称', async () => {
  const t = await modelTarget(f.tenantA, 'C转移模型', 'MODEL');
  const asset = await ledgerAsset(f.tenantA, {
    type: 'model',
    name: 'C模型资产',
    modelTargetId: t.id,
  });
  const input = { kind: 'model-target' as const, ids: [t.id], targetTenantId: f.tenantB };
  assert.ok((await planTransfer(input)).warnings.some((w) => w.code === 'LEDGER_UNLINKED'));
  await executeTransfer(input);
  await db.modelTarget.update({ where: { id: t.id }, data: { name: 'B租户改名后的模型' } });
  assert.equal(
    (await db.ledgerAsset.findUniqueOrThrow({ where: { id: asset.id } })).modelTargetId,
    null,
  );
  const list = (await get(f.adminA, '/api/ledger/assets?type=model&pageSize=200')).json();
  const item = list.items.find((i: { id: string }) => i.id === asset.id);
  assert.equal(item.displayName, 'C模型资产');
  assert.equal(item.target, null);
});

test('兜底：关联对象不在资产所在租户时当没关联（详情、列表、硬件、清单生成）；平台共享的评估对象照常', async () => {
  const ep = await fleetEndpoint(f.tenantA, 'c-xfer-stale');
  await db.fleetProbeReport.create({
    data: {
      endpointId: ep.id,
      reportId: `pr_${randomUUID()}`,
      scannedAt: new Date(),
      status: 'complete',
      bodyHash: 'h',
      body: { host: { cpu_model: '别家的 CPU' } },
    },
  });
  const server = await ledgerAsset(f.tenantA, {
    type: 'endpoint',
    name: 'C兜底终端',
    fleetEndpointId: ep.id,
    attrs: { ip: '10.70.0.8' },
  });
  const t = await modelTarget(f.tenantA, 'C兜底模型', 'MODEL');
  const model = await ledgerAsset(f.tenantA, {
    type: 'model',
    name: 'C兜底模型资产',
    modelTargetId: t.id,
  });
  // 绕过转移流程直接改归属（模拟历史数据）
  await db.fleetEndpoint.update({
    where: { id: ep.id },
    data: { tenantId: f.tenantB, hostname: '别家主机' },
  });
  await db.fleetProbeReport.updateMany({
    where: { endpointId: ep.id },
    data: { tenantId: f.tenantB },
  });
  await db.modelTarget.update({
    where: { id: t.id },
    data: { tenantId: f.tenantB, name: '别家模型' },
  });

  const d = (await get(f.adminA, `/api/ledger/assets/${server.id}`)).json();
  assert.equal(d.displayName, 'C兜底终端');
  assert.equal(d.endpoint, null);
  assert.equal(d.fleetEndpointId, null);
  assert.equal(d.hardware, null);
  const m = (await get(f.adminA, `/api/ledger/assets/${model.id}`)).json();
  assert.equal(m.displayName, 'C兜底模型资产');
  assert.equal(m.target, null);
  assert.ok(!JSON.stringify([d, m]).includes('别家'));

  // 清单生成也按没关联算：终端走「终端接入」，模型不出内容评估
  const scheme = await app.inject({
    method: 'POST',
    url: '/api/detect-schemes',
    headers: bearer(f.adminA),
    payload: {
      name: 'C兜底方案',
      requirement: {
        objective: 'x',
        categories: ['content', 'app_env'],
        assetIds: [server.id, model.id],
      },
    },
  });
  assert.equal(scheme.statusCode, 201, scheme.body);
  const gen = await app.inject({
    method: 'POST',
    url: `/api/detect-schemes/${scheme.json().id}/generate`,
    headers: bearer(f.adminA),
  });
  const entries = (gen.json().items as Array<{ entryKey: string }>).map((i) => i.entryKey).sort();
  assert.deepEqual(entries, ['fleet-onboard']);

  // 平台共享的评估对象（tenantId 为空）照常算关联
  const shared = await db.modelTarget.create({
    data: {
      tenantId: null,
      name: SHARED_TARGET,
      provider: 'openai-compatible',
      targetType: 'MODEL',
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'x',
      model: 'shared-model',
    },
  });
  // 插入时触发器会把空租户补成平台租户（只有平台裁判模型例外），这里写入后再置空模拟平台共享对象
  await db.modelTarget.update({ where: { id: shared.id }, data: { tenantId: null } });
  const sharedAsset = await ledgerAsset(f.tenantA, {
    type: 'model',
    name: 'C共享模型资产',
    modelTargetId: shared.id,
  });
  const s = (await get(f.adminA, `/api/ledger/assets/${sharedAsset.id}`)).json();
  assert.equal(s.displayName, 'C共享模型资产');
  assert.equal(s.target.name, SHARED_TARGET);
  assert.equal(s.target.id, shared.id);
});
