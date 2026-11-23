import { constants } from 'node:fs';
import { lstat, open, realpath, readdir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { configInScope, isConfigFile } from './config-file.js';
import { OFFICE_MACRO_FILE, isScriptFile } from './script-scan.js';
import { scanModelSource, sourceSha256, type FormatScan, type ScanLimits } from './scanner.js';
import type { ByteSource } from './source.js';
import { MODEL_FILE_EXT } from './types.js';
import { formatBytes } from './units.js';

export { MODEL_FILE_EXT } from './types.js';

/** 依赖、虚拟环境和版本库目录：里面的脚本是第三方包，不是模型带的代码，目录扫描不进去。 */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'site-packages',
  'dist-packages',
  '.venv',
  'venv',
  '.git',
  '__pycache__',
]);

/**
 * 目录扫描纳入的文件：模型文件、ZIP 压缩包，以及同目录的配置文件、脚本和带宏的 Office 文档
 * （识别模型、检查恶意脚本用）。
 */
export function isScanTarget(name: string): boolean {
  return (
    MODEL_FILE_EXT.test(name) ||
    /\.zip$/i.test(name) ||
    isConfigFile(name) ||
    isScriptFile(name) ||
    OFFICE_MACRO_FILE.test(name)
  );
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1).toLowerCase();

/**
 * 超出数量/总量上限时的取舍顺序：配置文件（小、识别要用）→ 模型文件和与 config.json 同目录的 .py
 * （auto_map 指向的自定义代码）→ 其他脚本和宏文档。configDirs 为含 config.json 的目录。
 */
function scanPriority(path: string, configDirs: ReadonlySet<string>): number {
  if (isConfigFile(path)) return 0;
  if (/\.py$/i.test(path) && configDirs.has(dirOf(path))) return 1;
  return isScriptFile(path) || OFFICE_MACRO_FILE.test(path) ? 2 : 1;
}

export interface DirectoryLimits extends ScanLimits {
  /** 单次目录扫描读取的文件总字节上限；超出后停止并返回已扫描部分。 */
  totalMaxBytes: number;
  maxFiles: number;
}
export type ScannedFile = FormatScan & { path: string; bytes: number; sha256: string };
export interface DirectoryScanResult {
  root: string;
  files: ScannedFile[];
  skipped: number;
  totalBytes: number;
  /** 因数量/总量上限或取消未扫描的模型文件数；>0 表示结果为部分结果。 */
  truncatedFiles: number;
  truncatedReason: string | null;
  /** 跳过的符号链接（目标在白名单外、断链或成环）。 */
  rejectedLinks: string[];
}
export interface ScanHooks {
  /** 每扫完一个文件或读完一块数据时回调；抛错即中止（用于取消）。 */
  onProgress?: (p: {
    files: number;
    bytes: number;
    totalFiles: number;
    totalBytes: number;
  }) => Promise<void>;
  isCancelled?: () => Promise<boolean>;
}
export class ScanCancelled extends Error {}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function realRoots(roots: string[]): Promise<string[]> {
  return (await Promise.all(roots.map((r) => realpath(r).catch(() => null)))).filter(
    (r): r is string => r !== null,
  );
}

/** 解析请求路径并确认其真实路径位于白名单根之内，返回真实路径。 */
export async function resolveAllowed(requestedPath: string, roots: string[]): Promise<string> {
  if (!isAbsolute(requestedPath)) throw new Error('扫描路径必须是绝对路径');
  const rootReal = await realRoots(roots);
  const targetReal = await realpath(requestedPath).catch(() => {
    throw new Error('扫描路径不存在或不可访问');
  });
  if (!rootReal.some((root) => isInside(root, targetReal))) {
    throw new Error('扫描目录不在白名单根路径内');
  }
  return targetReal;
}

/** 打开已解析的真实路径；O_NOFOLLOW 防止解析后被替换为符号链接。 */
async function openReal(path: string): Promise<ByteSource & { close(): Promise<void> }> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const { size } = await handle.stat();
  return {
    size,
    async read(offset, length) {
      const want = Math.max(0, Math.min(length, size - offset));
      const out = Buffer.alloc(want);
      let done = 0;
      while (done < want) {
        const { bytesRead } = await handle.read(out, done, want - done, offset + done);
        if (bytesRead === 0) break;
        done += bytesRead;
      }
      return out.subarray(0, done);
    },
    close: () => handle.close(),
  };
}

interface Candidate {
  display: string;
  real: string;
  size: number;
}

/**
 * 枚举目录下的模型文件。符号链接（HuggingFace 缓存 snapshots/ → blobs/）解析为真实路径，
 * 真实路径在任一白名单根内才纳入，否则记入 rejectedLinks 跳过；同一真实文件只扫一次。
 */
