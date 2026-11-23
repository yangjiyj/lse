import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  assertDiskSpace,
  assertUploadSize,
  assertOffset,
  libraryPaths,
  appendLibraryChunk,
  finishLibraryUpload,
  deleteLibraryFiles,
  isStaleUpload,
  CHUNK_BYTES,
  DISK_RESERVE_BYTES,
  uploadByteLimit,
  uploadStreamLimit,
} from './library-storage.js';

const failsWith = (status: number) => (e: unknown) =>
  (e as { statusCode?: number }).statusCode === status;

test('磁盘预留 5 GiB，空间不足明确说明剩余和所需', () => {
  assert.throws(
    () => assertDiskSpace(DISK_RESERVE_BYTES + 4, 5),
    (e: unknown) => {
      assert.equal((e as { statusCode: number }).statusCode, 413);
      assert.match((e as Error).message, /服务器磁盘剩余.*需要/);
      return true;
    },
  );
  assertDiskSpace(DISK_RESERVE_BYTES + 5, 5);
  assert.throws(() => assertDiskSpace(DISK_RESERVE_BYTES - 1, 0), failsWith(413));
});
test('断点只能从服务器已收位置继续，冲突携带位置', () => {
  assertOffset(12, 12);
  assert.throws(
    () => assertOffset(11, 12),
    (e: unknown) => {
      assert.equal((e as { statusCode: number }).statusCode, 409);
      assert.deepEqual((e as { details: unknown }).details, { bytes: 12 });
      return true;
    },
  );
});
test('完成时校验声明大小，可选硬上限默认零不限制旧接口大文件', () => {
  assert.throws(() => assertUploadSize(2, 3), failsWith(409));
  assertUploadSize(3, 3);
  assert.equal(uploadByteLimit(0), Number.MAX_SAFE_INTEGER);
  assert.ok(uploadByteLimit(0) > 2 * 1024 ** 3);
  assert.equal(uploadByteLimit(100), 100);
});
test('路径只能由 uuid 推导，拒绝目录穿越和非 uuid', () => {
  for (const id of ['../models/abc', '/models/abc', 'abc', '..']) {
    assert.throws(() => libraryPaths('/tmp/uploads', id), failsWith(400));
  }
});
test('只有超过七天无进展的上传中会话被清理，完成文件永不清理', () => {
  const old = new Date(Date.now() - 8 * 86400000);
  assert.equal(isStaleUpload({ status: 'READY', updatedAt: old }), false);
  assert.equal(isStaleUpload({ status: 'UPLOADING', updatedAt: old }), true);
  assert.equal(isStaleUpload({ status: 'UPLOADING', updatedAt: new Date() }), false);
});
test('实际分块续写、校验、流式指纹、改名及删除只作用于库文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), '模型库-'));
  try {
    const id = randomUUID();
    const paths = libraryPaths(dir, id);
    const other = join(dir, '服务器模型.safetensors');
    await writeFile(other, '不要删除');
    await writeFile(paths.part, '');
    assert.equal(await appendLibraryChunk(paths.part, 0, Readable.from(['abc'])), 3);
    assert.equal(await appendLibraryChunk(paths.part, 3, Readable.from(['def'])), 6);
    await assert.rejects(finishLibraryUpload(dir, id, 6, 7), failsWith(409));
    const result = await finishLibraryUpload(dir, id, 6, 6);
    assert.equal(result.sha256, createHash('sha256').update('abcdef').digest('hex'));
    assert.equal(await readFile(paths.final, 'utf8'), 'abcdef');
    await deleteLibraryFiles(dir, id);
    await assert.rejects(stat(paths.final));
    assert.equal(await readFile(other, 'utf8'), '不要删除');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('失败的分块回滚已写字节，重试不会重复或破坏已确认内容', async () => {
  const dir = await mkdtemp(join(tmpdir(), '模型库-'));
  const path = join(dir, 'part');
  try {
    await writeFile(path, 'abc');
    const broken = Readable.from(
      (async function* () {
        yield Buffer.from('def');
        throw new Error('网络中断');
      })(),
    );
    await assert.rejects(appendLibraryChunk(path, 3, broken), /网络中断/);
    assert.equal(await readFile(path, 'utf8'), 'abc');
    await assert.rejects(
      appendLibraryChunk(path, 3, Readable.from([Buffer.alloc(CHUNK_BYTES + 1)])),
      failsWith(413),
    );
    assert.equal(await readFile(path, 'utf8'), 'abc');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缺损文件被拒绝后保持原样，绝不能补零伪造已收内容', async () => {
  const dir = await mkdtemp(join(tmpdir(), '模型库-'));
  const path = join(dir, 'part');
  try {
    await writeFile(path, 'abc');
    await assert.rejects(appendLibraryChunk(path, 5, Readable.from(['x'])), failsWith(409));
    assert.equal(await readFile(path, 'utf8'), 'abc');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('旧流式上传实际接收超过 2 GiB 的内容，无需把整个文件存入内存', async () => {
  const buffer = Buffer.alloc(8 * 1024 ** 2);
  let received = 0;
  await pipeline(
    Readable.from(
      (function* () {
        for (let i = 0; i < 257; i++) yield buffer;
      })(),
    ),
    uploadStreamLimit(0, (n) => {
      received = n;
    }),
    new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    }),
  );
  assert.equal(received, 257 * buffer.length);
  await assert.rejects(
    pipeline(
      Readable.from(['abcd']),
      uploadStreamLimit(3, () => {}),
      new Writable({
        write(_chunk, _enc, cb) {
          cb();
        },
      }),
    ),
    failsWith(413),
  );
});

test('每块写入前再次核对磁盘，空间不足时保留已确认的字节', async () => {
  const dir = await mkdtemp(join(tmpdir(), '模型库-'));
  const path = join(dir, 'part');
  try {
    await writeFile(path, 'abc');
    await assert.rejects(
      appendLibraryChunk(path, 3, Readable.from(['def']), async (needed) =>
        assertDiskSpace(DISK_RESERVE_BYTES + 1, needed),
      ),
      failsWith(413),
    );
    assert.equal(await readFile(path, 'utf8'), 'abc');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
