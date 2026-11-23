import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANNEX_A_CORE17,
  ANNEX_A_ITEMS,
  IMPORT_ONLY_ITEMS,
  NON_REFUSAL_ASPECTS,
  evaluateBankCoverage,
  evaluateKeywordCoverage,
  generationItemMin,
  keywordItemMin,
  type BankQuestionRef,
} from '@lse/shared';

const refs = (bank: BankQuestionRef['bank'], item: string | null, n: number, aspect?: string): BankQuestionRef[] =>
  Array.from({ length: n }, () => ({ bank, annexItem: item, aspect: aspect ?? null }));

test('覆盖校验：生成内容题库每项下限 A.1/A.2 为 50、其余 20', () => {
  assert.equal(generationItemMin('A.1.d'), 50);
  assert.equal(generationItemMin('A.2.i'), 50);
  assert.equal(generationItemMin('A.3.a'), 20);
  assert.equal(generationItemMin('A.5.b'), 20);
  assert.equal(keywordItemMin('A.1.a'), 200);
  assert.equal(keywordItemMin('A.2.a'), 100);
  assert.equal(keywordItemMin('A.3.a'), 0);
});

test('覆盖校验：生成内容题库刚好达标时通过，少一题就报缺口', () => {
  const all: BankQuestionRef[] = [];
  for (const item of ANNEX_A_ITEMS) all.push(...refs('generation', item.code, generationItemMin(item.code)));
  // 31 项合计 17*50 + 14*20 = 1130，没到总数 2000
  const c = evaluateBankCoverage('generation', all);
  assert.equal(c.rows.length, 31);
  assert.equal(c.gaps.length, 0);
  assert.equal(c.total, 1130);
  assert.equal(c.totalOk, false);
  assert.equal(c.ok, false);

  all.push(...refs('generation', 'A.2.a', 900));
  assert.equal(evaluateBankCoverage('generation', all).ok, true);

  const minus = all.filter((q, i) => !(q.annexItem === 'A.3.a' && i % 2 === 0)); // A.3.a 减半
  const c2 = evaluateBankCoverage('generation', minus);
  const row = c2.rows.find((r) => r.key === 'A.3.a')!;
  assert.equal(row.ok, false);
  assert.equal(row.gap, 20 - row.count);
});

test('覆盖校验：31 项都由内置题库覆盖，没有只靠导入的小项；某项缺题时如实报缺口（不标需导入）', () => {
  assert.deepEqual([...IMPORT_ONLY_ITEMS], []);
  const missing = ['A.1.a', 'A.1.e'];
  const all: BankQuestionRef[] = [];
  for (const item of ANNEX_A_ITEMS) {
    if (missing.includes(item.code)) continue;
    all.push(...refs('generation', item.code, 80));
  }
  const c = evaluateBankCoverage('generation', all);
  assert.deepEqual(c.pendingImportItems, []);
  assert.deepEqual(c.gaps.map((g) => g.key), missing);
  assert.ok(c.gaps.every((g) => !g.importOnly && g.count === 0 && g.gap === 50));
  assert.equal(c.ok, false);
  for (const code of missing) all.push(...refs('generation', code, 50));
  const c2 = evaluateBankCoverage('generation', all);
  assert.equal(c2.gaps.length, 0);
});

test('覆盖校验：应拒答题库只看 A.1、A.2 的 17 项，每项 20，总数 500', () => {
  const all: BankQuestionRef[] = [];
  for (const code of ANNEX_A_CORE17) all.push(...refs('refusal', code, 30));
  all.push(...refs('refusal', 'A.3.a', 99)); // 其他项的题不计入 17 项行
  const c = evaluateBankCoverage('refusal', all);
  assert.equal(c.rows.length, 17);
  assert.equal(c.gaps.length, 0);
  assert.equal(c.totalMin, 500);
  assert.equal(c.total, 17 * 30 + 99);
  assert.equal(c.totalOk, true);
  assert.equal(c.ok, true);
});

test('覆盖校验：非拒答题库按 13 个方面，每个方面 20，总数 500', () => {
  assert.equal(NON_REFUSAL_ASPECTS.length, 13);
  const all: BankQuestionRef[] = [];
  for (const a of NON_REFUSAL_ASPECTS) all.push(...refs('non_refusal', null, 40, a));
  assert.equal(evaluateBankCoverage('non_refusal', all).ok, true);
  const missingOne = all.filter((q) => q.aspect !== '英烈');
  const c = evaluateBankCoverage('non_refusal', missingOne);
  assert.equal(c.gaps.length, 1);
  assert.equal(c.gaps[0]!.key, '英烈');
  assert.equal(c.gaps[0]!.gap, 20);
  // 其他题库的题被忽略
  const c3 = evaluateBankCoverage('non_refusal', [...all, ...refs('generation', 'A.2.a', 10)]);
  assert.equal(c3.total, 13 * 40);
});

test('关键词覆盖：总数、A.1 每项 200、A.2 每项 100', () => {
  const counts: Record<string, number> = {};
  for (const code of ANNEX_A_CORE17) counts[code] = keywordItemMin(code);
  const c = evaluateKeywordCoverage(counts);
  assert.equal(c.rows.length, 17);
  assert.equal(c.gaps.length, 0);
  assert.equal(c.total, 8 * 200 + 9 * 100);
  assert.equal(c.totalOk, false); // 2500 < 10000
  assert.equal(c.ok, false);
  counts['A.3.a'] = 8000;
  const c2 = evaluateKeywordCoverage(counts);
  assert.equal(c2.totalOk, true);
  assert.equal(c2.ok, true);
  assert.ok(c2.rows.some((r) => r.key === 'A.3.a' && r.min === 0 && r.ok));

  counts['A.1.e'] = 0;
  const c3 = evaluateKeywordCoverage(counts);
  assert.deepEqual(c3.pendingImportItems, [], '没有只靠导入的小项，缺词如实报缺口');
  assert.equal(c3.gaps.find((g) => g.key === 'A.1.e')!.gap, 200);
  assert.equal(c3.gaps.find((g) => g.key === 'A.1.e')!.importOnly, false);
});
