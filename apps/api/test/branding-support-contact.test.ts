import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { BRANDING_REQUESTS_PER_MINUTE } from '../src/modules/branding/routes.js';

// 2.9.10 平台参数：品牌设置补支持单位和联系人（单位、联系人、电话、邮箱），免登录的品牌接口也返回。

const P = 'w2brandcontact-';
const PW = ['Brand', 'Contact', '@', '2026'].join(''); // pragma: allowlist secret

let app!: FastifyInstance;
let adminJwt = '';
let auditorJwt = '';
let tenantAdminJwt = '';
let saved: unknown = undefined;

const h = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token;
}

async function patchTenant(jwt: string, tenant: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: h(jwt),
    payload: { tenant },
  });
}

async function cleanup(): Promise<void> {
  await prisma.user.deleteMany({ where: { username: { startsWith: P } } });
  await prisma.tenant.deleteMany({ where: { name: { startsWith: P } } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  saved = (await prisma.systemSetting.findUnique({ where: { key: 'tenant' } }))?.value;
  await prisma.systemSetting.deleteMany({ where: { key: 'tenant' } });
  const tenant = await prisma.tenant.create({ data: { name: `${P}租户`, code: `${P}t` } });
  for (const [key, roleName, tenantId] of [
    ['auditor', 'auditor', undefined],
    ['tadmin', 'tenant_admin', tenant.id],
  ] as const) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    await prisma.user.create({
      data: {
        username: `${P}${key}`,
        displayName: key,
        passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
        ...(tenantId ? { tenantId } : {}),
        roles: { create: { roleId: role.id } },
      },
    });
  }
  adminJwt = await login('admin', ['Admin', '@', '12345'].join(''));
  auditorJwt = await login(`${P}auditor`, PW);
  tenantAdminJwt = await login(`${P}tadmin`, PW);
});

