import { lstat, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MODEL_FILE_EXT } from './filesystem.js';

export const BROWSE_LIMITS = {
  /** 子目录、模型文件各自最多返回的条数。 */
  maxEntries: 500,
  /** 单个目录最多读取的目录项数，防止一个目录里有几十万项拖垮接口。 */
  maxScanned: 5000,
} as const;

export interface BrowseFile {
  name: string;
  bytes: number;
  /** 最后修改时间（ISO 8601）。 */
  modifiedAt: string;
}
export interface BrowseResult {
  /** 目录名，按名称排序，最多 maxEntries 个。 */
  directories: string[];
  directoryTotal: number;
  /** 模型文件，按名称排序，最多 maxEntries 个。 */
  modelFiles: BrowseFile[];
  modelFileTotal: number;
  /** 本级文件总数（含非模型文件）。 */
  fileCount: number;
  /** 其中不是模型文件的数量。 */
  otherFileCount: number;
  /** 子目录或模型文件有一项被截断，只显示了前 limit 个。 */
  truncated: boolean;
  /** 目录项太多，只读取并统计了前 maxScanned 项。 */
  scanLimited: boolean;
  limit: number;
}

const byName = (a: string, b: string) => a.localeCompare(b);

/**
 * 列出一个目录下的子目录与模型文件。路径必须已经过白名单校验（真实路径）。
 * 子目录符号链接不列出；指向文件的符号链接按文件统计。
 */
export async function browseDirectory(
  real: string,
  limits: { maxEntries: number; maxScanned: number } = BROWSE_LIMITS,
): Promise<BrowseResult> {
  const all = await readdir(real, { withFileTypes: true });
  const scanLimited = all.length > limits.maxScanned;
  const dirs: string[] = [];
  const models: BrowseFile[] = [];
  let files = 0;
  for (const entry of all.slice(0, limits.maxScanned)) {
    const p = resolve(real, entry.name);
    const info = await lstat(p).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) dirs.push(entry.name);
    else if (info.isFile() || info.isSymbolicLink()) {
      files++;
      if (!MODEL_FILE_EXT.test(entry.name)) continue;
      const target = info.isFile() ? info : await stat(p).catch(() => null);
      if (target?.isFile())
        models.push({
          name: entry.name,
          bytes: target.size,
          modifiedAt: target.mtime.toISOString(),
        });
    }
  }
  dirs.sort(byName);
  models.sort((a, b) => byName(a.name, b.name));
  const truncated =
    dirs.length > limits.maxEntries || models.length > limits.maxEntries || scanLimited;
  return {
    directories: dirs.slice(0, limits.maxEntries),
    directoryTotal: dirs.length,
    modelFiles: models.slice(0, limits.maxEntries),
    modelFileTotal: models.length,
    fileCount: files,
    otherFileCount: files - models.length,
    truncated,
    scanLimited,
    limit: limits.maxEntries,
  };
}
