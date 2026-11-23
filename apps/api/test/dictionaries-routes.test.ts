import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

// 2.9.4 数据字典：类型与条目的增删改查、内置类型保护、读写权限、审计。

const P = 'w6t_';
const USER_PREFIX = '__w6_dict_';
const TENANT_NAME = 'W6字典测试租户';
const PASSWORD = ['Dict', 'Test', '12345'].join('@');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RISK_DEFAULTS: Record<string, { label: string; sort: number }> = {
  HIGH: { label: '高风险', sort: 1 },
  MEDIUM: { label: '中风险', sort: 2 },
  LOW: { label: '低风险', sort: 3 },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';
let readerToken = '';
let auditorToken = '';
let operatorToken = '';
let tenantAdminToken = '';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** 内置「风险等级」恢复成迁移预置的样子（测试会改它的名称、排序和启停）。 */
async function restoreRiskLevel(): Promise<void> {
  await prisma.dictType.update({
    where: { code: 'risk_level' },
    data: { name: '风险等级', description: null },
  });
  await prisma.dictItem.deleteMany({
    where: { type: { code: 'risk_level' }, value: { notIn: Object.keys(RISK_DEFAULTS) } },
  });
  for (const [value, d] of Object.entries(RISK_DEFAULTS)) {
    await prisma.dictItem.updateMany({
      where: { type: { code: 'risk_level' }, value },
      data: { label: d.label, sort: d.sort, enabled: true },
    });
  }
}

async function riskItems() {
  return prisma.dictItem.findMany({
    where: { type: { code: 'risk_level' } },
    orderBy: { sort: 'asc' },
  });
}

async function cleanup(): Promise<void> {
  await prisma.dictType.deleteMany({ where: { code: { startsWith: P } } });
  await prisma.auditLog.deleteMany({ where: { action: { startsWith: 'dictionary.' } } });
  const tenants = await prisma.tenant.findMany({
    where: { name: TENANT_NAME },
    select: { id: true },
  });
  const tenantIds = tenants.map((t) => t.id);
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.user.deleteMany({
    where: { OR: [{ username: { startsWith: USER_PREFIX } }, { tenantId: { in: tenantIds } }] },
  });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.rolePermission.deleteMany({
    where: { role: { name: { startsWith: USER_PREFIX } } },
  });
  await prisma.role.deleteMany({ where: { name: { startsWith: USER_PREFIX } } });
  await restoreRiskLevel();
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

async function createUser(username: string, roleName: string, permissionCodes?: string[]) {
  let roleId: string;
  if (permissionCodes) {
    const role = await prisma.role.create({
      data: { name: roleName, description: '数据字典测试', isBuiltin: false },
    });
    const perms = await prisma.permission.findMany({
      where: { code: { in: permissionCodes } },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
    });
    roleId = role.id;
  } else {
    roleId = (await prisma.role.findUniqueOrThrow({ where: { name: roleName } })).id;
  }
  await prisma.user.create({
    data: {
      username,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: username,
      isActive: true,
      roles: { create: { roleId } },
    },
  });
  return login(username, PASSWORD);
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  adminToken = await login('admin', ['Admin', '@', '12345'].join(''));
  readerToken = await createUser(`${USER_PREFIX}reader`, `${USER_PREFIX}reader`, [
    'system_setting:read',
  ]);
  auditorToken = await createUser(`${USER_PREFIX}auditor`, 'auditor');
  operatorToken = await createUser(`${USER_PREFIX}operator`, 'operator');
  const tenant = await app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: bearer(adminToken),
    payload: { name: TENANT_NAME, admin: { username: `${USER_PREFIX}tadmin`, password: PASSWORD } },
  });
  assert.equal(tenant.statusCode, 201, tenant.body);
  await skipFirstPasswordChange(`${USER_PREFIX}tadmin`);
  tenantAdminToken = await login(`${USER_PREFIX}tadmin`, PASSWORD);
});

after(async () => {
  await cleanup();
  await app.close();
});

async function createType(code: string, name = '测试类型') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/dictionaries',
    headers: bearer(adminToken),
    payload: { code, name, description: '用于测试' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; code: string; builtin: boolean };
}

