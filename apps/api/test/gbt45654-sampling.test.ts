import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANNEX_ITEM_CODES,
  NON_REFUSAL_ASPECTS,
  REFUSAL_ITEM_CODES,
  generationItemQuota,
} from '../src/modules/standard-evaluations/gbt45654/constants.js';
import {
  allocateStrata,
  sampleBank,
  type BankQuestion,
} from '../src/modules/standard-evaluations/gbt45654/sampling.js';

function fixtureBank(keys: readonly string[], perKey: number, mode: 'annex' | 'aspect'): BankQuestion[] {
  const out: BankQuestion[] = [];
  for (const key of keys) {
    for (let i = 0; i < perKey; i += 1) {
      out.push({
        id: `${key}-${String(i).padStart(4, '0')}`,
        annexItem: mode === 'annex' ? key : null,
        aspect: mode === 'aspect' ? key : null,
        clauseIds: mode === 'annex' ? [`gbt45654.${key}`] : [],
      });
    }
  }
  return out;
}

test('生成内容抽样：按 31 项分层，每项至少抽到题库要求的题数，合计 1130', () => {
  const bank = fixtureBank(ANNEX_ITEM_CODES, 80, 'annex');
  const result = sampleBank('generation', bank, { seed: 's1' });
  assert.equal(result.items.length, 1130);
  assert.ok(result.items.length >= 1000, '不少于附录 B 要求的 1000 题');
  const perItem = new Map<string, number>();
  for (const q of result.items) perItem.set(q.annexItem!, (perItem.get(q.annexItem!) ?? 0) + 1);
  assert.equal(perItem.size, 31);
  for (const code of ANNEX_ITEM_CODES) {
    assert.equal(perItem.get(code), generationItemQuota(code), `${code} 的抽样题数`);
  }
  assert.equal(result.shortage, 0);
  assert.equal(new Set(result.items.map((q) => q.id)).size, result.items.length, '不放回');
});

test('生成内容抽样：要求超过保底之和时，余量均衡分配到各项', () => {
  const bank = fixtureBank(ANNEX_ITEM_CODES, 80, 'annex');
  const result = sampleBank('generation', bank, { seed: 's1', requested: 1500 });
  assert.equal(result.items.length, 1500);
  const perItem = new Map<string, number>();
  for (const q of result.items) perItem.set(q.annexItem!, (perItem.get(q.annexItem!) ?? 0) + 1);
  const counts = ANNEX_ITEM_CODES.map((c) => perItem.get(c)! - generationItemQuota(c));
  // 余量 370 题在 31 项里轮流分，每项相差不超过 1
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, JSON.stringify(counts));
});

test('同种子同题库得到同一名单，换种子名单变化', () => {
  const bank = fixtureBank(ANNEX_ITEM_CODES, 80, 'annex');
  const a = sampleBank('generation', bank, { seed: 'same' }).items.map((q) => q.id);
  const b = sampleBank('generation', bank, { seed: 'same' }).items.map((q) => q.id);
  const c = sampleBank('generation', bank, { seed: 'other' }).items.map((q) => q.id);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  // 题库顺序不影响名单
  const shuffled = [...bank].reverse();
  assert.deepEqual(sampleBank('generation', shuffled, { seed: 'same' }).items.map((q) => q.id), a);
});

test('应拒答题按 17 项分层、非拒答题按 13 个方面分层，各抽 300', () => {
  const refusal = sampleBank('refusal', fixtureBank(REFUSAL_ITEM_CODES, 40, 'annex'), { seed: 's' });
  assert.equal(refusal.items.length, 300);
  assert.equal(new Set(refusal.items.map((q) => q.annexItem)).size, 17);
  const perItem = new Map<string, number>();
  for (const q of refusal.items) perItem.set(q.annexItem!, (perItem.get(q.annexItem!) ?? 0) + 1);
  for (const c of REFUSAL_ITEM_CODES) assert.ok(perItem.get(c)! >= 17 && perItem.get(c)! <= 18, `${c}=${perItem.get(c)}`);

  const nonRefusal = sampleBank('non_refusal', fixtureBank(NON_REFUSAL_ASPECTS, 50, 'aspect'), { seed: 's' });
  assert.equal(nonRefusal.items.length, 300);
  assert.equal(new Set(nonRefusal.items.map((q) => q.aspect)).size, 13);
});

test('题库不足：照抽，缺口如实记录，保底项缺口写进分层结果', () => {
  // 题库只有 20 题（每项不足 1 题），远少于 1000
  const small = ANNEX_ITEM_CODES.slice(0, 20).map((code, i) => ({
    id: `q${i}`,
    annexItem: code,
    aspect: null,
    clauseIds: [`gbt45654.${code}`],
  }));
  const result = sampleBank('generation', small, { seed: 's' });
  assert.equal(result.items.length, 20);
  assert.equal(result.shortage, 980);
  const a1a = result.strata.find((s) => s.key === 'A.1.a')!;
  assert.equal(a1a.selected, 1);
  assert.equal(a1a.shortfall, 49);
  const missing = result.strata.find((s) => s.key === 'A.5.b')!;
  assert.equal(missing.available, 0);
  assert.equal(missing.selected, 0);
});

test('没有标注所属项的题不参与抽样，并计入未归类数', () => {
  const bank: BankQuestion[] = [
    { id: 'x1', annexItem: null, aspect: null, clauseIds: [] },
    { id: 'x2', annexItem: 'A.9.z', aspect: null, clauseIds: [] },
    { id: 'ok', annexItem: 'A.2.e', aspect: null, clauseIds: ['gbt45654.A.2.e'] },
  ];
  const result = sampleBank('generation', bank, { seed: 's' });
  assert.equal(result.items.length, 1);
  assert.equal(result.unclassified, 2);
});

test('allocateStrata：总数小于保底之和时均衡分配，不超过各层可用数', () => {
  const alloc = allocateStrata(
    [
      { key: 'a', available: 100, quota: 50 },
      { key: 'b', available: 2, quota: 50 },
      { key: 'c', available: 100, quota: 20 },
    ],
    30,
    'seed',
  );
  const sel = Object.fromEntries(alloc.map((a) => [a.key, a.selected]));
  assert.equal(sel.a + sel.b + sel.c, 30);
  assert.ok(sel.b <= 2);
  assert.equal(alloc.find((a) => a.key === 'b')!.shortfall, 48);
});
