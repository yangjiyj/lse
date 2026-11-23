import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateByoArchive,
  BYO_MAX_IMAGES,
  sniffImageMime,
} from '../src/modules/multimodal-jailbreak/byo-images/archive.js';
import { parseByoManifest } from '../src/modules/multimodal-jailbreak/byo-images/manifest.js';
import { fakeJpeg, fakeWebp, makeZip, tinyPng } from './helpers-byo-zip.js';

const HEADER = 'image,prompt,category,expected,note';
const msgs = (r: { issues: { message: string }[] }) => r.issues.map((i) => i.message).join('\n');

test('合法 zip：三种格式按魔数通过，expected 缺省为应拒绝，未引用图片给提示并忽略', async () => {
  const zip = makeZip([
    {
      name: 'manifest.csv',
      data: `${HEADER}\na.png,请描述这张图,甲类,,备注一\nb.jpg,"含逗号, 的提问",乙类,应谨慎,\nsub/c.webp,正常问题,,可正常回答,\n`,
    },
    { name: 'a.png', data: tinyPng(255, 0, 0) },
    { name: 'b.jpg', data: fakeJpeg() },
    { name: 'sub/c.webp', data: fakeWebp() },
    { name: 'unused.png', data: tinyPng(0, 0, 255) },
    { name: '__MACOSX/._a.png', data: 'x' },
  ]);
  const r = await validateByoArchive(zip);
  assert.equal(r.ok, true, msgs(r));
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0]!.expected, '应拒绝');
  assert.equal(r.items[1]!.prompt, '含逗号, 的提问');
  assert.equal(r.items[2]!.expected, '可正常回答');
  assert.deepEqual(r.images.map((i) => i.mimeType).sort(), [
    'image/jpeg',
    'image/png',
    'image/webp',
  ]);
  assert.equal(r.images.find((i) => i.name === 'a.png')!.width, 4);
  assert.ok(r.warnings.some((w) => w.message.includes('unused.png')));
  assert.ok(!r.images.some((i) => i.name === 'unused.png'), '未引用图片不保存');
});

test('魔数校验：扩展名是 png 但内容不是图片；扩展名与实际格式不符', async () => {
  const zip = makeZip([
    { name: 'manifest.csv', data: `${HEADER}\nfake.png,问题一,,,\nswap.png,问题二,,,\n` },
    { name: 'fake.png', data: '#!/bin/sh\necho hi\n' },
    { name: 'swap.png', data: fakeJpeg() },
  ]);
  const r = await validateByoArchive(zip);
  assert.equal(r.ok, false);
  assert.ok(
    r.issues.some((i) => i.line === 2 && i.message.includes('文件头不是')),
    msgs(r),
  );
  assert.ok(
    r.issues.some((i) => i.line === 3 && i.message.includes('实际格式是 JPG')),
    msgs(r),
  );
  assert.equal(r.images.length, 0, '失败时不返回任何可入库内容');
  assert.equal(sniffImageMime(Buffer.from('GIF89a')), null);
});

test('路径穿越 / 绝对路径 / 反斜杠 一律拒绝', async () => {
  for (const evil of ['../evil.png', '/etc/evil.png', 'a\\..\\evil.png', 'ok/../../evil.png']) {
    const zip = makeZip([
      { name: 'manifest.csv', data: `${HEADER}\na.png,问题,,,\n` },
      { name: 'a.png', data: tinyPng(1, 2, 3) },
      { name: evil, data: tinyPng(9, 9, 9) },
    ]);
    const r = await validateByoArchive(zip);
    assert.equal(r.ok, false, evil);
    assert.ok(
      r.issues.some((i) => i.message.includes('路径不安全')),
      `${evil}: ${msgs(r)}`,
    );
  }
});

test('数量上限：manifest 超过 500 条被拒', async () => {
  const rows = Array.from({ length: BYO_MAX_IMAGES + 1 }, (_, i) => `a.png,问题${i},,,`).join('\n');
  const r = await validateByoArchive(
    makeZip([
      { name: 'manifest.csv', data: `${HEADER}\n${rows}\n` },
      { name: 'a.png', data: tinyPng(1, 1, 1) },
    ]),
  );
  assert.equal(r.ok, false);
  assert.ok(msgs(r).includes('超过上限'), msgs(r));
});

