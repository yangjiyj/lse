import test from 'node:test';
import assert from 'node:assert/strict';
import { scanModelBytes } from '../src/modules/model-files/scanner.js';
import {
  OVBA_MAX_OUT,
  decompressOvba,
  extractVbaText,
} from '../src/modules/model-files/script-scan.js';
import { lineIndex, lineAt, lineText } from '../src/modules/engines/ai-asset/engine/lexer.js';

/** 审查复现的耗时问题：逐条命中都从头数行号（平方级）、宏工程解压放大。 */

test('8000 行 Shell "a" 的 .bas 在 2 秒内扫完，命中数有上限', async () => {
  const t0 = Date.now();
  const r = await scanModelBytes('m.bas', Buffer.from('Shell "a"\n'.repeat(8000)));
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `耗时 ${ms} ms`);
  const f = r.findings.find((x) => x.ruleId === 'vba.shell_exec');
  assert.ok(f, r.findings.map((x) => x.ruleId).join(','));
  assert.match(f!.detail, /第 1 行：Shell "a"/);
  assert.match(f!.detail, /至少 50 处/);
});

test('8000 行 eval(x) 的 .py、8000 行 powershell 的 .ps1 各在 2 秒内扫完', async () => {
  for (const [name, line, rule] of [
    ['m.py', 'eval(x)\n', 'code.dynamic_execution'],
    ['m.ps1', 'powershell -w hidden -c x\n', 'win.hidden_powershell'],
  ] as const) {
    const t0 = Date.now();
    const r = await scanModelBytes(name, Buffer.from(line.repeat(8000)));
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `${name} 耗时 ${ms} ms`);
    assert.ok(
      r.findings.some((x) => x.ruleId === rule),
      `${name}：${r.findings.map((x) => x.ruleId).join(',')}`,
    );
  }
});

test('行号表：二分查行号、取行文本，与逐字符数换行的结果一致（含 \\r\\n）', () => {
  const text = 'a\r\nbb\n\nccc\r\nd';
  const idx = lineIndex(text);
  for (let off = 0; off <= text.length; off++) {
    const slow = text.slice(0, off).split('\n').length;
    assert.equal(idx.lineAt(off), slow, `偏移 ${off}`);
    assert.equal(lineAt(text, off), slow, `偏移 ${off}`);
  }
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((n) => idx.lineText(n)),
    ['a', 'bb', '', 'ccc', 'd', ''],
  );
  assert.equal(lineText(text, 4), 'ccc');
});

/** 审查人构造的样本：n 个首尾相接的合法压缩块，每块都以 “\0Attribut” 开头，构成 n 个解压起点。 */
function ovbaBomb(n: number): Buffer {
  const chunks: Buffer[] = [Buffer.from([0x01])];
  for (let i = 0; i < n; i++) {
    const body: number[] = [];
    for (let g = 0; g < 455; g++) {
      body.push(0x00);
      for (const c of Buffer.from(g === 0 ? 'Attribut' : 'AAAAAAA\x01', 'latin1')) body.push(c);
    }
    const header = 0xb000 | (body.length + 2 - 3);
    chunks.push(Buffer.from([header & 0xff, header >> 8]), Buffer.from(body));
  }
  return Buffer.concat(chunks);
}

test('7.8 MiB 的宏工程解压样本 3 秒内完成，解压总量不超过预算，内存增长在 200 MB 以内', () => {
  const bin = ovbaBomb(2000);
  assert.ok(bin.length > 7.5 * 1024 * 1024);
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();
  const text = extractVbaText(bin);
  const ms = Date.now() - t0;
  const grown = (process.memoryUsage().rss - rss0) / 1024 / 1024;
  assert.ok(ms < 3000, `耗时 ${ms} ms`);
  assert.ok(grown < 200, `内存增长 ${grown.toFixed(0)} MB`);
  // 解压部分不超过 2 MiB，其余是原始字节里的可打印串（不超过输入长度）
  assert.ok(text.length <= OVBA_MAX_OUT + bin.length, `文本 ${text.length}`);
});

test('MS-OVBA 解压：返回消耗到的位置；每块输出不超过 4096 字节；到预算即停', () => {
  // "abc" 三个字面量后接复制记号（偏移 3、长度 9）→ abcabcabcabc
  const one = Buffer.from([0x01, 0x05, 0xb0, 0x08, 0x61, 0x62, 0x63, 0x06, 0x20]);
  const r = decompressOvba(one, 0);
  assert.equal(r.data.toString('latin1'), 'abcabcabcabc');
  assert.equal(r.end, one.length);
  assert.equal(r.truncated, false);

  // 一个块：字面量 a，然后 7 个复制记号各要 4098 字节，远超一块 4096 字节的上限
  const body = [0xfe, 0x61];
  for (let i = 0; i < 7; i++) body.push(0xff, 0x0f);
  const header = 0xb000 | (body.length + 2 - 3);
  const big = decompressOvba(Buffer.from([0x01, header & 0xff, header >> 8, ...body]), 0);
  assert.ok(big.data.length <= 4096, `一块输出 ${big.data.length} 字节`);

  const capped = decompressOvba(ovbaBomb(10), 0, 5000);
  assert.equal(capped.data.length, 5000);
  assert.equal(capped.truncated, true);
});
