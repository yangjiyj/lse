import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

// 租户信息设置：平台 logo、页签 logo、平台标题；公开只读品牌接口。
let app!: FastifyInstance;
let adminToken = '';
let saved: unknown = undefined;

// 1×1 PNG
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SVG = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
// 冒充 PNG 的 SVG
const FAKE_PNG = `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;

async function patchTenant(tenant: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { tenant },
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  saved = (await prisma.systemSetting.findUnique({ where: { key: 'tenant' } }))?.value;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  adminToken = res.json().token;
});

after(async () => {
  if (saved === undefined) await prisma.systemSetting.deleteMany({ where: { key: 'tenant' } });
  else
    await prisma.systemSetting.update({
      where: { key: 'tenant' },
      data: { value: saved as object },
    });
  await app.close();
  await prisma.$disconnect();
});

test('公开品牌接口无需登录，默认返回平台标题', async () => {
  await prisma.systemSetting.deleteMany({ where: { key: 'tenant' } });
  const res = await app.inject({ method: 'GET', url: '/api/branding' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().platformTitle, '鉴盾 · 大模型安全评估平台');
  assert.equal(res.json().updatedAt, null);
  assert.equal(res.json().platformLogo, null);
});

test('保存平台标题与 PNG logo 后公开接口生效', async () => {
  const res = await patchTenant({
    platformTitle: '国家管网大模型安全评估平台',
    platformLogo: PNG,
    tabLogo: PNG,
  });
  assert.equal(res.statusCode, 200, res.body);
  const pub = (await app.inject({ method: 'GET', url: '/api/branding' })).json();
  assert.equal(pub.platformTitle, '国家管网大模型安全评估平台');
  assert.match(pub.platformLogo, /^data:image\/png;base64,/);
  assert.match(pub.tabLogo, /^data:image\/png;base64,/);
});

test('禁止 SVG logo（含改 MIME 冒充 PNG 的 SVG）', async () => {
  const svg = await patchTenant({ platformLogo: SVG });
  assert.equal(svg.statusCode, 400, svg.body);
  assert.equal(svg.json().error.code, 'LOGO_SVG_FORBIDDEN');
  const fake = await patchTenant({ tabLogo: FAKE_PNG });
  assert.equal(fake.statusCode, 400, fake.body);
  assert.equal(fake.json().error.code, 'LOGO_INVALID');
});

test('logo 超过大小限制返回 400', async () => {
  const big = Buffer.alloc(300 * 1024);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
  const res = await patchTenant({
    platformLogo: `data:image/png;base64,${big.toString('base64')}`,
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('未登录不能修改租户信息', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    payload: { tenant: { platformTitle: 'x' } },
  });
  assert.equal(res.statusCode, 401);
});
