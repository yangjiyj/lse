import { gunzipSync, inflateRawSync } from 'node:zlib';

/**
 * 安全解包：zip / tar / tgz。只在内存中解出文本条目，不落盘、不执行。
 * 防护：条目数上限、单文件上限、总解压上限（含 zip bomb 压缩比）、
 * 拒绝路径穿越/绝对路径/盘符、拒绝符号链接/硬链接/设备文件/FIFO。
 */
export interface ArchiveLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** 单条目解压后/压缩前的比值上限，超过判定为压缩炸弹 */
  maxRatio: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 5000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxRatio: 200,
};

export class ArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface ExtractedEntry {
  path: string;
  bytes: Buffer;
}

export interface ExtractResult {
  entries: ExtractedEntry[];
  skipped: Array<{ path: string; reason: string }>;
  totalBytes: number;
}

export type ArchiveKind = 'zip' | 'tar' | 'tgz' | 'file';

export function detectArchiveKind(head: Buffer, fileName = ''): ArchiveKind {
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return 'zip';
  if (head.length >= 4 && head.readUInt32LE(0) === 0x06054b50) return 'zip'; // 空 zip
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'tgz';
  if (head.length >= 262 && head.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  if (/\.tar$/i.test(fileName) && head.length >= 512) return 'tar';
  return 'file';
}

/** 规范化条目路径；不安全时返回 null */
export function safeEntryPath(raw: string): string | null {
  if (!raw || raw.includes('\0')) return null;
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  if (!parts.length || parts.join('/').length > 1024) return null;
  return parts.join('/');
}

class Budget {
  entries = 0;
  total = 0;
  constructor(private readonly limits: ArchiveLimits) {}
  count() {
    if (++this.entries > this.limits.maxEntries)
      throw new ArchiveError('ARCHIVE_TOO_MANY_ENTRIES', `压缩包条目数超过上限 ${this.limits.maxEntries}`);
  }
  add(n: number) {
    this.total += n;
    if (this.total > this.limits.maxTotalBytes)
      throw new ArchiveError('ARCHIVE_TOO_LARGE', `解压后总大小超过上限 ${Math.round(this.limits.maxTotalBytes / 1024 / 1024)}MiB`);
  }
}

const fmtMiB = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
const fmtLimit = (n: number) => (n >= 1024 * 1024 ? `${Math.round((n / 1024 / 1024) * 10) / 10}MiB` : `${Math.round(n / 1024)}KiB`);
/** 声明总体积超限时，整体压缩比达到该值判为压缩炸弹，否则按“总大小超限”拒绝 */
const BOMB_TOTAL_RATIO = 20;

/** 单文件超限的跳过原因（普通超大文件，非压缩炸弹） */
export function oversizeReason(maxFileBytes: number, verb = '未解压'): string {
  return `超过单文件上限 ${fmtLimit(maxFileBytes)}，${verb}`;
}

function bombError(what: string, compressed: number, declared: number): ArchiveError {
  const ratio = compressed > 0 ? `${Math.round(declared / compressed)}:1` : '无穷大';
  return new ArchiveError('ARCHIVE_BOMB', `疑似压缩炸弹：${what}压缩比 ${ratio}、声明解压体积 ${fmtMiB(declared)}，已拒绝解压`);
}

/** 声明的解压总体积超过总上限：压缩比异常判炸弹，否则按超大拒绝。在任何解压之前执行。 */
function checkDeclaredTotal(declared: number, compressed: number, limits: ArchiveLimits, what: string) {
  if (declared <= limits.maxTotalBytes) return;
  if (declared / Math.max(1, compressed) >= BOMB_TOTAL_RATIO) throw bombError(what, compressed, declared);
  throw new ArchiveError('ARCHIVE_TOO_LARGE', `解压后总大小超过上限 ${fmtLimit(limits.maxTotalBytes)}（声明解压体积 ${fmtMiB(declared)}）`);
}

function extractZip(buf: Buffer, limits: ArchiveLimits): ExtractResult {
  const budget = new Budget(limits);
  const out: ExtractResult = { entries: [], skipped: [], totalBytes: 0 };
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError('ARCHIVE_INVALID', 'ZIP 结构无效：未找到结束记录');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ArchiveError('ARCHIVE_UNSUPPORTED', '暂不支持 ZIP64 压缩包');
  if (cdOffset + cdSize > buf.length) throw new ArchiveError('ARCHIVE_INVALID', 'ZIP 中央目录越界');
  // 先看中央目录声明的总解压体积与整体压缩比（任何解压之前）
  let declared = 0;
  let compressed = 0;
  for (let i = 0, q = cdOffset; i < count && q + 46 <= buf.length && buf.readUInt32LE(q) === 0x02014b50; i++) {
    compressed += buf.readUInt32LE(q + 20);
    declared += buf.readUInt32LE(q + 24);
    q += 46 + buf.readUInt16LE(q + 28) + buf.readUInt16LE(q + 30) + buf.readUInt16LE(q + 32);
  }
  checkDeclaredTotal(declared, compressed, limits, '整个压缩包');
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ArchiveError('ARCHIVE_INVALID', 'ZIP 中央目录项无效');
    budget.count();
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;
    if (rawName.endsWith('/')) continue; // 目录
    const unixType = madeBy === 3 ? (external >>> 16) & 0o170000 : 0;
    const name = safeEntryPath(rawName);
    if (!name) throw new ArchiveError('ARCHIVE_PATH_TRAVERSAL', `压缩包包含非法路径：${rawName.slice(0, 200)}`);
    if (unixType === 0o120000) throw new ArchiveError('ARCHIVE_SYMLINK', `压缩包包含符号链接，已拒绝：${name}`);
    if (unixType && unixType !== 0o100000) throw new ArchiveError('ARCHIVE_SPECIAL_FILE', `压缩包包含设备或特殊文件，已拒绝：${name}`);
    if (flags & 0x1) {
      out.skipped.push({ path: name, reason: '加密条目，未解压' });
      continue;
    }
    // 压缩比检查必须在单文件上限跳过之前：否则炸弹会被当成普通超大文件静默跳过
    if (csize > 0 && usize / csize > limits.maxRatio) throw bombError(`条目 ${name} `, csize, usize);
    if (usize > limits.maxFileBytes) {
      out.skipped.push({ path: name, reason: oversizeReason(limits.maxFileBytes) });
      continue;
    }
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50)
      throw new ArchiveError('ARCHIVE_INVALID', `ZIP 本地头无效：${name}`);
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + csize > buf.length) throw new ArchiveError('ARCHIVE_INVALID', `ZIP 条目数据越界：${name}`);
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: limits.maxFileBytes + 1 });
      } catch {
        throw new ArchiveError('ARCHIVE_BOMB', `条目 ${name} 解压超限或数据损坏`);
      }
    } else {
      out.skipped.push({ path: name, reason: `不支持的压缩方法 ${method}` });
      continue;
    }
    // 不信任头部声明的大小：以实际解压结果为准
    if (data.length > limits.maxFileBytes) throw new ArchiveError('ARCHIVE_BOMB', `条目 ${name} 实际解压大小超过声明，疑似压缩炸弹`);
    budget.add(data.length);
    out.entries.push({ path: name, bytes: data });
  }
  out.totalBytes = budget.total;
  return out;
}

