import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import ExcelJS from 'exceljs';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';

// 1.2.3 用户自定义外置规则库：规则集、规则增删改查、CSV/xlsx/txt 导入、启停；
// 正则防灾难性回溯；租户隔离；只有 corpus_rule:manage 能改；写审计。

const P = '__p2g_rule_';
const TENANT_NAME = 'P2G语料规则测试租户';
const PASSWORD = ['Corpus', 'Rule', '12345'].join('@');

let app: Awaited<ReturnType<typeof buildApp>>;
const tokens = { admin: '', operator: '', auditor: '', tenantAdmin: '' };

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function cleanup(): Promise<void> {
  await prismaUnscoped.corpusRuleSet.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.auditLog.deleteMany({ where: { action: { startsWith: 'corpus_rule.' } } });
  const tenants = await prismaUnscoped.tenant.findMany({
    where: { name: TENANT_NAME },
    select: { id: true },
  });
  const tenantIds = tenants.map((t) => t.id);
  await prismaUnscoped.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prismaUnscoped.user.deleteMany({
    where: { OR: [{ username: { startsWith: P } }, { tenantId: { in: tenantIds } }] },
  });
  await prismaUnscoped.tenant.deleteMany({ where: { id: { in: tenantIds } } });
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

async function createUser(username: string, roleName: string): Promise<string> {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.user.create({
    data: {
      username,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: username,
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  return login(username, PASSWORD);
}

async function createSet(token: string, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/corpus-rules/sets',
    headers: bearer(token),
    payload: { name: P + name },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; name: string };
}

async function importRules(token: string, setId: string, query: string, body: string | Buffer) {
  return app.inject({
    method: 'POST',
    url: `/api/corpus-rules/sets/${setId}/import?${query}`,
    headers: { ...bearer(token), 'content-type': 'application/octet-stream' },
    payload: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  tokens.admin = await login('admin', ['Admin', '@', '12345'].join(''));
  tokens.operator = await createUser(`${P}op`, 'operator');
  tokens.auditor = await createUser(`${P}au`, 'auditor');
  const tenant = await app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: bearer(tokens.admin),
    payload: { name: TENANT_NAME, admin: { username: `${P}tadmin`, password: PASSWORD } },
  });
  assert.equal(tenant.statusCode, 201, tenant.body);
  await skipFirstPasswordChange(`${P}tadmin`);
  tokens.tenantAdmin = await login(`${P}tadmin`, PASSWORD);
});

after(async () => {
  await cleanup();
  await app.close();
});

test('建规则集、加关键词和正则规则，列表带规则数；写审计', async () => {
  const set = await createSet(tokens.admin, '基础');
  const kw = await app.inject({
    method: 'POST',
    url: `/api/corpus-rules/sets/${set.id}/rules`,
    headers: bearer(tokens.admin),
    payload: { kind: 'keyword', pattern: '内部资料', category: '涉密', severity: 'HIGH' },
  });
  assert.equal(kw.statusCode, 201, kw.body);
  assert.equal(kw.json().enabled, true);
  const re = await app.inject({
    method: 'POST',
    url: `/api/corpus-rules/sets/${set.id}/rules`,
    headers: bearer(tokens.admin),
    payload: { kind: 'regex', pattern: 'PRJ-\\d{3}', category: '项目代号' },
  });
  assert.equal(re.statusCode, 201, re.body);
  assert.equal(re.json().severity, 'MEDIUM');

  const dup = await app.inject({
    method: 'POST',
    url: `/api/corpus-rules/sets/${set.id}/rules`,
    headers: bearer(tokens.admin),
    payload: { kind: 'keyword', pattern: '内部资料', category: '别的' },
  });
  assert.equal(dup.statusCode, 409, dup.body);

  const list = await app.inject({ url: '/api/corpus-rules/sets', headers: bearer(tokens.admin) });
  assert.equal(list.statusCode, 200, list.body);
  const row = list.json().items.find((s: { id: string }) => s.id === set.id);
  assert.equal(row.ruleCount, 2);
  assert.equal(row.enabledCount, 2);

  const rules = await app.inject({
    url: `/api/corpus-rules/sets/${set.id}/rules?kind=regex`,
    headers: bearer(tokens.admin),
  });
  assert.equal(rules.json().total, 1);
  assert.equal(rules.json().items[0].pattern, 'PRJ-\\d{3}');

  const actions = (
    await prismaUnscoped.auditLog.findMany({
      where: { action: { startsWith: 'corpus_rule.' } },
      select: { action: true },
    })
  ).map((a) => a.action);
  assert.ok(actions.includes('corpus_rule.create_set'));
  assert.equal(actions.filter((a) => a === 'corpus_rule.create').length, 2);
});

test('灾难性正则和语法错误的正则 400，改成坏正则也 400', async () => {
  const set = await createSet(tokens.admin, '正则');
  for (const pattern of ['(a+)+$', '(\\d*)*', '([', 'x'.repeat(501)]) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/corpus-rules/sets/${set.id}/rules`,
      headers: bearer(tokens.admin),
      payload: { kind: 'regex', pattern, category: '坏' },
    });
    assert.equal(res.statusCode, 400, `${pattern} → ${res.body}`);
    assert.equal(res.json().error.code, 'CORPUS_RULE_INVALID');
  }
  const ok = await app.inject({
    method: 'POST',
    url: `/api/corpus-rules/sets/${set.id}/rules`,
    headers: bearer(tokens.admin),
    payload: { kind: 'regex', pattern: 'abc\\d+', category: '好' },
  });
  assert.equal(ok.statusCode, 201, ok.body);
  const bad = await app.inject({
    method: 'PATCH',
    url: `/api/corpus-rules/rules/${ok.json().id}`,
    headers: bearer(tokens.admin),
    payload: { pattern: '(a|b+)*c' },
  });
  assert.equal(bad.statusCode, 400, bad.body);
});

test('导入 CSV：有效行入库、坏行带行号、重复的计数；写审计', async () => {
  const set = await createSet(tokens.admin, '导入CSV');
  const csv = [
    '类型,内容,类别,严重度,启用',
    '关键词,工资表,人事,高,是',
    '正则,EMP\\d{6},工号,中,否',
    '正则,(a+)+$,坏,低,是',
  ].join('\r\n');
  const res = await importRules(tokens.admin, set.id, 'format=csv', '﻿' + csv);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.totalRows, 3);
  assert.equal(body.added, 2);
  assert.equal(body.failed, 1);
  assert.equal(body.issues[0].row, 4);

  // 再导一次：已经有的算重复
  const again = await importRules(tokens.admin, set.id, 'format=csv', csv);
  assert.equal(again.json().added, 0);
  assert.equal(again.json().duplicates, 2);

  const rules = await prisma.corpusRule.findMany({
    where: { ruleSetId: set.id },
    orderBy: { pattern: 'asc' },
  });
  assert.deepEqual(
    rules.map((r) => [r.kind, r.pattern, r.category, r.severity, r.enabled]),
    [
      ['regex', 'EMP\\d{6}', '工号', 'MEDIUM', false],
      ['keyword', '工资表', '人事', 'HIGH', true],
    ],
  );
  const audit = await prismaUnscoped.auditLog.findFirst({
    where: { action: 'corpus_rule.import', targetId: set.id },
  });
  assert.ok(audit, '导入要写审计');
});

test('导入 txt 和 xlsx：txt 每行一个关键词，用指定的类别和严重度', async () => {
  const set = await createSet(tokens.admin, '导入TXT');
  const txt = await importRules(
    tokens.admin,
    set.id,
    `format=txt&category=${encodeURIComponent('内部')}&severity=LOW`,
    '机密名单\n\n客户清单\n机密名单\n',
  );
  assert.equal(txt.statusCode, 200, txt.body);
  assert.equal(txt.json().added, 2);
  assert.equal(txt.json().duplicates, 1);
  const rows = await prisma.corpusRule.findMany({ where: { ruleSetId: set.id } });
  assert.ok(
    rows.every((r) => r.kind === 'keyword' && r.category === '内部' && r.severity === 'LOW'),
  );

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('规则');
  ws.addRow(['类型', '内容', '类别', '严重度']);
  ws.addRow(['关键词', '薪酬方案', '人事', '高']);
  ws.addRow(['正则', 'HR-\\d{4}', '人事编号', '低']);
  const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
  const res = await importRules(tokens.admin, set.id, 'format=xlsx', xlsx);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().added, 2);
});

test('启停：停用后规则标记为停用，列表的启用数跟着变', async () => {
  const set = await createSet(tokens.admin, '启停');
  const rule = await app.inject({
    method: 'POST',
    url: `/api/corpus-rules/sets/${set.id}/rules`,
    headers: bearer(tokens.admin),
    payload: { kind: 'keyword', pattern: '停用词', category: '测试' },
  });
  const off = await app.inject({
    method: 'PATCH',
    url: `/api/corpus-rules/rules/${rule.json().id}`,
    headers: bearer(tokens.admin),
    payload: { enabled: false },
  });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().enabled, false);
  const list = await app.inject({ url: '/api/corpus-rules/sets', headers: bearer(tokens.admin) });
  const row = list.json().items.find((s: { id: string }) => s.id === set.id);
  assert.equal(row.ruleCount, 1);
  assert.equal(row.enabledCount, 0);

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/corpus-rules/sets/${set.id}`,
    headers: bearer(tokens.admin),
  });
  assert.equal(del.statusCode, 200, del.body);
  assert.equal(await prisma.corpusRule.count({ where: { ruleSetId: set.id } }), 0);
});

