import { describe, expect, it } from 'vitest';
import { buildTar, normalizeTarPath } from './tar-writer';

const dec = new TextDecoder();
const enc = new TextEncoder();

function readStr(b: Uint8Array, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const end = s.indexOf(0);
  return dec.decode(end >= 0 ? s.subarray(0, end) : s);
}

/** 测试用最小解析器：返回 [路径, 内容] 并校验头部校验和 */
function parse(tar: Uint8Array): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let off = 0;
  let pax: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const stored = parseInt(readStr(h, 148, 8).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    expect(sum).toBe(stored);
    expect(readStr(h, 257, 6)).toBe('ustar');
    const size = parseInt(readStr(h, 124, 12), 8);
    const type = String.fromCharCode(h[156]!);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const text = dec.decode(body);
      const m = /^(\d+) path=(.*)\n$/s.exec(text);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBe(enc.encode(text).length);
      pax = m![2]!;
      continue;
    }
    out.push([pax ?? readStr(h, 0, 100), dec.decode(body)]);
    pax = null;
  }
  return out;
}

describe('tar-writer', () => {
  it('多文件与目录结构可被还原，结尾有两个空块', () => {
    const tar = buildTar([
      { path: 'skill/SKILL.md', data: enc.encode('# demo\n') },
      { path: 'skill/scripts/run.py', data: enc.encode('print(1)\n'.repeat(100)) },
    ]);
    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(tar.length - 1024).every((b) => b === 0)).toBe(true);
    expect(parse(tar)).toEqual([
      ['skill/SKILL.md', '# demo\n'],
      ['skill/scripts/run.py', 'print(1)\n'.repeat(100)],
    ]);
  });

  it('长路径与中文路径写入 pax 扩展头', () => {
    const long = `a/${'b'.repeat(120)}/tool.json`;
    const tar = buildTar([
      { path: long, data: enc.encode('{}') },
      { path: '技能/说明.md', data: enc.encode('中文内容') },
    ]);
    expect(parse(tar)).toEqual([
      [long, '{}'],
      ['技能/说明.md', '中文内容'],
    ]);
  });

  it('拒绝 .. 与绝对路径，规范化 ./ 与反斜杠，重复路径只写一次', () => {
    expect(() => normalizeTarPath('../etc/passwd')).toThrow('文件路径不合法');
    expect(() => normalizeTarPath('a/../../b')).toThrow('文件路径不合法');
    expect(() => normalizeTarPath('/etc/passwd')).toThrow('文件路径不合法');
    expect(() => normalizeTarPath('C:/x.txt')).toThrow('文件路径不合法');
    expect(normalizeTarPath('./a\\b.txt')).toBe('a/b.txt');
    const tar = buildTar([
      { path: 'a.txt', data: enc.encode('1') },
      { path: './a.txt', data: enc.encode('2') },
    ]);
    expect(parse(tar)).toEqual([['a.txt', '1']]);
    expect(() => buildTar([{ path: '../x', data: new Uint8Array() }])).toThrow();
  });
});
