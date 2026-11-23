// 关键词状态「生效 / 候选 / 停用」：批量改状态接口（按 id、按小项 + 原状态）、权限与租户、审计、列表字段、覆盖统计、导出。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { parseCsv } from '../src/lib/question-import.js';
import { loadScanKeywords } from '../src/modules/corpus-scans/executor.js';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';

const TAG = `kwst${randomUUID().slice(0, 8)}`;
const PREFIX = `__kw_status_${TAG}_`;
const PW = ['Tenant', 'Admin', '12345'].join('!');
const BASE = '/api/question-sets/builtin/keywords';
// 用 A.3、A.4 的小项：没有导入下限要求，和其他测试的 A.1、A.2 词互不干扰。
const ITEM = 'A.4.c';

let app!: FastifyInstance;
let adminToken = '';
const tenant = { id: '', token: '', username: `${TAG}t` };

const h = (token: string) => ({ authorization: `Bearer ${token}` });

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token;
}

async function mk(
  name: string,
  opts: {
    tenantId?: string | null;
    reviewStatus?: string;
    source?: string;
    itemCode?: string;
  } = {},
) {
  return prisma.standardKeyword.create({
    data: {
      tenantId: opts.tenantId ?? null,
      itemCode: opts.itemCode ?? ITEM,
      term: `${PREFIX}${name}`,
      source: opts.source ?? 'import:txt',
      reviewStatus: opts.reviewStatus ?? 'approved',
    },
  });
}

const statusOf = async (id: string) =>
  (await prisma.standardKeyword.findUniqueOrThrow({ where: { id } })).reviewStatus;

function post(token: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: `${BASE}/status`,
    headers: h(token),
    payload: payload as object,
  });
}

async function cleanupKeywords() {
  await prisma.standardKeyword.deleteMany({ where: { term: { startsWith: PREFIX } } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanupKeywords();
  adminToken = await login('admin', 'Admin@12345'); // pragma: allowlist secret
  const res = await app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: h(adminToken),
    payload: { name: `${PREFIX}租户`, admin: { username: tenant.username, password: PW } },
  });
  assert.equal(res.statusCode, 201, res.body);
  tenant.id = res.json().id;
  await skipFirstPasswordChange(tenant.username);
  tenant.token = await login(tenant.username, PW);
});

after(async () => {
  await cleanupKeywords();
  if (tenant.id) {
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.user.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  }
  await app.close();
  await prisma.$disconnect();
});

