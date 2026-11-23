import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedRetestClosureReason, type RetestEvidenceInput } from '../src/modules/eval-tasks/retest-evidence.js';
const complete: RetestEvidenceInput = { originalTaskId: 'parent', parentTaskId: 'parent',
  originalOwnerId: 'service', retestOwnerId: 'service', status: 'COMPLETED', requiredQuestionIds: ['failed-case'],
  results: [{ questionId: 'failed-case', finalVerdict: 'PASS', status: 'SUCCESS' }] };
test('linked same-owner original failed case PASS permits closure', () => assert.equal(failedRetestClosureReason(complete), null));
for (const verdict of ['FAIL', 'ERROR', 'UNKNOWN', null]) {
  test(`retest ${verdict} never permits closure`, () => assert.ok(failedRetestClosureReason({ ...complete,
    results: [{ questionId: 'failed-case', finalVerdict: verdict, status: 'SUCCESS' }] })));
}
test('missing, pending, unlinked, cross-owner, empty and duplicate failed evidence deny closure', () => {
  for (const change of [{ results: [] }, { status: 'PENDING' }, { parentTaskId: 'foreign' },
    { retestOwnerId: 'foreign' }, { originalOwnerId: null }, { requiredQuestionIds: [] },
    { results: [...complete.results, { questionId: 'failed-case', finalVerdict: 'ERROR', status: 'ERROR' }] }])
    assert.ok(failedRetestClosureReason({ ...complete, ...change }));
});
