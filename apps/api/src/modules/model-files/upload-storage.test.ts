import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanupScanUpload, uploadPathFor, uploadMetaPathFor } from './upload-storage.js';

const uploadId = '12345678-1234-1234-1234-123456789abc';

test('库文件扫描完成后仍保留原文件与元信息', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-library-'));
  try {
    await writeFile(uploadPathFor(uploadId, dir), '模型文件');
    await writeFile(uploadMetaPathFor(uploadId, dir), '{}');
    await cleanupScanUpload({ uploadId, libraryUpload: true }, dir);
    assert.equal(await readFile(uploadPathFor(uploadId, dir), 'utf8'), '模型文件');
    assert.equal(await readFile(uploadMetaPathFor(uploadId, dir), 'utf8'), '{}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('一次性上传扫描完成后删除原文件与元信息', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-library-'));
  try {
    await writeFile(uploadPathFor(uploadId, dir), '模型文件');
    await writeFile(uploadMetaPathFor(uploadId, dir), '{}');
    await cleanupScanUpload({ uploadId }, dir);
    await assert.rejects(readFile(uploadPathFor(uploadId, dir)), { code: 'ENOENT' });
    await assert.rejects(readFile(uploadMetaPathFor(uploadId, dir)), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件路径拒绝越界和非标准标识', () => {
  for (const id of [
    '../models/model.bin',
    '/models/model.bin',
    '任意文件名',
    `${uploadId}/../model`,
  ]) {
    assert.throws(() => uploadPathFor(id), /非法的上传/);
    assert.throws(() => uploadMetaPathFor(id), /非法的上传/);
  }
});
