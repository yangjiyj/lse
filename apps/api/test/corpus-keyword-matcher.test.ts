import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeywordAutomaton } from '../src/modules/corpus-scans/core/keyword-matcher.ts';

// 违规内容检测（1.2.1、1.2.4）：国标关键词用 Aho-Corasick 自动机一次扫完，命中记条目编码。

const spans = (hits: { start: number; end: number; keyword: string }[]) =>
  hits.map((h) => `${h.keyword}@${h.start}-${h.end}`).sort();

test('重叠、包含的关键词都能命中', () => {
  const ac = buildKeywordAutomaton([
    { term: '中华', code: 'A.1.a' },
    { term: '华人', code: 'A.1.b' },
    { term: '中华人民', code: 'A.1.c' },
    { term: '人民', code: 'A.1.d' },
  ]);
  assert.equal(ac.size, 4);
  const hits = ac.search('中华人民共和国');
  assert.deepEqual(spans(hits), ['中华@0-2', '中华人民@0-4', '人民@2-4', '华人@1-3'].sort());
  assert.deepEqual(hits.find((h) => h.keyword === '华人')!.codes, ['A.1.b']);
});

test('中英文混排、大小写和全角都能命中，位置对应原文', () => {
  const ac = buildKeywordAutomaton([
    { term: 'Bomb', code: 'A.2.a' },
    { term: '制作bomb教程', code: 'A.2.b' },
  ]);
  const text = '请教制作ＢＯＭＢ教程，或者 make a BOMB now';
  const hits = ac.search(text);
  assert.deepEqual(spans(hits), ['Bomb@4-8', 'Bomb@21-25', '制作bomb教程@2-10'].sort());
  // 命中原文取原文片段（全角照原样）
  assert.equal(text.slice(4, 8), 'ＢＯＭＢ');
});

test('同一个词在多个条目下：编码合并、只报一次', () => {
  const ac = buildKeywordAutomaton([
    { term: '赌博', code: 'A.2.c' },
    { term: '赌博', code: 'A.2.f' },
    { term: '赌博', code: 'A.2.c' },
  ]);
  assert.equal(ac.size, 1);
  const hits = ac.search('网络赌博');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0]!.codes, ['A.2.c', 'A.2.f']);
});

test('短于下限的词不参与，空文本没有命中', () => {
  const ac = buildKeywordAutomaton(
    [
      { term: '枪', code: 'A.2.a' },
      { term: '  ', code: 'A.2.a' },
      { term: '枪支', code: 'A.2.a' },
    ],
    { minLength: 2 },
  );
  assert.equal(ac.size, 1);
  assert.deepEqual(spans(ac.search('买枪支')), ['枪支@1-3']);
  assert.deepEqual(ac.search(''), []);
});

test('性能：1 万关键词 × 1 万条记录在 15 秒内扫完', () => {
  const pool =
    '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈abcdefghijklmnopqrstuvwxyz';
  let x = 12345;
  const rand = (n: number) => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return x % n;
  };
  const word = (len: number) => Array.from({ length: len }, () => pool[rand(pool.length)]).join('');
  const entries = Array.from({ length: 10_000 }, (_, i) => ({
    term: word(2 + (i % 5)),
    code: `A.${1 + (i % 4)}.a`,
  }));
  const records = Array.from({ length: 10_000 }, () => word(300));
  const t0 = Date.now();
  const ac = buildKeywordAutomaton(entries, { minLength: 2 });
  let total = 0;
  for (const r of records) total += ac.search(r).length;
  const ms = Date.now() - t0;
  assert.ok(total > 0, '随机文本里应当有命中');
  assert.ok(ms < 15_000, `耗时 ${ms} ms`);
});

test('给了已命中集合时同一个词只报第一次，跨字段共用', () => {
  const ac = buildKeywordAutomaton([
    { term: '毒趴', code: 'A.1.x' },
    { term: '趴体', code: 'A.1.y' },
  ]);
  const seen = new Set<number>();
  assert.deepEqual(spans(ac.search('毒趴毒趴毒趴体', seen)), ['毒趴@0-2', '趴体@5-7']);
  assert.deepEqual(ac.search('又一个毒趴', seen), []);
  // 不给集合时照旧全部报
  assert.equal(ac.search('毒趴毒趴毒趴').length, 3);
});