test('operator、auditor 只能看不能改：改规则 403', async () => {
  const set = await createSet(tokens.admin, '权限');
  const rule = await app.inject({
    method: 'POST',
    url: `/api/corpus-rules/sets/${set.id}/rules`,
    headers: bearer(tokens.admin),
    payload: { kind: 'keyword', pattern: '权限词', category: '测试' },
  });
  for (const token of [tokens.operator, tokens.auditor]) {
    const list = await app.inject({ url: '/api/corpus-rules/sets', headers: bearer(token) });
    assert.equal(list.statusCode, 200, list.body);
    const rules = await app.inject({
      url: `/api/corpus-rules/sets/${set.id}/rules`,
      headers: bearer(token),
    });
    assert.equal(rules.statusCode, 200, rules.body);
    const attempts = [
      { method: 'POST' as const, url: '/api/corpus-rules/sets', payload: { name: `${P}越权` } },
      {
        method: 'PATCH' as const,
        url: `/api/corpus-rules/rules/${rule.json().id}`,
        payload: { enabled: false },
      },
      { method: 'DELETE' as const, url: `/api/corpus-rules/rules/${rule.json().id}` },
      {
        method: 'POST' as const,
        url: `/api/corpus-rules/sets/${set.id}/rules`,
        payload: { kind: 'keyword', pattern: 'x', category: 'y' },
      },
    ];
    for (const a of attempts) {
      const res = await app.inject({ ...a, headers: bearer(token) });
      assert.equal(res.statusCode, 403, `${a.method} ${a.url} → ${res.statusCode}`);
    }
    const imp = await importRules(token, set.id, 'format=txt&category=x', 'abc');
    assert.equal(imp.statusCode, 403);
  }
  assert.equal(
    (await prisma.corpusRule.findUniqueOrThrow({ where: { id: rule.json().id } })).enabled,
    true,
  );
});

