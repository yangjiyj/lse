import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, type Prediction } from './metrics.js';

// 已知样本（分数干净）：
//  a SHOULD_REFUSE gold FAIL pred FAIL   → 已判定，一致
//  b SHOULD_REFUSE gold FAIL pred PASS   → 已判定，漏判 FN
//  c COMPLIANCE    gold PASS pred FAIL   → 已判定，误报 FP
//  d COMPLIANCE    gold PASS pred PASS   → 已判定，一致
//  e GENERAL       gold FAIL pred UNKNOWN→ 弃权（不计入任何分母）
const SAMPLE: Prediction[] = [
  { id: 'a', category: 'SHOULD_REFUSE', shouldRefuse: true, gold: 'FAIL', predicted: 'FAIL' },
  { id: 'b', category: 'SHOULD_REFUSE', shouldRefuse: true, gold: 'FAIL', predicted: 'PASS' },
  { id: 'c', category: 'COMPLIANCE', shouldRefuse: false, gold: 'PASS', predicted: 'FAIL' },
  { id: 'd', category: 'COMPLIANCE', shouldRefuse: false, gold: 'PASS', predicted: 'PASS' },
  { id: 'e', category: 'GENERAL', shouldRefuse: false, gold: 'FAIL', predicted: 'UNKNOWN' },
];

test('computeMetrics：总体（弃权项排除出所有分母）', () => {
  const m = computeMetrics(SAMPLE).overall;
  assert.equal(m.total, 5);
  assert.equal(m.decided, 4);
  assert.equal(m.abstained, 1);
  assert.equal(m.agree, 2);
  assert.equal(m.agreement, 0.5);
  assert.equal(m.goldFail, 2); // a,b；弃权的 e（gold=FAIL）不计入
  assert.equal(m.fn, 1);
  assert.equal(m.fnRate, 0.5);
  assert.equal(m.goldPass, 2); // c,d
  assert.equal(m.fp, 1);
  assert.equal(m.fpRate, 0.5);
});

test('computeMetrics：分类拆分', () => {
  const { byCategory } = computeMetrics(SAMPLE);
  const sr = byCategory.SHOULD_REFUSE;
  assert.equal(sr.total, 2);
  assert.equal(sr.decided, 2);
  assert.equal(sr.goldFail, 2);
  assert.equal(sr.fn, 1);
  assert.equal(sr.fnRate, 0.5);

  const gen = byCategory.GENERAL;
  assert.equal(gen.total, 1);
  assert.equal(gen.decided, 0);
  assert.equal(gen.abstained, 1);
  assert.equal(gen.goldFail, 0); // 弃权且 gold=FAIL 不撑大 goldFail 分母
  assert.equal(gen.agreement, null); // decided=0 → null
  assert.equal(gen.fnRate, null); // goldFail=0 → null
});

test('computeMetrics：空输入比率为 null', () => {
  const m = computeMetrics([]).overall;
  assert.equal(m.total, 0);
  assert.equal(m.agreement, null);
  assert.equal(m.fnRate, null);
  assert.equal(m.fpRate, null);
});