function tarString(b: Buffer, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z < 0 ? s : s.subarray(0, z)).toString('utf8');
}

function tarNumber(b: Buffer, off: number, len: number): number {
  if (b[off]! & 0x80) throw new ArchiveError('ARCHIVE_UNSUPPORTED', 'tar 条目大小使用 base-256 编码，暂不支持');
  const v = parseInt(tarString(b, off, len).trim() || '0', 8);
  if (!Number.isFinite(v) || v < 0) throw new ArchiveError('ARCHIVE_INVALID', 'tar 头部数字字段无效');
  return v;
}

function extractTar(buf: Buffer, limits: ArchiveLimits): ExtractResult {
  const budget = new Budget(limits);
  const out: ExtractResult = { entries: [], skipped: [], totalBytes: 0 };
  let p = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (p + 512 <= buf.length) {
    const h = buf.subarray(p, p + 512);
    if (h.every((x) => x === 0)) break;
    const size = tarNumber(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const prefix = h.subarray(257, 262).toString('latin1') === 'ustar' ? tarString(h, 345, 155) : '';
    const base = tarString(h, 0, 100);
    const dataStart = p + 512;
    if (dataStart + size > buf.length) throw new ArchiveError('ARCHIVE_INVALID', 'tar 条目数据越界');
    p = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = tarString(buf, dataStart, Math.min(size, 4096));
      continue;
    }
    if (type === 'x' || type === 'g') {
      const m = /\d+ path=([^\n]*)\n/.exec(buf.subarray(dataStart, dataStart + Math.min(size, 65536)).toString('utf8'));
      if (type === 'x' && m) paxPath = m[1]!;
      continue;
    }
    const rawName = paxPath ?? longName ?? (prefix ? `${prefix}/${base}` : base);
    paxPath = longName = null;
    budget.count();
    if (type === '5') continue;
    const name = safeEntryPath(rawName);
    if (!name) throw new ArchiveError('ARCHIVE_PATH_TRAVERSAL', `压缩包包含非法路径：${rawName.slice(0, 200)}`);
    if (type === '1' || type === '2') throw new ArchiveError('ARCHIVE_SYMLINK', `压缩包包含符号链接或硬链接，已拒绝：${name}`);
    if (type !== '0' && type !== '7') throw new ArchiveError('ARCHIVE_SPECIAL_FILE', `压缩包包含设备或特殊文件，已拒绝：${name}`);
    if (size > limits.maxFileBytes) {
      out.skipped.push({ path: name, reason: oversizeReason(limits.maxFileBytes) });
      continue;
    }
    budget.add(size);
    out.entries.push({ path: name, bytes: Buffer.from(buf.subarray(dataStart, dataStart + size)) });
  }
  out.totalBytes = budget.total;
  return out;
}

