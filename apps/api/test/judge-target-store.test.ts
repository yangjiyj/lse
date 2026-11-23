import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadActiveJudgeTarget,
  selectLatestActiveJudgeTarget,
} from '../src/modules/engines/judge-target.js';

// executor 侧的「全局评审模型」DB 解析：查激活的 JUDGE ModelTarget → pickJudgeTarget(候选, SUT)。
// 返回三态，直接喂给 resolvePerQuestionEngines：
//  - 无 JUDGE 行 → undefined（回退环境变量 LLM_JUDGE_*，向后兼容）；
//  - 行存在但与 SUT 自评/字段不完整 → null（不启用 llm-judge，故障安全）；
//  - 行有效且区别于 SUT → LlmTargetConfig。

const SUT = {
  id: 'sut-row-1',
  baseUrl: 'http://sut.example/v1',
  model: 'qwen2.5-7b-instruct-local',
};

function judgeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'judge-row-1',
    name: 'AI复核',
    baseUrl: 'https://judge.example/v1',
    apiKey: 'sk-judge',
    model: 'judge-model',
    extraHeaders: null,
    defaultParams: null,
    lastTestStatus: 'SUCCESS',
    ...overrides,
  };
}

function store(row: unknown, capture?: { args?: unknown }) {
  return {
    modelTarget: {
      async findFirst(args: unknown) {
        if (capture) capture.args = args;
        return row as never;
      },
    },
  };
}

test('loadActiveJudgeTarget: 无 JUDGE 行 → undefined（回退环境变量）', async () => {
  const result = await loadActiveJudgeTarget(store(null), SUT);
  assert.equal(result, undefined);
});

test('loadActiveJudgeTarget: 有效且区别于 SUT 的行 → LlmTargetConfig', async () => {
  const result = await loadActiveJudgeTarget(store(judgeRow()), SUT);
  assert.deepEqual(result, {
    baseUrl: 'https://judge.example/v1',
    apiKey: 'sk-judge',
    model: 'judge-model',
    extraHeaders: null,
    defaultParams: null,
  });
});

test('loadActiveJudgeTarget: 行与 SUT 同一行（id 相同）→ null（禁止自评）', async () => {
  const result = await loadActiveJudgeTarget(store(judgeRow({ id: SUT.id })), SUT);
  assert.equal(result, null);
});

test('loadActiveJudgeTarget: 行与 SUT 同端点+同模型 → null', async () => {
  const result = await loadActiveJudgeTarget(
    store(judgeRow({ id: 'x', baseUrl: SUT.baseUrl, model: SUT.model })),
    SUT,
  );
  assert.equal(result, null);
});

test('loadActiveJudgeTarget: 仅查激活的 JUDGE 目标，按 updatedAt 倒序取最新', async () => {
  const capture: { args?: unknown } = {};
  await loadActiveJudgeTarget(store(judgeRow(), capture), SUT);
  assert.deepEqual(capture.args, {
    where: { targetType: 'JUDGE', isActive: true },
    orderBy: { updatedAt: 'desc' },
  });
});

test('loadActiveJudgeTarget: 行字段不完整（apiKey 空）→ null', async () => {
  const result = await loadActiveJudgeTarget(store(judgeRow({ apiKey: '' })), SUT);
  assert.equal(result, null);
});

test('selectLatestActiveJudgeTarget: 返回客户展示元数据且保持最新优先', async () => {
  const capture: { args?: unknown } = {};
  const selected = await selectLatestActiveJudgeTarget(
    store(judgeRow({ name: 'AI复核', lastTestStatus: 'SUCCESS' }), capture),
  );

  assert.equal(selected.found, true);
  assert.equal(selected.target?.name, 'AI复核');
  assert.equal(selected.target?.lastTestStatus, 'SUCCESS');
  assert.deepEqual(capture.args, {
    where: { targetType: 'JUDGE', isActive: true },
    orderBy: { updatedAt: 'desc' },
  });
});

test('selectLatestActiveJudgeTarget: 字段不完整时 found=true 但 target=null', async () => {
  const selected = await selectLatestActiveJudgeTarget(store(judgeRow({ apiKey: ' ' })));
  assert.deepEqual(selected, { found: true, target: null });
});

test('selectLatestActiveJudgeTarget: 未配置时 found=false', async () => {
  const selected = await selectLatestActiveJudgeTarget(store(null));
  assert.deepEqual(selected, { found: false, target: null });
});
