import { basename } from 'node:path';
import { ArchiveError, detectArchiveKind, extractArchive, safeEntryPath, type ArchiveKind } from './archive.js';
import { isScannableTextPath, type EngineInputFile } from './engine/index.js';

export interface IntakeResult {
  kind: ArchiveKind;
  files: EngineInputFile[];
  skipped: Array<{ path: string; reason: string }>;
  totalBytes: number;
}

/** 看起来像二进制（含 NUL 或大量不可解码字节）的内容不当作源码扫描 */
function decodeText(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8192).includes(0)) return null;
  const text = bytes.toString('utf8');
  const bad = (text.match(/\uFFFD/g) ?? []).length;
  return bad > Math.max(8, text.length * 0.01) ? null : text;
}

/** 目录上传时浏览器会带一层根目录；归档常见 node_modules / .git，跳过并记录 */
const IGNORED_DIR = /(?:^|\/)(?:node_modules|\.git|__pycache__|\.venv|venv|dist|build)\//;

/** 把上传的原始字节（单文件或 zip/tar/tgz）转为引擎输入。不执行任何内容。 */
export function intakeUpload(body: Buffer, fileName: string): IntakeResult {
  const kind = detectArchiveKind(body.subarray(0, 512), fileName);
  if (kind === 'file') {
    const path = safeEntryPath(basename(fileName.replace(/\\/g, '/')));
    if (!path) throw new ArchiveError('ARCHIVE_PATH_TRAVERSAL', '文件名非法');
    const text = decodeText(body);
    if (text === null || !isScannableTextPath(path))
      return { kind, files: [], skipped: [{ path, reason: '非文本/源码文件，未扫描' }], totalBytes: body.length };
    return { kind, files: [{ path, content: text }], skipped: [], totalBytes: body.length };
  }
  const extracted = extractArchive(body, kind);
  const files: EngineInputFile[] = [];
  const skipped = [...extracted.skipped];
  for (const e of extracted.entries) {
    if (IGNORED_DIR.test(`${e.path}`)) {
      skipped.push({ path: e.path, reason: '依赖/构建目录，未扫描' });
      continue;
    }
    if (!isScannableTextPath(e.path)) {
      skipped.push({ path: e.path, reason: '非文本/源码文件，未扫描' });
      continue;
    }
    const text = decodeText(e.bytes);
    if (text === null) {
      skipped.push({ path: e.path, reason: '二进制内容，未扫描' });
      continue;
    }
    files.push({ path: e.path, content: text });
  }
  return { kind, files, skipped, totalBytes: extracted.totalBytes };
}
