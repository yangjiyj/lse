import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_TAXONOMIES,
  findBuiltinCategory,
  getBuiltinTaxonomy,
  listBuiltinMinors,
  builtinSetSource,
  COMPLIANCE_TAXONOMY_IDS,
  RETIRED_BUILTIN_SET_SOURCES,
  ANNEX_A_ITEMS,
  BINDABLE_TAXONOMIES,
} from '@lse/shared';

test('TC260 体系：5 大类 31 种安全风险', () => {
  const t = getBuiltinTaxonomy('tc260');
  assert.ok(t);
  assert.equal(t.majors.length, 5);
  assert.equal(listBuiltinMinors('tc260').length, 31);
  assert.deepEqual(
    t.majors.map((x) => x.code),
    ['A.1', 'A.2', 'A.3', 'A.4', 'A.5'],
  );
  assert.equal(t.majors[1]!.name, 'A.2 歧视性内容');
});

test('信通院、能源行业两套已下线：不再列出，历史题目仍能反查分类名称', () => {
  assert.ok(!BUILTIN_TAXONOMIES.some((t) => t.id === 'caict' || t.id === 'energy'));
  assert.ok(!BINDABLE_TAXONOMIES.some((t) => t.id === 'caict'), '信通院分类不可绑定');
  assert.match(getBuiltinTaxonomy('energy')!.name, /非标准/);
  assert.equal(findBuiltinCategory('CAICT.porn')?.minor, '涉黄');
  assert.equal(findBuiltinCategory('ENERGY.fund_fraud')?.minor, '资金骗取');
  assert.deepEqual([...RETIRED_BUILTIN_SET_SOURCES], ['builtin:compliance:caict', 'builtin:compliance:energy']);
});

test('附录 A 小类名称与标准条款主表一致', () => {
  assert.deepEqual(
    listBuiltinMinors('tc260').map((x) => [x.minorCode, x.minor]),
    ANNEX_A_ITEMS.map((i) => [i.code, i.name]),
  );
});

test('小类编码全局唯一，且可反查', () => {
  const codes = BUILTIN_TAXONOMIES.flatMap((t) =>
    t.majors.flatMap((mj) => mj.minors.map((x) => x.code)),
  );
  assert.equal(new Set(codes).size, codes.length);
  const ref = findBuiltinCategory('A.2.d');
  assert.equal(ref?.taxonomy, 'tc260');
  assert.equal(ref?.minor, '地域歧视内容');
  assert.equal(findBuiltinCategory('nope'), undefined);
});

test('中文通用安全场景体系：2 大类 13 小类，source 走数据集口径', () => {
  const t = getBuiltinTaxonomy('safety');
  assert.ok(t);
  assert.deepEqual(
    t.majors.map((x) => x.code),
    ['SAFETY.typical', 'SAFETY.attack'],
  );
  assert.equal(listBuiltinMinors('safety').length, 13);
  assert.equal(builtinSetSource('safety'), 'builtin:dataset:safety-prompts');
  assert.equal(builtinSetSource('tc260'), 'builtin:compliance:tc260');
  assert.deepEqual([...COMPLIANCE_TAXONOMY_IDS], ['tc260']);
});
