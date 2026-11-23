import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RED_TEAM_DEFAULT_ROUNDS,
  RED_TEAM_MIN_ROUNDS,
  normalizeRedTeamMaxRounds,
} from '@lse/shared';
import { DEFAULT_RED_TEAM_CONFIG } from '../src/modules/red-team/config.js';

test('红队默认与最小轮数均不少于 5 轮', () => {
  assert.ok(RED_TEAM_MIN_ROUNDS >= 5);
  assert.ok(RED_TEAM_DEFAULT_ROUNDS >= RED_TEAM_MIN_ROUNDS);
  assert.equal(DEFAULT_RED_TEAM_CONFIG.maxRounds, RED_TEAM_DEFAULT_ROUNDS);
});

test('历史轮数兼容读取：小于 5 提升、非法回落默认、超限截断', () => {
  assert.equal(normalizeRedTeamMaxRounds(3), 5);
  assert.equal(normalizeRedTeamMaxRounds('8'), 8);
  assert.equal(normalizeRedTeamMaxRounds(undefined), RED_TEAM_DEFAULT_ROUNDS);
  assert.equal(normalizeRedTeamMaxRounds('abc'), RED_TEAM_DEFAULT_ROUNDS);
  assert.equal(normalizeRedTeamMaxRounds(99), 20);
});
