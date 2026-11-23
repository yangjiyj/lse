import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmTargetConfig } from '@lse/shared';
import { resolvePerQuestionEngines } from '../src/modules/engines/registry.js';

// 全局评审模型注入：executor 从 DB 解析出激活的 JUDGE 目标后，注入 resolvePerQuestionEngines。
// 关键语义：
//  - 注入有效目标 → llm-judge 自启用（DB 配置即开关），即便 LSE_TEST=1 门控关闭外部引擎；
//  - 不注入（undefined）→ 走环境变量旧路径，LSE_TEST=1 下 llm-judge 不出现（向后兼容）；
//  - 注入 null → 调用方明确「无评审目标」，不启用 llm-judge。
// 本测试在 LSE_TEST=1 下运行（见 package/test 约定）。

const JUDGE: LlmTargetConfig = {
  baseUrl: 'https://judge.example/v1',
  apiKey: 'sk-judge',
  model: 'judge-model',
  extraHeaders: null,
  defaultParams: null,
};

function ids(engines: { engine: string }[]): string[] {
  return engines.map((e) => e.engine);
}

test('resolvePerQuestionEngines: 注入有效评审目标 → 默认引擎集包含 llm-judge', () => {
  const engines = resolvePerQuestionEngines([], JUDGE);
  assert.ok(ids(engines).includes('llm-judge'), 'DB 评审目标应自启用 llm-judge');
  // 内置两引擎仍在
  assert.ok(ids(engines).includes('rule-judge'));
  assert.ok(ids(engines).includes('sensitive-info'));
});

test('resolvePerQuestionEngines: 未注入（undefined）→ LSE_TEST 下不含 llm-judge（向后兼容）', () => {
  const engines = resolvePerQuestionEngines([]);
  assert.equal(ids(engines).includes('llm-judge'), false);
});

test('resolvePerQuestionEngines: 注入 null → 不启用 llm-judge', () => {
  const engines = resolvePerQuestionEngines([], null);
  assert.equal(ids(engines).includes('llm-judge'), false);
});

test('resolvePerQuestionEngines: 显式勾选 llm-judge + 注入目标 → 可被选中', () => {
  const engines = resolvePerQuestionEngines(['llm-judge'], JUDGE);
  assert.deepEqual(ids(engines), ['llm-judge']);
});

test('resolvePerQuestionEngines: 只勾任务级引擎 + 注入目标 → 单题保底内置并追加 llm-judge', () => {
  const engines = resolvePerQuestionEngines(['ai-infra-guard'], JUDGE);
  assert.deepEqual(ids(engines), ['rule-judge', 'sensitive-info', 'llm-judge']);
});

test('resolvePerQuestionEngines: 注入目标字段不完整 → 不启用 llm-judge', () => {
  const engines = resolvePerQuestionEngines([], { ...JUDGE, baseUrl: '' });
  assert.equal(ids(engines).includes('llm-judge'), false);
});

test('plain model evaluation does not enable a tool judge merely because a review model is configured', () => {
  assert.ok(!ids(resolvePerQuestionEngines([], JUDGE, 'MODEL')).includes('agent-llm-judge'));
  assert.ok(ids(resolvePerQuestionEngines([], JUDGE, 'AGENT_API')).includes('agent-llm-judge'));
});
