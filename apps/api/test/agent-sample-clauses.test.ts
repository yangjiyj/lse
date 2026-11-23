import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getClause, ASSET_CHANNELS, ATTACK_VECTORS, AGENT_HARMS, clausesForLine } from '@lse/shared';
import { generateAgentScenarios, generateMcpScenarios } from '../src/modules/agent-evals/generator.js';
import { BUILTIN_AGENT_ATTACK_PACK, BUILTIN_MCP_ATTACK_PACK } from '../src/modules/agent-evals/packs/builtin.js';
import { generatePlatformAppScenarios } from '../src/modules/agent-evals/packs/platform-app.js';
import {
  PLATFORM_V2_TEMPLATES,
  generatePlatformAppV2Scenarios,
} from '../src/modules/agent-evals/packs/platform-app-v2.js';
import { buildFanoutMatrix } from '../src/modules/agent-evals/fanout/matrix.js';
import { FANOUT_CHANNELS } from '../src/modules/agent-evals/fanout/channels.js';
import { generateTriAgentScenarios, parseAgentConfig } from '../src/modules/agent-evals/agent-target.js';
import { buildStandardClauseSnapshot } from '../src/modules/reports/standard-clauses.js';
import { buildClauseTables } from '../src/modules/reports/html/clause-tables.js';

interface Meta {
  clauseIds?: string[];
  vector?: string;
  channel?: string;
  harms?: string[];
}

function assertTagged(label: string, meta: Meta) {
  assert.ok(meta.clauseIds && meta.clauseIds.length > 0, `${label} 没有 clauseIds`);
  for (const id of meta.clauseIds!) {
    const clause = getClause(id);
    assert.ok(clause, `${label} 的条款不存在：${id}`);
    assert.ok(clause!.lines.includes('agent'), `${label} 的条款不属于智能体线：${id}`);
  }
  assert.ok(Array.isArray(meta.harms), `${label} 缺 harms`);
  for (const h of meta.harms!) assert.ok((AGENT_HARMS as readonly string[]).includes(h), `${label} 危害无效：${h}`);
  assert.ok(meta.vector && (ATTACK_VECTORS as readonly string[]).includes(meta.vector), `${label} 攻击手法无效`);
  assert.ok(meta.channel && (ASSET_CHANNELS as readonly string[]).includes(meta.channel), `${label} 通道无效`);
}

test('L1–L6 全部 60 条模板、L8 四个场景、L9 十三个场景生成的样本都带条款与三维标签', () => {
  const all = generateAgentScenarios({
    level: 'adversarial',
    seed: 'clauses',
    sampleCount: 180,
    agenticScenarios: true,
    hitlScenarios: true,
  });
  const templateIds = new Set(all.map((s) => s.metadata.templateId));
  for (const t of BUILTIN_AGENT_ATTACK_PACK.templates) assert.ok(templateIds.has(t.id), `样本池未覆盖 ${t.id}`);
  assert.equal(all.filter((s) => s.metadata.sandboxScenario).length, 4);
  assert.equal(all.filter((s) => s.metadata.hitl).length, 13);
  for (const s of all) assertTagged(s.metadata.templateId, s.metadata);
});

test('L8 四个场景挂到对应条款', () => {
  const all = generateAgentScenarios({ level: 'smoke', seed: 'l8', agenticScenarios: true });
  const by = (name: string) => all.find((s) => s.metadata.sandboxScenario === name)!.metadata.clauseIds;
  assert.deepEqual(by('cascading_failure'), ['agentsec.anomaly-stop']);
  assert.ok(by('goal_hijack')!.includes('agentsec.io-protection'));
  assert.ok(by('memory_poisoning')!.includes('agentsec.system-permission'));
  assert.ok(by('privilege_escalation')!.includes('agentsec.tool-call'));
  assert.ok(all.some((s) => s.tags.includes('agent-scenario:cascading_failure')));
});

test('L9 高风险操作场景只挂 high-risk-hitl，且覆盖 8 g) 的各类操作', () => {
  const hitl = generateAgentScenarios({ level: 'smoke', seed: 'l9', hitlScenarios: true }).filter((s) => s.metadata.hitl);
  assert.ok(hitl.length >= 8);
  for (const s of hitl) assert.deepEqual(s.metadata.clauseIds, ['agentsec.high-risk-hitl']);
  const ops = new Set(hitl.map((s) => s.metadata.hitl!.operation));
  for (const op of ['stop_service', 'kill_process', 'format_disk', 'bulk_delete', 'change_permission', 'change_key', 'open_port', 'change_firewall', 'change_system_setting', 'access_password_manager', 'payment', 'download_exec', 'external_send']) {
    assert.ok(ops.has(op), `缺少 ${op}`);
  }
  assert.ok(hitl.every((s) => s.metadata.maxTurns >= 2));
});

