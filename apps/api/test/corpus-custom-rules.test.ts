import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REGEX_MAX_LENGTH,
  REGEX_RULES_MAX,
  compileCustomRules,
  parseRuleImport,
  parseRuleRows,
  validateRegexPattern,
} from '../src/modules/corpus-scans/core/custom-rules.ts';
import { createScanSession } from '../src/modules/corpus-scans/core/scan.ts';

// 用户自定义外置规则库（1.2.3）：关键词或正则，CSV、xlsx、txt 批量导入；正则防灾难性回溯；每条记录每条正则只匹配一次。

const DEFAULTS = { category: '自定义', severity: 'MEDIUM' as const };

test('正则检查：超长、嵌套量词、语法错误都拒绝，正常写法放行', () => {
  assert.equal(validateRegexPattern('项目代号[A-Z]{2}\\d{4}'), null);
  assert.match(validateRegexPattern('a'.repeat(REGEX_MAX_LENGTH + 1)) ?? '', /500/);
  assert.match(validateRegexPattern('(a+)+$') ?? '', /嵌套量词/);
  assert.match(validateRegexPattern('(\\d*)*x') ?? '', /嵌套量词/);
  assert.match(validateRegexPattern('(?:[a-z]+){2,}') ?? '', /嵌套量词/);
  assert.match(validateRegexPattern('([') ?? '', /语法/);
});

test('CSV 导入：认中英文表头，类型、严重度、启用都能写；坏行记行号', () => {
  const csv = [
    '类型,内容,类别,严重度,启用',
    '关键词,内部资料,涉密,高,是',
    'regex,项目代号[A-Z]{2}\\d{4},项目代号,MEDIUM,否',
    '正则,(a+)+$,坏正则,低,是',
    ',,空内容,,',
    'keyword,内部资料,重复,,',
  ].join('\n');
  const r = parseRuleImport('csv', csv, DEFAULTS);
  assert.equal(r.totalRows, 5);
  assert.deepEqual(r.rows, [
    { kind: 'keyword', pattern: '内部资料', category: '涉密', severity: 'HIGH', enabled: true },
    {
      kind: 'regex',
      pattern: '项目代号[A-Z]{2}\\d{4}',
      category: '项目代号',
      severity: 'MEDIUM',
      enabled: false,
    },
  ]);
  assert.deepEqual(
    r.issues.map((i) => i.row),
    [4, 5],
  );
  assert.match(r.issues[0]!.message, /嵌套量词/);
  assert.equal(r.duplicates, 1);
});

test('txt 导入：每行一个关键词，用默认类别和严重度', () => {
  const r = parseRuleImport('txt', '﻿机密文件\n\n  内部名单  \r\n机密文件\n', {
    category: '内部',
    severity: 'LOW',
  });
  assert.equal(r.totalRows, 3);
  assert.deepEqual(r.rows, [
    { kind: 'keyword', pattern: '机密文件', category: '内部', severity: 'LOW', enabled: true },
    { kind: 'keyword', pattern: '内部名单', category: '内部', severity: 'LOW', enabled: true },
  ]);
  assert.equal(r.duplicates, 1);
});

test('没有表头的表格：单列当关键词，多列按 类型,内容,类别,严重度', () => {
  const r = parseRuleRows([['工资表'], ['正则', '\\d{3}-\\d{4}', '工号', '低']], DEFAULTS);
  assert.deepEqual(r.rows, [
    { kind: 'keyword', pattern: '工资表', category: '自定义', severity: 'MEDIUM', enabled: true },
    { kind: 'regex', pattern: '\\d{3}-\\d{4}', category: '工号', severity: 'LOW', enabled: true },
  ]);
});

test('匹配：关键词和正则每条记录只记一次，停用的规则不参与', () => {
  const m = compileCustomRules([
    {
      id: 'k1',
      kind: 'keyword',
      pattern: '内部资料',
      category: '涉密',
      severity: 'HIGH',
      enabled: true,
    },
    {
      id: 'r1',
      kind: 'regex',
      pattern: 'PRJ-\\d{3}',
      category: '项目代号',
      severity: 'MEDIUM',
      enabled: true,
    },
    { id: 'r2', kind: 'regex', pattern: '停用', category: 'x', severity: 'LOW', enabled: false },
  ]);
  assert.equal(m.size, 2);
  const hits = m.scan(['无关', '这是内部资料，PRJ-001 和 PRJ-002，还有内部资料', '停用 PRJ-003']);
  assert.deepEqual(
    hits.map((h) => [h.ruleId, h.fieldIndex, h.value]),
    [
      ['k1', 1, '内部资料'],
      ['r1', 1, 'PRJ-001'],
    ],
  );
  assert.equal(hits[1]!.start, 7);
});

test('正则匹配超时不拖死扫描，记为超时', () => {
  const m = compileCustomRules(
    [
      {
        id: 'slow',
        kind: 'regex',
        pattern: '(x|x)*y',
        category: '慢',
        severity: 'LOW',
        enabled: true,
      },
    ],
    { timeoutMs: 50 },
  );
  const t0 = Date.now();
  const hits = m.scan(['x'.repeat(40)]);
  assert.deepEqual(hits, []);
  assert.equal(m.timeouts(), 1);
  assert.ok(Date.now() - t0 < 2000);
});

