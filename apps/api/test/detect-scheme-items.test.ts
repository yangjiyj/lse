import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prismaUnscoped as db } from '../src/db.js';
import {
  bearer,
  cleanupSchemeTenants,
  fleetEndpoint,
  ledgerAsset,
  modelTarget,
  setupSchemeTenants,
  type SchemeFixture,
} from './helpers/scheme-fixtures.js';

// 2.8.2 方案清单：生成、重新生成保留手工改过的项、手工添加、排序、删除资产后清单项保留，权限与租户隔离。

const TENANT_PREFIX = 'C5方案清单测试';
const USER_PREFIX = '__c5_items_';

let app: Awaited<ReturnType<typeof buildApp>>;
let f: SchemeFixture;
let model = '';
let server = '';
let platform = '';

interface Item {
  id: string;
  position: number;
  assetId: string | null;
  asset: { id: string; name: string } | null;
  entryKey: string;
  mode: string;
  jobKind: string | null;
  title: string;
  enabled: boolean;
  origin: string;
  edited: boolean;
  params: Record<string, unknown>;
}

function call(method: string, token: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as 'GET',
    url: `/api/detect-schemes${url}`,
    headers: bearer(token),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

async function newScheme(name: string, assetIds = [model, server, platform]) {
  const res = await call('POST', f.adminA, '', {
    name,
    requirement: {
      objective: '清单测试',
      categories: ['model', 'data', 'content', 'app_env'],
      assetIds,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

async function detail(id: string, token = f.adminA) {
  const res = await call('GET', token, `/${id}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as {
    status: string;
    generatedAt: string | null;
    items: Item[];
    itemCount: number;
  };
}

before(async () => {
  app = await buildApp();
  await app.ready();
  f = await setupSchemeTenants(app, TENANT_PREFIX, USER_PREFIX, 'c5-items');
  const mt = await modelTarget(f.tenantA, 'C5模型对象', 'MODEL');
  const ep = await fleetEndpoint(f.tenantA, 'c5-host');
  model = (await ledgerAsset(f.tenantA, { type: 'model', name: 'C5模型', modelTargetId: mt.id }))
    .id;
  server = (
    await ledgerAsset(f.tenantA, {
      type: 'server',
      name: 'C5服务器',
      fleetEndpointId: ep.id,
      attrs: { ip: '10.20.0.8' },
    })
  ).id;
  platform = (
    await ledgerAsset(f.tenantA, {
      type: 'platform',
      name: 'C5平台',
      attrs: { url: 'https://c5.example.com' },
    })
  ).id;
});

after(async () => {
  await cleanupSchemeTenants(TENANT_PREFIX, USER_PREFIX);
  await app.close();
});

test('生成后状态 planned；改一项 edited；重新生成保留改过的项、替换其余生成项、不出与保留项相同的新项', async () => {
  const id = await newScheme('清单生成');
  const gen = await call('POST', f.operatorA, `/${id}/generate`);
  assert.equal(gen.statusCode, 200, gen.body);
  const first = gen.json() as Awaited<ReturnType<typeof detail>>;
  assert.equal(first.status, 'planned');
  assert.ok(first.generatedAt);
  assert.deepEqual(
    first.items.map((i) => i.position),
    first.items.map((_, i) => i),
  );
  const keys = first.items.map((i) => `${i.assetId}|${i.entryKey}`);
  assert.ok(keys.includes(`${model}|content-eval`));
  assert.ok(keys.includes(`${server}|fleet-posture`));
  assert.ok(keys.includes(`${platform}|asset-discovery`));
  assert.ok(first.items.every((i) => i.origin === 'generated' && !i.edited));
  const posture = first.items.find((i) => i.entryKey === 'fleet-posture')!;
  assert.equal(posture.asset?.name, 'C5服务器');
  assert.ok(
    await db.auditLog.findFirst({ where: { action: 'detect_scheme.generate', targetId: id } }),
  );

  const target = first.items.find((i) => i.entryKey === 'content-eval')!;
  const patched = await call('PATCH', f.operatorA, `/${id}/items/${target.id}`, {
    title: '内容评估（改）',
    params: { ...target.params, questionSetIds: ['q-1'] },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().edited, true);
  assert.equal(patched.json().title, '内容评估（改）');
  const toggled = first.items.find((i) => i.entryKey === 'corpus-scan')!;
  const disabled = await call('PATCH', f.operatorA, `/${id}/items/${toggled.id}`, {
    enabled: false,
  });
  assert.equal(disabled.json().enabled, false);
  assert.equal(disabled.json().edited, true);

  const regen = await call('POST', f.operatorA, `/${id}/generate`);
  assert.equal(regen.statusCode, 200, regen.body);
  const second = regen.json() as Awaited<ReturnType<typeof detail>>;
  assert.equal(second.items.length, first.items.length);
  const kept = second.items.find((i) => i.id === target.id)!;
  assert.equal(kept.title, '内容评估（改）');
  assert.equal(second.items.find((i) => i.id === toggled.id)?.enabled, false);
  const untouched = first.items.filter((i) => i.id !== target.id && i.id !== toggled.id);
  for (const old of untouched) {
    assert.ok(!second.items.some((i) => i.id === old.id), `生成项 ${old.title} 应被替换`);
  }
  assert.equal(
    second.items.filter((i) => i.assetId === model && i.entryKey === 'content-eval').length,
    1,
    '不出与保留项相同的新项',
  );
  assert.deepEqual(
    second.items
      .slice(0, 2)
      .map((i) => i.id)
      .sort(),
    [target.id, toggled.id].sort(),
    '保留项排在前面',
  );
});

test('手工添加：auto 项子任务类型与入口不配 400；人工项带子任务类型 400；正确添加 origin = manual', async () => {
  const id = await newScheme('手工添加');
  const bad = await call('POST', f.adminA, `/${id}/items`, {
    entryKey: 'corpus-scan',
    mode: 'auto',
    jobKind: 'model_file_scan',
    assetId: model,
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().error.code, 'SCHEME_ITEM_INVALID');
  const noKind = await call('POST', f.adminA, `/${id}/items`, {
    entryKey: 'corpus-scan',
    mode: 'auto',
  });
  assert.equal(noKind.json().error.code, 'SCHEME_ITEM_INVALID');
  const manualWithKind = await call('POST', f.adminA, `/${id}/items`, {
    entryKey: 'red-team',
    mode: 'manual',
    jobKind: 'eval_task',
  });
  assert.equal(manualWithKind.json().error.code, 'SCHEME_ITEM_INVALID');
  const unknownEntry = await call('POST', f.adminA, `/${id}/items`, {
    entryKey: 'nope',
    mode: 'manual',
  });
  assert.equal(unknownEntry.statusCode, 400);

  const ok = await call('POST', f.adminA, `/${id}/items`, {
    entryKey: 'corpus-scan',
    mode: 'auto',
    jobKind: 'corpus_scan',
    assetId: model,
    params: { scanId: 'x' },
  });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().origin, 'manual');
  assert.equal(ok.json().category, 'data');
  // 标题里用资产名称，不用关联的评估对象名
  assert.equal(ok.json().title, '语料扫描 · C5模型');
  const manual = await call('POST', f.adminA, `/${id}/items`, {
    entryKey: 'standard-eval',
    mode: 'manual',
    title: '合规专项（人工）',
  });
  assert.equal(manual.statusCode, 201, manual.body);
  assert.equal(manual.json().position, 1);
  // 改成人工执行时子任务类型清空
  const toManual = await call('PATCH', f.adminA, `/${id}/items/${ok.json().id}`, {
    mode: 'manual',
  });
  assert.equal(toManual.statusCode, 200, toManual.body);
  assert.equal(toManual.json().jobKind, null);

  // 手工项重新生成时保留
  await call('POST', f.adminA, `/${id}/generate`);
  const after = await detail(id);
  assert.ok(after.items.some((i) => i.id === manual.json().id));
  assert.ok(
    await db.auditLog.findFirst({ where: { action: 'detect_scheme.item_create', targetId: id } }),
  );
});

test('排序：ids 不全或重复 400；全部给齐按新顺序；删除项写审计', async () => {
  const id = await newScheme('排序', [server]);
  const items = (await call('POST', f.adminA, `/${id}/generate`)).json().items as Item[];
  assert.ok(items.length >= 2);
  const ids = items.map((i) => i.id);
  const partial = await call('POST', f.adminA, `/${id}/items/reorder`, { ids: ids.slice(1) });
  assert.equal(partial.statusCode, 400, partial.body);
  assert.equal(partial.json().error.code, 'SCHEME_REORDER_INVALID');
  const dup = await call('POST', f.adminA, `/${id}/items/reorder`, {
    ids: [ids[0], ...ids.slice(0, -1)],
  });
  assert.equal(dup.statusCode, 400);
  const reversed = [...ids].reverse();
  const ok = await call('POST', f.adminA, `/${id}/items/reorder`, { ids: reversed });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(
    (ok.json().items as Item[]).map((i) => i.id),
    reversed,
  );
  const del = await call('DELETE', f.adminA, `/${id}/items/${ids[0]}`);
  assert.equal(del.statusCode, 200, del.body);
  assert.equal((await detail(id)).items.length, ids.length - 1);
  assert.ok(
    await db.auditLog.findFirst({ where: { action: 'detect_scheme.item_delete', targetId: id } }),
  );
  assert.ok(
    await db.auditLog.findFirst({ where: { action: 'detect_scheme.item_update', targetId: id } }),
  );
});

test('删除资产后清单项 assetId 为空、仍可读', async () => {
  const extra = await ledgerAsset(f.tenantA, { type: 'software', name: 'C5将删软件' });
  const id = await newScheme('删资产', [extra.id]);
  const items = (await call('POST', f.adminA, `/${id}/generate`)).json().items as Item[];
  assert.equal(items.length, 1);
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/ledger/assets/${extra.id}`,
    headers: bearer(f.adminA),
  });
  assert.equal(del.statusCode, 200, del.body);
  const after = await detail(id, f.auditorA);
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0]!.assetId, null);
  assert.equal(after.items[0]!.asset, null);
  assert.equal(after.items[0]!.title, items[0]!.title);
});

test('权限与隔离：auditor 生成、改项 403；另一个租户 404；归档后生成 409', async () => {
  const id = await newScheme('清单隔离');
  const items = (await call('POST', f.adminA, `/${id}/generate`)).json().items as Item[];
  const itemId = items[0]!.id;
  assert.equal((await call('POST', f.auditorA, `/${id}/generate`)).statusCode, 403);
  assert.equal(
    (await call('PATCH', f.auditorA, `/${id}/items/${itemId}`, { enabled: false })).statusCode,
    403,
  );
  assert.equal(
    (await call('POST', f.auditorA, `/${id}/items`, { entryKey: 'red-team', mode: 'manual' }))
      .statusCode,
    403,
  );
  assert.equal((await call('DELETE', f.auditorA, `/${id}/items/${itemId}`)).statusCode, 403);

  for (const [method, url, payload] of [
    ['POST', `/${id}/generate`, undefined],
    ['POST', `/${id}/items`, { entryKey: 'red-team', mode: 'manual' }],
    ['PATCH', `/${id}/items/${itemId}`, { enabled: false }],
    ['DELETE', `/${id}/items/${itemId}`, undefined],
    ['POST', `/${id}/items/reorder`, { ids: [itemId] }],
  ] as const) {
    const res = await call(method, f.adminB, url, payload);
    assert.equal(res.statusCode, 404, `${method} ${url} ${res.body}`);
  }
  // 另一个租户的方案里的项，不能通过本方案的路径改
  const other = await newScheme('清单隔离二', [server]);
  const wrongScheme = await call('PATCH', f.adminA, `/${other}/items/${itemId}`, {
    enabled: false,
  });
  assert.equal(wrongScheme.statusCode, 404);
  // 别的租户的资产不能加进清单
  const assetB = await ledgerAsset(f.tenantB, { type: 'software', name: 'C5乙软件' });
  const crossAsset = await call('POST', f.adminA, `/${id}/items`, {
    entryKey: 'service-assurance',
    mode: 'manual',
    assetId: assetB.id,
  });
  assert.equal(crossAsset.statusCode, 400);
  assert.equal(crossAsset.json().error.code, 'SCHEME_ASSET_INVALID');

  await call('POST', f.adminA, `/${id}/archive`);
  const archived = await call('POST', f.adminA, `/${id}/generate`);
  assert.equal(archived.statusCode, 409, archived.body);
  assert.equal(
    (await call('PATCH', f.adminA, `/${id}/items/${itemId}`, { enabled: false })).statusCode,
    409,
  );
});

test('重新生成时保留项的序号不变、新项排在后面；并发生成不出重复项', async () => {
  const id = await newScheme('序号保留');
  const first = (await call('POST', f.adminA, `/${id}/generate`)).json().items as Item[];
  assert.ok(first.length >= 3);
  // 把最后一项挪到最前，再手工改它
  const last = first[first.length - 1]!;
  const reorder = await call('POST', f.adminA, `/${id}/items/reorder`, {
    ids: [last.id, ...first.slice(0, -1).map((i) => i.id)],
  });
  assert.equal(reorder.statusCode, 200, reorder.body);
  await call('PATCH', f.adminA, `/${id}/items/${last.id}`, { note: '改过' });
  const regen = (await call('POST', f.adminA, `/${id}/generate`)).json().items as Item[];
  const kept = regen.find((i) => i.id === last.id)!;
  assert.equal(kept.position, 0, '保留项序号不变');
  assert.ok(regen.filter((i) => i.id !== last.id).every((i) => i.position > 0));
  assert.equal(regen.length, first.length);

  const [a, b] = await Promise.all([
    call('POST', f.adminA, `/${id}/generate`),
    call('POST', f.adminA, `/${id}/generate`),
  ]);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(b.statusCode, 200, b.body);
  const rows = await db.detectSchemeItem.findMany({ where: { schemeId: id } });
  const keys = rows.map((r) => `${r.assetId}|${r.entryKey}`);
  assert.equal(new Set(keys).size, keys.length, '并发生成出了重复项');
  assert.equal(rows.length, first.length);
});

test('自动项换检测对象：参数里绑定对象的终端、评估对象必须与新对象关联的一致，不一致 400', async () => {
  const ep2 = await fleetEndpoint(f.tenantA, 'c5-host-2');
  const server2 = await ledgerAsset(f.tenantA, {
    type: 'server',
    name: 'C5服务器二',
    fleetEndpointId: ep2.id,
  });
  const bare = await ledgerAsset(f.tenantA, { type: 'server', name: 'C5无终端服务器' });
  const id = await newScheme('换对象', [server, server2.id, model]);
  const items = (await call('POST', f.adminA, `/${id}/generate`)).json().items as Item[];
  const posture = items.find((i) => i.entryKey === 'fleet-posture' && i.assetId === server)!;
  const endpointOfServer = posture.params.endpointId as string;

  const mismatch = await call('PATCH', f.adminA, `/${id}/items/${posture.id}`, {
    assetId: server2.id,
  });
  assert.equal(mismatch.statusCode, 400, mismatch.body);
  assert.equal(mismatch.json().error.code, 'SCHEME_ITEM_ASSET_MISMATCH');
  const toBare = await call('PATCH', f.adminA, `/${id}/items/${posture.id}`, { assetId: bare.id });
  assert.equal(
    toBare.json().error.code,
    'SCHEME_ITEM_ASSET_MISMATCH',
    '没关联终端的对象也不能挂别的终端',
  );
  const ok = await call('PATCH', f.adminA, `/${id}/items/${posture.id}`, {
    assetId: server2.id,
    params: { endpointId: ep2.id },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().assetId, server2.id);
  // 不指定对象时不校验；单纯启停不受影响
  const noAsset = await call('PATCH', f.adminA, `/${id}/items/${posture.id}`, {
    assetId: null,
    params: { endpointId: endpointOfServer },
  });
  assert.equal(noAsset.statusCode, 200, noAsset.body);

  const evalItem = items.find((i) => i.entryKey === 'content-eval')!;
  const wrongTarget = await call('PATCH', f.adminA, `/${id}/items/${evalItem.id}`, {
    params: { ...evalItem.params, modelTargetId: '00000000-0000-4000-8000-0000000000ff' },
  });
  assert.equal(wrongTarget.json().error.code, 'SCHEME_ITEM_ASSET_MISMATCH');

  const addWrong = await call('POST', f.adminA, `/${id}/items`, {
    entryKey: 'fleet-posture',
    mode: 'auto',
    jobKind: 'fleet_posture',
    assetId: server,
    params: { endpointId: ep2.id },
  });
  assert.equal(addWrong.statusCode, 400, addWrong.body);
  assert.equal(addWrong.json().error.code, 'SCHEME_ITEM_ASSET_MISMATCH');
  // 扫描目标这类用户可改的字段不校验
  const discovery = await call('POST', f.adminA, `/${id}/items`, {
    entryKey: 'asset-discovery',
    mode: 'auto',
    jobKind: 'asset_discovery',
    assetId: server,
    params: { targets: ['https://anything.example.com'], ports: [], confirm: true },
  });
  assert.equal(discovery.statusCode, 201, discovery.body);
});
