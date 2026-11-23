import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { ArchiveError, DEFAULT_ARCHIVE_LIMITS, extractArchive } from '../src/modules/engines/ai-asset/archive.js';
import { runAiComponentEngine } from '../src/modules/engines/ai-asset/engine/index.js';

// e2e 验收缺陷 3：高压缩比炸弹先被“单文件 2MiB 跳过”吃掉，提示成“没有可扫描文件（已跳过 1 个）”。
// 样本全部在测试内生成（几 KB 的压缩包声明解压出数 MiB），不提交大文件。
const MIB = 1024 * 1024;
const PREFIX = 'AICE2E-';
let app!: FastifyInstance;
let token = '';

function tarEntry(name: string, data: Buffer): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('0', 156);
  h.write('ustar\0' + '00', 257, 'latin1');
  return Buffer.concat([h, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length)]);
}
const zipBomb = () => Buffer.from(zipSync({ 'payload.txt': Buffer.alloc(8 * MIB, 0x30), 'ok.py': Buffer.from('print(1)') }, { level: 9 }));
const isBomb = (e: unknown) => e instanceof ArchiveError && e.code === 'ARCHIVE_BOMB';

before(async () => {
  app = await buildApp();
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: ['Admin', '@', '12345'].join('') } });
  token = login.json().token;
});

after(async () => {
  await prisma.aiComponentScan.deleteMany({ where: { assetName: { startsWith: PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

const upload = (fileName: string, body: Buffer) =>
  app.inject({
    method: 'POST',
    url: `/api/engines/ai-components/scans/upload?${new URLSearchParams({ assetName: `${PREFIX}${fileName}`, assetType: 'MCP', fileName, mode: 'ARCHIVE' })}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    payload: body,
  });

test('zip：超过单文件上限的高压缩比条目判为压缩炸弹，提示压缩比与声明解压体积', () => {
  const bomb = zipBomb();
  assert.ok(bomb.length < 64 * 1024, `样本应很小，实际 ${bomb.length}`);
  assert.throws(() => extractArchive(bomb, 'zip'), (e: unknown) => {
    assert.ok(isBomb(e), String(e));
    assert.match((e as Error).message, /疑似压缩炸弹/);
    assert.match((e as Error).message, /压缩比 \d+:1/);
    assert.match((e as Error).message, /声明解压体积 8\.0 MiB/);
    return true;
  });
});

test('zip：多个条目各自压缩比不高但声明总体积超限且整体压缩比异常，也判为压缩炸弹', () => {
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < 6; i++) files[`f${i}.bin`] = Buffer.concat([randomBytes(8 * 1024), Buffer.alloc(MIB, 0x31)]);
  const z = Buffer.from(zipSync(files, { level: 9 }));
  assert.throws(() => extractArchive(z, 'zip', { ...DEFAULT_ARCHIVE_LIMITS, maxRatio: 1e6, maxTotalBytes: 4 * MIB }), (e: unknown) => isBomb(e) && /声明解压体积 6\.\d MiB/.test((e as Error).message));
});

test('负例：不可压缩的普通超大文件只跳过，原因写明“超过单文件上限 2MiB”，其余文件照常解出', () => {
  const z = Buffer.from(zipSync({ 'model.bin': randomBytes(3 * MIB), 'ok.py': Buffer.from('print(1)') }, { level: 0 }));
  const r = extractArchive(z, 'zip');
  assert.deepEqual(r.entries.map((e) => e.path), ['ok.py']);
  assert.equal(r.skipped[0]?.path, 'model.bin');
  assert.match(r.skipped[0]!.reason, /超过单文件上限 2MiB/);
  const t = extractArchive(Buffer.concat([tarEntry('big.py', randomBytes(3 * MIB)), tarEntry('ok.py', Buffer.from('x')), Buffer.alloc(1024)]), 'tar');
  assert.match(t.skipped[0]!.reason, /超过单文件上限 2MiB/);
  const eng = runAiComponentEngine({ assetType: 'MCP', files: [{ path: 'big.py', content: 'x'.repeat(3 * MIB) }] });
  assert.match(eng.skippedFiles[0]!.reason, /超过单文件上限 2MiB/);
});

test('tgz：gzip 声明解压体积超过总上限时直接判为压缩炸弹并给出压缩比与声明体积', () => {
  const tgz = gzipSync(Buffer.concat([tarEntry('a.txt', Buffer.alloc(8 * MIB, 0)), Buffer.alloc(1024)]), { level: 9 });
  assert.throws(() => extractArchive(tgz, 'tgz', { ...DEFAULT_ARCHIVE_LIMITS, maxTotalBytes: 4 * MIB }), (e: unknown) => {
    assert.ok(isBomb(e), String(e));
    assert.match((e as Error).message, /疑似压缩炸弹：.*压缩比 \d+:1.*声明解压体积 8\.0 MiB/);
    return true;
  });
});

test('上传压缩炸弹：返回明确的压缩炸弹错误（不是“没有可扫描文件”），失败记录保留原因', async () => {
  const r = await upload('bomb.zip', zipBomb());
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().error.code, 'ARCHIVE_BOMB');
  assert.match(r.json().error.message, /疑似压缩炸弹/);
  assert.doesNotMatch(r.json().error.message, /没有可扫描/);
  const row = await prisma.aiComponentScan.findFirstOrThrow({ where: { assetName: `${PREFIX}bomb.zip` } });
  assert.equal(row.status, 'FAILED');
  assert.match(row.error ?? '', /疑似压缩炸弹/);
});

test('上传只含超大文件的压缩包：提示列出跳过原因，扫描详情可看到跳过清单', async () => {
  const r = await upload('big.zip', Buffer.from(zipSync({ 'weights.py': randomBytes(3 * MIB) }, { level: 0 })));
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().error.code, 'AI_COMPONENT_NO_TEXT');
  assert.match(r.json().error.message, /weights\.py：超过单文件上限 2MiB/);
  const id = r.json().error.details?.scanId ?? (await prisma.aiComponentScan.findFirstOrThrow({ where: { assetName: `${PREFIX}big.zip` } })).id;
  const d = await app.inject({ method: 'GET', url: `/api/engines/ai-components/scans/${id}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(d.json().skippedCount, 1);
  assert.deepEqual(d.json().files, [{ path: 'weights.py', skipped: '超过单文件上限 2MiB，未解压' }]);
});