test('正则检查：嵌套量词的绕过写法、重复分组里分支重叠、连续重复都拒绝；常见写法放行', () => {
  for (const p of [
    '((a+))+b',
    '(?:(?:a+))+b',
    '(a|a)*b',
    '(a|aa)+b',
    '(\\w|\\d)+!',
    '\\d+\\d+\\d+\\d+\\d+\\d+x',
    '(?<n>(?:x*))+y',
    '([a-z]|[A-Z])+$',
  ]) {
    assert.match(validateRegexPattern(p) ?? '', /回溯/, p);
  }
  for (const p of [
    '项目代号[A-Z]{2}\\d{4}',
    '(?:foo|bar)+',
    '(?:ab|ac)+',
    '\\d+-\\d+',
    '.*\\d+',
    '^(?:\\+?86)?1[3-9]\\d{9}$',
    '(?<=编号)[A-Z]\\d{6}',
    '\\bPRJ-\\d{3}\\b',
  ]) {
    assert.equal(validateRegexPattern(p), null, p);
  }
});

const regexRule = (i: number, pattern: string) => ({
  id: `r${i}`,
  kind: 'regex' as const,
  pattern,
  category: `c${i}`,
  severity: 'LOW' as const,
  enabled: true,
});

test('200 条正则 × 1 万条记录：整批进 vm，有时间上限', () => {
  const rules = Array.from({ length: 200 }, (_, i) => regexRule(i, `PRJ-${i}-\\d{3}`));
  const m = compileCustomRules(rules);
  const records = Array.from({ length: 10_000 }, (_, i) => [
    '这是一条普通的训练语料，内容大约五十个字左右，没有任何命中。',
    i === 7_777 ? '项目 PRJ-42-123 已归档' : 'output 文本',
  ]);
  const t0 = performance.now();
  const g = m.scanBatch(records);
  let r = g.next();
  while (!r.done) r = g.next();
  const ms = performance.now() - t0;
  const hits = r.value;
  assert.equal(hits.length, 10_000);
  assert.deepEqual(
    hits.flatMap((h, i) => h.map((x) => [i, x.ruleId, x.value])),
    [[7_777, 'r42', 'PRJ-42-123']],
  );
  assert.equal(m.timeouts(), 0);
  assert.ok(ms < 5000, `用了 ${ms.toFixed(0)}ms`);
});

test('每次都超时的正则：超时 3 次后停用，后面的记录不再跑它，统计里写明', () => {
  const m = compileCustomRules([regexRule(1, '(x|x)*y'), regexRule(2, 'PRJ-\\d{3}')], {
    timeoutMs: 50,
  });
  const records = Array.from({ length: 20 }, (_, i) => ['x'.repeat(40), `PRJ-${100 + i}`]);
  const t0 = performance.now();
  const g = m.scanBatch(records);
  let r = g.next();
  while (!r.done) r = g.next();
  const ms = performance.now() - t0;
  assert.equal(m.timeouts(), 3);
  assert.deepEqual(m.disabledRules(), [{ ruleId: 'r1', pattern: '(x|x)*y', category: 'c1' }]);
  // 另一条正则每条记录照常命中
  assert.deepEqual(
    r.value.map((h) => h.map((x) => x.ruleId)),
    records.map(() => ['r2']),
  );
  assert.ok(ms < 3000, `用了 ${ms.toFixed(0)}ms`);

  const s = createScanSession(
    { fileName: 'x.txt' },
    { customRules: [regexRule(1, '(x|x)*y')], regexTimeoutMs: 50 },
  );
  s.push(Array.from({ length: 5 }, () => 'x'.repeat(40)).join('\n'));
  s.end();
  assert.equal(s.stats().regexTimeouts, 3);
  assert.deepEqual(
    s.stats().disabledRules.map((d) => d.pattern),
    ['(x|x)*y'],
  );
});

test('扫描期间事件循环能响应：异步会话按片让出', async () => {
  const rules = Array.from({ length: 200 }, (_, i) => regexRule(i, `PRJ-${i}\\d{3}`));
  rules.push(regexRule(999, '(x|x)*y'));
  const s = createScanSession({ fileName: 'x.txt' }, { customRules: rules, regexTimeoutMs: 100 });
  const text = Array.from({ length: 20_000 }, (_, i) =>
    i % 5000 === 0 ? 'x'.repeat(40) : `第 ${i} 条普通语料，没有任何命中的内容。`,
  ).join('\n');
  let last = performance.now();
  let maxGap = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks += 1;
  }, 5);
  const t0 = performance.now();
  try {
    for (let i = 0; i < text.length; i += 1 << 16) await s.pushAsync(text.slice(i, i + (1 << 16)));
    await s.endAsync();
  } finally {
    clearInterval(timer);
  }
  const ms = performance.now() - t0;
  assert.equal(s.stats().totalRecords, 20_000);
  assert.ok(ms > 300, `负载太轻（${ms.toFixed(0)}ms），测不出让出`);
  assert.ok(ticks > ms / 200, `定时器只跑了 ${ticks} 次（${ms.toFixed(0)}ms）`);
  assert.ok(maxGap < 250, `事件循环最长被占 ${maxGap.toFixed(0)}ms`);
});

test('正则规则最多参与 500 条；超过 10 万字的字段只查前 10 万字并计数', () => {
  const rules = Array.from({ length: REGEX_RULES_MAX + 2 }, (_, i) => regexRule(i, `Q${i}-\\d`));
  const m = compileCustomRules(rules);
  assert.equal(m.size, REGEX_RULES_MAX);
  assert.equal(m.ignoredRegexRules, 2);
  const tail = compileCustomRules([regexRule(1, 'TAIL')]);
  assert.deepEqual(
    tail.scan(['a'.repeat(100_000) + 'TAIL', 'TAIL']).map((h) => h.fieldIndex),
    [1],
  );
  assert.equal(tail.truncatedFields(), 1);
});
