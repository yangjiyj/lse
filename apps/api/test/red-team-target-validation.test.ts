import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/lib/errors.js';
import {
  assertCallableRedTeamTarget,
  assertExternalAttackerTarget,
  type RedTeamTarget,
} from '../src/modules/red-team/target-validation.js';

function target(overrides: Partial<RedTeamTarget> = {}): RedTeamTarget {
  return {
    id: 'target-1',
    targetType: 'MODEL',
    isActive: true,
    baseUrl: 'https://model.example/v1',
    apiKey: 'test-key',
    model: 'test-model',
    ...overrides,
  };
}

const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;

test('JUDGE 和 MODEL 均可作为完整的攻击模型', () => {
  assert.doesNotThrow(() =>
    assertCallableRedTeamTarget(target({ targetType: 'JUDGE' }), 'attacker'),
  );
  assert.doesNotThrow(() =>
    assertCallableRedTeamTarget(target({ targetType: 'MODEL' }), 'attacker'),
  );
});

test('停用、不支持类型或字段不完整的攻击模型被拒绝', () => {
  assert.throws(
    () => assertCallableRedTeamTarget(target({ isActive: false }), 'attacker'),
    hasCode('RED_TEAM_TARGET_INACTIVE'),
  );
  assert.throws(
    () => assertCallableRedTeamTarget(target({ targetType: 'AGENT_API' }), 'attacker'),
    hasCode('RED_TEAM_TARGET_NOT_CALLABLE'),
  );
  assert.throws(
    () => assertCallableRedTeamTarget(target({ apiKey: '  ' }), 'attacker'),
    hasCode('RED_TEAM_TARGET_NOT_CALLABLE'),
  );
});

test('缺失的判定模型引用被拒绝', () => {
  assert.throws(
    () => assertCallableRedTeamTarget(null, 'judge'),
    hasCode('RED_TEAM_TARGET_NOT_FOUND'),
  );
});

test('攻击模型与评估对象同记录或同端点同模型时被拒绝', () => {
  const sut = target({
    id: 'sut-target',
    baseUrl: 'https://model.example/v1/',
    model: 'test-model',
  });
  assert.throws(
    () => assertExternalAttackerTarget(target({ id: sut.id }), sut),
    hasCode('RED_TEAM_ATTACKER_MUST_DIFFER'),
  );
  assert.throws(
    () =>
      assertExternalAttackerTarget(
        target({
          id: 'duplicate-target',
          baseUrl: 'https://MODEL.example:443/v1?tenant=one#ignored',
          model: ' test-model ',
        }),
        sut,
      ),
    hasCode('RED_TEAM_ATTACKER_MUST_DIFFER'),
  );
  assert.doesNotThrow(() =>
    assertExternalAttackerTarget(target({ id: 'external-target', model: 'external-model' }), sut),
  );
});
