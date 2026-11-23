import { open, type FileHandle } from 'node:fs/promises';

/** 随机读取的字节源：上传用内存 Buffer，目录扫描用文件句柄按块读取。 */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export class TruncatedError extends Error {
  constructor(readonly offset: number) {
    super(`数据在偏移 ${offset} 处截断`);
    this.name = 'TruncatedError';
  }
}

export function bufferSource(bytes: Uint8Array): ByteSource {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    size: buf.byteLength,
    async read(offset, length) {
      return buf.subarray(offset, Math.min(buf.byteLength, offset + length));
    },
  };
}

export async function fileSource(path: string): Promise<ByteSource & { close(): Promise<void> }> {
  const handle: FileHandle = await open(path, 'r');
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
      return done === want ? out : out.subarray(0, done);
    },
    close: () => handle.close(),
  };
}

/** 顺序游标：按块（默认 1MiB）缓冲读取，跳过大段数据时不读盘。 */
export class Cursor {
  private buf: Buffer = Buffer.alloc(0);
  private bufStart = 0;
  /** skip() 跳过（未读取）的字节累计，用于计算实际读取窗口。 */
  public skipped = 0;
  constructor(
    private readonly src: ByteSource,
    public pos = 0,
    private readonly end = src.size,
    private readonly chunk = 1024 * 1024,
  ) {}

  get remaining(): number {
    return this.end - this.pos;
  }

  async take(n: number): Promise<Buffer> {
    if (n < 0 || this.pos + n > this.end) throw new TruncatedError(this.pos);
    const rel = this.pos - this.bufStart;
    if (rel >= 0 && rel + n <= this.buf.byteLength) {
      this.pos += n;
      return this.buf.subarray(rel, rel + n);
    }
    const len = Math.min(this.end - this.pos, Math.max(n, this.chunk));
    this.buf = await this.src.read(this.pos, len);
    this.bufStart = this.pos;
    if (this.buf.byteLength < n) throw new TruncatedError(this.pos);
    this.pos += n;
    return this.buf.subarray(0, n);
  }

  async byte(): Promise<number> {
    return (await this.take(1))[0]!;
  }

  async skip(n: number): Promise<void> {
    if (n < 0 || this.pos + n > this.end) throw new TruncatedError(this.pos);
    this.pos += n;
    this.skipped += n;
  }

  /** 读取到换行（不含换行），行长上限防止恶意超长行。 */
  async line(max = 64 * 1024): Promise<string> {
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const b = await this.byte();
      if (b === 0x0a) break;
      if (++total > max) throw new Error(`行长度超过 ${max} 字节`);
      parts.push(Buffer.of(b));
    }
    return Buffer.concat(parts).toString('latin1');
  }

  async u32(): Promise<number> {
    return (await this.take(4)).readUInt32LE(0);
  }

  async i32(): Promise<number> {
    return (await this.take(4)).readInt32LE(0);
  }

  async u64(): Promise<number> {
    const v = (await this.take(8)).readBigUInt64LE(0);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('64 位长度超出可处理范围');
    return Number(v);
  }
}
