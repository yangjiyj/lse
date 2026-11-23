import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../src/modules/generator/core/prng.js';

test('makeRng 同种子产生相同序列（决定性）', () => {
  const a = makeRng('seed-x');
  const b = makeRng('seed-x');
  const seqA = [a.next(), a.next(), a.next()];
  const seqB = [b.next(), b.next(), b.next()];
  assert.deepEqual(seqA, seqB);
});

test('makeRng 不同种子产生不同序列', () => {
  const a = makeRng('seed-x');
  const b = makeRng('seed-y');
  assert.notDeepEqual([a.next(), a.next()], [b.next(), b.next()]);
});

test('rng.int 落在 [0, maxExclusive)', () => {
  const r = makeRng('s');
  for (let i = 0; i < 200; i++) {
    const v = r.int(7);
    assert.ok(v >= 0 && v < 7 && Number.isInteger(v));
  }
});

test('rng.pick 返回数组中的元素，shuffle 不丢元素', () => {
  const r = makeRng('s');
  const arr = ['a', 'b', 'c', 'd'];
  assert.ok(arr.includes(r.pick(arr)));
  const sh = r.shuffle(arr);
  assert.deepEqual([...sh].sort(), [...arr].sort());
});

test('rng.pick 空数组抛 RangeError', () => {
  const r = makeRng('s');
  assert.throws(() => r.pick([]), { name: 'RangeError' });
});

test('rng.int maxExclusive<=0 抛 RangeError', () => {
  const r = makeRng('s');
  assert.throws(() => r.int(0), { name: 'RangeError' });
  assert.throws(() => r.int(-1), { name: 'RangeError' });
});

import {
  slotNames,
  fillTemplate,
  patternCapacity,
  sampleFilled,
} from '../src/modules/generator/core/fill.js';
import type { QuestionPattern } from '../src/modules/generator/templates/types.js';

const FILL_PATTERN: QuestionPattern = {
  id: 't-fill',
  type: 'GENERAL',
  category: '通用能力',
  language: 'zh',
  severity: 'INFO',
  shouldRefuse: false,
  template: '请用{style}解释{topic}。',
  slots: { style: ['一句话', '类比'], topic: ['机器学习', '区块链', '光合作用'] },
  expectedBehavior: '应清晰解释{topic}。',
  referenceAnswer: undefined,
  tags: ['general'],
};

test('slotNames 提取去重的槽名', () => {
  assert.deepEqual(slotNames('请用{style}解释{topic}，再次{style}').sort(), ['style', 'topic']);
});

test('fillTemplate 替换已知槽，未知槽保留字面量', () => {
  assert.equal(fillTemplate('a{x}b{y}', { x: '1' }), 'a1b{y}');
});

test('patternCapacity = 各槽词表长度笛卡尔积', () => {
  assert.equal(patternCapacity(FILL_PATTERN), 2 * 3);
});

test('sampleFilled 返回 content/values/key，且 key 由所选槽值组成', () => {
  const r = makeRng('s');
  const out = sampleFilled(FILL_PATTERN, r);
  assert.ok(out.content.includes('解释'));
  assert.ok(['一句话', '类比'].includes(out.values.style));
  assert.ok(out.key.startsWith('t-fill|'));
});

import { applyVariant } from '../src/modules/generator/core/variants.js';

test('variantStrength=0 原样返回', () => {
  const r = makeRng('s');
  assert.equal(applyVariant('原句。', 'zh', 0, r), '原句。');
});

test('variantStrength=1 仅可能加前缀（结果包含原句）', () => {
  const r = makeRng('s');
  const out = applyVariant('原句。', 'zh', 1, r);
  assert.ok(out.includes('原句。'));
});

test('英文变体使用英文前后缀（不混入中文）', () => {
  const r = makeRng('seed-en');
  const out = applyVariant('Original.', 'en', 2, r);
  assert.ok(/^[\x00-\x7F\s]*Original\./.test(out) || out === 'Original.');
});

import { autoTags } from '../src/modules/generator/core/tagging.js';

test('autoTags 合并基础标签并补 lang/type/cat/gen 标记，去重', () => {
  const tags = autoTags(['safety', 'safety'], 'SHOULD_REFUSE', '危险物品', 'zh');
  assert.ok(tags.includes('safety'));
  assert.ok(tags.includes('lang:zh'));
  assert.ok(tags.includes('type:SHOULD_REFUSE'));
  assert.ok(tags.includes('cat:危险物品'));
  assert.ok(tags.includes('gen:algo'));
  assert.equal(tags.filter((t) => t === 'safety').length, 1);
});

import { specSignature } from '../src/modules/generator/core/signature.js';
import type { GenerateSpec } from '../src/modules/generator/core/types.js';

test('specSignature 与 types 顺序无关（规范化排序后签名一致）', () => {
  const a: GenerateSpec = { types: ['GENERAL', 'COMPLIANCE'], language: 'zh', count: 10 };
  const b: GenerateSpec = { types: ['COMPLIANCE', 'GENERAL'], language: 'zh', count: 10 };
  assert.equal(specSignature(a), specSignature(b));
});

test('specSignature 对 seed 敏感（不同 seed → 不同签名）', () => {
  const a: GenerateSpec = { types: ['GENERAL'], language: 'zh', count: 10, seed: 's1' };
  const b: GenerateSpec = { types: ['GENERAL'], language: 'zh', count: 10, seed: 's2' };
  assert.notEqual(specSignature(a), specSignature(b));
});

test('specSignature 格式为 /^gen[0-9a-z]+$/', () => {
  const a: GenerateSpec = { types: ['GENERAL'], language: 'zh', count: 10 };
  assert.match(specSignature(a), /^gen[0-9a-z]+$/);
});

