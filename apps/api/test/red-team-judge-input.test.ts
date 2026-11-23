import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toJudgeInput } from '../src/modules/red-team/judge-input.js';
import type { RedTeamSeed } from '../src/modules/red-team/types.js';

const seed: RedTeamSeed = {
  questionId: 'q-trace',
  content: '请测试工具越权',
  category: 'agent_tool_abuse',
  expectedBehavior: null,
  referenceAnswer: null,
  shouldRefuse: true,
  severity: 'HIGH',
  questionType: 'PROMPT_INJECTION',
};

test('toJudgeInput 透传 agentTrace/agentMetadata 到 rules', () => {
  const agentTrace = [{ toolName: 'send_data', allowed: false, riskSurface: 'data_exfiltration' }];
  const agentMetadata = { runnerVerdict: 'FAIL', seed: 'agent-seed' };

  const input = toJudgeInput('task-trace', seed, 'prompt', 'response', {
    agentTrace,
    agentMetadata,
  });

  assert.deepEqual(input.rules?.agentTrace, agentTrace);
  assert.deepEqual(input.rules?.agentMetadata, agentMetadata);
});

test('toJudgeInput 不提供 trace 上下文时不生成空 rules', () => {
  const input = toJudgeInput('task-chat', seed, 'prompt', 'response');

  assert.equal(input.rules, undefined);
});
