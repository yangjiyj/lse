/**
 * 浏览器端最小 ustar 写入器：把用户选择的目录/多个文件打成一个 tar，
 * 再以 application/octet-stream 上传（后端用同一套安全解包逻辑处理）。
 * 路径超过 100 字节或含非 ASCII 字符时，前置 pax 扩展头（path=...）。
 */
export interface TarInputFile {
  path: string;
  data: Uint8Array;
}

const enc = new TextEncoder();

/** 规范化相对路径；绝对路径、含 .. 或空段一律拒绝 */
export function normalizeTarPath(raw: string): string {
  const p = raw.replace(/\\/g, '/');
  if (!p || p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.includes('\0')) {
    throw new Error(`文件路径不合法：${raw}`);
  }
  const parts = p.split('/').filter((s) => s !== '' && s !== '.');
  if (!parts.length || parts.some((s) => s === '..')) throw new Error(`文件路径不合法：${raw}`);
  return parts.join('/');
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, type: '0' | 'x'): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, off: number, len: number) => h.set(enc.encode(s).subarray(0, len), off);
  put(name, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put('        ', 148, 8);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

function padded(data: Uint8Array): Uint8Array[] {
  const rest = data.length % 512;
  return rest ? [data, new Uint8Array(512 - rest)] : [data];
}

function paxRecord(key: string, value: string): Uint8Array {
  // 记录格式 "<len> key=value\n"，len 包含自身位数
  const body = ` ${key}=${value}\n`;
  const bodyLen = enc.encode(body).length;
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return enc.encode(`${len}${body}`);
}

export function buildTar(files: TarInputFile[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const path = normalizeTarPath(f.path);
    if (seen.has(path)) continue;
    seen.add(path);
    const needsPax = enc.encode(path).length > 100 || /[^\x20-\x7e]/.test(path);
    if (needsPax) {
      const rec = paxRecord('path', path);
      chunks.push(header('PaxHeader', rec.length, 'x'), ...padded(rec));
    }
    const shortName = needsPax ? path.replace(/[^\x20-\x7e]/g, '_').slice(-100) : path;
    chunks.push(header(shortName, f.data.length, '0'), ...padded(f.data));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