after(async () => {
  if (saved === undefined) await prisma.systemSetting.deleteMany({ where: { key: 'tenant' } });
  else
    await prisma.systemSetting.upsert({
      where: { key: 'tenant' },
      update: { value: saved as object },
      create: { key: 'tenant', value: saved as object },
    });
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

const CONTACT = {
  supportOrg: '国家管网信息中心',
  contactName: '张工',
  contactPhone: '010-12345678',
  contactEmail: 'support@example.com',
};

test('未设置时四项为空，公开品牌接口返回 null', async () => {
  const settings = await app.inject({
    method: 'GET',
    url: '/api/system-settings',
    headers: h(adminJwt),
  });
  assert.equal(settings.statusCode, 200, settings.body);
  const tenant = settings.json().tenant;
  for (const key of Object.keys(CONTACT)) assert.equal(tenant[key], '', key);

  const pub = await app.inject({ method: 'GET', url: '/api/branding' });
  assert.equal(pub.statusCode, 200, pub.body);
  for (const key of Object.keys(CONTACT)) assert.equal(pub.json()[key], null, key);
});

test('平台管理员保存四项后，设置和免登录品牌接口都能读到', async () => {
  const res = await patchTenant(adminJwt, CONTACT);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    Object.fromEntries(Object.keys(CONTACT).map((k) => [k, res.json().tenant[k]])),
    CONTACT,
  );
  const pub = await app.inject({ method: 'GET', url: '/api/branding' });
  assert.equal(pub.statusCode, 200, pub.body);
  for (const [key, value] of Object.entries(CONTACT)) assert.equal(pub.json()[key], value, key);
});

test('只改一项时其他项保持不变，平台标题不受影响', async () => {
  const before = (
    await app.inject({ method: 'GET', url: '/api/system-settings', headers: h(adminJwt) })
  ).json().tenant;
  const res = await patchTenant(adminJwt, { contactPhone: '13800000000' });
  assert.equal(res.statusCode, 200, res.body);
  const tenant = res.json().tenant;
  assert.equal(tenant.contactPhone, '13800000000');
  assert.equal(tenant.supportOrg, CONTACT.supportOrg);
  assert.equal(tenant.contactEmail, CONTACT.contactEmail);
  assert.equal(tenant.platformTitle, before.platformTitle);
});

test('清空后公开接口不再返回该项', async () => {
  const res = await patchTenant(adminJwt, { contactEmail: '' });
  assert.equal(res.statusCode, 200, res.body);
  const pub = (await app.inject({ method: 'GET', url: '/api/branding' })).json();
  assert.equal(pub.contactEmail, null);
  assert.equal(pub.contactName, CONTACT.contactName);
});

test('邮箱或电话格式不对返回 400', async () => {
  const email = await patchTenant(adminJwt, { contactEmail: 'not-an-email' });
  assert.equal(email.statusCode, 400, email.body);
  const phone = await patchTenant(adminJwt, { contactPhone: 'call me<script>' });
  assert.equal(phone.statusCode, 400, phone.body);
  const longOrg = await patchTenant(adminJwt, { supportOrg: '单'.repeat(101) });
  assert.equal(longOrg.statusCode, 400, longOrg.body);
});

test('保存记审计 system_setting.update', async () => {
  const startedAt = new Date();
  const res = await patchTenant(adminJwt, { contactName: '李工' });
  assert.equal(res.statusCode, 200, res.body);
  const log = await prisma.auditLog.findFirst({
    where: { action: 'system_setting.update', createdAt: { gte: startedAt } },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(log, '没有记审计');
  assert.equal(log.actorName, 'admin');
  assert.equal(log.targetType, 'system_setting');
});

test('没有平台设置修改权限的不能改', async () => {
  for (const jwt of [auditorJwt, tenantAdminJwt]) {
    const res = await patchTenant(jwt, { contactName: '越权' });
    assert.equal(res.statusCode, 403, res.body);
  }
  const pub = (await app.inject({ method: 'GET', url: '/api/branding' })).json();
  assert.notEqual(pub.contactName, '越权');
});

test('电话允许「转」和 ext 分机写法', async () => {
  for (const phone of ['010-12345678 转 8001', '010-12345678 ext 8001', '010-12345678 EXT. 8001']) {
    const res = await patchTenant(adminJwt, { contactPhone: phone });
    assert.equal(res.statusCode, 200, `${phone} ${res.body}`);
    assert.equal(res.json().tenant.contactPhone, phone);
  }
  const bad = await patchTenant(adminJwt, { contactPhone: '010-12345678 转 abc' });
  assert.equal(bad.statusCode, 400, bad.body);
});

// 1×1 PNG
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('存量品牌设置某一项不合法时只回退那一项，标题和 logo 保留', async () => {
  const value = {
    platformTitle: `${P}标题`,
    platformLogo: PNG,
    tabLogo: PNG,
    supportOrg: '某某单位',
    contactName: '王工',
    contactPhone: 'call me<script>',
    contactEmail: 'not-an-email',
  };
  await prisma.systemSetting.upsert({
    where: { key: 'tenant' },
    update: { value },
    create: { key: 'tenant', value },
  });
  const pub = await app.inject({ method: 'GET', url: '/api/branding' });
  assert.equal(pub.statusCode, 200, pub.body);
  const b = pub.json();
  assert.equal(b.platformTitle, value.platformTitle);
  assert.equal(b.platformLogo, PNG);
  assert.equal(b.tabLogo, PNG);
  assert.equal(b.supportOrg, '某某单位');
  assert.equal(b.contactName, '王工');
  assert.equal(b.contactPhone, null);
  assert.equal(b.contactEmail, null);

  const settings = await app.inject({
    method: 'GET',
    url: '/api/system-settings',
    headers: h(adminJwt),
  });
  assert.equal(settings.statusCode, 200, settings.body);
  const tenant = settings.json().tenant;
  assert.equal(tenant.platformTitle, value.platformTitle);
  assert.equal(tenant.contactPhone, '');
  assert.equal(tenant.contactEmail, '');
});

test('公开品牌接口限流：同一 IP 每分钟超过上限返回 429，换 IP 不受影响', async () => {
  const ip = `10.77.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
  for (let i = 0; i < BRANDING_REQUESTS_PER_MINUTE; i += 1) {
    const ok = await app.inject({ method: 'GET', url: '/api/branding', remoteAddress: ip });
    assert.equal(ok.statusCode, 200, `第 ${i + 1} 次：${ok.body}`);
  }
  const limited = await app.inject({ method: 'GET', url: '/api/branding', remoteAddress: ip });
  assert.equal(limited.statusCode, 429, limited.body);
  const other = await app.inject({
    method: 'GET',
    url: '/api/branding',
    remoteAddress: '10.78.1.1',
  });
  assert.equal(other.statusCode, 200, other.body);
});

test('改系统设置的审计详情用 groups 记改了哪些分组，不被当成密钥打码', async () => {
  const res = await patchTenant(adminJwt, { supportOrg: `${P}审计分组` });
  assert.equal(res.statusCode, 200, res.body);
  const log = await prisma.auditLog.findFirst({
    where: { action: 'system_setting.update' },
    orderBy: { createdAt: 'desc' },
  });
  assert.deepEqual((log?.detail as { groups?: unknown })?.groups, ['tenant']);
});
