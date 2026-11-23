import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { mock } from 'node:test';
import { BUILTIN_PROBE_TOOL_CODE } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import {
  displayFilename,
  storageDeps,
  storeUpload,
  sweepStaleParts,
} from '../src/modules/tools/storage.js';
import {
  bearer,
  createToolTestContext,
  destroyToolTestContext,
  waitForParts,
  type ToolTestContext,
} from './helpers/tool-fixtures.js';

// 工具上传与删除（A-3，需求 2.3.1、2.3.8）：建工具、上传版本（流式写盘、算 sha256）、删版本、删工具。

const P = 'zz-a3-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let ctx: ToolTestContext;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function createTool(token: string, suffix: string, extra: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/tools',
    headers: bearer(token),
    payload: { code: `${P}${suffix}`, name: `工具${suffix}`, category: 'model', ...extra },
  });
}

function upload(
  token: string,
  toolId: string,
  body: Buffer | Readable,
  meta: Record<string, string> = {},
) {
  const query = new URLSearchParams({
    version: '1.0.0',
    os: 'linux',
    arch: 'amd64',
    filename: 'agent.tar.gz',
    ...meta,
  });
  return ctx.app.inject({
    method: 'POST',
    url: `/api/tools/${toolId}/versions?${query}`,
    headers: { ...bearer(token), 'content-type': 'application/octet-stream' },
    payload: body,
  });
}

async function newTool(suffix: string): Promise<string> {
  const res = await createTool(ctx.tokens.admin, suffix);
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

const storedFiles = () => readdirSync(ctx.storageDir).sort();

before(async () => {
  ctx = await createToolTestContext(P);
});

after(async () => {
  delete process.env.TOOL_UPLOAD_MAX_BYTES;
  await destroyToolTestContext(ctx, P);
  await prisma.$disconnect();
});

test('平台管理员建工具；编码重复 409，编码或类别不合法 400，写审计 tool.create', async () => {
  const res = await createTool(ctx.tokens.admin, 'create', {
    description: '扫描模型文件',
    instructions: '第一段\n\n第二段',
    configParams: [
      { name: 'path', label: '扫描路径', description: '', defaultValue: '/models', required: true },
    ],
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.equal(body.code, `${P}create`);
  assert.equal(body.builtin, false);
  assert.equal(body.enabled, true);
  assert.equal(body.instructions, '第一段\n\n第二段');
  assert.equal(body.configParams[0].defaultValue, '/models');
  assert.equal(body.createdBy.username, 'admin');
  const log = await prisma.auditLog.findFirst({
    where: { action: 'tool.create', targetId: body.id },
  });
  assert.ok(log, '缺少 tool.create 审计');
  assert.equal(log.targetType, 'tool');

  assert.equal((await createTool(ctx.tokens.admin, 'create')).statusCode, 409);
  for (const bad of [
    { code: 'Upper-Case' },
    { code: '-lead' },
    { code: 'has space' },
    { category: 'secret' },
    { name: '' },
  ]) {
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/tools',
      headers: bearer(ctx.tokens.admin),
      payload: { code: `${P}bad`, name: '坏', category: 'model', ...bad },
    });
    assert.equal(r.statusCode, 400, JSON.stringify(bad));
  }
  const dupParams = await createTool(ctx.tokens.admin, 'dup-params', {
    configParams: [
      { name: 'a', label: '甲' },
      { name: 'a', label: '乙' },
    ],
  });
  assert.equal(dupParams.statusCode, 400, '参数名重复');
});

test('上传版本：sha256、大小正确，文件在存储目录下、文件名是 uuid，写审计 tool.version_upload', async () => {
  const toolId = await newTool('upload');
  const file = Buffer.from('hello tool center\n'.repeat(1000));
  const res = await upload(ctx.tokens.admin, toolId, file, {
    filename: '../../etc/agent.tar.gz',
    releaseNotes: '首个版本',
  });
  assert.equal(res.statusCode, 201, res.body);
  const v = res.json();
  assert.equal(v.size, file.length);
  assert.equal(v.sha256, sha(file));
  assert.equal(v.filename, 'agent.tar.gz', '展示用文件名只保留最后一段');
  assert.equal(v.releaseNotes, '首个版本');
  assert.equal(v.createdBy.username, 'admin');
  const row = await prisma.toolVersion.findUniqueOrThrow({ where: { id: v.id } });
  assert.match(row.storageKey, UUID);
  assert.ok(storedFiles().includes(row.storageKey), '存储目录里没有以 uuid 命名的文件');
  assert.ok(!storedFiles().some((f) => f.endsWith('.part')), '不留临时文件');
  assert.deepEqual(readFileSync(join(ctx.storageDir, row.storageKey)), file);
  const log = await prisma.auditLog.findFirst({
    where: { action: 'tool.version_upload', targetId: v.id },
  });
  assert.ok(log, '缺少 tool.version_upload 审计');
});

test('详情带版本上传上限 maxUploadBytes（前端据此预先比对）', async () => {
  const toolId = await newTool('limit');
  const detail = () =>
    ctx.app.inject({ url: `/api/tools/${toolId}`, headers: bearer(ctx.tokens.admin) });
  assert.equal((await detail()).json().maxUploadBytes, 1024 ** 3);
  process.env.TOOL_UPLOAD_MAX_BYTES = '4096';
  try {
    assert.equal((await detail()).json().maxUploadBytes, 4096);
  } finally {
    delete process.env.TOOL_UPLOAD_MAX_BYTES;
  }
});

test('超过上限 413，不留文件', async () => {
  const toolId = await newTool('too-large');
  const before = storedFiles();
  process.env.TOOL_UPLOAD_MAX_BYTES = '16';
  try {
    const res = await upload(ctx.tokens.admin, toolId, Buffer.alloc(64, 1));
    assert.equal(res.statusCode, 413, res.body);
    assert.equal(await prisma.toolVersion.count({ where: { toolId } }), 0);
  } finally {
    delete process.env.TOOL_UPLOAD_MAX_BYTES;
  }
  assert.deepEqual(storedFiles(), before);
});

test('展示用文件名去掉路径、控制字符和 Unicode 双向控制符', () => {
  assert.equal(displayFilename('C:\\x\\..\\报告\u202Efdp.exe'), '报告fdp.exe');
  assert.equal(displayFilename('a\u2066b\u2069\u0007.zip'), 'ab.zip');
});

test('边写边数：没有声明长度的流超过上限也会中止（413），不留半截文件', async () => {
  const before = storedFiles();
  await assert.rejects(
    storeUpload(Readable.from([Buffer.alloc(10, 1), Buffer.alloc(10, 2)]), 0, 16),
    (err: { statusCode?: number }) => err.statusCode === 413,
  );
  assert.deepEqual(storedFiles(), before);
});

test('上传中途工具被删：404「工具不存在」，不留文件', async () => {
  const toolId = await newTool('gone-mid-upload');
  const before = storedFiles();
  const storageDir = ctx.storageDir;
  async function* body() {
    yield Buffer.from('first half ');
    await waitForParts(storageDir, 1);
    await prisma.tool.delete({ where: { id: toolId } });
    yield Buffer.from('second half');
  }
  const res = await upload(ctx.tokens.admin, toolId, Readable.from(body()));
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().error.message, '工具不存在');
  assert.deepEqual(storedFiles(), before, '已写的文件清掉');
});

