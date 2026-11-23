import type { ByteSource } from './source.js';
import { inflatingSource } from './inflate.js';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export function looksLikeZip(head: Uint8Array): boolean {
  return (
    head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
  );
}

function big(b: Buffer, at: number): number {
  const v = b.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ZIP64 字段超出可处理范围');
  return Number(v);
}

/** 只读中央目录（最多 maxEntries 项），支持 ZIP64；不解压任何数据。 */
export async function listZip(src: ByteSource, maxEntries = 10_000): Promise<ZipEntry[]> {
  const tailLen = Math.min(src.size, 22 + 0xffff);
  const tail = await src.read(src.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('未找到 ZIP 结束记录');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('ZIP64 定位记录缺失');
    const z64 = await src.read(big(tail, loc + 8), 56);
    if (z64.length < 56 || z64.readUInt32LE(0) !== 0x06064b50)
      throw new Error('ZIP64 结束记录无效');
    count = big(z64, 32);
    cdSize = big(z64, 40);
    cdOffset = big(z64, 48);
  }
  if (count > maxEntries) throw new Error(`ZIP 条目数 ${count} 超过上限 ${maxEntries}`);
  if (cdOffset + cdSize > src.size || cdSize > 64 * 1024 * 1024)
    throw new Error('ZIP 中央目录越界');
  const cd = await src.read(cdOffset, cdSize);
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50)
      throw new Error('ZIP 中央目录项无效');
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28),
      extraLen = cd.readUInt16LE(p + 30),
      commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e),
        len = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) {
          size = big(extra, q);
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = big(extra, q);
          q += 8;
        }
        if (localOffset === 0xffffffff) {
          localOffset = big(extra, q);
        }
      }
      e += 4 + len;
    }
    out.push({ name, method, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * 返回条目数据的字节源。STORED 条目直接映射到原文件区间（不复制）；
 * DEFLATE 条目流式解压（只在内存保留读取窗口），逻辑大小按中央目录声明的 size，
 * 超过 maxInflate 的部分不可读（调用方按窗口扫描并标注）。
 */
export async function entrySource(
  src: ByteSource,
  entry: ZipEntry,
  maxInflate: number,
): Promise<ByteSource> {
  const lh = await src.read(entry.localOffset, 30);
  if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50)
    throw new Error(`ZIP 本地头无效：${entry.name}`);
  const dataStart = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  if (dataStart + entry.compressedSize > src.size)
    throw new Error(`ZIP 条目数据越界：${entry.name}`);
  if (entry.method === 0) {
    return {
      size: entry.compressedSize,
      read: (offset, length) =>
        src.read(dataStart + offset, Math.max(0, Math.min(length, entry.compressedSize - offset))),
    };
  }
  if (entry.method !== 8) throw new Error(`不支持的 ZIP 压缩方法 ${entry.method}：${entry.name}`);
  return inflatingSource(src, dataStart, entry.compressedSize, Math.min(entry.size, maxInflate));
}