test('按 id 改状态：写入修改人和修改时间，已剔除的词不改', async () => {
  await cleanupKeywords();
  const a = await mk('甲', { reviewStatus: 'approved' });
  const b = await mk('乙', { reviewStatus: 'pending' });
  const r = await mk('丙', { reviewStatus: 'rejected' });
  const t0 = Date.now();
  const res = await post(adminToken, { ids: [a.id, b.id, r.id], to: 'disabled' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().changed, 2);
  assert.equal(res.json().to, 'disabled');
  const rowA = await prisma.standardKeyword.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(rowA.reviewStatus, 'disabled');
  assert.equal(rowA.statusChangedBy, 'admin');
  assert.ok(rowA.statusChangedAt && rowA.statusChangedAt.getTime() >= t0 - 1000);
  assert.equal(await statusOf(b.id), 'disabled');
  assert.equal(await statusOf(r.id), 'rejected');

  const back = await post(adminToken, { ids: [a.id], to: 'approved' });
  assert.equal(back.statusCode, 200, back.body);
  assert.equal(back.json().changed, 1);
  assert.equal(await statusOf(a.id), 'approved');
});

test('按小项 + 原状态改：只改该小项、该状态的词', async () => {
  await cleanupKeywords();
  const p1 = await mk('候选一', { reviewStatus: 'pending' });
  const p2 = await mk('候选二', { reviewStatus: 'pending' });
  const other = await mk('别的小项候选', { reviewStatus: 'pending', itemCode: 'A.4.d' });
  const on = await mk('生效', { reviewStatus: 'approved' });
  const before = await prisma.standardKeyword.count({
    where: { tenantId: null, itemCode: ITEM, reviewStatus: 'pending' },
  });
  const res = await post(adminToken, { itemCode: ITEM, fromStatus: 'pending', to: 'approved' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().changed, before);
  assert.equal(res.json().itemCode, ITEM);
  assert.equal(await statusOf(p1.id), 'approved');
  assert.equal(await statusOf(p2.id), 'approved');
  assert.equal(await statusOf(other.id), 'pending');
  assert.equal(await statusOf(on.id), 'approved');
});

test('请求体校验：缺 id 和小项、只给小项不给原状态、原状态与目标相同、目标不合法', async () => {
  for (const payload of [
    { to: 'approved' },
    { itemCode: ITEM, to: 'approved' },
    { itemCode: ITEM, fromStatus: 'approved', to: 'approved' },
    { ids: [], to: 'approved' },
    { ids: ['x'], to: 'pending' },
    { ids: ['x'], to: 'rejected' },
  ]) {
    const res = await post(adminToken, payload);
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} → ${res.statusCode} ${res.body}`);
  }
  const bad = await post(adminToken, { itemCode: 'A.9.z', fromStatus: 'pending', to: 'approved' });
  assert.equal(bad.statusCode, 409);
  const anon = await app.inject({
    method: 'POST',
    url: `${BASE}/status`,
    payload: { ids: ['x'], to: 'approved' },
  });
  assert.equal(anon.statusCode, 401);
});

test('旧的审校接口已去掉', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `${BASE}/review`,
    headers: h(adminToken),
    payload: { action: 'approve' },
  });
  assert.equal(res.statusCode, 404);
});

test('租户：改平台词 403；混着自己的词一起改也整体 403，自己的词不动；只改自己的词可以', async () => {
  await cleanupKeywords();
  const platform = await mk('平台词');
  const own = await mk('租户词', { tenantId: tenant.id });
  const res = await post(tenant.token, { ids: [platform.id], to: 'disabled' });
  assert.equal(res.statusCode, 403, res.body);
  assert.match(res.json().error.message, /平台词表只有平台管理员可以修改/);
  const mixed = await post(tenant.token, { ids: [own.id, platform.id], to: 'disabled' });
  assert.equal(mixed.statusCode, 403, mixed.body);
  assert.equal(await statusOf(own.id), 'approved');
  assert.equal(await statusOf(platform.id), 'approved');
  const missing = await post(tenant.token, { ids: [own.id, randomUUID()], to: 'disabled' });
  assert.equal(missing.statusCode, 403, missing.body);
  assert.match(missing.json().error.message, /有 1 个关键词不存在或已删除/);

  const ok = await post(tenant.token, { ids: [own.id], to: 'disabled' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().changed, 1);
  const row = await prisma.standardKeyword.findUniqueOrThrow({ where: { id: own.id } });
  assert.equal(row.reviewStatus, 'disabled');
  assert.equal(row.statusChangedBy, tenant.username);

  // 平台管理员也不能按 id 改租户的词
  const cross = await post(adminToken, { ids: [own.id], to: 'approved' });
  assert.equal(cross.statusCode, 403, cross.body);
  assert.match(cross.json().error.message, /租户导入的关键词只能由该租户修改/);
});

test('租户按小项改：只改自己导入的词，平台词不动', async () => {
  await cleanupKeywords();
  const platform = await mk('平台生效');
  const own1 = await mk('租户生效一', { tenantId: tenant.id });
  const own2 = await mk('租户生效二', { tenantId: tenant.id });
  const res = await post(tenant.token, { itemCode: ITEM, fromStatus: 'approved', to: 'disabled' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().changed, 2);
  assert.equal(await statusOf(own1.id), 'disabled');
  assert.equal(await statusOf(own2.id), 'disabled');
  assert.equal(await statusOf(platform.id), 'approved');
});

test('审计：动作 keyword_library.status，detail 带目标状态、数量、小项和前 20 个词', async () => {
  await cleanupKeywords();
  for (let i = 0; i < 25; i++)
    await mk(`审计${String(i).padStart(2, '0')}`, { reviewStatus: 'pending', itemCode: 'A.4.e' });
  const res = await post(adminToken, { itemCode: 'A.4.e', fromStatus: 'pending', to: 'disabled' });
  assert.equal(res.statusCode, 200, res.body);
  const changed = res.json().changed as number;
  assert.ok(changed >= 25);
  const log = await prisma.auditLog.findFirstOrThrow({
    where: { action: 'keyword_library.status' },
    orderBy: { createdAt: 'desc' },
  });
  const detail = log.detail as {
    to: string;
    count: number;
    itemCode: string | null;
    terms: string[];
  };
  assert.equal(log.targetType, 'keyword_library');
  assert.equal(detail.to, 'disabled');
  assert.equal(detail.count, changed);
  assert.equal(detail.itemCode, 'A.4.e');
  assert.equal(detail.terms.length, 20);
  assert.ok(detail.terms.every((t) => typeof t === 'string'));

  // 按 id 改同一小项的词，detail.itemCode 也带上
  const one = await prisma.standardKeyword.findFirstOrThrow({ where: { term: `${PREFIX}审计00` } });
  await post(adminToken, { ids: [one.id], to: 'approved' });
  const log2 = await prisma.auditLog.findFirstOrThrow({
    where: { action: 'keyword_library.status' },
    orderBy: { createdAt: 'desc' },
  });
  assert.deepEqual(
    { ...(log2.detail as object) },
    { to: 'approved', count: 1, itemCode: 'A.4.e', terms: [`${PREFIX}审计00`] },
  );
});

test('列表：返回来源、修改人和时间、是否可改；默认不列已剔除的词', async () => {
  await cleanupKeywords();
  await mk('内置', { source: 'builtin:gbt45654' });
  await mk('导入', { source: 'import:csv', reviewStatus: 'pending' });
  await mk('每周', { source: 'auto:weekly', reviewStatus: 'pending' });
  await mk('剔除', { source: 'builtin:gbt45654', reviewStatus: 'rejected' });
  await mk('租户', { tenantId: tenant.id });
  const toDisable = await mk('停用', { source: 'import:txt' });
  await post(adminToken, { ids: [toDisable.id], to: 'disabled' });

  const url = `${BASE}?itemCode=${ITEM}&keyword=${encodeURIComponent(PREFIX)}&pageSize=200`;
  const admin = (await app.inject({ method: 'GET', url, headers: h(adminToken) })).json();
  const byName = (list: any) =>
    Object.fromEntries(list.items.map((i: any) => [i.term.slice(PREFIX.length), i]));
  const a = byName(admin);
  assert.deepEqual(
    Object.keys(a).sort(),
    ['停用', '内置', '导入', '每周'].sort(),
    '平台管理员看不到别的租户的词，也不列已剔除的词',
  );
  assert.equal(a['内置'].sourceLabel, '内置');
  assert.equal(a['导入'].sourceLabel, '导入');
  assert.equal(a['每周'].sourceLabel, '每周更新');
  assert.equal(a['内置'].reviewStatusLabel, '在用');
  assert.equal(a['导入'].reviewStatusLabel, '待确认');
  assert.equal(a['停用'].reviewStatusLabel, '停用');
  assert.equal(a['停用'].statusChangedBy, 'admin');
  assert.ok(a['停用'].statusChangedAt);
  assert.equal(a['内置'].statusChangedBy, null);
  assert.ok(Object.values(a).every((i: any) => i.editable === true));
  assert.equal(admin.editableTotal, 4);

  const rejected = (
    await app.inject({ method: 'GET', url: `${url}&reviewStatus=rejected`, headers: h(adminToken) })
  ).json();
  assert.equal(rejected.total, 1);
  assert.equal(rejected.items[0].reviewStatusLabel, '已剔除');
  assert.equal(rejected.items[0].editable, false);
  assert.equal(rejected.editableTotal, 0);

  const disabled = (
    await app.inject({ method: 'GET', url: `${url}&reviewStatus=disabled`, headers: h(adminToken) })
  ).json();
  assert.equal(disabled.total, 1);

  const t = byName((await app.inject({ method: 'GET', url, headers: h(tenant.token) })).json());
  assert.equal(t['租户'].editable, true);
  assert.equal(t['租户'].scope, '本租户');
  assert.equal(t['内置'].editable, false);
  assert.equal(t['导入'].editable, false);
  const tl = (await app.inject({ method: 'GET', url, headers: h(tenant.token) })).json();
  assert.equal(tl.editableTotal, 1);
});

test('覆盖统计：每个小项返回生效、候选、停用数，达标和总数只算生效的词', async () => {
  await cleanupKeywords();
  const cov = async () =>
    (await app.inject({ method: 'GET', url: `${BASE}/coverage`, headers: h(adminToken) })).json();
  const before = await cov();
  const row0 = before.rows.find((r: any) => r.key === ITEM);
  const s0 = before.byItemStatus[ITEM] ?? { approved: 0, pending: 0, disabled: 0 };
  assert.equal(row0.count, s0.approved, '小项数量只算生效');

  await mk('生效一');
  await mk('生效二');
  await mk('候选一', { reviewStatus: 'pending' });
  await mk('停用一', { reviewStatus: 'disabled' });
  await mk('剔除一', { reviewStatus: 'rejected' });
  const after = await cov();
  const s1 = after.byItemStatus[ITEM];
  assert.deepEqual(
    {
      approved: s1.approved - s0.approved,
      pending: s1.pending - s0.pending,
      disabled: s1.disabled - s0.disabled,
    },
    { approved: 2, pending: 1, disabled: 1 },
  );
  assert.equal(after.rows.find((r: any) => r.key === ITEM).count, row0.count + 2);
  assert.equal(after.total, before.total + 2);
  assert.equal(after.byStatus.disabled - (before.byStatus.disabled ?? 0), 1);
});

test('导入的词默认生效', async () => {
  await cleanupKeywords();
  const res = await app.inject({
    method: 'POST',
    url: `${BASE}/import`,
    headers: h(tenant.token),
    payload: {
      format: 'txt',
      filename: 'k.txt',
      itemCode: ITEM,
      content: `${PREFIX}导入甲\n${PREFIX}导入乙\n`,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().added, 2);
  const rows = await prisma.standardKeyword.findMany({
    where: { term: { startsWith: `${PREFIX}导入` } },
  });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.reviewStatus, 'approved');
    assert.equal(r.tenantId, tenant.id);
  }
});

test('导出 CSV：状态列用中文，默认不含已剔除的词', async () => {
  await cleanupKeywords();
  await mk('导出生效');
  await mk('导出候选', { reviewStatus: 'pending' });
  await mk('导出停用', { reviewStatus: 'disabled' });
  await mk('导出剔除', { reviewStatus: 'rejected' });
  const exp = await app.inject({
    method: 'GET',
    url: `${BASE}/export?itemCode=${ITEM}`,
    headers: h(adminToken),
  });
  assert.equal(exp.statusCode, 200);
  const rows = parseCsv(exp.body).filter((r) => r[1]?.startsWith(PREFIX));
  const status = Object.fromEntries(rows.map((r) => [r[1]!.slice(PREFIX.length), r[3]]));
  assert.deepEqual(status, { 导出生效: '在用', 导出候选: '待确认', 导出停用: '停用' });
});

test('语料违规检测只用生效的词：候选、停用、已剔除的都不用', async () => {
  await cleanupKeywords();
  await mk('扫描生效');
  await mk('扫描候选', { reviewStatus: 'pending' });
  await mk('扫描停用', { reviewStatus: 'disabled' });
  await mk('扫描剔除', { reviewStatus: 'rejected' });
  const terms = (await loadScanKeywords(null))
    .map((k) => k.term)
    .filter((t) => t.startsWith(PREFIX));
  assert.deepEqual(
    terms.map((t) => t.slice(PREFIX.length)),
    ['扫描生效'],
  );
});

test('导出再导入：带状态列时停用、已剔除的行不导入并单独计数，候选按候选导入，生效和空的按生效导入', async () => {
  await cleanupKeywords();
  const rows = [
    ['生效甲', '生效'],
    ['候选乙', '候选'],
    ['停用丙', '停用'],
    ['剔除丁', '已剔除'],
    ['停用戊', 'disabled'],
    ['剔除己', 'rejected'],
    ['候选庚', 'pending'],
    ['生效辛', 'approved'],
    ['空状态壬', ''],
  ];
  const content =
    'itemCode,term,source,reviewStatus\r\n' +
    rows.map(([t, st]) => `${ITEM},${PREFIX}${t},import:csv,${st}`).join('\r\n') +
    '\r\n';
  const res = await app.inject({
    method: 'POST',
    url: `${BASE}/import`,
    headers: h(tenant.token),
    payload: { format: 'csv', filename: 'roundtrip.csv', content },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().added, 5);
  assert.equal(res.json().skippedInactive, 4);
  assert.equal(res.json().failed, 0);
  const got = await prisma.standardKeyword.findMany({
    where: { tenantId: tenant.id, term: { startsWith: PREFIX } },
    select: { term: true, reviewStatus: true },
  });
  assert.deepEqual(
    Object.fromEntries(got.map((g) => [g.term.slice(PREFIX.length), g.reviewStatus])),
    {
      生效甲: 'approved',
      候选乙: 'pending',
      候选庚: 'pending',
      生效辛: 'approved',
      空状态壬: 'approved',
    },
  );

  const bad = await app.inject({
    method: 'POST',
    url: `${BASE}/import`,
    headers: h(tenant.token),
    payload: {
      format: 'csv',
      filename: 'bad.csv',
      content: `itemCode,term,reviewStatus\r\n${ITEM},${PREFIX}乱写状态,乱写\r\n`,
    },
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match(bad.json().issues[0].message, /状态「乱写」不认识/);
});

test('导出再导入：租户导出后导回，平台停用的词不会变成本租户生效词，已剔除的不在导出里', async () => {
  await cleanupKeywords();
  const dis = await mk('往返停用');
  await post(adminToken, { ids: [dis.id], to: 'disabled' });
  const rej = await mk('往返剔除', { reviewStatus: 'rejected' });
  const exp = await app.inject({
    method: 'GET',
    url: `${BASE}/export?itemCode=${ITEM}`,
    headers: h(tenant.token),
  });
  assert.equal(exp.statusCode, 200);
  const lines = exp.body.replace(/^\uFEFF/, '').split(/\r\n/);
  const mine = lines.filter((l) => l.includes(PREFIX));
  assert.equal(mine.length, 1, '已剔除的不导出');
  const imp = await app.inject({
    method: 'POST',
    url: `${BASE}/import`,
    headers: h(tenant.token),
    payload: {
      format: 'csv',
      filename: 'roundtrip.csv',
      content: [lines[0], ...mine].join('\r\n'),
    },
  });
  assert.equal(imp.statusCode, 400, '只有停用的行，没有可导入的词');
  assert.equal(
    await prisma.standardKeyword.count({
      where: { tenantId: tenant.id, term: { in: [dis.term, rej.term] } },
    }),
    0,
  );
});

test('全部租户视角：列表里的词一律不可改，别的租户的词不标「本租户」；写操作被拦', async () => {
  await cleanupKeywords();
  const p = await mk('全局平台词');
  const t = await mk('全局租户词', { tenantId: tenant.id });
  const all = { ...h(adminToken), 'x-lse-tenant': 'all' };
  const list = await app.inject({
    method: 'GET',
    url: `${BASE}?itemCode=${ITEM}&keyword=${encodeURIComponent(PREFIX)}`,
    headers: all,
  });
  assert.equal(list.statusCode, 200, list.body);
  const items = list.json().items as Array<{ id: string; editable: boolean; scope: string }>;
  assert.ok(items.every((i) => i.editable === false));
  assert.equal(items.find((i) => i.id === p.id)?.scope, '平台');
  assert.equal(items.find((i) => i.id === t.id)?.scope, '其他租户');
  assert.equal(list.json().editableTotal, 0);
  assert.equal(list.json().writesPlatform, false);
  const res = await app.inject({
    method: 'POST',
    url: `${BASE}/status`,
    headers: all,
    payload: { ids: [p.id], to: 'disabled' },
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(await statusOf(p.id), 'approved');
});

test('平台管理员进入租户：按小项只改该租户的词，平台词不动；列表标明写的不是平台词表', async () => {
  await cleanupKeywords();
  const p = await mk('进入平台词');
  const t = await mk('进入租户词', { tenantId: tenant.id });
  const hdr = { ...h(adminToken), 'x-lse-tenant': tenant.id };
  const r = await app.inject({
    method: 'POST',
    url: `${BASE}/status`,
    headers: hdr,
    payload: { itemCode: ITEM, fromStatus: 'approved', to: 'disabled' },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await statusOf(p.id), 'approved');
  assert.equal(await statusOf(t.id), 'disabled');
  const list = await app.inject({
    method: 'GET',
    url: `${BASE}?itemCode=${ITEM}&keyword=${encodeURIComponent(PREFIX)}`,
    headers: hdr,
  });
  assert.equal(list.json().writesPlatform, false);
  const own = await app.inject({
    method: 'GET',
    url: `${BASE}?itemCode=${ITEM}&keyword=${encodeURIComponent(PREFIX)}`,
    headers: h(adminToken),
  });
  assert.equal(own.json().writesPlatform, true);
});

test('租户看平台词：最后修改只给时间，不给平台账号的用户名；自己的词照常给', async () => {
  await cleanupKeywords();
  const p = await mk('平台改过');
  await post(adminToken, { ids: [p.id], to: 'disabled' });
  const t = await mk('租户改过', { tenantId: tenant.id });
  await post(tenant.token, { ids: [t.id], to: 'disabled' });
  const url = `${BASE}?itemCode=${ITEM}&keyword=${encodeURIComponent(PREFIX)}`;
  const byId = (body: any) => Object.fromEntries(body.items.map((i: any) => [i.id, i]));
  const tv = byId((await app.inject({ method: 'GET', url, headers: h(tenant.token) })).json());
  assert.equal(tv[p.id].statusChangedBy, null);
  assert.ok(tv[p.id].statusChangedAt);
  assert.equal(tv[t.id].statusChangedBy, tenant.username);
  const av = byId((await app.inject({ method: 'GET', url, headers: h(adminToken) })).json());
  assert.equal(av[p.id].statusChangedBy, 'admin');
});
