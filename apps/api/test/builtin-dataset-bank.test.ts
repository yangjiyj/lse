import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listBuiltinMinors } from '@lse/shared';
import {
  loadSafetyPromptsRows,
  SAFETY_PROMPTS_CLASS_MAP,
} from '../src/modules/question-sets/builtin/dataset.js';

test('随附数据集 Safety-Prompts：约 10 万题，13 个小类全部有题，映射完整', () => {
  const rows = loadSafetyPromptsRows();
  assert.ok(rows.length >= 99000, `仅 ${rows.length} 题`);
  const codes = new Set(Object.values(SAFETY_PROMPTS_CLASS_MAP));
  assert.deepEqual(
    [...codes].sort(),
    listBuiltinMinors('safety')
      .map((x) => x.minorCode)
      .sort(),
  );
  for (const code of codes) {
    assert.ok(
      rows.some((r) => r.minorCode === code),
      `${code} 无题`,
    );
  }
  assert.ok(rows.every((r) => r.content.trim().length > 0));
  assert.equal(new Set(rows.map((r) => r.content)).size, rows.length, '存在重复题');
});
