import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { AppError, badRequest } from '../../lib/errors.js';
import { formatBytes } from './units.js';

export const CHUNK_BYTES = 64 * 1024 * 1024;
export const DISK_RESERVE_BYTES = 5 * 1024 ** 3;
const STALE_MS = 7 * 86400000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function libraryPaths(dir: string, id: string) {
  if (!UUID.test(id)) throw badRequest('上传文件标识不正确', 'MODEL_FILE_UPLOAD_ID');
  return { part: join(dir, `${id}.part`), final: join(dir, `${id}.bin`) };
}
export function uploadByteLimit(configured: number) {
  return configured > 0 ? configured : Number.MAX_SAFE_INTEGER;
}
export function assertDiskSpace(freeBytes: number, needed: number) {
  if (freeBytes < DISK_RESERVE_BYTES || needed > freeBytes - DISK_RESERVE_BYTES) {
    throw new AppError(
      413,
      `服务器磁盘剩余 ${formatBytes(freeBytes)}，需要 ${formatBytes(needed)}；还需为系统保留 5 GiB，请删除不再使用的上传文件或联系管理员扩容`,
      'MODEL_FILE_DISK_FULL',
      { diskFreeBytes: freeBytes, neededBytes: needed },
    );
  }
}
export async function diskFreeBytes(dir: string) {
  const disk = await statfs(dir, { bigint: true });
  return Number(disk.bavail * disk.bsize);
}
export function assertOffset(offset: number, bytes: number) {
  if (offset !== bytes)
    throw new AppError(
      409,
      `上传进度已变化，服务器已收到 ${bytes} 字节，将从此处继续`,
      'MODEL_FILE_UPLOAD_OFFSET',
      { bytes },
    );
}
export function assertUploadSize(bytes: number, expectedBytes: number | null) {
  if (expectedBytes !== null && expectedBytes !== bytes)
    throw new AppError(409, '文件尚未完整上传，请继续上传后重试', 'MODEL_FILE_UPLOAD_INCOMPLETE', {
      bytes,
      expectedBytes,
    });
}
export function isStaleUpload(row: { status: string; updatedAt: Date }, now = Date.now()) {
  return row.status === 'UPLOADING' && now - row.updatedAt.getTime() > STALE_MS;
}

/** 每块写入失败即回退到已确认位置；从不缓存整个文件。调用方负责会话互斥。 */
export async function appendLibraryChunk(
  path: string,
  offset: number,
  body: Readable,
  checkSpace?: (needed: number) => Promise<void>,
  maxBytes = CHUNK_BYTES,
) {
  const handle = await open(path, 'r+');
  let received = 0;
  let canRollback = false;
  try {
    const info = await handle.stat();
    if (info.size < offset)
      throw new AppError(409, '服务器上的上传内容不完整，请重新上传', 'MODEL_FILE_UPLOAD_DAMAGED');
    canRollback = true;
    await handle.truncate(offset);
    for await (const input of body) {
      const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
      received += chunk.length;
      if (received > maxBytes)
        throw new AppError(413, '本次传输内容过大，请分段上传', 'MODEL_FILE_CHUNK_TOO_LARGE');
      await checkSpace?.(chunk.length);
      let written = 0;
      while (written < chunk.length) {
        const result = await handle.write(
          chunk,
          written,
          chunk.length - written,
          offset + received - chunk.length + written,
        );
        if (result.bytesWritten === 0) throw new Error('上传文件写入失败');
        written += result.bytesWritten;
      }
    }
    await handle.sync();
    return offset + received;
  } catch (e) {
    if (canRollback) await handle.truncate(offset);
    if ((e as NodeJS.ErrnoException).code === 'ENOSPC')
      throw new AppError(
        413,
        '服务器磁盘空间不足，请删除不再使用的上传文件或联系管理员扩容',
        'MODEL_FILE_DISK_FULL',
      );
    throw e;
  } finally {
    await handle.close();
  }
}
export async function finishLibraryUpload(
  dir: string,
  id: string,
  bytes: number,
  expected: number | null,
) {
  assertUploadSize(bytes, expected);
  const paths = libraryPaths(dir, id);
  // 改名后数据库写入中断时，允许重复完成以恢复会话。
  const part = await stat(paths.part).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return false;
      throw e;
    },
  );
  const path = part ? paths.part : paths.final;
  const info = await stat(path);
  assertUploadSize(info.size, bytes);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (part) await rename(paths.part, paths.final);
  return { sha256: hash.digest('hex') };
}
export async function deleteLibraryFiles(dir: string, id: string) {
  const paths = libraryPaths(dir, id);
  await rm(paths.part, { force: true });
  await rm(paths.final, { force: true });
}

/** 旧上传入口同样流式处理，0 表示不限制文件总大小。 */
export function uploadStreamLimit(
  maxBytes: number,
  onBytes: (bytes: number) => void,
  checkSpace?: (needed: number) => Promise<void>,
) {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      onBytes(seen);
      if (maxBytes > 0 && seen > maxBytes)
        cb(
          new AppError(
            413,
            `上传超过管理员设置的 ${formatBytes(maxBytes)} 文件大小上限`,
            'MODEL_FILE_UPLOAD_TOO_LARGE',
          ),
        );
      else if (checkSpace)
        checkSpace(chunk.length)
          .then(() => cb(null, chunk))
          .catch(cb);
      else cb(null, chunk);
    },
  });
}