export function extractArchive(buf: Buffer, kind: ArchiveKind, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): ExtractResult {
  if (kind === 'zip') return extractZip(buf, limits);
  if (kind === 'tar') return extractTar(buf, limits);
  if (kind === 'tgz') {
    // gzip 尾部 ISIZE 为声明的解压体积（mod 2^32）：先据此判定，再解压；实际解压仍受 maxOutputLength 限制
    const tarCap = limits.maxTotalBytes + 1024 * 1024;
    const declared = buf.length >= 18 ? buf.readUInt32LE(buf.length - 4) : 0;
    if (declared > tarCap) checkDeclaredTotal(declared, buf.length, { ...limits, maxTotalBytes: tarCap }, 'gzip ');
    let tar: Buffer;
    try {
      tar = gunzipSync(buf, { maxOutputLength: tarCap });
    } catch {
      throw new ArchiveError('ARCHIVE_BOMB', `疑似压缩炸弹：gzip 实际解压超过总大小上限 ${fmtLimit(limits.maxTotalBytes)}（声明解压体积 ${fmtMiB(declared)}）或数据损坏`);
    }
    if (tar.length / Math.max(1, buf.length) > limits.maxRatio * 5 && tar.length > 16 * 1024 * 1024) throw bombError('gzip ', buf.length, tar.length);
    return extractTar(tar, limits);
  }
  throw new ArchiveError('ARCHIVE_UNSUPPORTED', '不是受支持的压缩包格式（zip / tar / tgz）');
}
