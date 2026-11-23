import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, badRequest } from '../../lib/errors.js';

// 语料文件存储：CORPUS_STORAGE_DIR（默认在现网 api、worker 共用的持久卷 model_scan_uploads 下），
// 文件名只用服务端生成的 uuid，不用客户端文件名；扫完保留，删除扫描时删文件。
// 打码副本由 worker 在扫描完成时生成，与原文件放在同一目录，也用 uuid 命名。
// 原文件和打码副本保留 CORPUS_RETENTION_DAYS 天（默认 30），worker 每天清理一次，扫描结果保留。
// 目录、上限、保留天数每次调用时读环境变量（测试里可以临时改）。

export const DEFAULT_CORPUS_STORAGE_DIR = '/var/lib/lse/model-scan-uploads/corpus';
export const DEFAULT_CORPUS_UPLOAD_MAX_BYTES = 500 * 1024 * 1024;
export const DEFAULT_CORPUS_RETENTION_DAYS = 30;
/** 上传前磁盘至少要比声明的文件大小多留这么多空间 */
export const DEFAULT_CORPUS_DISK_RESERVE_BYTES = 1024 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function positiveEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function corpusStorageDir(): string {
  return process.env.CORPUS_STORAGE_DIR?.trim() || DEFAULT_CORPUS_STORAGE_DIR;
}

export function corpusUploadMaxBytes(): number {
  return positiveEnv('CORPUS_UPLOAD_MAX_BYTES', DEFAULT_CORPUS_UPLOAD_MAX_BYTES);
}

export function corpusRetentionDays(): number {
  return positiveEnv('CORPUS_RETENTION_DAYS', DEFAULT_CORPUS_RETENTION_DAYS);
}

export function corpusDiskReserveBytes(): number {
  return positiveEnv('CORPUS_DISK_RESERVE_BYTES', DEFAULT_CORPUS_DISK_RESERVE_BYTES);
}

/** 原文件和打码副本都按 uuid 存：<目录>/<uuid>.dat */
export function corpusFilePath(storageKey: string): string {
  if (!UUID.test(storageKey)) throw new Error('非法的语料文件 ID');
  return join(corpusStorageDir(), `${storageKey}.dat`);
}

export async function removeCorpusFile(storageKey: string | null | undefined): Promise<void> {
  if (!storageKey || !UUID.test(storageKey)) return;
  await rm(corpusFilePath(storageKey), { force: true });
}

function formatLimit(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} 字节`;
}

export function corpusUploadTooLarge(max: number): AppError {
  return new AppError(413, `语料文件不能超过 ${formatLimit(max)}`, 'CORPUS_UPLOAD_TOO_LARGE');
}

/** 存储目录所在磁盘的剩余空间不够放下 bytes 再留出余量时 507。 */
export async function assertCorpusDiskSpace(bytes: number): Promise<void> {
  const dir = corpusStorageDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const s = await statfs(dir);
  const free = s.bavail * s.bsize;
  if (free < bytes + corpusDiskReserveBytes()) {
    throw new AppError(507, '服务器存储空间不足，请联系管理员清理后再上传', 'CORPUS_DISK_FULL');
  }
}

/** 流式写盘，边写边算 sha256；超过上限 413，空文件 400，出错时删掉半截文件。 */
export async function storeCorpusUpload(
  source: Readable,
  max: number,
): Promise<{ storageKey: string; bytes: number; sha256: string }> {
  const dir = corpusStorageDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const storageKey = randomUUID();
  const dest = corpusFilePath(storageKey);
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > max) return cb(corpusUploadTooLarge(max));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(source, meter, createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
  } catch (e) {
    await rm(dest, { force: true });
    throw e;
  }
  if (bytes === 0) {
    await rm(dest, { force: true });
    throw badRequest('上传的文件是空的', 'CORPUS_UPLOAD_EMPTY');
  }
  return { storageKey, bytes, sha256: hash.digest('hex') };
}
