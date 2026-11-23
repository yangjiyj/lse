import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEndpointSummary } from './endpoint-summary.js';

const config = {
  state: 'internal_store',
  items: [
    { item: 'permission', state: 'internal_store', installs: 1 },
    { item: 'auto_approval', state: 'unknown', installs: 1 },
    { item: 'sandbox', state: 'internal_store', installs: 1 },
  ],
  note: '该软件把这项设置保存在内部，探针读不到，需要在软件里确认。',
};

test('摘要按安装带出配置读取状态、安装位置和账号，内部字段不外露', () => {
  const result = buildEndpointSummary({
    task: {},
    agents: [
      {
        product: 'claude-code',
        displayName: 'Claude Code',
        version: '2.1',
        snapshot: { location: '~/.claude', account: 'yj', config },
      },
      {
        product: 'claude-code',
        displayName: 'Claude Code',
        version: '2.1',
        snapshot: { location: '…/package.json 所在目录', account: 'alice' },
      },
    ],
  });
  assert.equal(result.agents.length, 2);
  assert.equal(result.agents[0]!.location, '~/.claude');
  assert.equal(result.agents[0]!.account, 'yj');
  assert.deepEqual(result.agents[0]!.config, config);
  assert.equal(result.agents[1]!.location, '…/package.json 所在目录');
  assert.equal(result.agents[1]!.account, 'alice');
  assert.equal('config' in result.agents[1]!, false, '旧快照没有配置状态时不能出现该字段');
  assert.doesNotMatch(JSON.stringify(result), /snapshot/);
});

test('没有任何快照数据时，智能体行保持原有字段', () => {
  const result = buildEndpointSummary({
    task: {},
    agents: [{ product: 'codex', displayName: 'Codex', version: '0.160.1' }],
  });
  const agent = result.agents[0]!;
  assert.equal('config' in agent, false);
  assert.equal('location' in agent, false);
  assert.equal('account' in agent, false);
});

test('任务摘要保留新版防护风险和指令检查的三种对象状态', async () => {
  const { postureSignalsReport } = await import('../../../test/fleet-admin-fixtures.js');
  const { judgeProbeReport } = await import('../fleet-admin/posture.js');
  const result = buildEndpointSummary({
    task: {},
    findings: judgeProbeReport(postureSignalsReport()),
  });
  const items = result.groups.flatMap((g) => g.items);
  const hooks = items.find((f) => f.ruleId === 'hooks')!;
  assert.equal(hooks.state, 'risk');
  assert.equal(hooks.subjects.filter((s) => s.state === 'risk').length, 1);
  const instruction = items.find((f) => f.ruleId === 'instruction_file')!;
  assert.deepEqual(
    instruction.subjects.map((s) => [s.kind, s.state, s.cause]),
    [
      ['agent', 'clear', undefined],
      ['agent', 'not_checked', 'instruction_scan_incomplete'],
      ['agent', 'risk', undefined],
    ],
  );
});
