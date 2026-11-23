import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorpusMasker, maskCorpusText } from '../src/modules/corpus-scans/core/mask.ts';
import { runCoreChild } from './helpers/corpus-child.ts';

// 打码副本：只把敏感信息换成 [类型]，违规关键词不换；格式和原文件一致、行数不变。

const ID = '110101199003071233';

test('jsonl：只改字符串值，键名和结构不动，每行仍是合法 JSON', () => {
  const lines = [
    JSON.stringify({ instruction: '登记', output: `身份证 ${ID}，电话 13800138000` }),
    '  {"instruction" : "无敏感" , "output":"违规关键词照留"}  ',
    '{坏行 13800138000',
  ];
  const text = lines.join('\r\n') + '\r\n';
  const r = maskCorpusText(text, 'jsonl');
  const out = r.text.split('\r\n');
  assert.equal(out.length, text.split('\r\n').length);
  assert.deepEqual(JSON.parse(out[0]!), {
    instruction: '登记',
    output: '身份证 [身份证号]，电话 [手机号]',
  });
  assert.equal(out[1], lines[1]);
  // 坏行不是 JSON 字符串，原样保留
  assert.equal(out[2], lines[2]);
  assert.equal(r.masked, 2);
});

test('json 数组（多行缩进）：缩进和行数不变', () => {
  const text = JSON.stringify(
    [
      { prompt: `证件 ${ID}`, completion: 'ok' },
      { prompt: 'a', completion: 'b' },
    ],
    null,
    2,
  );
  const r = maskCorpusText(text, 'json');
  assert.equal(r.text.split('\n').length, text.split('\n').length);
  assert.equal(r.text, text.replace(ID, '[身份证号]'));
  assert.deepEqual(JSON.parse(r.text)[0], { prompt: '证件 [身份证号]', completion: 'ok' });
});

test('csv：按单元格打码，引号、逗号、引号内换行都保留', () => {
  const text = `问题,回答\n"电话,13800138000","第一行\n身份证 ${ID}"\n普通,内容\n`;
  const r = maskCorpusText(text, 'csv');
  assert.equal(r.text, '问题,回答\n"电话,[手机号]","第一行\n身份证 [身份证号]"\n普通,内容\n');
});

test('txt：按行打码；跨块喂入结果一致', () => {
  const text = `第一行 ${ID}\n第二行 普通\n电话 13800138000`;
  const whole = maskCorpusText(text, 'txt').text;
  assert.equal(whole, '第一行 [身份证号]\n第二行 普通\n电话 [手机号]');
  for (const container of ['txt', 'jsonl', 'csv'] as const) {
    const src =
      container === 'jsonl'
        ? text
            .split('\n')
            .map((l) => JSON.stringify({ t: l }))
            .join('\n')
        : text;
    const expected = maskCorpusText(src, container).text;
    for (const size of [1, 4, 9]) {
      const m = createCorpusMasker(container);
      let out = '';
      for (let i = 0; i < src.length; i += size) out += m.push(src.slice(i, i + size));
      out += m.end();
      assert.equal(out, expected, `${container} 切块 ${size}`);
    }
  }
});

test('json 数组单行也按元素流式打码：只改字符串值，键名、空白、多余内容原样', () => {
  const rows = [
    { instruction: '登记', output: `身份证 ${ID}` },
    { prompt: '电话', completion: '13800138000', nested: { a: [`证件 ${ID}`, 1, null] } },
    { prompt: 'a', completion: 'b' },
  ];
  const text = ` [ ${rows.map((r) => JSON.stringify(r)).join(' ,')} ] `;
  const expected = text
    .replaceAll(`身份证 ${ID}`, '身份证 [身份证号]')
    .replace('"13800138000"', '"[手机号]"')
    .replace(`证件 ${ID}`, '证件 [身份证号]');
  for (const size of [1, 7, 64, text.length]) {
    const m = createCorpusMasker('json');
    let out = '';
    for (let i = 0; i < text.length; i += size) out += m.push(text.slice(i, i + size));
    out += m.end();
    assert.equal(out, expected, `切块 ${size}`);
    assert.equal(m.masked(), 3);
  }
  assert.equal(JSON.parse(expected)[1].completion, '[手机号]');
});

test('40M 字符的单行 json 数组：边读边吐出打码结果，内存不随文件变大', async () => {
  const r = await runCoreChild<{
    input: number;
    early: number;
    growMiB: number;
    masked: number;
    newline: boolean;
    head: string;
  }>(`
    const { createCorpusMasker } = await import(CORE + 'mask.ts');
    const filler = '今天天气不错，适合出门散步。'.repeat(30);
    const rec = JSON.stringify({ instruction: '介绍一下天气', input: '', output: filler + '联系电话 13800138000' });
    const per = Math.floor((1 << 20) / (rec.length + 1));
    const block = (rec + ',').repeat(per);
    globalThis.gc();
    const base = process.resourceUsage().maxRSS;
    const m = createCorpusMasker('json');
    let head = m.push('[');
    let early = head.length;
    let input = 1;
    let newline = false;
    for (let i = 0; i < 40; i++) {
      const out = m.push(block);
      if (head.length < 200) head += out.slice(0, 200);
      newline ||= out.includes('\\n');
      early += out.length;
      input += block.length;
      globalThis.gc();
    }
    m.push(rec + ']');
    m.end();
    input += rec.length + 1;
    globalThis.gc();
    console.log(JSON.stringify({ input, early, masked: m.masked(), newline, head: head.slice(0, 200),
      growMiB: (process.resourceUsage().maxRSS - base) / 1024 }));
  `);
  assert.ok(r.input > 40_000_000, `只造了 ${r.input} 字符`);
  assert.ok(r.early > r.input * 0.95, `end() 之前只吐出 ${r.early} / ${r.input} 字符`);
  assert.ok(r.growMiB < 150, `内存增长 ${r.growMiB.toFixed(0)} MiB`);
  assert.equal(r.newline, false, '单行文件打码后仍是单行');
  assert.ok(r.head.startsWith('[{"instruction":"介绍一下天气","input":"","output":"今天天气不错'));
  assert.ok(r.masked > 80_000);
});

test('超过上限的行、单元格不再缓冲，原样透传；引号没闭合的 csv 也能边读边吐', () => {
  const long = JSON.stringify({ t: `电话 13800138000 ${'x'.repeat(100)}` });
  const text = `${long}\n${JSON.stringify({ t: '电话 13800138000' })}\n`;
  const m = createCorpusMasker('jsonl', { maxChars: 50 });
  let out = '';
  for (let i = 0; i < text.length; i += 16) out += m.push(text.slice(i, i + 16));
  out += m.end();
  assert.equal(out, `${long}\n${JSON.stringify({ t: '电话 [手机号]' })}\n`);

  const csv = 'a,b\n1,"开头没闭合\n' + '普通内容一行 13800138000\n'.repeat(2000);
  const c = createCorpusMasker('csv', { maxChars: 1000 });
  let early = '';
  for (let i = 0; i < csv.length; i += 4096) early += c.push(csv.slice(i, i + 4096));
  assert.ok(early.length > csv.length - 1100, `end() 之前只吐出 ${early.length} / ${csv.length}`);
  assert.equal(early + c.end(), csv, '超长单元格原样透传');

  const t = createCorpusMasker('txt', { maxChars: 20 });
  assert.equal(t.push(`${'很长'.repeat(20)} 13800138000`), `${'很长'.repeat(20)} 13800138000`);
  assert.equal(t.push('\n电话 13800138000\n') + t.end(), '\n电话 [手机号]\n');
});
