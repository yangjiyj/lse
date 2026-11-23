import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateAgentScenarios } from '../src/modules/agent-evals/generator.js';
import { AGENT_RISK_SURFACES } from '../src/modules/agent-evals/strength.js';

test('Agent 场景生成：同 seed 可复现，不要求用户先生成题目', () => {
  const a = generateAgentScenarios({ level: 'standard', sampleCount: 12, seed: 'agent-seed' });
  const b = generateAgentScenarios({ level: 'standard', sampleCount: 12, seed: 'agent-seed' });

  assert.deepEqual(
    a.map((x) => x.id),
    b.map((x) => x.id),
  );
  assert.deepEqual(
    a.map((x) => x.prompt),
    b.map((x) => x.prompt),
  );
  assert.equal(a.length, 12);
});

test('Agent 场景生成：默认标准强度带 agent_runtime 元数据和沙箱约束', () => {
  const scenarios = generateAgentScenarios({ seed: 'metadata-seed' });

  assert.equal(scenarios.length, 30); // 改造后 standard 默认 30 条 baseline(不再复读)
  for (const scenario of scenarios) {
    assert.equal(scenario.type, 'PROMPT_INJECTION');
    assert.equal(scenario.shouldRefuse, true);
    assert.equal(scenario.metadata.kind, 'agent_runtime');
    assert.equal(scenario.metadata.seed, 'metadata-seed');
    assert.match(scenario.metadata.attackPackVersion, /^builtin-agent-attacks@/);
    assert.ok(AGENT_RISK_SURFACES.includes(scenario.metadata.riskSurface));
    assert.ok(scenario.metadata.allowedTools.length > 0);
    assert.equal(scenario.metadata.maxTurns, 2);
    assert.equal(scenario.metadata.preflightStatus, 'passed');
    assert.ok(scenario.metadata.preflightChecks.includes('safe_canary_present'));
    assert.ok(scenario.metadata.scenarioName.length > 0);
    assert.ok(scenario.metadata.businessRole.length > 0);
    assert.ok(scenario.metadata.attackVariant.length > 0);
    assert.ok(scenario.metadata.toolBoundary.allowedTools.length > 0);
    assert.ok(scenario.metadata.successSignals.length > 0);
    assert.ok(scenario.metadata.evidenceRequirements.length > 0);
    assert.ok(scenario.metadata.remediation.owner.length > 0);
    assert.match(scenario.prompt, /你是|可以调用的工具|数据处理要求/);
    // 有效性铁律：prompt 是真的发给被测模型的，不得泄露「成功信号」等考题答案。
    assert.ok(!scenario.prompt.includes('成功信号'), 'prompt 泄露了成功信号（等于告知答案）');
    assert.ok(!scenario.prompt.includes('攻击变体'), 'prompt 暴露了元术语「攻击变体」');
    assert.ok(scenario.metadata.displayTitle && scenario.metadata.displayTitle.length > 0);
    assert.ok(scenario.tags.includes('agent:runtime'));
    assert.ok(scenario.tags.includes(`agent:${scenario.metadata.riskSurface}`));
    // 新增：每条 baseline 必须携带 attackTechnique 分类
    assert.ok(scenario.metadata.attackTechnique);
    assert.ok(scenario.tags.includes(`agent-technique:${scenario.metadata.attackTechnique}`));
  }
});

test('Agent 场景生成：标准默认样本覆盖全部核心风险面', () => {
  const scenarios = generateAgentScenarios({ level: 'standard', seed: 'coverage-seed' });
  const riskSurfaces = new Set(scenarios.map((x) => x.metadata.riskSurface));

  for (const surface of AGENT_RISK_SURFACES) {
    assert.ok(riskSurfaces.has(surface), `missing risk surface ${surface}`);
  }
});

test('Agent 场景生成：standard 招式集只允许 boundary_reframe/task_splitting/authority_override', () => {
  const scenarios = generateAgentScenarios({ level: 'standard', seed: 'technique-seed' });
  const allowed = new Set(['boundary_reframe', 'task_splitting', 'authority_override']);
  for (const s of scenarios) {
    assert.ok(
      allowed.has(s.metadata.attackTechnique),
      `standard 不该出现招式 ${s.metadata.attackTechnique}`,
    );
  }
});

test('Agent 场景生成：低于强度最小样本量时提升到 minSampleCount', () => {
  const scenarios = generateAgentScenarios({
    level: 'deep',
    sampleCount: 9,
    seed: 'narrow-seed',
    riskSurfaces: ['ssrf', 'tool_argument_bypass'],
  });

  // deep 最小样本量已从 16 提到 24(覆盖深度红队招式集所需的最小广度)
  assert.equal(scenarios.length, 24);
  assert.deepEqual(
    new Set(scenarios.map((x) => x.metadata.riskSurface)),
    new Set(['ssrf', 'tool_argument_bypass']),
  );
});

test('Agent 场景生成：preflight 失败的变体不进入正式样本', () => {
  const scenarios = generateAgentScenarios({
    level: 'smoke',
    sampleCount: 4,
    seed: 'preflight-skip-seed',
    preflightRequiredAnchors: ['__missing_required_anchor__'],
  } as never);

  assert.equal(scenarios.length, 0);
});

test('Agent 场景生成：baseline 模板不重复抽样(第 1 轮先全池覆盖)', () => {
  // 验证不再是"按 surface 复读",而是按招式 × 风险面去重抽样
  const scenarios = generateAgentScenarios({
    level: 'standard',
    sampleCount: 30,
    seed: 'dedup-seed',
  });
  const templateIds = scenarios.map((s) => s.metadata.templateId);
  const uniqueTemplateIds = new Set(templateIds);

  // 第 1 轮抽样应该覆盖至少 25 个不同模板(允许 5 条以内的 RNG 抖动)
  // 这与旧版本"9 条模板复读"形成鲜明对比
  assert.ok(uniqueTemplateIds.size >= 25, `期望至少 25 个不同模板,实际 ${uniqueTemplateIds.size}`);
});
