import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BIDI_CONTROLS } from '../../lib/attachment.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';

// 工具中心的文件存储：安装包和手册都落在 TOOL_STORAGE_DIR，文件名只用服务端生成的 uuid，
// 不信任客户端文件名（只作展示）。流式写盘、边写边算 sha256，超过上限立即中止并删掉半截文件。
// 环境变量在调用时读取（测试和运维改了无需重启路由注册）。

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 现网 api、worker 都挂了可写的持久卷 model_scan_uploads，工具中心放在它下面，不改 compose。 */
export const DEFAULT_TOOL_STORAGE_DIR = '/var/lib/lse/model-scan-uploads/tool-center';
export const DEFAULT_TOOL_UPLOAD_MAX_BYTES = 1024 ** 3;
/** 写盘前磁盘至少要剩「声明长度 + 1 GiB」，不够就提前拒绝，不把卷写满。 */
export const DISK_RESERVE_BYTES = 1024 ** 3;
/** 存放超过这么久的半截文件（*.part）当作进程被杀等情况留下的，启动时清掉。 */
const STALE_PART_MS = 24 * 3600_000;

/** 可替换的依赖（测试注入磁盘剩余空间）。 */
export const storageDeps = {
  statfs: (dir: string): Promise<{ bavail: number; bsize: number }> => statfs(dir),
};

export function toolStorageDir(): string {
  return process.env.TOOL_STORAGE_DIR?.trim() || DEFAULT_TOOL_STORAGE_DIR;
}

export function toolUploadMaxBytes(): number {
  const raw = Number(process.env.TOOL_UPLOAD_MAX_BYTES);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_TOOL_UPLOAD_MAX_BYTES;
}

export function storedPath(storageKey: string): string {
  if (!UUID.test(storageKey)) throw new Error('非法的存储键');
  return join(toolStorageDir(), storageKey);
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${+(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${+(bytes / 1024 ** 2).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${+(bytes / 1024).toFixed(2)} KiB`;
  return `${bytes} 字节`;
}

export function tooLarge(maxBytes: number, what = '文件'): AppError {
  return new AppError(413, `${what}超过 ${formatSize(maxBytes)} 的上限`, 'TOOL_UPLOAD_TOO_LARGE', {
    maxBytes,
  });
}

export function diskFull(): AppError {
  return new AppError(507, '存储空间不足，请删除不再使用的文件或联系管理员扩容', 'TOOL_DISK_FULL');
}

/** 剩余空间不够「声明长度 + 1 GiB」时拒绝；查不到剩余空间时不拦（写盘时的 ENOSPC 兜底）。 */
async function ensureFreeSpace(dir: string, declaredLength: number): Promise<void> {
  let free: number;
  try {
    const info = await storageDeps.statfs(dir);
    free = Number(info.bavail) * Number(info.bsize);
  } catch {
    return;
  }
  if (free <= declaredLength + DISK_RESERVE_BYTES) throw diskFull();
}

export interface StoredFile {
  storageKey: string;
  size: number;
  sha256: string;
}

/** 把请求体（application/octet-stream 原始字节流）写进存储目录。 */
export async function storeUpload(
  body: unknown,
  declaredLength: number,
  maxBytes: number,
  what = '文件',
): Promise<StoredFile> {
  if (declaredLength > maxBytes) throw tooLarge(maxBytes, what);
  if (!(body && typeof (body as Readable).pipe === 'function'))
    throw badRequest('上传方式不正确，请在页面中选择文件上传', 'TOOL_UPLOAD_TYPE');
  const dir = toolStorageDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await ensureFreeSpace(dir, declaredLength);
  const storageKey = randomUUID();
  const final = join(dir, storageKey);
  const part = `${final}.part`;
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(tooLarge(maxBytes, what));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(body as Readable, meter, createWriteStream(part, { flags: 'wx', mode: 0o600 }));
  } catch (e) {
    await rm(part, { force: true });
    if ((e as NodeJS.ErrnoException).code === 'ENOSPC') throw diskFull();
    throw e;
  }
  if (size === 0) {
    await rm(part, { force: true });
    throw badRequest('上传文件为空', 'TOOL_UPLOAD_EMPTY');
  }
  await rename(part, final);
  return { storageKey, size, sha256: hash.digest('hex') };
}

/**
 * 清掉存储目录里存放超过 1 天的半截文件（<uuid>.part，进程被杀、断电等情况留下的）。
 * 目录不存在时什么也不做。返回删掉的个数。
 */
export async function sweepStaleParts(dir = toolStorageDir(), now = Date.now()): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.part') || !UUID.test(name.slice(0, -'.part'.length))) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || now - info.mtimeMs <= STALE_PART_MS) continue;
    await rm(path, { force: true });
    removed++;
  }
  return removed;
}

/** 删除存储的文件；文件已不在也不报错。 */
export async function removeStored(storageKey: string): Promise<void> {
  if (!UUID.test(storageKey)) return;
  await rm(join(toolStorageDir(), storageKey), { force: true });
}

/** 打开存储的文件准备下载；文件丢失时 404。 */
export async function openStored(storageKey: string) {
  const path = storedPath(storageKey);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw notFound('文件已丢失，请联系管理员重新上传', 'TOOL_FILE_MISSING');
  return { size: info.size, stream: createReadStream(path) };
}

/** 客户端给的文件名只作展示：去掉路径、控制字符和 Unicode 双向控制符，限长。 */
export function displayFilename(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(BIDI_CONTROLS, '')
    .trim()
    .slice(0, 255);
}