test('磁盘剩余空间不够「声明长度 + 1 GiB」：提前拒绝（507「存储空间不足」），不写盘', async () => {
  const toolId = await newTool('disk-full');
  const before = storedFiles();
  const statfs = mock.method(storageDeps, 'statfs', async () => ({
    bavail: 1024,
    bsize: 4096,
  }));
  try {
    const res = await upload(ctx.tokens.admin, toolId, Buffer.from('package bytes'));
    assert.equal(res.statusCode, 507, res.body);
    assert.match(res.json().error.message, /存储空间不足/);
    assert.equal(statfs.mock.callCount(), 1);
  } finally {
    statfs.mock.restore();
  }
  assert.deepEqual(storedFiles(), before);
  assert.equal(await prisma.toolVersion.count({ where: { toolId } }), 0);
  // 余量够（刚好多 1 字节）就照常写
  const ok = mock.method(storageDeps, 'statfs', async () => ({
    bavail: 1024 ** 3 + 100,
    bsize: 1,
  }));
  try {
    const res = await upload(ctx.tokens.admin, toolId, Buffer.alloc(99, 7));
    assert.equal(res.statusCode, 201, res.body);
  } finally {
    ok.mock.restore();
  }
});

test('写盘时磁盘写满（ENOSPC）：507「存储空间不足」，不留半截文件', async () => {
  const before = storedFiles();
  const failing = new Readable({
    read() {
      this.destroy(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
    },
  });
  await assert.rejects(
    storeUpload(failing, 0, 1024),
    (err: { statusCode?: number; message?: string }) =>
      err.statusCode === 507 && /存储空间不足/.test(err.message ?? ''),
  );
  assert.deepEqual(storedFiles(), before);
});

test('清理存放超过 1 天的半截文件（*.part），新的和正式文件不动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lse-tool-parts-'));
  try {
    const old = new Date(Date.now() - 25 * 3600_000);
    const stale = '11111111-1111-4111-8111-111111111111.part';
    const fresh = '22222222-2222-4222-8222-222222222222.part';
    const done = '33333333-3333-4333-8333-333333333333';
    const other = 'notes.part';
    for (const f of [stale, fresh, done, other]) writeFileSync(join(dir, f), 'x');
    for (const f of [stale, done, other]) utimesSync(join(dir, f), old, old);
    assert.equal(await sweepStaleParts(dir), 1);
    assert.deepEqual(readdirSync(dir).sort(), [fresh, done, other].sort());
    assert.equal(await sweepStaleParts(join(dir, 'missing')), 0, '目录不存在不报错');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('api 启动时清一次存放超过 1 天的 *.part', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lse-tool-boot-'));
  const saved = process.env.TOOL_STORAGE_DIR;
  const stale = '44444444-4444-4444-8444-444444444444.part';
  writeFileSync(join(dir, stale), 'x');
  const old = new Date(Date.now() - 2 * 86400_000);
  utimesSync(join(dir, stale), old, old);
  process.env.TOOL_STORAGE_DIR = dir;
  const app = await buildApp();
  try {
    await app.ready();
    assert.equal(existsSync(join(dir, stale)), false);
  } finally {
    process.env.TOOL_STORAGE_DIR = saved;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同版本、同系统、同架构重复上传 409；换架构可以；空文件 400', async () => {
  const toolId = await newTool('dup');
  assert.equal((await upload(ctx.tokens.admin, toolId, Buffer.from('a'))).statusCode, 201);
  const before = storedFiles();
  const dup = await upload(ctx.tokens.admin, toolId, Buffer.from('b'));
  assert.equal(dup.statusCode, 409, dup.body);
  assert.deepEqual(storedFiles(), before, '冲突时不留文件');
  const arm = await upload(ctx.tokens.admin, toolId, Buffer.from('c'), { arch: 'arm64' });
  assert.equal(arm.statusCode, 201, arm.body);
  const empty = await upload(ctx.tokens.admin, toolId, Buffer.alloc(0), { version: '2.0.0' });
  assert.equal(empty.statusCode, 400, empty.body);
  for (const bad of [{ os: 'solaris' }, { arch: 'mips' }, { version: '1 0' }]) {
    assert.equal(
      (await upload(ctx.tokens.admin, toolId, Buffer.from('x'), bad)).statusCode,
      400,
      JSON.stringify(bad),
    );
  }
});

test('operator 和 auditor 不能建工具、上传、删除（403）', async () => {
  const toolId = await newTool('perm');
  for (const token of [ctx.tokens.operator, ctx.tokens.auditor]) {
    assert.equal((await createTool(token, 'perm-x')).statusCode, 403);
    assert.equal((await upload(token, toolId, Buffer.from('x'))).statusCode, 403);
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/tools/${toolId}`,
      headers: bearer(token),
    });
    assert.equal(del.statusCode, 403);
  }
});

test('内置工具不能上传版本、不能删除（409）', async () => {
  const probe = await prisma.tool.findUniqueOrThrow({ where: { code: BUILTIN_PROBE_TOOL_CODE } });
  assert.equal((await upload(ctx.tokens.admin, probe.id, Buffer.from('x'))).statusCode, 409);
  const del = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/tools/${probe.id}`,
    headers: bearer(ctx.tokens.admin),
  });
  assert.equal(del.statusCode, 409);
  assert.ok(await prisma.tool.findUnique({ where: { id: probe.id } }));
});

