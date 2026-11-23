import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickJudgeTarget } from '../src/modules/engines/judge-target.js';

// 全局单一「评审模型」配置入口：评审对象与被测对象（SUT）必须解耦。
// pickJudgeTarget 接收 DB 里激活的 JUDGE ModelTarget 候选 + 当前任务的 SUT 引用，
// 返回可注入 llm-judge 的 LlmTargetConfig；任何「自评 / 未配置」情形一律返回 null，
// 由调用方回退到环境变量或不启用 llm-judge。

const SUT = {
  id: 'sut-row-1',
  baseUrl: 'http://sut.example/v1',
  model: 'qwen2.5-7b-instruct-local',
};

function judge(overrides: Record<string, unknown> = {}) {
  return {
    id: 'judge-row-1',
    baseUrl: 'https://judge.example/v1',
    apiKey: 'sk-judge',
    model: 'judge-model',
    extraHeaders: null,
    defaultParams: null,
    ...overrides,
  };
}

test('pickJudgeTarget: 完整且区别于 SUT 的候选 → 归一化为 LlmTargetConfig', () => {
  const cfg = pickJudgeTarget(judge(), SUT);
  assert.deepEqual(cfg, {
    baseUrl: 'https://judge.example/v1',
    apiKey: 'sk-judge',
    model: 'judge-model',
    extraHeaders: null,
    defaultParams: null,
  });
});

test('pickJudgeTarget: 候选携带 extraHeaders/defaultParams → 原样保留', () => {
  const cfg = pickJudgeTarget(
    judge({ extraHeaders: { 'x-k': 'v' }, defaultParams: { temperature: 0 } }),
    SUT,
  );
  assert.deepEqual(cfg?.extraHeaders, { 'x-k': 'v' });
  assert.deepEqual(cfg?.defaultParams, { temperature: 0 });
});

test('pickJudgeTarget: 候选为 null/undefined（未配置评审模型）→ null', () => {
  assert.equal(pickJudgeTarget(null, SUT), null);
  assert.equal(pickJudgeTarget(undefined, SUT), null);
});

test('pickJudgeTarget: baseUrl/apiKey/model 任一缺失或空白 → null（视为未配置）', () => {
  assert.equal(pickJudgeTarget(judge({ baseUrl: '' }), SUT), null);
  assert.equal(pickJudgeTarget(judge({ apiKey: '' }), SUT), null);
  assert.equal(pickJudgeTarget(judge({ model: '' }), SUT), null);
  assert.equal(pickJudgeTarget(judge({ baseUrl: '   ' }), SUT), null);
});

test('pickJudgeTarget: 候选与 SUT 同一行（id 相同）→ null（禁止自评）', () => {
  const cfg = pickJudgeTarget(judge({ id: SUT.id }), SUT);
  assert.equal(cfg, null);
});

test('pickJudgeTarget: 候选与 SUT 同一端点+同一模型 → null（同端点自评）', () => {
  const cfg = pickJudgeTarget(
    judge({ id: 'other-row', baseUrl: SUT.baseUrl, model: SUT.model }),
    SUT,
  );
  assert.equal(cfg, null);
});

test('pickJudgeTarget: 同端点但不同模型 → 允许（同一网关下另一模型可作评审）', () => {
  const cfg = pickJudgeTarget(
    judge({ id: 'other-row', baseUrl: SUT.baseUrl, model: 'a-different-judge-model' }),
    SUT,
  );
  assert.equal(cfg?.baseUrl, SUT.baseUrl);
  assert.equal(cfg?.model, 'a-different-judge-model');
});
