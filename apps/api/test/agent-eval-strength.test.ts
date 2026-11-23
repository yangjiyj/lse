import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_RISK_SURFACES,
  resolveAgentEvalStrength,
} from '../src/modules/agent-evals/strength.js';

test('Agent 测评强度：标准上线是默认档，覆盖全部核心风险面', () => {
  const cfg = resolveAgentEvalStrength(undefined);

  assert.equal(cfg.level, 'standard');
  assert.equal(cfg.maxTurns, 2);
  assert.deepEqual(new Set(cfg.riskSurfaces), new Set(AGENT_RISK_SURFACES));
});

test('Agent 测评强度：各档位样本量是 baseline 池真实容量，而非复读数', () => {
  // 改造后：defaultSampleCount 是"baseline 池真实可抽样数"，超过部分靠 attacker 自适应变形生成
  // 不再是"9 条模板复读 N 次"的虚假数字
  assert.equal(resolveAgentEvalStrength('smoke').defaultSampleCount, 10);
  assert.equal(resolveAgentEvalStrength('standard').defaultSampleCount, 30);
  assert.equal(resolveAgentEvalStrength('deep').defaultSampleCount, 50);
  assert.equal(resolveAgentEvalStrength('adversarial').defaultSampleCount, 60);

  assert.equal(resolveAgentEvalStrength('smoke').maxTurns, 1);
  assert.equal(resolveAgentEvalStrength('deep').maxTurns, 3);
  assert.equal(resolveAgentEvalStrength('adversarial').maxTurns, 4);
});

test('Agent 测评强度：招式覆盖随档位加宽（smoke 只测 boundary_reframe）', () => {
  assert.deepEqual(resolveAgentEvalStrength('smoke').techniques, ['boundary_reframe']);
  assert.ok(resolveAgentEvalStrength('standard').techniques.length >= 3);
  assert.ok(resolveAgentEvalStrength('deep').techniques.length >= 5);
  assert.ok(resolveAgentEvalStrength('adversarial').techniques.length === 6);
});

test('Agent 测评强度：自适应变形轮数随档位递增', () => {
  assert.equal(resolveAgentEvalStrength('smoke').adaptiveRounds, 0);
  assert.equal(resolveAgentEvalStrength('standard').adaptiveRounds, 1);
  assert.equal(resolveAgentEvalStrength('deep').adaptiveRounds, 2);
  assert.equal(resolveAgentEvalStrength('adversarial').adaptiveRounds, 4);
});

test('Agent 测评强度：未知档位回退到标准上线', () => {
  const cfg = resolveAgentEvalStrength('unknown');

  assert.equal(cfg.level, 'standard');
  assert.equal(cfg.defaultSampleCount, 30);
});
