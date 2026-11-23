import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRedTeamConfig, DEFAULT_RED_TEAM_CONFIG } from '../src/modules/red-team/config.js';
import { MOVES } from '../src/modules/red-team/moves.js';

test('全局默认 + 题级 override 合并', async () => {
  const loadSetting = async (key: string) =>
    key === 'redteam.config'
      ? { gatewayTargetId: 'gw-global', attackerTargetId: 'atk-global', maxRounds: 8 }
      : null;
  const cfg = await resolveRedTeamConfig(
    { redteam: { moves: ['academic_wrap'], noProgressK: 2 } },
    loadSetting as any,
  );
  assert.equal(cfg.maxRounds, 8); // 全局覆盖默认 6
  assert.equal(cfg.noProgressK, 2); // 题级覆盖默认 3
  assert.deepEqual(cfg.moves, ['academic_wrap']); // 题级覆盖招式
  assert.equal(cfg.gatewayTargetId, 'gw-global');
});

test('题级缺省时回落默认招式全集', async () => {
  const cfg = await resolveRedTeamConfig(
    { redteam: { gatewayTargetId: 'gw', attackerTargetId: 'atk' } },
    async () => null,
  );
  assert.deepEqual(cfg.moves, DEFAULT_RED_TEAM_CONFIG.moves);
  assert.equal(cfg.maxRounds, 6);
});

test('历史中文攻击技术映射为执行器支持的策略 ID', async () => {
  const cfg = await resolveRedTeamConfig(null, async () => ({
    attackerTargetId: 'attacker',
    moves: ['身份冒充诱导', '任务拆分绕过', '虚假前提构造', '情绪施压'],
  }));

  assert.deepEqual(cfg.moves, [
    'identity_spoof',
    'stepwise_decompose',
    'fictional_frame',
    'authority_pressure',
  ]);
  for (const move of cfg.moves) assert.ok(MOVES[move]);
});

test('未知或空攻击技术不会进入执行器，全部无效时回退标准策略', async () => {
  const mixed = await resolveRedTeamConfig(null, async () => ({
    attackerTargetId: 'attacker',
    moves: ['academic_wrap', '自定义但未实现的策略', 'academic_wrap'],
  }));
  assert.deepEqual(mixed.moves, ['academic_wrap']);

  const invalid = await resolveRedTeamConfig(null, async () => ({
    attackerTargetId: 'attacker',
    moves: ['自定义但未实现的策略'],
  }));
  assert.deepEqual(invalid.moves, DEFAULT_RED_TEAM_CONFIG.moves);
});

test('未配置 breakOn 时默认 verdict（实质裁判破局）', async () => {
  const cfg = await resolveRedTeamConfig(
    { redteam: { gatewayTargetId: 'gw', attackerTargetId: 'atk' } },
    async () => null,
  );
  assert.equal(cfg.breakOn, 'verdict');
  assert.equal(cfg.judgeTargetId, '');
  assert.equal(cfg.secondaryAttackerTargetId, '');
});

test('透传 breakOn=attitude 与 judge/secondary target id', async () => {
  const cfg = await resolveRedTeamConfig(
    {
      redteam: {
        gatewayTargetId: 'gw',
        attackerTargetId: 'atk',
        breakOn: 'attitude',
        judgeTargetId: 'judge-1',
        secondaryAttackerTargetId: 'atk-2',
      },
    },
    async () => null,
  );
  assert.equal(cfg.breakOn, 'attitude');
  assert.equal(cfg.judgeTargetId, 'judge-1');
  assert.equal(cfg.secondaryAttackerTargetId, 'atk-2');
});

test('breakOn 非法值回落 verdict', async () => {
  const cfg = await resolveRedTeamConfig(
    { redteam: { gatewayTargetId: 'gw', attackerTargetId: 'atk', breakOn: 'garbage' } },
    async () => null,
  );
  assert.equal(cfg.breakOn, 'verdict');
});

test('允许不配置防护层 target，按单模型自主红队执行', async () => {
  const cfg = await resolveRedTeamConfig(
    { redteam: { attackerTargetId: 'attacker-target', judgeTargetId: 'judge-target' } },
    async () => null,
  );

  assert.equal(cfg.gatewayTargetId, '');
  assert.equal(cfg.attackerTargetId, 'attacker-target');
  assert.equal(cfg.judgeTargetId, 'judge-target');
});
