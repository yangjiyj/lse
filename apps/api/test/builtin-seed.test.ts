import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_NAME } from '../src/lib/product-name.js';
import { getBenchmarkSample, listBenchmarkSamples } from '../src/modules/benchmarks/samples.js';
import {
  buildBuiltinQuestionSetSeed,
  BUILTIN_SAMPLE_ID,
  findMissingBuiltinQuestions,
} from '../src/modules/benchmarks/builtin-seed.js';

test('内置样本集种子：稳定来源键 + 内置标记 + 13 题', () => {
  const seed = buildBuiltinQuestionSetSeed();
  // source 作为幂等键，必须稳定且与基准导入路由一致
  assert.equal(seed.source, `benchmark:${BUILTIN_SAMPLE_ID}`);
  assert.equal(seed.source, 'benchmark:lse-safety-mini');
  assert.equal(seed.isBuiltin, true);
  assert.equal(seed.type, 'GENERAL');
  assert.equal(seed.questions.length, 13);
  assert.ok(seed.name.length > 0, '题集必须有名称');
  assert.ok(seed.description.length > 0, '题集必须有描述');
});

test('内置样本集种子：四类题型齐全（合规/注入/应拒答/通用）', () => {
  const seed = buildBuiltinQuestionSetSeed();
  const types = new Set(seed.questions.map((q) => q.type));
  for (const t of ['COMPLIANCE', 'PROMPT_INJECTION', 'SHOULD_REFUSE', 'GENERAL']) {
    assert.ok(types.has(t), `缺少题型 ${t}`);
  }
});

test('内置样本集种子：每条题目内容/题型非空，应拒答题已打标', () => {
  const seed = buildBuiltinQuestionSetSeed();
  for (const q of seed.questions) {
    assert.ok(q.content.length > 0, '题目内容不能为空');
    assert.ok(q.type, '题目必须有题型');
  }
  // 至少一条应拒答题被标记 shouldRefuse=true（高危题不能漏标）
  assert.ok(
    seed.questions.some((q) => q.shouldRefuse === true),
    '应至少有一条 shouldRefuse=true 的题目',
  );
  assert.ok(
    seed.questions.some((q) => q.tags.includes('agent_tool_abuse')),
    '应包含 Agent 工具调用风险样例',
  );
});

test('内置样本集种子：未知样本集抛出明确错误', () => {
  assert.throws(() => buildBuiltinQuestionSetSeed('does-not-exist'), /未知的内置样本集/);
});

test('内置样本集种子同步：旧 12 题集只补 Agent 题且不会重复插入', () => {
  const seed = buildBuiltinQuestionSetSeed();
  const existingWithoutAgent = seed.questions
    .filter((q) => q.externalId !== 'LSE-AGT-001')
    .map((q) => ({ externalId: q.externalId, content: q.content, type: q.type }));

  const missing = findMissingBuiltinQuestions(seed.questions, existingWithoutAgent);
  assert.deepEqual(
    missing.map((q) => q.externalId),
    ['LSE-AGT-001'],
  );

  const existingAll = seed.questions.map((q) => ({
    externalId: q.externalId,
    content: q.content,
    type: q.type,
  }));
  assert.equal(findMissingBuiltinQuestions(seed.questions, existingAll).length, 0);
});

test('内置样本集改用产品名：不再出现旧名 LSE，名称含 PRODUCT_NAME，且稳定键（id/source）不变', () => {
  const seed = buildBuiltinQuestionSetSeed();
  assert.ok(seed.name.includes(PRODUCT_NAME), `题集名应含产品名，实际 ${seed.name}`);
  assert.doesNotMatch(seed.name, /LSE/);
  assert.doesNotMatch(seed.description, /LSE/);
  // 种子库幂等同步按 source 定位，样本集 id 是导入接口的入参：二者都不能因改名而变化
  assert.equal(seed.source, 'benchmark:lse-safety-mini');
  assert.equal(BUILTIN_SAMPLE_ID, 'lse-safety-mini');
  const sample = getBenchmarkSample('lse-safety-mini');
  assert.ok(sample, '按 id 仍能取到内置样本集');
  assert.equal(sample.label, seed.name);
  const listed = listBenchmarkSamples().find((x) => x.id === 'lse-safety-mini');
  assert.equal(listed?.label, seed.name);
});
