import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPrimaryReportResults } from '../src/modules/reports/report-primary-results.js';

test('主评估结果选择：同组有 B 选 B，无 B 保留 A，普通与无组 A 稳定保留', () => {
  const rows = [
    { id: 'ordinary-1', side: null, controlGroupId: null },
    { id: 'pair-a', side: 'A', controlGroupId: 'pair-1' },
    { id: 'ordinary-2', side: null, controlGroupId: null },
    { id: 'pair-b', side: 'B', controlGroupId: 'pair-1' },
    { id: 'a-only', side: 'A', controlGroupId: 'pair-2' },
    { id: 'a-no-group', side: 'A', controlGroupId: null },
    { id: 'b-no-group', side: 'B', controlGroupId: null },
  ];

  assert.deepEqual(
    selectPrimaryReportResults(rows).map((row) => row.id),
    ['ordinary-1', 'ordinary-2', 'pair-b', 'a-only', 'a-no-group', 'b-no-group'],
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ['ordinary-1', 'pair-a', 'ordinary-2', 'pair-b', 'a-only', 'a-no-group', 'b-no-group'],
  );
});
