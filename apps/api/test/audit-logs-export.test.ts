import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { invalidateSecurityPolicyCache } from '../src/lib/security-policy.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import * as auditLogModule from '../src/modules/audit-logs/routes.js';

// 2.9.6 审计日志导出与查看范围。

const P = 'w2auditexp_';
const PW = ['Audit', 'Export', '@', '2026'].join(''); // pragma: allowlist secret
const ACTION = `${P}action`;
const BIG_ACTION = `${P}big`;
const BATCH_ACTION = `${P}batch`;
const TENANT_COL_ACTION = `${P}tenantcol`;

let app!: FastifyInstance;
let adminJwt = '';
let auditorJwt = '';
let tenantAdminJwt = '';
let operatorJwt = '';
let tenantId = '';
let savedSecurity: unknown = undefined;

const h = (jwt: string, tenant?: string) => ({
  authorization: `Bearer ${jwt}`,
  ...(tenant ? { 'x-lse-tenant': tenant } : {}),
});

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token;
}

async function createUser(username: string, roleName: string, tenantId?: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.user.create({
    data: {
      username,
      displayName: username,
      passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
      ...(tenantId ? { tenantId } : {}),
      roles: { create: { roleId: role.id } },
    },
  });
}

async function cleanup(): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { action: { startsWith: P } },
        { actorName: { startsWith: P } },
        { action: 'audit_log.export', actorName: { in: ['admin'] } },
      ],
    },
  });
  await prisma.user.deleteMany({ where: { username: { startsWith: P } } });
  await prisma.tenant.deleteMany({ where: { name: { startsWith: P } } });
}

async function setAuditLogAccess(value: string) {
  return app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: h(adminJwt),
    payload: { security: { auditLogAccess: value } },
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  savedSecurity = (await prisma.systemSetting.findUnique({ where: { key: 'security' } }))?.value;
  await prisma.systemSetting.deleteMany({ where: { key: 'security' } });
  invalidateSecurityPolicyCache();

  const tenant = await prisma.tenant.create({ data: { name: `${P}租户`, code: `${P}t` } });
  tenantId = tenant.id;
  await createUser(`${P}auditor`, 'auditor');
  await createUser(`${P}operator`, 'operator');
  await createUser(`${P}tadmin`, 'tenant_admin', tenant.id);

  adminJwt = await login('admin', ['Admin', '@', '12345'].join(''));
  auditorJwt = await login(`${P}auditor`, PW);
  operatorJwt = await login(`${P}operator`, PW);
  tenantAdminJwt = await login(`${P}tadmin`, PW);

  await prisma.auditLog.createMany({
    data: [
      {
        action: ACTION,
        actorName: `${P}alice`,
        targetType: 'role',
        targetId: 'r-1',
        ip: '10.0.0.1',
        detail: { name: '安全分析员, "甲"' },
        createdAt: new Date('2026-11-10T02:00:00.000Z'),
      },
      {
        action: ACTION,
        actorName: `${P}bob`,
        targetType: 'user',
        targetId: 'u-1',
        ip: '10.0.0.2',
        detail: { note: '=cmd|calc' },
        createdAt: new Date('2026-11-12T02:00:00.000Z'),
      },
    ],
  });
});

after(async () => {
  await cleanup();
  if (savedSecurity === undefined) {
    await prisma.systemSetting.deleteMany({ where: { key: 'security' } });
  } else {
    await prisma.systemSetting.upsert({
      where: { key: 'security' },
      update: { value: savedSecurity as object },
      create: { key: 'security', value: savedSecurity as object },
    });
  }
  invalidateSecurityPolicyCache();
  await app.close();
  await prisma.$disconnect();
});

function parseCsv(body: string): string[] {
  return body
    .replace(/^\ufeff/, '')
    .split('\r\n')
    .filter(Boolean);
}

