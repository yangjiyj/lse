import { crc32 } from 'node:zlib';

/** 以代码构造 pickle opcode 字节的测试夹具，不依赖 Python。 */
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

export const pk = {
  proto: (v: number) => Buffer.of(0x80, v),
  frame: (n: number) => Buffer.concat([Buffer.of(0x95), u64(n)]),
  pop: () => Buffer.of(0x30),
  memoize: () => Buffer.of(0x94),
  binput: (i: number) => Buffer.of(0x71, i),
  binget: (i: number) => Buffer.of(0x68, i),
  longBinput: (i: number) => Buffer.concat([Buffer.of(0x72), u32(i)]),
  longBinget: (i: number) => Buffer.concat([Buffer.of(0x6a), u32(i)]),
  shortUnicode: (s: string) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([Buffer.of(0x8c, b.length), b]);
  },
  binunicode: (s: string) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([Buffer.of(0x58), u32(b.length), b]);
  },
  unicode8: (s: string) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([Buffer.of(0x8d), u64(b.length), b]);
  },
  global: (m: string, n: string) => Buffer.from(`c${m}\n${n}\n`, 'latin1'),
};

/** os.system 经 STACK_GLOBAL + memo 的恶意 pickle。 */
export function maliciousPickle(): Buffer {
  return Buffer.concat([
    pk.proto(4),
    pk.shortUnicode('os'),
    pk.binput(0),
    pk.pop(),
    pk.shortUnicode('system'),
    pk.binput(1),
    pk.pop(),
    pk.binget(0),
    pk.binget(1),
    Buffer.of(0x93),
    pk.shortUnicode('id'),
    Buffer.of(0x85, 0x52, 0x2e),
  ]);
}

/** 仅含 collections.OrderedDict 的安全 pickle。 */
export function safePickle(): Buffer {
  return Buffer.concat([
    pk.proto(2),
    pk.global('collections', 'OrderedDict'),
    Buffer.of(0x29, 0x52, 0x2e),
  ]);
}

/** 构造 STORED（不压缩）ZIP，用于模拟 PyTorch 归档。 */
export function buildStoredZip(entries: Array<[string, Buffer]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    centrals.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 构造 GGUF v3 文件：KV 仅支持字符串与 uint32。 */
export function buildGguf(kv: Array<[string, string | number]>, tensorCount = 0): Buffer {
  const str = (s: string) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([u64(b.length), b]);
  };
  const parts: Buffer[] = [Buffer.from('GGUF'), u32(3), u64(tensorCount), u64(kv.length)];
  for (const [k, v] of kv) {
    parts.push(str(k));
    if (typeof v === 'string') parts.push(u32(8), str(v));
    else parts.push(u32(4), u32(v));
  }
  return Buffer.concat(parts);
}
