import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PROBE_TOOL_CODE } from '@lse/shared';
import { prisma } from '../src/db.js';
import {
  bearer,
  createToolTestContext,
  destroyToolTestContext,
  seedTool,
  type ToolTestContext,
} from './helpers/tool-fixtures.js';

// 工具列表和详情（A-2，需求 2.3.1、2.3.2）：按类别、系统、架构筛选；隐藏工具对普通用户不可见；禁用工具标出来。

const P = 'zz-a2-';
let ctx: ToolTestContext;
const ids: Record<string, string> = {};

interface ListItem {
  id: string;
  code: string;
  category: string;
  enabled: boolean;
  hidden: boolean;
  builtin: boolean;
  latestVersion: { version: string } | null;
  platforms: Array<{ os: string; arch: string }>;
  versionCount: number;
  downloadCount: number;
}

async function list(token: string, query = ''): Promise<ListItem[]> {
  const res = await ctx.app.inject({ url: `/api/tools${query}`, headers: bearer(token) });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { items: ListItem[] }).items;
}

const codes = (items: ListItem[]) =>
  items
    .map((t) => t.code)
    .filter((c) => c.startsWith(P))
    .sort();

before(async () => {
  ctx = await createToolTestContext(P);
  const linux = await seedTool(P, 'linux', {
    versions: [
      { version: '1.0.0', os: 'linux', arch: 'amd64' },
      { version: '1.1.0', os: 'linux', arch: 'amd64' },
    ],
  });
  const win = await seedTool(P, 'win', {
    category: 'data',
    versions: [
      { version: '2.0.0', os: 'windows', arch: 'amd64' },
      { version: '2.0.0', os: 'linux', arch: 'arm64' },
    ],
  });
  const universal = await seedTool(P, 'universal', {
    versions: [{ version: '0.1.0', os: 'any', arch: 'any' }],
  });
  const hidden = await seedTool(P, 'hidden', {
    hidden: true,
    versions: [{ version: '1.0.0', os: 'windows', arch: 'amd64' }],
  });
  const disabled = await seedTool(P, 'disabled', { enabled: false });
  Object.assign(ids, {
    linux: linux.id,
    win: win.id,
    universal: universal.id,
    hidden: hidden.id,
    disabled: disabled.id,
  });
  await prisma.toolDownload.createMany({
    data: [
      { toolId: win.id, kind: 'package', ip: '10.0.0.1' },
      { toolId: win.id, kind: 'package', ip: '10.0.0.2' },
      { toolId: win.id, kind: 'manual', ip: '10.0.0.3' },
    ],
  });
});

after(async () => {
  await destroyToolTestContext(ctx, P);
  await prisma.$disconnect();
});

test('按 os=windows 只返回有 Windows 版本（或不限系统）的工具', async () => {
  assert.deepEqual(codes(await list(ctx.tokens.admin, '?os=windows')), [
    `${P}hidden`,
    `${P}universal`,
    `${P}win`,
  ]);
  assert.deepEqual(codes(await list(ctx.tokens.operator, '?os=windows')), [
    `${P}universal`,
    `${P}win`,
  ]);
});

test('系统和架构同时筛选时要落在同一个版本上', async () => {
  assert.deepEqual(codes(await list(ctx.tokens.admin, '?os=linux&arch=arm64')), [
    `${P}universal`,
    `${P}win`,
  ]);
  assert.deepEqual(codes(await list(ctx.tokens.admin, '?os=windows&arch=arm64')), [
    `${P}universal`,
  ]);
});

test('按类别筛选；类别、系统、架构取值不对返回 400', async () => {
  assert.deepEqual(codes(await list(ctx.tokens.admin, '?category=data')), [`${P}win`]);
  for (const q of ['?category=secret', '?os=solaris', '?arch=mips']) {
    const res = await ctx.app.inject({ url: `/api/tools${q}`, headers: bearer(ctx.tokens.admin) });
    assert.equal(res.statusCode, 400, q);
  }
});

test('列表带最新版本、各版本的系统和架构、下载量', async () => {
  const items = await list(ctx.tokens.operator);
  const linux = items.find((t) => t.id === ids.linux)!;
  assert.equal(linux.latestVersion?.version, '1.1.0');
  assert.equal(linux.versionCount, 2);
  assert.deepEqual(linux.platforms, [{ os: 'linux', arch: 'amd64' }]);
  const win = items.find((t) => t.id === ids.win)!;
  assert.deepEqual(win.platforms.map((p) => `${p.os}/${p.arch}`).sort(), [
    'linux/arm64',
    'windows/amd64',
  ]);
  assert.equal(win.downloadCount, 2, '只算安装包下载，手册下载不算');
  assert.equal(win.category, 'data');
});

test('隐藏工具对 operator 不出现、详情 404，对平台管理员出现', async () => {
  assert.ok(!(await list(ctx.tokens.operator)).some((t) => t.id === ids.hidden));
  const adminItem = (await list(ctx.tokens.admin)).find((t) => t.id === ids.hidden);
  assert.equal(adminItem?.hidden, true);
  const asOperator = await ctx.app.inject({
    url: `/api/tools/${ids.hidden}`,
    headers: bearer(ctx.tokens.operator),
  });
  assert.equal(asOperator.statusCode, 404);
  const asAdmin = await ctx.app.inject({
    url: `/api/tools/${ids.hidden}`,
    headers: bearer(ctx.tokens.admin),
  });
  assert.equal(asAdmin.statusCode, 200, asAdmin.body);
  assert.equal(asAdmin.json().hidden, true);
});

test('禁用工具仍在列表里，带 enabled:false', async () => {
  const item = (await list(ctx.tokens.auditor)).find((t) => t.id === ids.disabled);
  assert.equal(item?.enabled, false);
});

test('详情带说明、配置参数、版本（新到旧）和手册', async () => {
  const res = await ctx.app.inject({
    url: `/api/tools/${ids.linux}`,
    headers: bearer(ctx.tokens.operator),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.code, `${P}linux`);
  assert.equal(typeof body.instructions, 'string');
  assert.deepEqual(body.configParams, []);
  assert.deepEqual(
    body.versions.map((v: { version: string }) => v.version),
    ['1.1.0', '1.0.0'],
  );
  const v = body.versions[0];
  assert.equal(v.size, 11);
  assert.equal(v.downloadUrl, `/api/tools/${ids.linux}/versions/${v.id}/download`);
  assert.ok(!('storageKey' in v), '不暴露存储键');
  assert.deepEqual(body.manuals, []);
});

test('内置终端探针在列表里，标为内置', async () => {
  const probe = (await list(ctx.tokens.operator)).find((t) => t.code === BUILTIN_PROBE_TOOL_CODE);
  assert.ok(probe);
  assert.equal(probe.builtin, true);
  assert.equal(probe.category, 'app_env');
});

test('没有 tool:read 的用户 403；不存在的工具 404', async () => {
  const denied = await ctx.app.inject({ url: '/api/tools', headers: bearer(ctx.tokens.noTool) });
  assert.equal(denied.statusCode, 403);
  const deniedDetail = await ctx.app.inject({
    url: `/api/tools/${ids.linux}`,
    headers: bearer(ctx.tokens.noTool),
  });
  assert.equal(deniedDetail.statusCode, 403);
  const missing = await ctx.app.inject({
    url: '/api/tools/00000000-0000-4000-8000-00000000abcd',
    headers: bearer(ctx.tokens.admin),
  });
  assert.equal(missing.statusCode, 404);
});
