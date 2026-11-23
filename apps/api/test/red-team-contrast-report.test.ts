import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContrastView } from '../src/modules/reports/routes.js';

test('按 controlGroupId 分组出 A/B 对照表', () => {
  const rows = [
    { controlGroupId: 'cg1', side: 'A', finalVerdict: 'FAIL', questionId: 'q1' },
    { controlGroupId: 'cg1', side: 'B', finalVerdict: 'PASS', questionId: 'q1' },
    { controlGroupId: 'cg2', side: 'A', finalVerdict: 'FAIL', questionId: 'q2' },
    { controlGroupId: 'cg2', side: 'B', finalVerdict: 'FAIL', questionId: 'q2' },
    { controlGroupId: null, side: null, finalVerdict: 'PASS', questionId: 'q3' }, // 普通评测，忽略
  ];
  const view = buildContrastView(rows as any);
  assert.equal(view.pairs.length, 2);
  assert.equal(view.blockedByGateway, 1); // cg1: A 破 B 未破 → 网关挡下
  assert.equal(view.bypassedGateway, 1); // cg2: A 破 B 也破 → 绕过
  assert.equal(view.note, '对比数字为本次实测；若样本不足请在报告标注「示意」。');
});

test('对照组只有一侧（B 缺失）时不计入挡下/绕过', () => {
  const rows = [
    { controlGroupId: 'cgX', side: 'A', finalVerdict: 'FAIL', questionId: 'q1' },
    // 没有 side B
  ];
  const view = buildContrastView(rows as any);
  assert.equal(view.pairs.length, 1);
  assert.equal(view.blockedByGateway, 0);
  assert.equal(view.bypassedGateway, 0);
});

test('ERROR/UNKNOWN 裁判结果不计入挡下/绕过（对客户保守）', () => {
  const rows = [
    { controlGroupId: 'cgErr', side: 'A', finalVerdict: 'ERROR', questionId: 'q1' },
    { controlGroupId: 'cgErr', side: 'B', finalVerdict: 'PASS', questionId: 'q1' },
    { controlGroupId: 'cgUnk', side: 'A', finalVerdict: 'UNKNOWN', questionId: 'q2' },
    { controlGroupId: 'cgUnk', side: 'B', finalVerdict: 'FAIL', questionId: 'q2' },
  ];
  const view = buildContrastView(rows as any);
  assert.equal(view.pairs.length, 2);
  assert.equal(view.blockedByGateway, 0); // A 不是 FAIL，不算挡下
  assert.equal(view.bypassedGateway, 0); // A 不是 FAIL，不算绕过
});
