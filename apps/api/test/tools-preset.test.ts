import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '../src/db.js';
import { registerPresetToolVersion } from '../src/modules/tools/preset.js';

// 集成：语料扫描命令行版作为预置工具登记进工具中心（部署时在容器里跑）。

const CODE = 'corpus-scan-cli';
let dir = '';
let storage = '';
let prevStorage: string | undefined;

async function cleanup(): Promise<void> {
  await prisma.tool.deleteMany({ where: { code: CODE } });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tools-preset-'));
  storage = mkdtempSync(join(tmpdir(), 'tools-preset-store-'));
  prevStorage = process.env.TOOL_STORAGE_DIR;
  process.env.TOOL_STORAGE_DIR = storage;
  await cleanup();
});

after(async () => {
  await cleanup();
  if (prevStorage === undefined) delete process.env.TOOL_STORAGE_DIR;
  else process.env.TOOL_STORAGE_DIR = prevStorage;
  rmSync(dir, { recursive: true, force: true });
  rmSync(storage, { recursive: true, force: true });
  await prisma.$disconnect();
});

test('首次登记建出数据安全类工具和版本，再登记同一文件不重复建', async () => {
  const file = join(dir, 'corpus-scan-cli-9.9.9.tar.gz');
  writeFileSync(file, 'fake tarball v1');
  const sha = createHash('sha256').update('fake tarball v1').digest('hex');

  const first = await registerPresetToolVersion(prisma, { code: CODE, file, version: '9.9.9' });
  assert.equal(first.toolCreated, true);
  assert.equal(first.versionCreated, true);
  assert.equal(first.sha256, sha);
  const tool = await prisma.tool.findUniqueOrThrow({
    where: { code: CODE },
    include: { versions: true },
  });
  assert.equal(tool.category, 'data');
  assert.equal(tool.taskEntry, 'corpus-scan');
  assert.equal(tool.builtin, false, '预置工具是普通工具，管理员可以上传新版本');
  assert.equal(tool.versions.length, 1);
  assert.equal(tool.versions[0]!.os, 'any');
  assert.equal(tool.versions[0]!.filename, 'corpus-scan-cli-9.9.9.tar.gz');
  assert.equal(readdirSync(storage).length, 1);

  const again = await registerPresetToolVersion(prisma, { code: CODE, file, version: '9.9.9' });
  assert.equal(again.toolCreated, false);
  assert.equal(again.versionCreated, false);
  assert.equal(again.versionId, first.versionId);
  assert.equal(readdirSync(storage).length, 1, '重复登记不留多余文件');
});

test('同一版本换了内容报错，不覆盖；已存在的工具不改管理员的修改', async () => {
  const tool = await prisma.tool.findUniqueOrThrow({ where: { code: CODE } });
  await prisma.tool.update({
    where: { id: tool.id },
    data: { name: '管理员改过的名字', hidden: true },
  });
  const other = join(dir, 'other.tar.gz');
  writeFileSync(other, 'fake tarball v2');
  await assert.rejects(
    registerPresetToolVersion(prisma, { code: CODE, file: other, version: '9.9.9' }),
    /内容不同/,
  );
  assert.equal(readdirSync(storage).length, 1, '报错时不留新文件');

  const next = await registerPresetToolVersion(prisma, {
    code: CODE,
    file: other,
    version: '9.9.10',
    releaseNotes: '新版本',
  });
  assert.equal(next.versionCreated, true);
  const after2 = await prisma.tool.findUniqueOrThrow({ where: { code: CODE } });
  assert.equal(after2.name, '管理员改过的名字');
  assert.equal(after2.hidden, true);
});
