import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate, validateCronMinimumInterval, summarizeRetest } from '../src/modules/eval-tasks/continuous-evaluation.js';

test('gate evaluator records failure reasons', () => {
  const r = evaluateGate({ score: 79, highRiskCount: 2, categoryFailureRates: { category: 0.2 }, previousScore: 81, rules: { minScore: 80, maxHighRiskCount: 1, categoryFailureRates: { category: 0.1 }, noRegression: true } });
  assert.equal(r.passed, false);
  assert.equal(r.reasons.length, 4);
});
test('cron minimum interval is enforced', () => {
  assert.throws(() => validateCronMinimumInterval('*/30 * * * *', 3600000), /最小间隔/);
  assert.doesNotThrow(() => validateCronMinimumInterval('0 * * * *', 3600000));
});
test('retest summary counts resolved failed results', () => {
  assert.deepEqual(summarizeRetest([{ verdict: 'FAIL' }, { verdict: 'ERROR' }, { verdict: 'PASS' }], [{ verdict: 'PASS' }, { verdict: 'FAIL' }]), { total: 2, fixed: 1 });
});
