import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PROBE_TOOL_CODE } from '@lse/shared';
import { prisma } from '../src/db.js';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';
import {
  bearer,
  createToolTestContext,
  destroyToolTestContext,
  type ToolTestContext,
} from './helpers/tool-fixtures.js';

// 禁用和隐藏（A-6，需求 2.3.4）：禁用仍在列表、不能下载；隐藏对没有 tool:manage 的用户完全不可见；
// 内置工具不能禁用、可以隐藏。工具是平台级内容，其他租户的管理员也只能看、不能改。

const P = 'zz-a6-';
const TENANT_NAME = 'A6工具中心测试租户';
const PASSWORD = ['Tenant', 'Tool', '12345'].join('@');
let ctx: ToolTestContext;
let tenantAdminToken = '';
let toolId = '';
let versionId = '';
let probeId = '';

function patchTool(token: string, id: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/tools/${id}`,
    headers: bearer(token),
    payload,
  });
}

async function listIds(token: string): Promise<string[]> {
  const res = await ctx.app.inject({ url: '/api/tools', headers: bearer(token) });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json().items as Array<{ id: string }>).map((t) => t.id);
}

function download(token: string) {
  return ctx.app.inject({
    url: `/api/tools/${toolId}/versions/${versionId}/download`,
    headers: bearer(token),
  });
}

async function cleanupTenant() {
  const tenants = await prisma.tenant.findMany({
    where: { name: TENANT_NAME },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  await cleanupTenant();
  ctx = await createToolTestContext(P);
  probeId = (await prisma.tool.findUniqueOrThrow({ where: { code: BUILTIN_PROBE_TOOL_CODE } })).id;
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/tools',
    headers: bearer(ctx.tokens.admin),
    payload: { code: `${P}state`, name: '状态工具', category: 'model' },
  });
  assert.equal(created.statusCode, 201, created.body);
  toolId = created.json().id;
  const q = new URLSearchParams({
    version: '1.0.0',
    os: 'linux',
    arch: 'amd64',
    filename: 'a.bin',
  });
  const up = await ctx.app.inject({
    method: 'POST',
    url: `/api/tools/${toolId}/versions?${q}`,
    headers: { ...bearer(ctx.tokens.admin), 'content-type': 'application/octet-stream' },
    payload: Buffer.from('state'),
  });
  assert.equal(up.statusCode, 201, up.body);
  versionId = up.json().id;

  const tenant = await ctx.app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: bearer(ctx.tokens.admin),
    payload: { name: TENANT_NAME, admin: { username: `${P}tadmin`, password: PASSWORD } },
  });
  assert.equal(tenant.statusCode, 201, tenant.body);
  await skipFirstPasswordChange(`${P}tadmin`);
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: `${P}tadmin`, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  tenantAdminToken = login.json().token;
});

after(async () => {
  await prisma.tool.update({ where: { id: probeId }, data: { hidden: false, enabled: true } });
  await destroyToolTestContext(ctx, P);
  await cleanupTenant();
  await prisma.$disconnect();
});

test('内置工具不能禁用（400），可以隐藏', async () => {
  const disable = await patchTool(ctx.tokens.admin, probeId, { enabled: false });
  assert.equal(disable.statusCode, 400, disable.body);
  assert.equal((await prisma.tool.findUniqueOrThrow({ where: { id: probeId } })).enabled, true);
  const hide = await patchTool(ctx.tokens.admin, probeId, { hidden: true });
  assert.equal(hide.statusCode, 200, hide.body);
  assert.equal(hide.json().hidden, true);
  assert.ok(!(await listIds(ctx.tokens.operator)).includes(probeId));
  assert.ok((await listIds(ctx.tokens.admin)).includes(probeId));
  const show = await patchTool(ctx.tokens.admin, probeId, { hidden: false });
  assert.equal(show.statusCode, 200);
  assert.ok((await listIds(ctx.tokens.operator)).includes(probeId));
});

test('隐藏后 operator 列表看不到、详情和下载 404；取消隐藏后恢复', async () => {
  const hide = await patchTool(ctx.tokens.admin, toolId, { hidden: true });
  assert.equal(hide.statusCode, 200, hide.body);
  assert.ok(!(await listIds(ctx.tokens.operator)).includes(toolId));
  const detail = await ctx.app.inject({
    url: `/api/tools/${toolId}`,
    headers: bearer(ctx.tokens.operator),
  });
  assert.equal(detail.statusCode, 404);
  assert.equal((await download(ctx.tokens.operator)).statusCode, 404);
  assert.equal((await download(ctx.tokens.admin)).statusCode, 200, '管理员仍可下载');
  const log = await prisma.auditLog.findFirst({
    where: { action: 'tool.update', targetId: toolId },
    orderBy: { createdAt: 'desc' },
  });
  assert.deepEqual((log?.detail as { hidden?: boolean } | null)?.hidden, true);

  assert.equal((await patchTool(ctx.tokens.admin, toolId, { hidden: false })).statusCode, 200);
  assert.ok((await listIds(ctx.tokens.operator)).includes(toolId));
  assert.equal((await download(ctx.tokens.operator)).statusCode, 200);
});

test('禁用后仍在列表里（enabled:false），下载 409；启用后恢复', async () => {
  const off = await patchTool(ctx.tokens.admin, toolId, { enabled: false });
  assert.equal(off.statusCode, 200, off.body);
  const res = await ctx.app.inject({ url: '/api/tools', headers: bearer(ctx.tokens.operator) });
  const item = (res.json().items as Array<{ id: string; enabled: boolean }>).find(
    (t) => t.id === toolId,
  );
  assert.equal(item?.enabled, false);
  assert.equal((await download(ctx.tokens.operator)).statusCode, 409);
  assert.equal((await download(ctx.tokens.admin)).statusCode, 409);
  assert.equal((await patchTool(ctx.tokens.admin, toolId, { enabled: true })).statusCode, 200);
  assert.equal((await download(ctx.tokens.operator)).statusCode, 200);
});

test('operator 不能禁用或隐藏（403）', async () => {
  assert.equal((await patchTool(ctx.tokens.operator, toolId, { enabled: false })).statusCode, 403);
  assert.equal((await patchTool(ctx.tokens.operator, toolId, { hidden: true })).statusCode, 403);
});

test('其他租户的管理员：能看平台的工具，看不到隐藏的，不能改', async () => {
  assert.ok((await listIds(tenantAdminToken)).includes(toolId));
  assert.equal((await patchTool(tenantAdminToken, toolId, { hidden: true })).statusCode, 403);
  await patchTool(ctx.tokens.admin, toolId, { hidden: true });
  try {
    assert.ok(!(await listIds(tenantAdminToken)).includes(toolId));
    const detail = await ctx.app.inject({
      url: `/api/tools/${toolId}`,
      headers: bearer(tenantAdminToken),
    });
    assert.equal(detail.statusCode, 404);
  } finally {
    await patchTool(ctx.tokens.admin, toolId, { hidden: false });
  }
  const del = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/tools/${toolId}`,
    headers: bearer(tenantAdminToken),
  });
  assert.equal(del.statusCode, 403);
});
