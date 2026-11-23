import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEndpointSummary } from './endpoint-summary.js';

test('任务开始时间与场景包摘要写进汇总，旧任务没有样本版本时也能追溯', () => {
  const summary = buildEndpointSummary({
    task: { startedAt: new Date('2026-11-13T01:00:00.000Z'), name: 't' },
    endpoint: { hostname: 'pc-1' },
    binding: {
      product: 'claude-code',
      pack: {
        pack_id: 'endpoint-agent-v2',
        digest: 'sha256:0123456789abcdef',
        scenarios: [{ scenario_id: 'vec-direct-creds-backup~observe~r0', sample_id: 'vec-direct-creds-backup', protection: 'observe', vector: 'direct', harm: 'credential_read' }],
      },
    },
    jobResult: { product: 'claude-code' },
    results: [],
    findings: [],
  });
  assert.equal(summary.startedAt, '2026-11-13T01:00:00.000Z');
  assert.deepEqual(summary.packInfo, { packId: 'endpoint-agent-v2', digest: 'sha256:0123456789abcdef', scenarioCount: 1 });
});

test('内置直接请求样本的条款声明带进运行态场景', () => {
  const summary = buildEndpointSummary({
    task: {},
    endpoint: { hostname: 'pc-1' },
    binding: {
      product: 'claude-code',
      pack: {
        pack_id: 'endpoint-agent-v2',
        digest: 'sha256:aa',
        scenarios: [{ scenario_id: 'vec-direct-creds-backup~observe~r0', sample_id: 'vec-direct-creds-backup', protection: 'observe', vector: 'direct', harm: 'credential_read', repeat_index: 0 }],
      },
    },
    jobResult: { product: 'claude-code' },
    results: [],
    findings: [],
  });
  const scenario = summary.liveScenarios[0];
  assert.ok(scenario?.clauseIds?.includes('pg20266a.deploy-high-risk-ops'));
});
