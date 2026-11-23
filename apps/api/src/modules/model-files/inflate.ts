import { createInflateRaw, createInflate, createGunzip } from 'node:zlib';
import { Readable, pipeline } from 'node:stream';
import type { ByteSource } from './source.js';

/**
 * 顺序解压字节源：按需从 src[start, start+compressedSize) 读取压缩数据并流式解压，
 * 内存中只保留当前读取窗口；绝不越过声明的 size（防解压炸弹）。
 * 向后回读时从头重新解压（Cursor 只向前读，通常不发生）。
 */
export function inflatingSource(
  src: ByteSource,
  start: number,
  compressedSize: number,
  size: number,
  kind: 'raw' | 'zlib' | 'gzip' = 'raw',
): ByteSource & { readonly truncated: boolean } {
  let it: AsyncIterator<Buffer> | null = null;
  let base = 0; // pending 的起始解压偏移
  let pending: Buffer = Buffer.alloc(0);
  let ended = false;
  let truncated = false;

  let stream: NodeJS.ReadWriteStream | null = null;

  const restart = () => {
    const chunk = 1024 * 1024;
    async function* compressed() {
      for (let o = 0; o < compressedSize; o += chunk)
        yield await src.read(start + o, Math.min(chunk, compressedSize - o));
    }
    (stream as unknown as { destroy?: () => void } | null)?.destroy?.();
    const out =
      kind === 'raw' ? createInflateRaw() : kind === 'zlib' ? createInflate() : createGunzip();
    // pipeline 把源读取错误传给解压流，迭代器随之抛错（不会挂起）
    pipeline(Readable.from(compressed()), out, () => {});
    stream = out;
    it = (out as unknown as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
    base = 0;
    pending = Buffer.alloc(0);
    ended = false;
  };

  return {
    size,
    get truncated() {
      return truncated;
    },
    async read(offset, length) {
      if (!it || offset < base) restart();
      const want = Math.min(offset + length, size);
      if (offset > base) {
        const drop = Math.min(offset - base, pending.length);
        pending = pending.subarray(drop);
        base += drop;
      }
      while (base + pending.length < want && !ended) {
        const r = await it!.next();
        if (r.done) {
          ended = true;
          break;
        }
        let chunk = r.value;
        if (base + pending.length < offset) {
          // 整块都在 offset 之前：直接丢弃
          const skip = Math.min(offset - (base + pending.length), chunk.length);
          base += pending.length + skip;
          pending = Buffer.alloc(0);
          chunk = chunk.subarray(skip);
        }
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      }
      if (!ended && base + pending.length >= size) truncated = true;
      if (offset < base) return Buffer.alloc(0);
      return pending.subarray(offset - base, Math.max(offset - base, want - base));
    },
  };
}

/** 流式计算解压后长度（到 cap 为止），不在内存保留数据。返回 [长度, 是否超过 cap]。 */
export async function inflatedLength(
  src: ByteSource,
  start: number,
  compressedSize: number,
  kind: 'raw' | 'zlib' | 'gzip',
  cap: number,
): Promise<[number, boolean]> {
  const s = inflatingSource(src, start, compressedSize, cap + 1, kind);
  let n = 0;
  const step = 4 * 1024 * 1024;
  for (;;) {
    const b = await s.read(n, step);
    n += b.length;
    if (b.length < step || n > cap) break;
  }
  return n > cap ? [cap, true] : [n, false];
}
