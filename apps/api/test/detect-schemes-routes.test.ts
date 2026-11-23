import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PLATFORM_ONLY_PERMISSIONS, ROLE_DEFS } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prismaUnscoped as db } from '../src/db.js';
import { TENANT_OWNED_MODELS } from '../src/lib/tenant-models.js';
import { schemeStatus } from '../src/modules/detect-schemes/service.js';
import {
  bearer,
  cleanupSchemeTenants,
  ledgerAsset,
  setupSchemeTenants,
  type SchemeFixture,
} from './helpers/scheme-fixtures.js';

// 2.8.2 检测方案与需求配置：校验、同名、状态（需求配置中 / 归档）、权限、租户隔离与审计。

const TENANT_PREFIX = 'C4检测方案测试';
const USER_PREFIX = '__c4_scheme_';

let app: Awaited<ReturnType<typeof buildApp>>;
let f: SchemeFixture;
let assetA = '';
let assetA2 = '';
let assetB = '';

const requirement = (over: Record<string, unknown> = {}) => ({
  objective: '上线前安全检测',
  categories: ['content', 'model'],
  assetIds: [assetA],
  plannedStart: '2026-12-01',
  plannedEnd: '2026-12-10',
  contactName: '李四',
  contactPhone: '13800000000',
  ...over,
});