import {
  generate,
  selectPatterns,
  capacityCeiling,
} from '../src/modules/generator/core/generate.js';
import { ALL_PATTERNS } from '../src/modules/generator/templates/index.js';

import { LANGUAGE_PROFILES } from '../src/modules/generator/core/language-profiles.js';
import { ATTACK_VARIANTS } from '../src/modules/generator/core/attack-variants.js';

test('selectPatterns 按语言+题型+可选分类过滤', () => {
  const sel = selectPatterns(ALL_PATTERNS, { types: ['GENERAL'], language: 'zh', count: 1 });
  assert.ok(sel.length > 0);
  assert.ok(sel.every((p) => p.language === 'zh' && p.type === 'GENERAL'));
});

test('generate 决定性：同 seed 同结果', () => {
  const spec = { types: ['GENERAL'] as const, language: 'zh' as const, count: 8, seed: 'fixed' };
  const a = generate(ALL_PATTERNS, { ...spec, types: [...spec.types] });
  const b = generate(ALL_PATTERNS, { ...spec, types: [...spec.types] });
  assert.deepEqual(
    a.questions.map((q) => q.content),
    b.questions.map((q) => q.content),
  );
});

test('generate 新鲜性：不同 seed 多半不同', () => {
  const base = { types: ['GENERAL'] as string[], language: 'zh' as const, count: 8 };
  const a = generate(ALL_PATTERNS, { ...base, seed: 's1' });
  const b = generate(ALL_PATTERNS, { ...base, seed: 's2' });
  assert.notDeepEqual(
    a.questions.map((q) => q.content),
    b.questions.map((q) => q.content),
  );
});

test('generate 保守容量：produced 不超过 ceiling，去重不补重复', () => {
  const spec = {
    types: ['GENERAL'] as string[],
    language: 'zh' as const,
    count: 100000,
    dedupe: true,
    seed: 'cap',
  };
  const out = generate(ALL_PATTERNS, spec);
  assert.equal(out.produced, out.questions.length);
  assert.ok(out.produced <= out.capacityCeiling);
  const contents = out.questions.map((q) => q.content);
  assert.equal(new Set(contents).size, contents.length); // 无重复
});

test('generate 空模板集 → produced 0', () => {
  const out = generate(ALL_PATTERNS, {
    types: ['GENERAL'],
    language: 'zh',
    count: 5,
    categories: ['不存在的分类'],
  });
  assert.equal(out.produced, 0);
  assert.equal(out.questions.length, 0);
});

test('generate externalId 唯一', () => {
  const out = generate(ALL_PATTERNS, {
    types: ['GENERAL', 'SHOULD_REFUSE'],
    language: 'zh',
    count: 30,
    seed: 'eid',
  });
  const ids = out.questions.map((q) => q.externalId);
  assert.equal(new Set(ids).size, ids.length);
});

test('语言画像覆盖不少于 40 种语言且包含小语种权重', () => {
  assert.ok(LANGUAGE_PROFILES.length >= 40);
  assert.ok(LANGUAGE_PROFILES.some((p) => p.code === 'sw' && p.weight > 0));
  assert.ok(LANGUAGE_PROFILES.some((p) => p.code === 'yo' && p.weight > 0));
});

test('攻击变种池覆盖编码、混淆、多语言、间接注入和多轮形态', () => {
  const ids = ATTACK_VARIANTS.map((v) => v.id);
  assert.ok(ids.includes('base64'));
  assert.ok(ids.includes('homoglyph'));
  assert.ok(ids.includes('multilingual_mix'));
  assert.ok(ids.includes('indirect_tool_output'));
  assert.ok(ids.includes('crescendo_seed'));
  assert.ok(ids.includes('gcg_style_suffix'));
});

test('auto generate 自动覆盖多语言、变种和风险域标签', () => {
  const out = generate(ALL_PATTERNS, {
    types: ['PROMPT_INJECTION', 'SHOULD_REFUSE', 'COMPLIANCE', 'GENERAL'],
    count: 220,
    seed: 'auto-diverse',
  });
  const langs = new Set(out.questions.map((q) => q.language));
  const variants = new Set(
    out.questions.flatMap((q) => q.tags.filter((t) => t.startsWith('variant:'))),
  );
  const risks = new Set(out.questions.flatMap((q) => q.tags.filter((t) => t.startsWith('risk:'))));
  assert.ok(langs.size >= 8);
  assert.ok(variants.size >= 8);
  assert.ok(risks.size >= 10, `风险域覆盖不足：${[...risks].join(', ')}`);
  for (const expected of [
    'risk:prompt_injection',
    'risk:harmful_capability',
    'risk:cyber_abuse',
    'risk:fraud_social_engineering',
    'risk:system_prompt_leakage',
    'risk:rag_data_poisoning',
    'risk:output_injection',
    'risk:misinformation_hallucination',
    'risk:unsafe_professional_advice',
  ]) {
    assert.ok(risks.has(expected), `缺少风险域标签 ${expected}`);
  }
  assert.equal(out.diversity.languages.length, langs.size);
  assert.equal(out.diversity.variants.length, variants.size);
});

test('auto generate 同 seed 保持确定性', () => {
  const spec = { types: ['PROMPT_INJECTION'] as const, count: 30, seed: 'same-auto-seed' };
  const a = generate(ALL_PATTERNS, { ...spec, types: [...spec.types] });
  const b = generate(ALL_PATTERNS, { ...spec, types: [...spec.types] });
  assert.deepEqual(
    a.questions.map((q) => [
      q.content,
      q.language,
      q.tags.filter((t) => t.startsWith('variant:')).join(','),
    ]),
    b.questions.map((q) => [
      q.content,
      q.language,
      q.tags.filter((t) => t.startsWith('variant:')).join(','),
    ]),
  );
});