test('删除版本后文件不在了', async () => {
  const toolId = await newTool('del-version');
  const v = (await upload(ctx.tokens.admin, toolId, Buffer.from('version'))).json();
  const row = await prisma.toolVersion.findUniqueOrThrow({ where: { id: v.id } });
  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/tools/${toolId}/versions/${v.id}`,
    headers: bearer(ctx.tokens.admin),
  });
  assert.equal(res.statusCode, 204, res.body);
  assert.equal(existsSync(join(ctx.storageDir, row.storageKey)), false);
  assert.equal(await prisma.toolVersion.count({ where: { id: v.id } }), 0);
  const again = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/tools/${toolId}/versions/${v.id}`,
    headers: bearer(ctx.tokens.admin),
  });
  assert.equal(again.statusCode, 404);
});

test('删除工具：文件和下载记录一起删掉，写审计 tool.delete', async () => {
  const toolId = await newTool('del-tool');
  const v = (await upload(ctx.tokens.admin, toolId, Buffer.from('to be removed'))).json();
  const row = await prisma.toolVersion.findUniqueOrThrow({ where: { id: v.id } });
  await prisma.toolDownload.create({
    data: { toolId, versionId: v.id, kind: 'package', ip: '10.1.1.1' },
  });
  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/tools/${toolId}`,
    headers: bearer(ctx.tokens.admin),
  });
  assert.equal(res.statusCode, 204, res.body);
  assert.equal(existsSync(join(ctx.storageDir, row.storageKey)), false);
  assert.equal(await prisma.tool.count({ where: { id: toolId } }), 0);
  assert.equal(await prisma.toolDownload.count({ where: { toolId } }), 0);
  const log = await prisma.auditLog.findFirst({
    where: { action: 'tool.delete', targetId: toolId },
  });
  assert.ok(log, '缺少 tool.delete 审计');
});

test('平台管理员在「全部租户」视角下也能管理工具（平台级内容）', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/tools',
    headers: { ...bearer(ctx.tokens.admin), 'x-lse-tenant': 'all' },
    payload: { code: `${P}all-view`, name: '全局视角', category: 'content' },
  });
  assert.equal(res.statusCode, 201, res.body);
});
