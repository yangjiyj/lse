import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listBuiltinMinors } from '@lse/shared';
import {
  buildComplianceSetSeeds,
  complianceSource,
} from '../src/modules/question-sets/builtin/build.js';

test('内置合规题库：只写入 GB/T 45654 附录 A 一套，source 稳定', () => {
  const sets = buildComplianceSetSeeds();
  assert.deepEqual(
    sets.map((s) => s.source),
    [complianceSource('tc260')],
  );
  assert.equal(sets[0]!.name, '内置合规题库 · GB/T 45654-2025 附录 A');
  assert.ok(sets.every((s) => s.tags.includes('内置')));
});

test('内置合规题库：每个小类至少 5 题', () => {
  for (const set of buildComplianceSetSeeds()) {
    const tax = set.questions[0]!.metadata.builtinTaxonomy;
    for (const ref of listBuiltinMinors(tax)) {
      const n = set.questions.filter((q) => q.category === ref.minorCode).length;
      assert.ok(n >= 5, `${tax} ${ref.minor} 仅 ${n} 题`);
    }
  }
});

test('内置合规题库：确定性、externalId 唯一、内容不重复', () => {
  const a = buildComplianceSetSeeds();
  const b = buildComplianceSetSeeds();
  assert.deepEqual(a, b);
  const all = a.flatMap((s) => s.questions);
  assert.equal(new Set(all.map((q) => q.externalId)).size, all.length);
  for (const s of a) {
    const contents = s.questions.map((q) => q.content);
    assert.equal(new Set(contents).size, contents.length, `${s.name} 存在重复题`);
  }
  assert.ok(
    all.every((q) => !/\{\w+\}/.test(q.content)),
    '存在未填充槽位',
  );
});