export async function listModelFiles(targetReal: string, roots: string[]) {
  const rootReal = await realRoots(roots);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const visitedDirs = new Set<string>();
  const rejectedLinks: string[] = [];
  let skipped = 0;
  async function walk(dirReal: string, display: string, depth: number): Promise<void> {
    if (depth > 32 || visitedDirs.has(dirReal)) return;
    visitedDirs.add(dirReal);
    for (const entry of (await readdir(dirReal, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = resolve(dirReal, entry.name);
      const shown = display ? `${display}/${entry.name}` : entry.name;
      let real = full;
      let info = await lstat(full);
      if (info.isSymbolicLink()) {
        const r = await realpath(full).catch(() => null);
        if (!r || !rootReal.some((root) => isInside(root, r))) {
          rejectedLinks.push(shown);
          continue;
        }
        real = r;
        info = await stat(r);
      }
      if (info.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(real, shown, depth + 1);
      } else if (info.isFile() && isScanTarget(entry.name)) {
        if (seen.has(real)) continue;
        seen.add(real);
        out.push({ display: shown, real, size: info.size });
      } else skipped++;
    }
  }
  const rootInfo = await stat(targetReal);
  if (rootInfo.isFile()) {
    out.push({ display: targetReal.split(sep).pop()!, real: targetReal, size: rootInfo.size });
    return { candidates: out, skipped, rejectedLinks };
  }
  await walk(targetReal, '', 0);
  // YAML 只留 mergekit 配置和与权重同目录的，CI、docker-compose 等不看
  const weightDirs = new Set(
    out.filter((c) => MODEL_FILE_EXT.test(c.display)).map((c) => dirOf(c.display)),
  );
  const kept = out.filter((c) => !isConfigFile(c.display) || configInScope(c.display, weightDirs));
  return { candidates: kept, skipped: skipped + out.length - kept.length, rejectedLinks };
}

/**
 * 按数量与总量上限挑选要扫描的文件，超出即停并说明原因。
 * 总量按文件大小累加：目录扫描会把每个选中的文件完整读一遍（计算 SHA-256），
 * 所以文件大小就是实际读取量，不存在“只读头部所以可以放宽”的情形。
 */
export function planFiles<T extends { size: number }>(
  candidates: T[],
  limits: { totalMaxBytes: number; maxFiles: number },
) {
  const chosen: T[] = [];
  let planned = 0;
  let truncatedReason: string | null = null;
  for (const c of candidates) {
    if (chosen.length >= limits.maxFiles) {
      truncatedReason = `模型文件数量超过上限 ${limits.maxFiles}`;
      break;
    }
    if (planned + c.size > limits.totalMaxBytes) {
      truncatedReason = `扫描内容超过总量上限 ${formatBytes(limits.totalMaxBytes)}`;
      break;
    }
    chosen.push(c);
    planned += c.size;
  }
  return { chosen, planned, truncatedReason };
}

/** 扫描目录（或单个文件）。超过数量/总量上限时扫描前面的文件并返回部分结果，不整单失败。 */
export async function scanAllowedDirectory(
  requestedPath: string,
  roots: string[],
  limits: DirectoryLimits,
  hooks: ScanHooks = {},
): Promise<DirectoryScanResult> {
  const targetReal = await resolveAllowed(requestedPath, roots);
  const { candidates, skipped, rejectedLinks } = await listModelFiles(targetReal, roots);
  const order = new Map(candidates.map((c, i) => [c.display, i]));
  const configDirs = new Set(
    candidates.filter((c) => baseOf(c.display) === 'config.json').map((c) => dirOf(c.display)),
  );
  const { chosen, planned, truncatedReason } = planFiles(
    [...candidates].sort(
      (a, b) => scanPriority(a.display, configDirs) - scanPriority(b.display, configDirs),
    ),
    limits,
  );
  chosen.sort((a, b) => order.get(a.display)! - order.get(b.display)!);
  const files: ScannedFile[] = [];
  let bytesDone = 0;
  const progress = () =>
    hooks.onProgress?.({
      files: files.length,
      bytes: bytesDone,
      totalFiles: chosen.length,
      totalBytes: planned,
    });
  for (const c of chosen) {
    if (await hooks.isCancelled?.()) throw new ScanCancelled('扫描已取消');
    const src = await openReal(c.real);
    try {
      const scan = await scanModelSource(c.display, src, limits);
      let lastReport = Date.now();
      const sha256 = await sourceSha256(src, async (n) => {
        bytesDone += n;
        if (Date.now() - lastReport > 1000) {
          lastReport = Date.now();
          if (await hooks.isCancelled?.()) throw new ScanCancelled('扫描已取消');
          await progress();
        }
      });
      files.push({ ...scan, path: c.display, bytes: src.size, sha256 });
    } finally {
      await src.close();
    }
    await progress();
    // 文件之间让出事件循环（脚本扫描是同步的计算）
    await new Promise((r) => setImmediate(r));
  }
  return {
    root: targetReal,
    files,
    skipped,
    totalBytes: planned,
    truncatedFiles: candidates.length - chosen.length,
    truncatedReason,
    rejectedLinks: rejectedLinks.slice(0, 200),
  };
}
