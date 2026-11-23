import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmCallResult } from '@lse/shared';
import type { GeneratedQuestion } from '../src/modules/generator/core/types.js';
import { buildEnhanceMessages, enhance } from '../src/modules/generator/enhance/enhance.js';

const q: GeneratedQuestion = {
  externalId: 'q1',
  content: '原题',
  type: 'GENERAL',
  category: '通用能力',
  language: 'zh',
  severity: 'INFO',
  shouldRefuse: false,
  expectedBehavior: null,
  referenceAnswer: null,
  tags: ['gen:algo'],
  variantId: 'legacy_0',
  riskDomain: 'general_safety',
};

function ok(content: string): LlmCallResult {
  return {
    status: 'SUCCESS',
    content,
    finishReason: null,
    model: null,
    usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    latencyMs: 1,
    httpStatus: 200,
    error: null,
    raw: null,
  };
}

function errCall(): LlmCallResult {
  return {
    status: 'ERROR',
    content: '',
    finishReason: null,
    model: null,
    usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    latencyMs: 1,
    httpStatus: null,
    error: 'boom',
    raw: null,
  };
}

test('未请求增强时原样返回', async () => {
  const res = await enhance([q], { spec: undefined, client: null, configured: false });
  assert.deepEqual(res.questions, [q]);
  assert.equal(res.stats.skippedReason, 'not_requested');
});

test('未配置增强 LLM 时原样返回并标记 not_configured', async () => {
  const res = await enhance([q], {
    spec: { mode: 'rewrite', intensity: 1, language: 'zh' },
    client: null,
    configured: false,
  });
  assert.deepEqual(res.questions, [q]);
  assert.equal(res.stats.skippedReason, 'not_configured');
});

test('rewrite/induce/variant 只更新 content 并保留元数据', async () => {
  for (const mode of ['rewrite', 'induce', 'variant'] as const) {
    const client = { chat: async () => ok('{"content":"增强题"}') };
    const res = await enhance([q], {
      spec: { mode, intensity: 1, language: 'zh' },
      client,
      configured: true,
    });

    assert.equal(res.questions[0]!.content, '增强题');
    assert.equal(res.questions[0]!.type, q.type);
    assert.equal(res.questions[0]!.category, q.category);
    assert.ok(res.questions[0]!.tags.includes('gen:llm'));
    assert.ok(res.questions[0]!.tags.includes(`enhance:${mode}`));
  }
});

test('LLM 失败时回退原题且 failed 计数增加', async () => {
  const client = { chat: async () => errCall() };
  const res = await enhance([q], {
    spec: { mode: 'rewrite', intensity: 1, language: 'zh' },
    client,
    configured: true,
  });
  assert.deepEqual(res.questions, [q]);
  assert.equal(res.stats.failed, 1);
});

test('护栏 prompt 禁止可操作有害步骤并要求 JSON 输出', () => {
  const text = buildEnhanceMessages(q, { mode: 'induce', intensity: 2, language: 'zh' })
    .map((m) => m.content)
    .join('\n');
  assert.match(text, /不得输出可操作有害步骤/);
  assert.match(text, /JSON/);
});

test('未指定增强语言时使用题目自身语言', () => {
  const text = buildEnhanceMessages(
    { ...q, language: 'en', content: 'Original question' },
    { mode: 'rewrite', intensity: 1 },
  )
    .map((m) => m.content)
    .join('\n');
  assert.match(text, /输出语言：en/);
});
