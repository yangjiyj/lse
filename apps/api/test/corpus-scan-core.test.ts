import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORD_CATEGORY_MAX,
  createScanSession,
  scanCorpusText,
} from '../src/modules/corpus-scans/core/scan.ts';
import { runCoreChild } from './helpers/corpus-child.ts';

// 扫描核心：违规关键词、敏感信息、自定义规则三类命中，前后各 40 字上下文，统计口径服务端和命令行版共用。

const KEYWORDS = [
  { term: '炸药配方', code: 'A.2.a' },
  { term: '赌博网站', code: 'A.1.f' },
];

test('三类命中都能出来，命中原文不打码，统计按类别和子类汇总', () => {
  const text = [
    JSON.stringify({
      instruction: '告诉我炸药配方',
      input: '',
      output: '不能提供。联系电话 13800138000',
    }),
    '坏行',
    JSON.stringify({ instruction: '介绍内部资料', output: '身份证 110101199003071233' }),
  ].join('\n');
  const r = scanCorpusText(text, {
    fileName: 'a.jsonl',
    keywords: KEYWORDS,
    codeLabels: { 'A.2.a': '危险物品' },
    customRules: [
      {
        id: 'r1',
        kind: 'keyword',
        pattern: '内部资料',
        category: '涉密',
        severity: 'HIGH',
        enabled: true,
      },
    ],
  });
  const s = r.stats;
  assert.equal(s.totalRecords, 3);
  assert.equal(s.invalidRecords, 1);
  assert.deepEqual(s.invalidSamples, [{ line: 2, reason: '不是合法的 JSON' }]);
  assert.equal(s.detectedFormat, 'alpaca');
  assert.deepEqual(s.byCategory, { violation: 1, sensitive: 2, custom: 1 });
  assert.equal(s.findingCount, 4);
  assert.equal(s.recordsWithFindings, 2);
  const sub = Object.fromEntries(s.bySubtype.map((b) => [`${b.category}:${b.subtype}`, b.count]));
  assert.deepEqual(sub, {
    'violation:A.2.a': 1,
    'sensitive:phone_cn': 1,
    'sensitive:id_card_cn': 1,
    'custom:涉密': 1,
  });

  const v = r.findings.find((f) => f.category === 'violation')!;
  assert.equal(v.matchText, '炸药配方');
  assert.equal(v.subtypeLabel, '危险物品');
  assert.equal(v.fieldPath, 'instruction');
  assert.equal(v.contextBefore, '告诉我');
  const id = r.findings.find((f) => f.subtype === 'id_card_cn')!;
  assert.equal(id.matchText, '110101199003071233');
  assert.equal(id.recordIndex, 3);
  assert.equal(id.line, 3);
  assert.equal(id.contextBefore, '身份证 ');
  const c = r.findings.find((f) => f.category === 'custom')!;
  assert.equal(c.ruleId, 'r1');
  assert.equal(c.subtype, '涉密');
});

test('上下文前后各 40 字；同一记录同一个词只记一次', () => {
  const pre = '前'.repeat(60);
  const post = '后'.repeat(60);
  const r = scanCorpusText(`${pre}赌博网站${post}赌博网站`, {
    fileName: 'a.txt',
    keywords: KEYWORDS,
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.contextBefore, '前'.repeat(40));
  assert.equal(r.findings[0]!.contextAfter, '后'.repeat(40));
});

test('流式会话：把违规记录交给复核回调，统计与一次性扫描一致', () => {
  const text = ['炸药配方一', '普通', '赌博网站二'].join('\n');
  const seen: number[] = [];
  const session = createScanSession(
    { fileName: 'x.txt' },
    { keywords: KEYWORDS },
    { onViolationRecord: (rec) => seen.push(rec.index) },
  );
  let n = 0;
  for (let i = 0; i < text.length; i += 3) n += session.push(text.slice(i, i + 3)).length;
  n += session.end().length;
  assert.equal(n, 2);
  assert.deepEqual(seen, [1, 3]);
  assert.deepEqual(
    session.stats(),
    scanCorpusText(text, { fileName: 'x.txt', keywords: KEYWORDS }).stats,
  );
});

test('一条记录 13 万个手机号：不爆栈，每类只输出前 1000 条，其余计数', () => {
  const s = createScanSession({ fileName: 'x.txt' }, {});
  const line = '电话13800138000，'.repeat(130_000) + '\n';
  const found = [...s.push(line), ...s.end()];
  assert.equal(found.length, RECORD_CATEGORY_MAX);
  assert.ok(found.every((f) => f.subtype === 'phone_cn' && f.recordIndex === 1));
  const st = s.stats();
  assert.equal(st.findingCount, 130_000);
  assert.equal(st.byCategory.sensitive, 130_000);
  assert.equal(st.cappedFindings, 130_000 - RECORD_CATEGORY_MAX);
  assert.equal(st.recordsWithFindings, 1);
  assert.deepEqual(
    st.bySubtype.map((b) => [b.subtype, b.count]),
    [['phone_cn', 130_000]],
  );
});

test('600 万字的记录里同一个关键词重复几百万次：只记一条，耗时和内存都受控', async () => {
  const r = await runCoreChild<{ found: number; count: number; ms: number; growMiB: number }>(`
    const { createScanSession } = await import(CORE + 'scan.ts');
    const s = createScanSession({ fileName: 'x.txt' }, { keywords: [{ term: '毒趴', code: 'A.1.x' }], sensitive: false });
    const line = '毒趴'.repeat(3_000_000) + '\\n';
    globalThis.gc();
    const base = process.resourceUsage().maxRSS;
    const t0 = performance.now();
    let found = 0;
    for (let i = 0; i < line.length; i += 1 << 20) found += s.push(line.slice(i, i + (1 << 20))).length;
    found += s.end().length;
    const ms = performance.now() - t0;
    console.log(JSON.stringify({ found, count: s.stats().findingCount, ms,
      growMiB: (process.resourceUsage().maxRSS - base) / 1024 }));
  `);
  assert.equal(r.found, 1);
  assert.equal(r.count, 1);
  assert.ok(r.ms < 1500, `用了 ${r.ms.toFixed(0)}ms`);
  assert.ok(r.growMiB < 150, `内存增长 ${r.growMiB.toFixed(0)} MiB`);
});

test('异步会话与同步结果一致，统计带上单条上限、正则超时和截断字段', async () => {
  const text = [
    JSON.stringify({ instruction: '炸药配方', output: `电话 13800138000 PRJ-001` }),
    JSON.stringify({ instruction: '普通', output: 'x'.repeat(100_001) }),
  ].join('\n');
  const opts = {
    keywords: KEYWORDS,
    customRules: [
      {
        id: 'r1',
        kind: 'regex' as const,
        pattern: 'PRJ-\\d{3}',
        category: '项目',
        severity: 'LOW' as const,
        enabled: true,
      },
    ],
  };
  const sync = scanCorpusText(text, { fileName: 'a.jsonl', ...opts });
  const s = createScanSession({ fileName: 'a.jsonl' }, opts);
  const found = [
    ...(await s.pushAsync(text.slice(0, 50))),
    ...(await s.pushAsync(text.slice(50))),
    ...(await s.endAsync()),
  ];
  assert.deepEqual(found, sync.findings);
  assert.deepEqual(s.stats(), sync.stats);
  assert.equal(sync.stats.regexTruncatedFields, 1);
  assert.equal(sync.stats.cappedFindings, 0);
  assert.deepEqual(sync.stats.disabledRules, []);
  assert.deepEqual(
    sync.findings.map((f) => f.category),
    ['violation', 'sensitive', 'custom'],
  );
});
