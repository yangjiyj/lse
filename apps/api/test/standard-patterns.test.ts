import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGUAGE,
  QUESTION_TYPE,
  STANDARD_NON_REFUSAL_TOPICS,
  STANDARD_RISK_CATEGORIES,
} from '@lse/shared';
import { slotNames } from '../src/modules/generator/core/fill.js';
import { generate } from '../src/modules/generator/core/generate.js';
import {
  STANDARD_ATTACK_PATTERNS,
  STANDARD_NON_REFUSAL_PATTERNS,
  STANDARD_ZH_PATTERNS,
} from '../src/modules/standard-evaluations/standard-patterns.js';

test('国标模板：31 个风险类别全部有攻击样本模板', () => {
  const covered = new Set(STANDARD_ATTACK_PATTERNS.map((pattern) => pattern.category));
  const missing = STANDARD_RISK_CATEGORIES.filter((category) => !covered.has(category));
  assert.deepEqual(missing, [], `缺少攻击样本模板的风险类别: ${missing.join(', ')}`);
});

test('国标模板：13 个非拒答主题全部有对照样本模板', () => {
  const covered = new Set(STANDARD_NON_REFUSAL_PATTERNS.map((pattern) => pattern.category));
  const missing = STANDARD_NON_REFUSAL_TOPICS.filter((topic) => !covered.has(topic));
  assert.deepEqual(missing, [], `缺少对照样本模板的非拒答主题: ${missing.join(', ')}`);
});

test('国标模板：攻击样本一律 shouldRefuse，对照样本一律不拒答', () => {
  for (const pattern of STANDARD_ATTACK_PATTERNS) {
    assert.equal(pattern.shouldRefuse, true, `${pattern.id} 攻击样本必须 shouldRefuse`);
  }
  for (const pattern of STANDARD_NON_REFUSAL_PATTERNS) {
    assert.equal(pattern.shouldRefuse, false, `${pattern.id} 对照样本不应要求拒答`);
    assert.equal(pattern.type, 'GENERAL', `${pattern.id} 对照样本题型应为 GENERAL`);
  }
});

test('国标模板：id 唯一、槽位闭合、语言与题型合法', () => {
  const ids = STANDARD_ZH_PATTERNS.map((pattern) => pattern.id);
  assert.equal(new Set(ids).size, ids.length, '模板 id 重复');

  for (const pattern of STANDARD_ZH_PATTERNS) {
    const used = new Set<string>([
      ...slotNames(pattern.template),
      ...slotNames(pattern.expectedBehavior ?? ''),
      ...slotNames(pattern.referenceAnswer ?? ''),
    ]);
    for (const name of used) {
      const words = pattern.slots[name];
      assert.ok(Array.isArray(words) && words.length > 0, `${pattern.id} 缺槽位词表: ${name}`);
    }
    assert.ok((LANGUAGE as readonly string[]).includes(pattern.language), `${pattern.id} 非法语言`);
    assert.ok(
      (QUESTION_TYPE as readonly string[]).includes(pattern.type),
      `${pattern.id} 非法题型`,
    );
    assert.equal(pattern.language, 'zh', `${pattern.id} 国标专项只覆盖中文`);
  }
});

test('国标模板：每条模板的槽位组合足够产出多样本，不会一抽就重复', () => {
  for (const pattern of STANDARD_ZH_PATTERNS) {
    const capacity = Object.values(pattern.slots).reduce(
      (product, words) => product * words.length,
      1,
    );
    assert.ok(capacity >= 4, `${pattern.id} 槽位组合只有 ${capacity} 种，太少`);
  }
});

test('国标模板：生成足量样本时能覆盖到全部风险类别', () => {
  const outcome = generate(STANDARD_ATTACK_PATTERNS, {
    types: [...new Set(STANDARD_ATTACK_PATTERNS.map((pattern) => pattern.type))],
    language: 'zh',
    count: 400,
    seed: 'coverage-check',
    dedupe: true,
  });
  assert.ok(outcome.produced > 0, '生成器没有产出样本');
  const covered = new Set(outcome.questions.map((question) => question.category));
  const missing = STANDARD_RISK_CATEGORIES.filter((category) => !covered.has(category));
  assert.deepEqual(missing, [], `400 条抽样仍未覆盖: ${missing.join(', ')}`);
});

test('国标模板：同一 seed 复现同一批样本', () => {
  const spec = {
    types: [...new Set(STANDARD_ATTACK_PATTERNS.map((pattern) => pattern.type))],
    language: 'zh' as const,
    count: 30,
    seed: 'replay-check',
    dedupe: true,
  };
  const first = generate(STANDARD_ATTACK_PATTERNS, spec);
  const second = generate(STANDARD_ATTACK_PATTERNS, spec);
  assert.deepEqual(
    first.questions.map((question) => question.content),
    second.questions.map((question) => question.content),
  );
});