test('大小上限：单图超过 8MB 被拒；高压缩比炸弹被拒', async () => {
  const big = Buffer.concat([tinyPng(0, 0, 0), Buffer.alloc(9 * 1024 * 1024, 7)]);
  const r1 = await validateByoArchive(
    makeZip([
      { name: 'manifest.csv', data: `${HEADER}\nbig.png,问题,,,\n` },
      { name: 'big.png', data: big, store: true },
    ]),
  );
  assert.equal(r1.ok, false);
  assert.ok(msgs(r1).includes('超过单图 8MB'), msgs(r1));
  // 压缩炸弹：全零 60MB，压缩后只有几十 KB
  const bomb = Buffer.alloc(60 * 1024 * 1024, 0);
  const r2 = await validateByoArchive(
    makeZip([
      { name: 'manifest.csv', data: `${HEADER}\nbomb.png,问题,,,\n` },
      { name: 'bomb.png', data: bomb },
    ]),
  );
  assert.equal(r2.ok, false);
  assert.ok(msgs(r2).includes('压缩炸弹') || msgs(r2).includes('超过单图'), msgs(r2));
});

test('manifest 问题：缺列、缺图、重复、非法 expected、缺 manifest、非 zip', async () => {
  const noCol = await validateByoArchive(
    makeZip([
      { name: 'manifest.csv', data: 'image,category\na.png,x\n' },
      { name: 'a.png', data: tinyPng(1, 1, 1) },
    ]),
  );
  assert.ok(msgs(noCol).includes('缺少必填列：prompt'), msgs(noCol));

  const mixed = await validateByoArchive(
    makeZip([
      {
        name: 'manifest.csv',
        data: `${HEADER}\na.png,问题,,,\na.png,问题,,,\nmissing.png,问题二,,,\na.png,问题三,,随便,\nA.PNG,问题四,,,\n,,,,\n`,
      },
      { name: 'a.png', data: tinyPng(1, 1, 1) },
    ]),
  );
  assert.equal(mixed.ok, false);
  const m = msgs(mixed);
  assert.ok(m.includes('重复'), m);
  assert.ok(m.includes('找不到图片“missing.png”'), m);
  assert.ok(m.includes('expected 取值无效'), m);
  assert.ok(m.includes('注意大小写'), m);

  const noManifest = await validateByoArchive(makeZip([{ name: 'a.png', data: tinyPng(1, 1, 1) }]));
  assert.ok(msgs(noManifest).includes('缺少 manifest.csv'));
  const notZip = await validateByoArchive(Buffer.from('hello world, not zip'));
  assert.ok(msgs(notZip).includes('不是有效的 zip'));
  const empty = await validateByoArchive(Buffer.alloc(0));
  assert.equal(empty.ok, false);
});

test('内容相同的两个文件仅保存一份；同图多提问共用一份', async () => {
  const same = tinyPng(5, 5, 5);
  const r = await validateByoArchive(
    makeZip([
      { name: 'manifest.csv', data: `${HEADER}\none.png,问1,,,\ntwo.png,问2,,,\none.png,问3,,,\n` },
      { name: 'one.png', data: same },
      { name: 'two.png', data: same },
    ]),
  );
  assert.equal(r.ok, true, msgs(r));
  assert.equal(r.images.length, 1);
  assert.equal(r.items.length, 3);
  assert.ok(r.warnings.some((w) => w.message.includes('内容完全相同')));
});

test('manifest 解析：BOM、CRLF、引号内换行与转义引号', () => {
  const { rows, issues } = parseByoManifest(
    '﻿image,prompt\r\na.png,"第一行\n第二行 ""引用"""\r\nb.png,普通\r\n',
  );
  assert.equal(issues.length, 0);
  assert.equal(rows[0]!.prompt, '第一行\n第二行 "引用"');
  assert.equal(rows[1]!.line, 4);
});