test('导出 CSV：UTF-8 带 BOM，列为时间、操作人、动作、对象类型、对象、IP、详情', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/audit-logs/export?format=csv&action=${encodeURIComponent(ACTION)}`,
    headers: h(auditorJwt),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['content-type']), /^text\/csv; charset=utf-8/);
  assert.match(String(res.headers['content-disposition']), /^attachment;/);
  assert.ok(res.body.startsWith('\ufeff'), '缺 BOM');
  const lines = parseCsv(res.body);
  assert.equal(lines[0], '时间,操作人,动作,对象类型,对象,IP,详情');
  assert.equal(lines.length, 3);
  // 新的在前；时间按东八区显示
  assert.ok(lines[1]!.startsWith(`2026-11-12 10:00:00,${P}bob,${ACTION},user,u-1,10.0.0.2,`));
  assert.ok(lines[2]!.startsWith(`2026-11-10 10:00:00,${P}alice,${ACTION},role,r-1,10.0.0.1,`));
  // 详情含逗号和引号时整格加引号转义
  assert.ok(lines[2]!.includes('"{""name"":""安全分析员, \\""甲\\""""}"'), lines[2]);
});

test('导出 CSV 防公式注入：以 = 开头的单元格前置单引号', async () => {
  await prisma.auditLog.create({
    data: { action: ACTION, actorName: `=${P}evil`, targetType: 'user' },
  });
  const res = await app.inject({
    method: 'GET',
    url: `/api/audit-logs/export?format=csv&actorName=${encodeURIComponent(`=${P}evil`)}`,
    headers: h(auditorJwt),
  });
  assert.equal(res.statusCode, 200, res.body);
  const lines = parseCsv(res.body);
  assert.equal(lines.length, 2);
  assert.ok(lines[1]!.includes(`,'=${P}evil,`), lines[1]);
  await prisma.auditLog.deleteMany({ where: { actorName: `=${P}evil` } });
});

test('导出 JSON：与列表相同的筛选条件', async () => {
  const res = await app.inject({
    method: 'GET',
    url:
      `/api/audit-logs/export?format=json&action=${encodeURIComponent(ACTION)}` +
      `&targetType=role&start=${encodeURIComponent('2026-11-09T00:00:00.000Z')}` +
      `&end=${encodeURIComponent('2026-11-11T00:00:00.000Z')}`,
    headers: h(auditorJwt),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['content-type']), /^application\/json/);
  assert.match(String(res.headers['content-disposition']), /^attachment;/);
  const items = res.json() as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.actorName, `${P}alice`);
  assert.equal(items[0]!.targetId, 'r-1');
  assert.deepEqual(items[0]!.detail, { name: '安全分析员, "甲"' });
});

