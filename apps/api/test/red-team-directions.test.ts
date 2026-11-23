import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RED_TEAM_DIRECTIONS,
  RED_TEAM_DIRECTION_IDS,
  objectiveIdsForDirections,
  variantChainForDirections,
  directionForObjective,
  RED_TEAM_RISK_TYPE_LABELS,
} from '../src/modules/red-team/directions.js';
import {
  RED_TEAM_OBJECTIVE_IDS,
  RED_TEAM_ATTACK_VARIANT_IDS,
} from '../src/modules/red-team/builtin-seeds.js';

test('5 个攻击方向，id 与 RED_TEAM_DIRECTION_IDS 一致', () => {
  assert.equal(RED_TEAM_DIRECTIONS.length, 5);
  assert.deepEqual(
    RED_TEAM_DIRECTIONS.map((d) => d.id),
    [...RED_TEAM_DIRECTION_IDS],
  );
});

test('每个方向的 objectiveIds 都是真实存在的红队风险目标', () => {
  const known = new Set(RED_TEAM_OBJECTIVE_IDS);
  for (const dir of RED_TEAM_DIRECTIONS) {
    assert.ok(dir.objectiveIds.length > 0, `${dir.id} 应至少聚合一个风险目标`);
    for (const objectiveId of dir.objectiveIds) {
      assert.ok(known.has(objectiveId), `${dir.id} 引用了未知风险目标 ${objectiveId}`);
    }
  }
});

test('24 个风险目标全部被方向覆盖，无遗漏', () => {
  const covered = new Set(RED_TEAM_DIRECTIONS.flatMap((d) => d.objectiveIds));
  for (const objectiveId of RED_TEAM_OBJECTIVE_IDS) {
    assert.ok(covered.has(objectiveId), `风险目标 ${objectiveId} 未被任何方向覆盖`);
  }
});

test('每个方向的 variantChain 都是合法攻击变体且非空', () => {
  const validVariants = new Set(RED_TEAM_ATTACK_VARIANT_IDS);
  for (const dir of RED_TEAM_DIRECTIONS) {
    assert.ok(dir.variantChain.length > 0, `${dir.id} 应有多轮链 variantChain`);
    for (const variant of dir.variantChain) {
      assert.ok(validVariants.has(variant), `${dir.id} 的 variantChain 含非法变体 ${variant}`);
    }
    assert.ok(dir.chainSummary.includes('→'), `${dir.id} 应有人类可读的链路说明`);
  }
});

test('objectiveIdsForDirections：合并多个方向并去重', () => {
  const ids = objectiveIdsForDirections(['data_security', 'agent_escalation']);
  const expected = new Set([
    ...RED_TEAM_DIRECTIONS.find((d) => d.id === 'data_security')!.objectiveIds,
    ...RED_TEAM_DIRECTIONS.find((d) => d.id === 'agent_escalation')!.objectiveIds,
  ]);
  assert.equal(ids.length, expected.size);
  assert.deepEqual(new Set(ids), expected);
});

test('objectiveIdsForDirections：未知方向被忽略', () => {
  assert.deepEqual(objectiveIdsForDirections(['bogus']), []);
});

test('variantChainForDirections：合并多个方向的链并保持顺序去重', () => {
  const chain = variantChainForDirections(['data_security']);
  assert.deepEqual(chain, ['stepwise', 'obfuscation', 'direct']);
});

test('directionForObjective：反查风险目标所属方向', () => {
  assert.equal(directionForObjective('data_exfiltration')?.id, 'data_security');
  assert.equal(directionForObjective('agent_tool_abuse')?.id, 'agent_escalation');
  assert.equal(directionForObjective('not-a-real-objective'), undefined);
});

test('攻击方向按提示注入 / 敏感信息泄露 / 违规内容生成三类风险分组', () => {
  assert.deepEqual(Object.values(RED_TEAM_RISK_TYPE_LABELS), [
    '提示注入',
    '敏感信息泄露',
    '违规内容生成',
  ]);
  const byId = Object.fromEntries(RED_TEAM_DIRECTIONS.map((d) => [d.id, d.riskType]));
  assert.equal(byId.data_security, 'sensitive_info_leakage');
  assert.equal(byId.agent_escalation, 'prompt_injection');
  assert.equal(byId.content_compliance, 'violating_content');
  for (const dir of RED_TEAM_DIRECTIONS) assert.ok(RED_TEAM_RISK_TYPE_LABELS[dir.riskType]);
});