test('默认不追加 L9', () => {
  const off = generateAgentScenarios({ level: 'smoke', seed: 'l9' });
  assert.ok(off.every((s) => !s.metadata.hitl));
});

test('L7 MCP 全部模板的样本带条款与三维标签', () => {
  const all = generateMcpScenarios({ seed: 'mcp' });
  assert.equal(new Set(all.map((s) => s.metadata.templateId)).size, BUILTIN_MCP_ATTACK_PACK.templates.length);
  for (const s of all) assertTagged(s.metadata.templateId, s.metadata);
});

test('平台应用 v1、v2 全部场景与变体的样本带条款与三维标签', () => {
  for (const s of generatePlatformAppScenarios('seed', 5, undefined, { knowledgeCanary: 'LSE-CANARY-KB-1' })) {
    assertTagged(`v1/${s.metadata.templateId}`, s.metadata);
  }
  const total = PLATFORM_V2_TEMPLATES.reduce((n, t) => n + t.variants.length, 0);
  const v2 = generatePlatformAppV2Scenarios('seed', total, undefined, { knowledgeCanary: 'LSE-CANARY-KB-1' });
  for (const s of v2) assertTagged(`v2/${s.metadata.templateId}/${s.metadata.variantId}`, s.metadata);
  const identity = generatePlatformAppV2Scenarios('seed', 8, ['identity']);
  assert.equal(identity.length, 8);
  assert.ok(v2.some((s) => s.metadata.templateId === 'identity'));
  for (const s of identity) {
    assert.deepEqual(s.metadata.clauseIds, ['agentsec.identity']);
    assert.equal(s.metadata.judge, 'identity');
    assert.equal(s.category, 'agent_identity');
  }
});

test('扇出各通道、自研智能体各用例的样本带条款与三维标签', () => {
  const specs = buildFanoutMatrix({
    objective: { id: 'o', secretHint: 'x', benignTaskZh: '整理发布说明' },
    registration: { runToken: 't', canary: 'c', exfilUrl: 'http://e', sinkUrl: (ch: string) => `http://s/${ch}` } as never,
  });
  assert.equal(specs.length, FANOUT_CHANNELS.length);
  for (const spec of specs) assertTagged(`fanout/${spec.channel}`, spec.metadata as Meta);
  const cfg = parseAgentConfig({
    agentInstanceId: 'a1', gatewayCredentialId: 'k1', systemPrompt: 'x',
    tools: [{ name: 'http_get', description: 'd', parameters: { type: 'object' }, dangerLevel: 'HIGH', simulator: 'http_get' }],
    mcp: [], skills: [],
  });
  for (const s of generateTriAgentScenarios(cfg, 'tri', 6)) assertTagged(`tri/${s.metadata.templateId}`, s.metadata);
});

test('报告：8 项要求逐条给结论，每项带代表性样本，未测项写明原因', () => {
  const scenarios = generateAgentScenarios({ level: 'smoke', seed: 'rep', hitlScenarios: true });
  const results = scenarios.map((s, i) => ({
    finalVerdict: i % 3 === 0 ? 'FAIL' : 'PASS',
    response: `回答 ${i}`,
    question: { category: s.category, content: s.prompt, displayTitle: s.metadata.displayTitle ?? null, clauseIds: s.metadata.clauseIds ?? null },
  }));
  const snapshot = buildStandardClauseSnapshot(results, ['agent'], [
    { clauseId: 'agentsec.logging-monitoring', verdict: 'conform', note: '已核对日志留存 180 天' },
  ])!;
  const table = buildClauseTables(['agent'], snapshot)[0]!;
  const rows = table.groups.flatMap((g) => g.rows);
  assert.equal(rows.length, clausesForLine('agent').length);
  const hitl = rows.find((r) => r.title === '高风险操作人工介入')!;
  assert.ok(hitl.tested > 0);
  assert.ok(hitl.evidence && hitl.evidence.length >= 1 && hitl.evidence.length <= 3);
  assert.ok(hitl.evidence![0]!.sampleName.length > 0 && hitl.evidence![0]!.outcomeLabel.length > 0);
  const anomaly = rows.find((r) => r.title === '异常阻断与紧急关停')!;
  assert.equal(anomaly.verdict, 'not_tested');
  assert.match(anomaly.note, /人工填报/);
  const logging = rows.find((r) => r.title === '日志留存与动态监测')!;
  assert.equal(logging.verdict, 'conform');
  assert.match(logging.note, /人工填报说明/);
  const identity = rows.find((r) => r.title === '身份标识')!;
  assert.equal(identity.verdict, 'not_tested');
  assert.match(table.statement, /非现行/);
});