test('导出操作本身记审计 audit_log.export', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/audit-logs/export?format=json&actorName=${encodeURIComponent(`${P}bob`)}`,
    headers: h(auditorJwt),
  });
  assert.equal(res.statusCode, 200, res.body);
  const log = await prisma.auditLog.findFirst({
    where: { action: 'audit_log.export', actorName: `${P}auditor` },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(log, '没有记导出审计');
  assert.equal(log.targetType, 'audit_log');
  const detail = log.detail as Record<string, unknown>;
  assert.equal(detail.format, 'json');
  assert.equal(detail.count, 1);
});

test('没有 audit_log:read 不能导出', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/audit-logs/export?format=csv',
    headers: h(operatorJwt),
  });
  assert.equal(res.statusCode, 403, res.body);
});

test('格式非法返回 400', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/audit-logs/export?format=xlsx',
    headers: h(auditorJwt),
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('超过 50000 行返回 400，提示缩小范围', async () => {
  const rows = Array.from({ length: 50_001 }, () => ({ action: BIG_ACTION, actorName: `${P}big` }));
  for (let i = 0; i < rows.length; i += 5000) {
    await prisma.auditLog.createMany({ data: rows.slice(i, i + 5000) });
  }
  const res = await app.inject({
    method: 'GET',
    url: `/api/audit-logs/export?format=csv&action=${encodeURIComponent(BIG_ACTION)}`,
    headers: h(auditorJwt),
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error.message, /请缩小范围/);
  await prisma.auditLog.deleteMany({ where: { action: BIG_ACTION } });
});

test('安全策略默认的查看范围是管理员和审计员', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/system-settings',
    headers: h(adminJwt),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().security.auditLogAccess, 'admins_and_auditors');
  for (const jwt of [auditorJwt, tenantAdminJwt]) {
    const list = await app.inject({ method: 'GET', url: '/api/audit-logs', headers: h(jwt) });
    assert.equal(list.statusCode, 200, list.body);
  }
});

test('查看范围取值非法返回 400', async () => {
  const res = await setAuditLogAccess('everyone');
  assert.equal(res.statusCode, 400, res.body);
});

test('仅平台管理员时，审计员和租户管理员不能查看、检索、导出', async () => {
  const id = (await prisma.auditLog.findFirstOrThrow({ where: { action: ACTION } })).id;
  const saved = await setAuditLogAccess('system_admin_only');
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().security.auditLogAccess, 'system_admin_only');
  try {
    const urls = [
      '/api/audit-logs',
      `/api/audit-logs?action=${encodeURIComponent(ACTION)}`,
      `/api/audit-logs/${id}`,
      '/api/audit-logs/export?format=csv',
    ];
    for (const jwt of [auditorJwt, tenantAdminJwt]) {
      for (const url of urls) {
        const res = await app.inject({ method: 'GET', url, headers: h(jwt) });
        assert.equal(res.statusCode, 403, `${url} ${res.body}`);
      }
    }
    for (const url of urls) {
      const res = await app.inject({ method: 'GET', url, headers: h(adminJwt) });
      assert.equal(res.statusCode, 200, `${url} ${res.body}`);
    }
  } finally {
    const back = await setAuditLogAccess('admins_and_auditors');
    assert.equal(back.statusCode, 200, back.body);
  }
  const again = await app.inject({ method: 'GET', url: '/api/audit-logs', headers: h(auditorJwt) });
  assert.equal(again.statusCode, 200, again.body);
});

test('全部租户视角导出：CSV 追加「租户」列，JSON 每条带 tenantName', async () => {
  const platform = await prisma.tenant.findUniqueOrThrow({ where: { id: PLATFORM_TENANT_ID } });
  await prisma.auditLog.createMany({
    data: [
      {
        action: TENANT_COL_ACTION,
        actorName: `${P}t1`,
        tenantId,
        createdAt: new Date('2026-11-13T02:00:00.000Z'),
      },
      {
        action: TENANT_COL_ACTION,
        actorName: `${P}t2`,
        tenantId: PLATFORM_TENANT_ID,
        createdAt: new Date('2026-11-12T02:00:00.000Z'),
      },
    ],
  });
  const query = `action=${encodeURIComponent(TENANT_COL_ACTION)}`;

  const csv = await app.inject({
    method: 'GET',
    url: `/api/audit-logs/export?format=csv&${query}`,
    headers: h(adminJwt, 'all'),
  });
  assert.equal(csv.statusCode, 200, csv.body);
  assert.ok(csv.body.startsWith('﻿'), '缺 BOM');
  const lines = parseCsv(csv.body);
  assert.equal(lines[0], '时间,操作人,动作,对象类型,对象,IP,详情,租户');
  assert.equal(lines.length, 3);
  assert.ok(lines[1]!.endsWith(`,${P}租户`), lines[1]);
  assert.ok(lines[2]!.endsWith(`,${platform.name}`), lines[2]);

  const json = await app.inject({
    method: 'GET',
    url: `/api/audit-logs/export?format=json&${query}`,
    headers: h(adminJwt, 'all'),
  });
  assert.equal(json.statusCode, 200, json.body);
  const items = json.json() as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.map((i) => i.tenantName),
    [`${P}租户`, platform.name],
  );

  // 不在全部租户视角时不加租户列。
  const plainCsv = await app.inject({
    method: 'GET',
    url: `/api/audit-logs/export?format=csv&${query}`,
    headers: h(adminJwt),
  });
  assert.equal(plainCsv.statusCode, 200, plainCsv.body);
  const plainLines = parseCsv(plainCsv.body);
  assert.equal(plainLines[0], '时间,操作人,动作,对象类型,对象,IP,详情');
  assert.equal(plainLines.length, 2);
  const plainJson = await app.inject({
    method: 'GET',
    url: `/api/audit-logs/export?format=json&${query}`,
    headers: h(adminJwt),
  });
  const plainItems = plainJson.json() as Array<Record<string, unknown>>;
  assert.equal(plainItems.length, 1);
  assert.ok(!('tenantName' in plainItems[0]!), JSON.stringify(plainItems[0]));
});

test('修改查看范围时，审计详情记下前后值', async () => {
  const startedAt = new Date(Date.now() - 1000);
  const saved = await setAuditLogAccess('system_admin_only');
  try {
    assert.equal(saved.statusCode, 200, saved.body);
    const log = await prisma.auditLog.findFirst({
      where: { action: 'system_setting.update', actorName: 'admin', createdAt: { gte: startedAt } },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(log, '没有记审计');
    const detail = log.detail as { changes?: { security?: Record<string, unknown> } };
    assert.deepEqual(detail.changes?.security, {
      auditLogAccess: { before: 'admins_and_auditors', after: 'system_admin_only' },
    });
  } finally {
    const back = await setAuditLogAccess('admins_and_auditors');
    assert.equal(back.statusCode, 200, back.body);
  }
});

test('登录用户能从 /api/auth/me 读到操作日志查看范围', async () => {
  const saved = await setAuditLogAccess('system_admin_only');
  try {
    assert.equal(saved.statusCode, 200, saved.body);
    for (const jwt of [auditorJwt, tenantAdminJwt, adminJwt]) {
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: h(jwt) });
      assert.equal(me.statusCode, 200, me.body);
      assert.equal(me.json().user.auditLogAccess, 'system_admin_only');
    }
  } finally {
    const back = await setAuditLogAccess('admins_and_auditors');
    assert.equal(back.statusCode, 200, back.body);
  }
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: h(auditorJwt) });
  assert.equal(me.json().user.auditLogAccess, 'admins_and_auditors');
});

test('导出按时间倒序分批读取，每批 2000 行，CSV 只取用得到的列', async () => {
  const read = (auditLogModule as Record<string, unknown>).readAuditLogBatches as
    | ((
        where: Record<string, unknown>,
        format: 'csv' | 'json',
      ) => AsyncIterable<Array<Record<string, unknown> & { id: string; createdAt: Date }>>)
    | undefined;
  assert.equal(typeof read, 'function', '缺少分批读取 readAuditLogBatches');
  const at = new Date('2026-11-14T02:00:00.000Z');
  // 前 3000 行时间完全相同，翻页必须靠 ID 兜底，不能漏也不能重。
  await prisma.auditLog.createMany({
    data: Array.from({ length: 4500 }, (_, i) => ({
      action: BATCH_ACTION,
      actorName: `${P}batch`,
      userAgent: 'w2-ua',
      detail: { i },
      createdAt: i < 3000 ? at : new Date(at.getTime() + i),
    })),
  });
  try {
    const sizes: number[] = [];
    const ids = new Set<string>();
    let prev: Date | null = null;
    for await (const batch of read!({ action: BATCH_ACTION }, 'csv')) {
      sizes.push(batch.length);
      for (const row of batch) {
        assert.ok(!('userAgent' in row), 'CSV 不需要 userAgent');
        assert.ok(!('actorId' in row), 'CSV 不需要 actorId');
        assert.ok('detail' in row);
        if (prev) assert.ok(prev.getTime() >= row.createdAt.getTime(), '不是倒序');
        prev = row.createdAt;
        ids.add(row.id);
      }
    }
    assert.deepEqual(sizes, [2000, 2000, 500]);
    assert.equal(ids.size, 4500);

    const csv = await app.inject({
      method: 'GET',
      url: `/api/audit-logs/export?format=csv&action=${encodeURIComponent(BATCH_ACTION)}`,
      headers: h(auditorJwt),
    });
    assert.equal(csv.statusCode, 200, csv.body);
    assert.ok(csv.body.startsWith('﻿'), '缺 BOM');
    const lines = parseCsv(csv.body);
    assert.equal(lines[0], '时间,操作人,动作,对象类型,对象,IP,详情');
    assert.equal(lines.length, 4501);

    const json = await app.inject({
      method: 'GET',
      url: `/api/audit-logs/export?format=json&action=${encodeURIComponent(BATCH_ACTION)}`,
      headers: h(auditorJwt),
    });
    assert.equal(json.statusCode, 200, json.body);
    const items = json.json() as Array<{ id: string; userAgent: string }>;
    assert.equal(items.length, 4500);
    assert.equal(new Set(items.map((i) => i.id)).size, 4500);
    assert.equal(items[0]!.userAgent, 'w2-ua');

    const log = await prisma.auditLog.findFirst({
      where: { action: 'audit_log.export', actorName: `${P}auditor` },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal((log?.detail as { count?: number }).count, 4500);
  } finally {
    await prisma.auditLog.deleteMany({ where: { action: BATCH_ACTION } });
  }
});