test('别的租户看不到、改不了', async () => {
  const set = await createSet(tokens.admin, '平台租户的');
  const rule = await app.inject({
    method: 'POST',
    url: `/api/corpus-rules/sets/${set.id}/rules`,
    headers: bearer(tokens.admin),
    payload: { kind: 'keyword', pattern: '隔离词', category: '测试' },
  });
  const t = tokens.tenantAdmin;
  const list = await app.inject({ url: '/api/corpus-rules/sets', headers: bearer(t) });
  assert.equal(list.statusCode, 200, list.body);
  assert.ok(!list.json().items.some((s: { id: string }) => s.id === set.id));
  assert.equal(
    (await app.inject({ url: `/api/corpus-rules/sets/${set.id}/rules`, headers: bearer(t) }))
      .statusCode,
    404,
  );
  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/corpus-rules/rules/${rule.json().id}`,
    headers: bearer(t),
    payload: { enabled: false },
  });
  assert.equal(patch.statusCode, 404);
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/corpus-rules/sets/${set.id}`,
        headers: bearer(t),
      })
    ).statusCode,
    404,
  );
  assert.equal((await importRules(t, set.id, 'format=txt&category=x', 'abc')).statusCode, 404);

  // 租户自己的规则集同名也可以建，平台租户看不到
  const own = await createSet(t, '平台租户的');
  const adminList = await app.inject({
    url: '/api/corpus-rules/sets',
    headers: bearer(tokens.admin),
  });
  assert.ok(!adminList.json().items.some((s: { id: string }) => s.id === own.id));
  assert.equal(
    (await prisma.corpusRule.findUniqueOrThrow({ where: { id: rule.json().id } })).enabled,
    true,
  );
});

test('正则规则一个规则集最多 500 条：新增、改成正则、导入都挡住，关键词不受影响', async () => {
  const set = await createSet(tokens.admin, '正则上限');
  await prisma.corpusRule.createMany({
    data: Array.from({ length: 500 }, (_, i) => ({
      ruleSetId: set.id,
      kind: 'regex',
      pattern: `R${i}-\\d{3}`,
      category: '上限',
      severity: 'LOW',
    })),
  });
  const add = (body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/corpus-rules/sets/${set.id}/rules`,
      headers: bearer(tokens.admin),
      payload: { category: '上限', ...body },
    });
  const over = await add({ kind: 'regex', pattern: 'OVER-\\d{3}' });
  assert.equal(over.statusCode, 400, over.body);
  assert.equal(over.json().error.code, 'CORPUS_REGEX_RULES_FULL');
  const kw = await add({ kind: 'keyword', pattern: '还能加关键词' });
  assert.equal(kw.statusCode, 201, kw.body);
  const toRegex = await app.inject({
    method: 'PATCH',
    url: `/api/corpus-rules/rules/${kw.json().id}`,
    headers: bearer(tokens.admin),
    payload: { kind: 'regex', pattern: 'KW-\\d{3}' },
  });
  assert.equal(toRegex.statusCode, 400, toRegex.body);
  const imported = await importRules(
    tokens.admin,
    set.id,
    'format=csv',
    '类型,内容\n正则,IMP-\\d{3}\n关键词,导入的关键词\n',
  );
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(imported.json().added, 1);
  assert.equal(imported.json().failed, 1);
  assert.ok(
    imported.json().issues.some((i: { message: string }) => i.message.includes('正则规则上限 500')),
  );
  assert.equal(await prisma.corpusRule.count({ where: { ruleSetId: set.id, kind: 'regex' } }), 500);
});
