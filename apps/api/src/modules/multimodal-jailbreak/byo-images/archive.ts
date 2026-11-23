// 「客户自带图片集」zip 校验：魔数、路径穿越、炸弹、数量/大小、manifest 对应关系。
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { bufferSource, type ByteSource } from '../../model-files/source.js';
import { listZip, looksLikeZip, type ZipEntry } from '../../model-files/zip.js';
import { parseByoManifest, type ByoIssue, type ByoManifestRow } from './manifest.js';

export const BYO_ZIP_MAX_BYTES = 100 * 1024 * 1024;
export const BYO_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const BYO_MAX_IMAGES = 500;
/** 解压后总量上限（仅统计被 manifest 引用的图片）。 */
export const BYO_MAX_UNPACKED_BYTES = 300 * 1024 * 1024;
export const BYO_MAX_ZIP_ENTRIES = 1200;
const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const MAX_RATIO = 200;

export type ByoMime = 'image/png' | 'image/jpeg' | 'image/webp';
const EXT_MIME: Record<string, ByoMime> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};
const MIME_LABEL: Record<ByoMime, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPG',
  'image/webp': 'WebP',
};

/** 按文件头魔数识别格式，不信扩展名。 */
export function sniffImageMime(b: Uint8Array): ByoMime | null {
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  )
    return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 12 &&
    Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' &&
    Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/** 尽力读取尺寸（PNG / JPEG）；失败返回 0。 */
