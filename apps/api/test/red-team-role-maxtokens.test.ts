import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRedTeamConfig, RED_TEAM_SETTING_KEY } from '../src/modules/red-team/config.js';

// 约定：题级配置在 questionMeta.redteam，全局在 SystemSetting(redteam.config)。
const q = { attackerTargetId: 'atk', gatewayTargetId: 'gw' };

test('角色 maxTokens 默认：attacker=512 / target=1024 / judge=512', async () => {
  const cfg = await resolveRedTeamConfig({ redteam: { ...q } }, async () => null);
  assert.equal(cfg.attackerMaxTokens, 512);
  assert.equal(cfg.targetMaxTokens, 1024);
  assert.equal(cfg.judgeMaxTokens, 512);
});

test('角色 maxTokens 可被全局 SystemSetting 覆盖', async () => {
  const cfg = await resolveRedTeamConfig({ redteam: { ...q } }, async (key: string) =>
    key === RED_TEAM_SETTING_KEY
      ? { attackerMaxTokens: 256, targetMaxTokens: 2048, judgeMaxTokens: 128 }
      : null,
  );
  assert.equal(cfg.attackerMaxTokens, 256);
  assert.equal(cfg.targetMaxTokens, 2048);
  assert.equal(cfg.judgeMaxTokens, 128);
});

test('角色 maxTokens 非法值回落默认（安全下限）', async () => {
  const cfg = await resolveRedTeamConfig({ redteam: { ...q } }, async (key: string) =>
    key === RED_TEAM_SETTING_KEY ? { attackerMaxTokens: 'x', targetMaxTokens: -5 } : null,
  );
  assert.equal(cfg.attackerMaxTokens, 512);
  assert.equal(cfg.targetMaxTokens, 1024);
});
