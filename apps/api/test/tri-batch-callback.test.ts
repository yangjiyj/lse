import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCallbackRuns } from '../src/modules/batch-evaluations/callback.js';
test('batch callback counts stored sample verdicts without inventing a run verdict', () => {
  assert.deepEqual(summarizeCallbackRuns([
    { status: 'COMPLETED', results: [{ verdict: 'PASS' }] },
    { status: 'COMPLETED', results: [{ verdict: 'FAIL' }] },
    { status: 'RUNNING', results: [{ verdict: 'PASS' }] },
    { status: 'COMPLETED', results: [] },
    { status: 'COMPLETED', results: [{ verdict: 'ERROR' }] },
  ]), { total: 5, pass: 1, fail: 1, incomplete: 3 });
});