export function imageDimensions(b: Buffer, mime: ByoMime): { width: number; height: number } {
  try {
    if (mime === 'image/png' && b.length >= 24)
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (mime === 'image/jpeg') {
      let p = 2;
      while (p + 9 < b.length) {
        if (b[p] !== 0xff) {
          p++;
          continue;
        }
        const marker = b[p + 1]!;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return { height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
        p += 2 + b.readUInt16BE(p + 2);
      }
    }
  } catch {
    /* 尺寸只是展示信息 */
  }
  return { width: 0, height: 0 };
}

export interface ByoValidatedItem extends ByoManifestRow {
  imageKey: string;
}
export interface ByoValidatedImage {
  key: string;
  name: string;
  mimeType: ByoMime;
  sha256: string;
  sizeBytes: number;
  width: number;
  height: number;
  data: Buffer;
}
export interface ByoValidationResult {
  ok: boolean;
  /** 阻断问题：存在则不入库。 */
  issues: ByoIssue[];
  /** 提示：不阻断（如未被引用的图片已忽略、内容重复已合并）。 */
  warnings: ByoIssue[];
  items: ByoValidatedItem[];
  images: ByoValidatedImage[];
  stats: { zipBytes: number; entries: number; rows: number; images: number; unpackedBytes: number };
}

/** 规范化 zip 内路径；非法（穿越/绝对/盘符/反斜杠/控制字符）返回 null。 */
export function normalizeEntryName(raw: string): string | null {
  if (!raw || raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return null;
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return null;
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

async function readEntry(src: ByteSource, e: ZipEntry, maxBytes: number): Promise<Buffer> {
  const lh = await src.read(e.localOffset, 30);
  if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP 本地头无效');
  const start = e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  if (start + e.compressedSize > src.size) throw new Error('ZIP 条目数据越界');
  const raw = await src.read(start, e.compressedSize);
  if (e.method === 0) {
    if (raw.length > maxBytes) throw new RangeError('超出大小上限');
    return raw;
  }
  if (e.method === 8) return inflateRawSync(raw, { maxOutputLength: maxBytes + 1 });
  throw new Error(`不支持的 ZIP 压缩方法 ${e.method}`);
}

const fail = (issue: ByoIssue, zipBytes = 0): ByoValidationResult => ({
  ok: false,
  issues: [issue],
  warnings: [],
  items: [],
  images: [],
  stats: { zipBytes, entries: 0, rows: 0, images: 0, unpackedBytes: 0 },
});

export async function validateByoArchive(zip: Buffer): Promise<ByoValidationResult> {
  if (zip.length === 0) return fail({ line: 0, message: '上传文件为空' });
  if (zip.length > BYO_ZIP_MAX_BYTES)
    return fail(
      { line: 0, message: `zip 大小超过 ${BYO_ZIP_MAX_BYTES / 1024 / 1024}MB 上限` },
      zip.length,
    );
  if (!looksLikeZip(zip.subarray(0, 4)))
    return fail({ line: 0, message: '文件不是有效的 zip 压缩包' }, zip.length);

  const src = bufferSource(zip);
  let entries: ZipEntry[];
  try {
    entries = await listZip(src, BYO_MAX_ZIP_ENTRIES);
  } catch (e) {
    return fail(
      {
        line: 0,
        message: `zip 无法解析或条目数超过 ${BYO_MAX_ZIP_ENTRIES}：${(e as Error).message}`,
      },
      zip.length,
    );
  }

  const issues: ByoIssue[] = [];
  const warnings: ByoIssue[] = [];
  const files = new Map<string, ZipEntry>();
  let declaredTotal = 0;
  for (const e of entries) {
    if (e.name.endsWith('/')) continue; // 目录
    const norm = normalizeEntryName(e.name);
    if (norm === null) {
      issues.push({
        line: 0,
        message: `压缩包内路径不安全，已拒绝：“${e.name.slice(0, 80)}”（含 ..、绝对路径或反斜杠）`,
      });
      continue;
    }
    if (/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(norm) || norm.split('/').pop()!.startsWith('._'))
      continue;
    if (files.has(norm)) {
      issues.push({ line: 0, message: `压缩包内存在同名条目：“${norm}”` });
      continue;
    }
    declaredTotal += e.size;
    if (e.size > 1024 * 1024 && e.compressedSize > 0 && e.size / e.compressedSize > MAX_RATIO) {
      issues.push({ line: 0, message: `“${norm}”压缩比异常（疑似压缩炸弹），已拒绝` });
      continue;
    }
    files.set(norm, e);
  }
  if (declaredTotal > BYO_MAX_UNPACKED_BYTES * 4) {
    issues.push({ line: 0, message: '压缩包声明的解压后总量过大（疑似压缩炸弹），已拒绝' });
  }
  if (issues.length) {
    return { ...fail(issues[0]!, zip.length), issues, warnings };
  }

  const manifestKey = [...files.keys()].find((k) => k.toLowerCase() === 'manifest.csv');
  if (!manifestKey) {
    return {
      ...fail({ line: 0, message: '压缩包根目录缺少 manifest.csv' }, zip.length),
      stats: { zipBytes: zip.length, entries: files.size, rows: 0, images: 0, unpackedBytes: 0 },
    };
  }
  let manifestText: string;
  try {
    manifestText = (await readEntry(src, files.get(manifestKey)!, MANIFEST_MAX_BYTES)).toString(
      'utf8',
    );
  } catch (e) {
    return fail(
      { line: 0, message: `manifest.csv 读取失败或超过 2MB：${(e as Error).message}` },
      zip.length,
    );
  }
  const parsed = parseByoManifest(manifestText);
  issues.push(...parsed.issues);
  if (parsed.rows.length > BYO_MAX_IMAGES) {
    issues.push({
      line: 0,
      message: `manifest 条目数 ${parsed.rows.length} 超过上限 ${BYO_MAX_IMAGES}`,
    });
  }

  // 逐行校验：图片存在、扩展名、大小、魔数。
  const lowerIndex = new Map<string, string>();
  for (const k of files.keys()) lowerIndex.set(k.toLowerCase(), k);
  const referenced = new Set<string>();
  const byPath = new Map<string, ByoValidatedImage>(); // zip 内路径 -> 图片（重复内容的路径指向同一张）
  const bySha = new Map<string, ByoValidatedImage>();
  const items: ByoValidatedItem[] = [];
  let unpacked = 0;
  if (parsed.rows.length <= BYO_MAX_IMAGES) {
    for (const row of parsed.rows) {
      const norm = normalizeEntryName(row.image);
      if (norm === null) {
        issues.push({ line: row.line, message: `image“${row.image.slice(0, 80)}”路径不合法` });
        continue;
      }
      if (!files.has(norm)) {
        const alt = lowerIndex.get(norm.toLowerCase());
        issues.push({
          line: row.line,
          message: alt
            ? `压缩包内找不到图片“${norm}”（注意大小写，现有同名但大小写不同的文件：“${alt}”）`
            : `压缩包内找不到图片“${norm}”`,
        });
        continue;
      }
      referenced.add(norm);
      if (!byPath.has(norm)) {
        const ext = norm.split('.').pop()!.toLowerCase();
        const extMime = EXT_MIME[ext];
        if (!extMime) {
          issues.push({
            line: row.line,
            message: `“${norm}”扩展名不受支持，仅允许 png、jpg、jpeg、webp`,
          });
          continue;
        }
        const e = files.get(norm)!;
        if (e.size > BYO_IMAGE_MAX_BYTES) {
          issues.push({
            line: row.line,
            message: `“${norm}”大小 ${(e.size / 1024 / 1024).toFixed(1)}MB，超过单图 ${BYO_IMAGE_MAX_BYTES / 1024 / 1024}MB 上限`,
          });
          continue;
        }
        let data: Buffer;
        try {
          data = await readEntry(src, e, BYO_IMAGE_MAX_BYTES);
        } catch (err) {
          issues.push({
            line: row.line,
            message:
              err instanceof RangeError ||
              /maxOutputLength|Cannot create a Buffer/.test(String(err))
                ? `“${norm}”解压后超过单图 ${BYO_IMAGE_MAX_BYTES / 1024 / 1024}MB 上限（与声明大小不符）`
                : `“${norm}”无法解压：${(err as Error).message}`,
          });
          continue;
        }
        if (data.length !== e.size) {
          issues.push({ line: row.line, message: `“${norm}”解压后大小与压缩包声明不一致，已拒绝` });
          continue;
        }
        unpacked += data.length;
        if (unpacked > BYO_MAX_UNPACKED_BYTES) {
          issues.push({
            line: 0,
            message: `解压后总大小超过 ${BYO_MAX_UNPACKED_BYTES / 1024 / 1024}MB 上限`,
          });
          break;
        }
        const mime = sniffImageMime(data);
        if (!mime) {
          issues.push({
            line: row.line,
            message: `“${norm}”文件头不是 PNG/JPG/WebP 图片（不按扩展名信任），已拒绝`,
          });
          continue;
        }
        if (mime !== extMime) {
          issues.push({
            line: row.line,
            message: `“${norm}”扩展名为 ${ext}，但实际格式是 ${MIME_LABEL[mime]}，请改正文件名`,
          });
          continue;
        }
        const sha256 = createHash('sha256').update(data).digest('hex');
        const dup = bySha.get(sha256);
        if (dup) {
          warnings.push({
            line: row.line,
            message: `“${norm}”与“${dup.name}”内容完全相同，仅保存一份`,
          });
          byPath.set(norm, dup);
        } else {
          const img: ByoValidatedImage = {
            key: norm,
            name: norm,
            mimeType: mime,
            sha256,
            sizeBytes: data.length,
            ...imageDimensions(data, mime),
            data,
          };
          bySha.set(sha256, img);
          byPath.set(norm, img);
        }
      }
      items.push({ ...row, imageKey: byPath.get(norm)!.key });
    }
  }

  for (const k of files.keys()) {
    if (k === manifestKey || referenced.has(k)) continue;
    warnings.push({ line: 0, message: `压缩包内“${k}”未在 manifest 中引用，已忽略且不会保存` });
  }
  const uniqueImages = [...bySha.values()];
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    items: issues.length === 0 ? items : [],
    images: issues.length === 0 ? uniqueImages : [],
    stats: {
      zipBytes: zip.length,
      entries: files.size,
      rows: parsed.rows.length,
      images: uniqueImages.length,
      unpackedBytes: unpacked,
    },
  };
}
