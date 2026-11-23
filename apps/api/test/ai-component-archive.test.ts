import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import {
  ArchiveError,
  DEFAULT_ARCHIVE_LIMITS,
  detectArchiveKind,
  extractArchive,
  safeEntryPath,
} from '../src/modules/engines/ai-asset/archive.js';

function tarEntry(name: string, body: Buffer | string, type = '0', linkname = ''): Buffer {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(linkname, 157, 100);
  h.write('ustar\0' + '00', 257, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
  return Buffer.concat([h, data, pad]);
}
const tar = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)]);

/** 把 zip 中第一个条目的中央目录外部属性改为符号链接（Unix madeBy=3，mode=0120777） */
function markFirstZipEntrySymlink(zip: Uint8Array): Buffer {
  const b = Buffer.from(zip);
  const cd = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  b.writeUInt16LE((3 << 8) | 20, cd + 4);
  b.writeUInt32LE((0o120777 << 16) >>> 0, cd + 38);
  return b;
}

test('识别 zip / tar / tgz / 单文件', () => {
  const z = Buffer.from(zipSync({ 'a.py': Buffer.from('x') }));
  const t = tar(tarEntry('a.py', 'x'));
  assert.equal(detectArchiveKind(z), 'zip');
  assert.equal(detectArchiveKind(t), 'tar');
  assert.equal(detectArchiveKind(gzipSync(t)), 'tgz');
  assert.equal(detectArchiveKind(Buffer.from('print(1)'), 'a.py'), 'file');
});

test('正常 zip 与 tgz 解出文本条目', () => {
  const z = Buffer.from(zipSync({ 'pkg/server.py': Buffer.from('print(1)'), 'pkg/SKILL.md': Buffer.from('# s') }));
  assert.deepEqual(extractArchive(z, 'zip').entries.map((e) => e.path).sort(), ['pkg/SKILL.md', 'pkg/server.py']);
  const t = gzipSync(tar(tarEntry('pkg/', '', '5'), tarEntry('pkg/index.ts', 'export {}')));
  const r = extractArchive(t, 'tgz');
  assert.deepEqual(r.entries.map((e) => [e.path, e.bytes.toString()]), [['pkg/index.ts', 'export {}']]);
});

test('路径规范化拒绝穿越、绝对路径与盘符', () => {
  assert.equal(safeEntryPath('a/./b/c.py'), 'a/b/c.py');
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/Windows/x', 'a\\..\\..\\x', '']) assert.equal(safeEntryPath(bad), null, bad);
});

test('zip 路径穿越被拒绝', () => {
  const z = Buffer.from(zipSync({ '../../evil.py': Buffer.from('x') }));
  assert.throws(() => extractArchive(z, 'zip'), (e: unknown) => e instanceof ArchiveError && e.code === 'ARCHIVE_PATH_TRAVERSAL');
});

test('tar 路径穿越与绝对路径被拒绝', () => {
  for (const name of ['../evil.sh', '/etc/cron.d/x']) {
    assert.throws(() => extractArchive(tar(tarEntry(name, 'x')), 'tar'), (e: unknown) => e instanceof ArchiveError && e.code === 'ARCHIVE_PATH_TRAVERSAL');
  }
});

test('符号链接与硬链接被拒绝（tar 与 zip）', () => {
  assert.throws(() => extractArchive(tar(tarEntry('link', '', '2', '/etc/passwd')), 'tar'), (e: unknown) => e instanceof ArchiveError && e.code === 'ARCHIVE_SYMLINK');
  assert.throws(() => extractArchive(tar(tarEntry('hard', '', '1', 'x')), 'tar'), (e: unknown) => e instanceof ArchiveError && e.code === 'ARCHIVE_SYMLINK');
  const z = markFirstZipEntrySymlink(zipSync({ link: Buffer.from('/etc/passwd') }, { level: 0 }));
  assert.throws(() => extractArchive(z, 'zip'), (e: unknown) => e instanceof ArchiveError && e.code === 'ARCHIVE_SYMLINK');
});

test('设备文件与 FIFO 被拒绝', () => {
  for (const type of ['3', '4', '6']) {
    assert.throws(() => extractArchive(tar(tarEntry('dev', '', type)), 'tar'), (e: unknown) => e instanceof ArchiveError && e.code === 'ARCHIVE_SPECIAL_FILE');
  }
});

test('zip 炸弹：高压缩比条目被拒绝', () => {
  const bomb = Buffer.from(zipSync({ 'a.txt': Buffer.alloc(1024 * 1024, 0x41) }, { level: 9 }));
  assert.throws(() => extractArchive(bomb, 'zip'), (e: unknown) => e instanceof ArchiveError && e.code === 'ARCHIVE_BOMB');
});

test('zip 炸弹：头部谎报大小时以实际解压结果为准', () => {
  const b = Buffer.from(zipSync({ 'a.txt': Buffer.alloc(3 * 1024 * 1024, 0x41) }, { level: 9 }));
  const cd = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  b.writeUInt32LE(100, cd + 24); // 谎报解压后 100 字节
  assert.throws(() => extractArchive(b, 'zip', { ...DEFAULT_ARCHIVE_LIMITS, maxRatio: 1e9 }), (e: unknown) => e instanceof ArchiveError && e.code === 'ARCHIVE_BOMB');
});

test('gzip 炸弹：超过总大小上限被拒绝', () => {
  const big = gzipSync(tar(tarEntry('a.txt', Buffer.alloc(8 * 1024 * 1024, 0))));
  assert.throws(
    () => extractArchive(big, 'tgz', { ...DEFAULT_ARCHIVE_LIMITS, maxTotalBytes: 4 * 1024 * 1024 }),
    (e: unknown) => e instanceof ArchiveError && e.code === 'ARCHIVE_BOMB',
  );
});

test('条目数与总大小上限', () => {
  const many: Record<string, Uint8Array> = {};
  for (let i = 0; i < 12; i++) many[`f${i}.py`] = Buffer.from('x');
  assert.throws(() => extractArchive(Buffer.from(zipSync(many)), 'zip', { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 10 }), (e: unknown) => e instanceof ArchiveError && e.code === 'ARCHIVE_TOO_MANY_ENTRIES');
  const t = tar(tarEntry('a', Buffer.alloc(600)), tarEntry('b', Buffer.alloc(600)));
  assert.throws(() => extractArchive(t, 'tar', { ...DEFAULT_ARCHIVE_LIMITS, maxTotalBytes: 1000 }), (e: unknown) => e instanceof ArchiveError && e.code === 'ARCHIVE_TOO_LARGE');
});

test('超过单文件上限的条目被跳过并明确记录，而非静默丢弃', () => {
  const t = tar(tarEntry('big.py', Buffer.alloc(3000, 0x61)), tarEntry('ok.py', 'x'));
  const r = extractArchive(t, 'tar', { ...DEFAULT_ARCHIVE_LIMITS, maxFileBytes: 2048 });
  assert.deepEqual(r.entries.map((e) => e.path), ['ok.py']);
  assert.equal(r.skipped[0]?.path, 'big.py');
  assert.match(r.skipped[0]!.reason, /超过单文件上限 2KiB/);
});
