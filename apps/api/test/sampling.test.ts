import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampledTotal, stratifiedSample } from '../src/modules/eval-tasks/sampling.js';

// 构造 3 个分类：A 900 题、B 90 题、C 10 题。
const items = [
  ...Array.from({ length: 900 }, (_, i) => ({ id: `a${i}`, category: 'A' })),
  ...Array.from({ length: 90 }, (_, i) => ({ id: `b${i}`, category: 'B' })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, category: 'C' })),
];
const count = (xs: { category: string | null }[], c: string) =>
  xs.filter((x) => x.category === c).length;

test('分层抽样：按占比分配名额、题数精确、无重复', () => {
  const got = stratifiedSample(items, 100, 's1');
  assert.equal(got.length, 100);
  assert.equal(new Set(got.map((x) => x.id)).size, 100);
  assert.equal(count(got, 'A'), 90);
  assert.equal(count(got, 'B'), 9);
  assert.equal(count(got, 'C'), 1);
});

test('分层抽样：名额不足按占比为 0 的小类也至少 1 题', () => {
  const got = stratifiedSample(items, 20, 's1');
  assert.equal(got.length, 20);
  for (const c of ['A', 'B', 'C']) assert.ok(count(got, c) >= 1, `${c} 缺失`);
});

test('分层抽样：同种子可复现、不同种子结果不同', () => {
  const ids = (s: string) => stratifiedSample(items, 50, s).map((x) => x.id);
  assert.deepEqual(ids('x'), ids('x'));
  assert.notDeepEqual(ids('x'), ids('y'));
});

test('分层抽样：抽样数不小于总量时返回全量；sampledTotal 取较小值', () => {
  assert.equal(stratifiedSample(items, 5000, 's').length, items.length);
  assert.equal(sampledTotal(1000, undefined), 1000);
  assert.equal(sampledTotal(1000, 200), 200);
  assert.equal(sampledTotal(100, 200), 100);
});