async function createItem(code: string, payload: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/dictionaries/${code}/items`,
    headers: bearer(adminToken),
    payload,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; value: string; label: string; sort: number; enabled: boolean };
}

test('内置「风险等级」类型已预置，条目与现有风险等级一致', async () => {
  const list = await app.inject({ url: '/api/dictionaries', headers: bearer(adminToken) });
  assert.equal(list.statusCode, 200, list.body);
  const risk = list.json().items.find((t: { code: string }) => t.code === 'risk_level');
  assert.ok(risk, '缺少内置的风险等级类型');
  assert.equal(risk.builtin, true);
  assert.equal(risk.name, '风险等级');

  const items = await app.inject({
    url: '/api/dictionaries/risk_level/items',
    headers: bearer(adminToken),
  });
  assert.equal(items.statusCode, 200, items.body);
  assert.deepEqual(
    items.json().items.map((i: { value: string; label: string }) => [i.value, i.label]),
    [
      ['HIGH', '高风险'],
      ['MEDIUM', '中风险'],
      ['LOW', '低风险'],
    ],
  );
});

test('字典类型可以新建、查看、修改和删除，编码重复返回 409', async () => {
  const created = await createType(`${P}crud`, '工单分类');
  assert.equal(created.builtin, false);

  const dup = await app.inject({
    method: 'POST',
    url: '/api/dictionaries',
    headers: bearer(adminToken),
    payload: { code: `${P}crud`, name: '重复' },
  });
  assert.equal(dup.statusCode, 409, dup.body);

  const badCode = await app.inject({
    method: 'POST',
    url: '/api/dictionaries',
    headers: bearer(adminToken),
    payload: { code: 'Bad Code', name: '非法编码' },
  });
  assert.equal(badCode.statusCode, 400, badCode.body);

  const list = await app.inject({ url: '/api/dictionaries', headers: bearer(adminToken) });
  const row = list.json().items.find((t: { code: string }) => t.code === `${P}crud`);
  assert.equal(row.name, '工单分类');
  assert.equal(row.itemCount, 0);

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/dictionaries/${P}crud`,
    headers: bearer(adminToken),
    payload: { name: '工单类别', description: null },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().name, '工单类别');
  assert.equal(patched.json().description, null);

  await createItem(`${P}crud`, { value: 'a', label: '甲' });
  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/dictionaries/${P}crud`,
    headers: bearer(adminToken),
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(await prisma.dictType.count({ where: { code: `${P}crud` } }), 0);
  assert.equal(await prisma.dictItem.count({ where: { typeId: created.id } }), 0, '条目随类型删除');

  const gone = await app.inject({
    url: `/api/dictionaries/${P}crud`,
    headers: bearer(adminToken),
  });
  assert.equal(gone.statusCode, 404, gone.body);
});

test('内置类型不能删除，返回 400', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: '/api/dictionaries/risk_level',
    headers: bearer(adminToken),
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(await prisma.dictType.count({ where: { code: 'risk_level' } }), 1);
});

test('内置条目的 id 是 uuid，可以停用和整组排序', async () => {
  try {
    const type = await prisma.dictType.findUniqueOrThrow({ where: { code: 'risk_level' } });
    assert.match(type.id, UUID_RE);
    const [high, medium, low] = await riskItems();
    for (const i of [high!, medium!, low!]) assert.match(i.id, UUID_RE, i.value);

    const off = await app.inject({
      method: 'PATCH',
      url: `/api/dictionaries/risk_level/items/${high!.id}`,
      headers: bearer(adminToken),
      payload: { enabled: false },
    });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(off.json().enabled, false);

    const reorder = await app.inject({
      method: 'PUT',
      url: '/api/dictionaries/risk_level/items/order',
      headers: bearer(adminToken),
      payload: { ids: [low!.id, medium!.id, high!.id] },
    });
    assert.equal(reorder.statusCode, 200, reorder.body);
    assert.deepEqual(
      reorder.json().items.map((i: { value: string }) => i.value),
      ['LOW', 'MEDIUM', 'HIGH'],
    );
  } finally {
    await restoreRiskLevel();
  }
});

test('内置条目只能改名称、排序和启停，不能改取值、不能删除', async () => {
  try {
    const [high] = await riskItems();
    const url = `/api/dictionaries/risk_level/items/${high!.id}`;

    const allowed = await app.inject({
      method: 'PATCH',
      url,
      headers: bearer(adminToken),
      payload: { label: '高危', sort: 7, enabled: true },
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(allowed.json().label, '高危');
    assert.equal(allowed.json().sort, 7);

    const sameValue = await app.inject({
      method: 'PATCH',
      url,
      headers: bearer(adminToken),
      payload: { value: 'HIGH', label: '高风险' },
    });
    assert.equal(sameValue.statusCode, 200, '取值没变时照常保存：' + sameValue.body);

    const changeValue = await app.inject({
      method: 'PATCH',
      url,
      headers: bearer(adminToken),
      payload: { value: 'CRITICAL' },
    });
    assert.equal(changeValue.statusCode, 400, changeValue.body);
    assert.equal(changeValue.json().error.message, '内置条目不能修改取值');

    const removed = await app.inject({ method: 'DELETE', url, headers: bearer(adminToken) });
    assert.equal(removed.statusCode, 400, removed.body);
    assert.equal(removed.json().error.message, '内置条目不能删除');

    const row = await prisma.dictItem.findUniqueOrThrow({ where: { id: high!.id } });
    assert.equal(row.value, 'HIGH');

    // 新增的条目按上面的规则也删不掉，内置字典的取值集合固定。
    const added = await app.inject({
      method: 'POST',
      url: '/api/dictionaries/risk_level/items',
      headers: bearer(adminToken),
      payload: { value: 'CRITICAL', label: '严重' },
    });
    assert.equal(added.statusCode, 400, added.body);
    assert.equal(added.json().error.message, '内置字典不能新增条目');
    assert.equal((await riskItems()).length, 3);
  } finally {
    await restoreRiskLevel();
  }
});

test('内置类型不能改名称和编码，描述可以改', async () => {
  try {
    const rename = await app.inject({
      method: 'PATCH',
      url: '/api/dictionaries/risk_level',
      headers: bearer(adminToken),
      payload: { name: '风险级别' },
    });
    assert.equal(rename.statusCode, 400, rename.body);
    assert.equal(rename.json().error.message, '内置字典不能改名');

    const recode = await app.inject({
      method: 'PATCH',
      url: '/api/dictionaries/risk_level',
      headers: bearer(adminToken),
      payload: { code: 'risk', description: '改编码' },
    });
    assert.equal(recode.statusCode, 400, recode.body);
    assert.equal(recode.json().error.message, '字典编码不能修改');

    const withDescription = await app.inject({
      method: 'PATCH',
      url: '/api/dictionaries/risk_level',
      headers: bearer(adminToken),
      payload: { name: '风险等级', description: '平台内置' },
    });
    assert.equal(withDescription.statusCode, 200, withDescription.body);
    assert.equal(withDescription.json().description, '平台内置');

    const row = await prisma.dictType.findUniqueOrThrow({ where: { code: 'risk_level' } });
    assert.equal(row.name, '风险等级');
  } finally {
    await restoreRiskLevel();
  }
});

test('PATCH 空 body 返回 400，不刷新 updatedAt、不写审计', async () => {
  const type = await createType(`${P}empty`);
  const item = await createItem(`${P}empty`, { value: 'v', label: '值' });
  const before = {
    type: (await prisma.dictType.findUniqueOrThrow({ where: { id: type.id } })).updatedAt,
    item: (await prisma.dictItem.findUniqueOrThrow({ where: { id: item.id } })).updatedAt,
  };
  for (const url of [
    `/api/dictionaries/${P}empty`,
    `/api/dictionaries/${P}empty/items/${item.id}`,
  ]) {
    const res = await app.inject({
      method: 'PATCH',
      url,
      headers: bearer(adminToken),
      payload: {},
    });
    assert.equal(res.statusCode, 400, `${url}: ${res.body}`);
    assert.equal(res.json().error.message, '没有要修改的内容');
  }
  const after = {
    type: (await prisma.dictType.findUniqueOrThrow({ where: { id: type.id } })).updatedAt,
    item: (await prisma.dictItem.findUniqueOrThrow({ where: { id: item.id } })).updatedAt,
  };
  assert.deepEqual(after, before);
  assert.equal(
    await prisma.auditLog.count({
      where: {
        action: { in: ['dictionary.type_update', 'dictionary.item_update'] },
        targetId: { in: [type.id, item.id] },
      },
    }),
    0,
  );
});

test('description 传空字符串存成 null', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/dictionaries',
    headers: bearer(adminToken),
    payload: { code: `${P}blank`, name: '空描述', description: '' },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().description, null);

  const filled = await app.inject({
    method: 'PATCH',
    url: `/api/dictionaries/${P}blank`,
    headers: bearer(adminToken),
    payload: { description: '有描述' },
  });
  assert.equal(filled.json().description, '有描述');

  const cleared = await app.inject({
    method: 'PATCH',
    url: `/api/dictionaries/${P}blank`,
    headers: bearer(adminToken),
    payload: { description: '  ' },
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().description, null);
  const row = await prisma.dictType.findUniqueOrThrow({ where: { code: `${P}blank` } });
  assert.equal(row.description, null);
});

test('字典条目可以增删改、启停和排序；同一类型内值重复返回 409', async () => {
  await createType(`${P}items`);
  const a = await createItem(`${P}items`, { value: 'a', label: '甲' });
  const b = await createItem(`${P}items`, { value: 'b', label: '乙' });
  const c = await createItem(`${P}items`, { value: 'c', label: '丙' });
  assert.ok(a.sort < b.sort && b.sort < c.sort, '新条目默认排在最后');
  assert.equal(a.enabled, true);

  const dup = await app.inject({
    method: 'POST',
    url: `/api/dictionaries/${P}items/items`,
    headers: bearer(adminToken),
    payload: { value: 'a', label: '重复' },
  });
  assert.equal(dup.statusCode, 409, dup.body);

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/dictionaries/${P}items/items/${b.id}`,
    headers: bearer(adminToken),
    payload: { label: '乙（改）', enabled: false },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().label, '乙（改）');
  assert.equal(patched.json().enabled, false);

  const reorder = await app.inject({
    method: 'PUT',
    url: `/api/dictionaries/${P}items/items/order`,
    headers: bearer(adminToken),
    payload: { ids: [c.id, b.id, a.id] },
  });
  assert.equal(reorder.statusCode, 200, reorder.body);

  const detail = await app.inject({
    url: `/api/dictionaries/${P}items`,
    headers: bearer(adminToken),
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(
    detail.json().items.map((i: { value: string; enabled: boolean }) => [i.value, i.enabled]),
    [
      ['c', true],
      ['b', false],
      ['a', true],
    ],
    '管理视图返回全部条目，按排序',
  );

  const badOrder = await app.inject({
    method: 'PUT',
    url: `/api/dictionaries/${P}items/items/order`,
    headers: bearer(adminToken),
    payload: { ids: [c.id, a.id] },
  });
  assert.equal(badOrder.statusCode, 400, badOrder.body);

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/dictionaries/${P}items/items/${c.id}`,
    headers: bearer(adminToken),
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(await prisma.dictItem.count({ where: { id: c.id } }), 0);
});

test('GET /:code/items 只返回启用的条目，按 sort 排序', async () => {
  await createType(`${P}enabled`);
  await createItem(`${P}enabled`, { value: 'z', label: '末', sort: 30 });
  await createItem(`${P}enabled`, { value: 'x', label: '首', sort: 10 });
  await createItem(`${P}enabled`, { value: 'y', label: '停用', sort: 20, enabled: false });

  const res = await app.inject({
    url: `/api/dictionaries/${P}enabled/items`,
    headers: bearer(readerToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    res.json().items.map((i: { value: string }) => i.value),
    ['x', 'z'],
  );

  const missing = await app.inject({
    url: `/api/dictionaries/${P}nope/items`,
    headers: bearer(readerToken),
  });
  assert.equal(missing.statusCode, 404, missing.body);
});

test('管理接口要 system_setting:read；业务取数接口登录即可读', async () => {
  for (const url of ['/api/dictionaries', '/api/dictionaries/risk_level']) {
    const noRead = await app.inject({ url, headers: bearer(auditorToken) });
    assert.equal(noRead.statusCode, 403, `${url}: ${noRead.body}`);
    const read = await app.inject({ url, headers: bearer(readerToken) });
    assert.equal(read.statusCode, 200, `${url}: ${read.body}`);
  }

  await createType(`${P}public`);
  await createItem(`${P}public`, { value: 'on', label: '启用' });
  await createItem(`${P}public`, { value: 'off', label: '停用', enabled: false });
  for (const token of [operatorToken, auditorToken]) {
    const res = await app.inject({
      url: `/api/dictionaries/${P}public/items`,
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(
      res.json().items.map((i: { value: string }) => i.value),
      ['on'],
    );
  }
  const anonymous = await app.inject({ url: `/api/dictionaries/${P}public/items` });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
});

test('字典的 7 个写接口：没有 system_setting:update（含租户管理员）都返回 403', async () => {
  await createType(`${P}deny`, '拒绝');
  const item = await createItem(`${P}deny`, { value: 'v', label: '值' });
  const base = `/api/dictionaries/${P}deny`;
  const writes = [
    {
      method: 'POST' as const,
      url: '/api/dictionaries',
      payload: { code: `${P}deny2`, name: '新' },
    },
    { method: 'PATCH' as const, url: base, payload: { name: '改名' } },
    { method: 'DELETE' as const, url: base },
    { method: 'POST' as const, url: `${base}/items`, payload: { value: 'x', label: '新' } },
    { method: 'PUT' as const, url: `${base}/items/order`, payload: { ids: [item.id] } },
    { method: 'PATCH' as const, url: `${base}/items/${item.id}`, payload: { label: '改名' } },
    { method: 'DELETE' as const, url: `${base}/items/${item.id}` },
  ];
  for (const [who, token] of [
    ['只读用户', readerToken],
    ['租户管理员', tenantAdminToken],
  ] as const) {
    for (const w of writes) {
      const res = await app.inject({ ...w, headers: bearer(token) });
      assert.equal(res.statusCode, 403, `${who} ${w.method} ${w.url}: ${res.body}`);
    }
  }
  assert.equal(await prisma.dictType.count({ where: { code: `${P}deny2` } }), 0);
  const type = await prisma.dictType.findUniqueOrThrow({
    where: { code: `${P}deny` },
    include: { items: true },
  });
  assert.equal(type.name, '拒绝');
  assert.deepEqual(
    type.items.map((i) => [i.value, i.label]),
    [['v', '值']],
  );
});

test('字典的写操作都记审计', async () => {
  await prisma.auditLog.deleteMany({ where: { action: { startsWith: 'dictionary.' } } });
  const type = await createType(`${P}audit`);
  const item = await createItem(`${P}audit`, { value: 'v', label: '值' });
  const ops = [
    { method: 'PATCH' as const, url: `/api/dictionaries/${P}audit`, payload: { name: '审计类型' } },
    {
      method: 'PATCH' as const,
      url: `/api/dictionaries/${P}audit/items/${item.id}`,
      payload: { enabled: false },
    },
    {
      method: 'PUT' as const,
      url: `/api/dictionaries/${P}audit/items/order`,
      payload: { ids: [item.id] },
    },
    { method: 'DELETE' as const, url: `/api/dictionaries/${P}audit/items/${item.id}` },
    { method: 'DELETE' as const, url: `/api/dictionaries/${P}audit` },
  ];
  for (const op of ops) {
    const res = await app.inject({ ...op, headers: bearer(adminToken) });
    assert.equal(res.statusCode, 200, `${op.method} ${op.url}: ${res.body}`);
  }
  const logs = await prisma.auditLog.findMany({
    where: { action: { startsWith: 'dictionary.' } },
    orderBy: { createdAt: 'asc' },
  });
  assert.deepEqual(
    logs.map((l) => l.action),
    [
      'dictionary.type_create',
      'dictionary.item_create',
      'dictionary.type_update',
      'dictionary.item_update',
      'dictionary.item_reorder',
      'dictionary.item_delete',
      'dictionary.type_delete',
    ],
  );
  assert.equal(logs[0]!.targetType, 'dict_type');
  assert.equal(logs[0]!.targetId, type.id);
  assert.equal(logs[1]!.targetType, 'dict_item');
  assert.equal(logs[1]!.targetId, item.id);
  assert.equal(logs[0]!.actorName, 'admin');
});