function call(method: string, token: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as 'GET',
    url: `/api/detect-schemes${url}`,
    headers: bearer(token),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

async function mustCreate(token: string, name: string, req = requirement()) {
  const res = await call('POST', token, '', { name, requirement: req });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

before(async () => {
  app = await buildApp();
  await app.ready();
  f = await setupSchemeTenants(app, TENANT_PREFIX, USER_PREFIX, 'c4-scheme');
  assetA = (await ledgerAsset(f.tenantA, { type: 'model', name: 'C4模型' })).id;
  assetA2 = (await ledgerAsset(f.tenantA, { type: 'platform', name: 'C4平台' })).id;
  assetB = (await ledgerAsset(f.tenantB, { type: 'model', name: 'C4乙模型' })).id;
});

after(async () => {
  await cleanupSchemeTenants(TENANT_PREFIX, USER_PREFIX);
  await app.close();
});

test('状态推算：归档、需求配置中、清单已生成、执行中、已完成', () => {
  const base = { archivedAt: null, itemCount: 0, jobCount: 0, activeJobCount: 0 };
  assert.equal(schemeStatus(base), 'draft');
  assert.equal(schemeStatus({ ...base, itemCount: 3 }), 'planned');
  assert.equal(
    schemeStatus({ ...base, itemCount: 3, jobCount: 1, activeJobCount: 1 }),
    'executing',
  );
  assert.equal(schemeStatus({ ...base, itemCount: 3, jobCount: 2 }), 'done');
  assert.equal(schemeStatus({ ...base, itemCount: 3, archivedAt: new Date() }), 'archived');
});

test('方案表登记为租户内数据；权限点分配正确', async () => {
  assert.ok(TENANT_OWNED_MODELS.has('DetectScheme'));
  assert.ok(TENANT_OWNED_MODELS.has('DetectSchemeItem'));
  const manage = new Set(['admin', 'tenant_admin', 'operator']);
  for (const role of ROLE_DEFS) {
    assert.ok(role.permissions.includes('scheme:read'), `${role.name} 缺 scheme:read`);
    assert.equal(role.permissions.includes('scheme:manage'), manage.has(role.name), role.name);
  }
  assert.ok(!PLATFORM_ONLY_PERMISSIONS.includes('scheme:manage'));
  const granted = async (code: string) =>
    (
      await db.rolePermission.findMany({
        where: { permission: { code } },
        select: { role: { select: { name: true } } },
      })
    )
      .map((r) => r.role.name)
      .filter((n) => ['admin', 'tenant_admin', 'operator', 'auditor'].includes(n))
      .sort();
  assert.deepEqual(await granted('scheme:read'), ['admin', 'auditor', 'operator', 'tenant_admin']);
  assert.deepEqual(await granted('scheme:manage'), ['admin', 'operator', 'tenant_admin']);
});

test('建方案：类别为空、对象含别的租户的资产、开始晚于结束、日期格式不对都 400；同名 409；写审计', async () => {
  const bad = async (req: Record<string, unknown>, label: string) => {
    const res = await call('POST', f.adminA, '', { name: `坏-${label}`, requirement: req });
    assert.equal(res.statusCode, 400, `${label}: ${res.body}`);
    return res.json();
  };
  await bad(requirement({ categories: [] }), '类别为空');
  await bad(requirement({ categories: ['secret'] }), '未知类别');
  await bad(requirement({ assetIds: [] }), '对象为空');
  const cross = await bad(requirement({ assetIds: [assetA, assetB] }), '跨租户对象');
  assert.equal(cross.error.code, 'SCHEME_ASSET_INVALID');
  await bad(requirement({ plannedStart: '2026-12-11', plannedEnd: '2026-12-10' }), '开始晚于结束');
  await bad(requirement({ plannedStart: '2026-02-30' }), '日期不存在');
  await bad(requirement({ objective: '' }), '目标为空');
  await bad(requirement({ contactPhone: '1'.repeat(31) }), '电话超长');
  await bad(requirement({ extra: 1 }), '未知字段');

  const created = await mustCreate(
    f.adminA,
    '上线前检测',
    requirement({ categories: ['model', 'content', 'model'] }),
  );
  assert.equal(created.status, 'draft');
  assert.deepEqual(created.requirement.categories, ['model', 'content']);
  assert.deepEqual(created.assets, [{ id: assetA, type: 'model', name: 'C4模型' }]);
  assert.deepEqual(created.items, []);
  const audit = await db.auditLog.findFirst({
    where: { action: 'detect_scheme.create', targetId: created.id },
  });
  assert.ok(audit);
  assert.equal(audit.tenantId, f.tenantA);

  const dup = await call('POST', f.operatorA, '', {
    name: '上线前检测',
    requirement: requirement(),
  });
  assert.equal(dup.statusCode, 409, dup.body);
  assert.equal(dup.json().error.code, 'SCHEME_NAME_TAKEN');
  // 别的租户可以同名
  await mustCreate(f.adminB, '上线前检测', requirement({ assetIds: [assetB] }));
});

test('列表的 status 为 draft；归档后为 archived 且不能改，取消归档后恢复；改需求配置写审计', async () => {
  const s = await mustCreate(f.operatorA, '归档测试');
  const list = async () => {
    const res = await call('GET', f.auditorA, '?pageSize=200');
    assert.equal(res.statusCode, 200, res.body);
    return res.json().items.find((i: { id: string }) => i.id === s.id);
  };
  const row = await list();
  assert.equal(row.status, 'draft');
  assert.equal(row.itemCount, 0);
  assert.equal(row.jobCount, 0);

  const archived = await call('POST', f.operatorA, `/${s.id}/archive`);
  assert.equal(archived.statusCode, 200, archived.body);
  assert.equal(archived.json().status, 'archived');
  assert.equal((await list()).status, 'archived');
  const patchArchived = await call('PATCH', f.operatorA, `/${s.id}`, { name: '归档后改名' });
  assert.equal(patchArchived.statusCode, 409, patchArchived.body);
  assert.equal(patchArchived.json().error.code, 'SCHEME_ARCHIVED');

  const restored = await call('POST', f.operatorA, `/${s.id}/unarchive`);
  assert.equal(restored.json().status, 'draft');
  assert.equal((await list()).status, 'draft');

  const patched = await call('PATCH', f.operatorA, `/${s.id}`, {
    name: '归档测试改名',
    requirement: requirement({ assetIds: [assetA2, assetA], categories: ['app_env'] }),
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().name, '归档测试改名');
  assert.deepEqual(
    patched.json().assets.map((a: { name: string }) => a.name),
    ['C4平台', 'C4模型'],
  );
  const crossPatch = await call('PATCH', f.operatorA, `/${s.id}`, {
    requirement: requirement({ assetIds: [assetB] }),
  });
  assert.equal(crossPatch.statusCode, 400, crossPatch.body);

  for (const action of [
    'detect_scheme.archive',
    'detect_scheme.unarchive',
    'detect_scheme.update',
  ]) {
    assert.ok(
      await db.auditLog.findFirst({ where: { action, targetId: s.id } }),
      `缺审计 ${action}`,
    );
  }
});

test('auditor 写 403；另一个租户看不到、改不了、删不了；删除写审计', async () => {
  const s = await mustCreate(f.adminA, '隔离方案');
  for (const [method, url, payload] of [
    ['POST', '', { name: '审计员建', requirement: requirement() }],
    ['PATCH', `/${s.id}`, { name: 'x' }],
    ['DELETE', `/${s.id}`, undefined],
    ['POST', `/${s.id}/archive`, undefined],
    ['POST', `/${s.id}/unarchive`, undefined],
  ] as const) {
    const res = await call(method, f.auditorA, url, payload);
    assert.equal(res.statusCode, 403, `${method} ${url} ${res.body}`);
  }
  assert.equal((await call('GET', f.auditorA, `/${s.id}`)).statusCode, 200);

  assert.equal((await call('GET', f.adminB, `/${s.id}`)).statusCode, 404);
  const listB = (await call('GET', f.adminB, '?pageSize=200')).json();
  assert.ok(!listB.items.some((i: { id: string }) => i.id === s.id));
  for (const [method, url, payload] of [
    ['PATCH', `/${s.id}`, { name: '乙改' }],
    ['DELETE', `/${s.id}`, undefined],
    ['POST', `/${s.id}/archive`, undefined],
  ] as const) {
    const res = await call(method, f.adminB, url, payload);
    assert.equal(res.statusCode, 404, `${method} ${url} ${res.body}`);
  }

  const del = await call('DELETE', f.adminA, `/${s.id}`);
  assert.equal(del.statusCode, 200, del.body);
  assert.equal(await db.detectScheme.count({ where: { id: s.id } }), 0);
  assert.ok(
    await db.auditLog.findFirst({ where: { action: 'detect_scheme.delete', targetId: s.id } }),
  );
});

test('需求配置里的对象被删后：详情只返回还在的，原样回填保存忽略已删的；新加不存在的 id 仍 400', async () => {
  const a1 = await ledgerAsset(f.tenantA, { type: 'software', name: 'C4留下的软件' });
  const a2 = await ledgerAsset(f.tenantA, { type: 'software', name: 'C4将删的软件' });
  const s = await mustCreate(f.adminA, '对象被删', requirement({ assetIds: [a1.id, a2.id] }));
  const original = s.requirement as Record<string, unknown>;
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/ledger/assets/${a2.id}`,
    headers: bearer(f.adminA),
  });
  assert.equal(del.statusCode, 200, del.body);
  const detail = (await call('GET', f.adminA, `/${s.id}`)).json();
  assert.deepEqual(detail.requirement.assetIds, [a1.id]);
  assert.deepEqual(
    detail.assets.map((a: { id: string }) => a.id),
    [a1.id],
  );

  // 用删资产之前的配置原样回填：已删的忽略
  const stale = await call('PATCH', f.adminA, `/${s.id}`, {
    requirement: { ...original, objective: '改个目标' },
  });
  assert.equal(stale.statusCode, 200, stale.body);
  assert.deepEqual(stale.json().requirement.assetIds, [a1.id]);
  assert.equal(stale.json().requirement.objective, '改个目标');

  const unknown = await call('PATCH', f.adminA, `/${s.id}`, {
    requirement: requirement({ assetIds: [a1.id, randomUUID()] }),
  });
  assert.equal(unknown.statusCode, 400, unknown.body);
  assert.equal(unknown.json().error.code, 'SCHEME_ASSET_INVALID');
  // 已经从配置里去掉的已删资产，再加回来也不行
  const readded = await call('PATCH', f.adminA, `/${s.id}`, {
    requirement: requirement({ assetIds: [a2.id] }),
  });
  assert.equal(readded.statusCode, 400, readded.body);
});
