import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRiskItemsBySeverity,
  buildRiskAttribution,
  type ReportFinding,
} from '../src/modules/reports/report-builder.js';

let seq = 0;
function finding(
  over: Partial<ReportFinding> & { detail?: Record<string, unknown> },
): ReportFinding {
  const { detail, ...rest } = over;
  seq += 1; // 每条唯一题面，避免报告侧「题面|类别」去重把测试样本合并（真实数据每条对话不同）
  return {
    engine: 'newapi-agent-security-gateway',
    riskCategory: 'agent_tool_abuse',
    severity: 'HIGH',
    verdict: 'FAIL',
    score: null,
    evidence: '证据',
    title: '[网关·工具] 危险工具',
    detail: {
      requestId: `req-${seq}`,
      createdAt: '2026-06-22T10:00:00Z',
      clientId: 'key_a',
      sourceIp: '',
      agentType: 'openclaw',
      rejudgeReason: '【既遂】危险工具执行',
      promptExcerpt: `请求样本-${seq}`,
      responseExcerpt: 'q',
      ...(detail ?? {}),
    },
    ...rest,
  };
}

function attributionOf(findings: ReportFinding[]) {
  const groups = buildRiskItemsBySeverity([], { findings });
  return buildRiskAttribution(groups);
}

test('buildRiskAttribution：按 key 聚合 + 计数 + 既遂数 + Top类别', () => {
  const a = attributionOf([
    finding({
      detail: { clientId: 'key_a', rejudgeReason: '【既遂】x' },
      riskCategory: 'data_exfiltration',
    }),
    finding({
      detail: { clientId: 'key_a', rejudgeReason: '【未遂/姿态】y' },
      riskCategory: 'agent_tool_abuse',
      severity: 'MEDIUM',
      verdict: 'UNKNOWN',
    }),
    finding({
      detail: { clientId: 'key_b', rejudgeReason: '【既遂】z' },
      riskCategory: 'ssrf_network_access',
    }),
  ]);
  assert.equal(a.keyCount, 2, '两个不同 key');
  const keyA = a.topByKey.find((s) => s.id === 'key_a');
  assert.ok(keyA);
  assert.equal(keyA.riskCount, 2);
  assert.equal(keyA.consummatedCount, 1, 'key_a 只有一条既遂');
  assert.ok(keyA.topCategories.length >= 1);
});

test('buildRiskAttribution：高危实体排最前（按最高severity）', () => {
  const a = attributionOf([
    finding({
      detail: { clientId: 'low_key' },
      severity: 'LOW',
      verdict: 'UNKNOWN',
      riskCategory: 'agent_tool_abuse',
    }),
    finding({
      detail: { clientId: 'crit_key' },
      severity: 'CRITICAL',
      riskCategory: 'data_exfiltration',
    }),
  ]);
  assert.equal(a.topByKey[0]!.id, 'crit_key', '最高危的 key 排最前');
});

test('buildRiskAttribution：按 agent_type 聚合', () => {
  const a = attributionOf([
    finding({ detail: { agentType: 'openclaw', clientId: 'k1' } }),
    finding({ detail: { agentType: 'openclaw', clientId: 'k2' } }),
    finding({ detail: { agentType: 'cursor', clientId: 'k3' } }),
  ]);
  assert.equal(a.agentTypeCount, 2);
  const oc = a.topByAgentType.find((s) => s.id === 'openclaw');
  assert.equal(oc?.riskCount, 2);
});

test('buildRiskAttribution：空 key 归"（未标注）"，不计入 keyCount', () => {
  const a = attributionOf([
    finding({ detail: { clientId: '', sourceIp: '', agentType: '' } }),
    finding({ detail: { clientId: 'key_real', agentType: 'openclaw' } }),
  ]);
  assert.equal(a.keyCount, 1, '只有一个真实 key');
  assert.ok(
    a.topByKey.some((s) => s.id === '（未标注）'),
    '未标注实体仍列出',
  );
});

test('buildRiskAttribution：Top 风险类别按数量+严重度排序', () => {
  const a = attributionOf([
    finding({
      riskCategory: 'data_exfiltration',
      severity: 'CRITICAL',
      detail: { clientId: 'k1' },
    }),
    finding({
      riskCategory: 'agent_tool_abuse',
      severity: 'MEDIUM',
      verdict: 'UNKNOWN',
      detail: { clientId: 'k2' },
    }),
    finding({
      riskCategory: 'agent_tool_abuse',
      severity: 'MEDIUM',
      verdict: 'UNKNOWN',
      detail: { clientId: 'k3' },
    }),
  ]);
  assert.ok(a.categoryRanking.length >= 2);
  // data_exfiltration(CRITICAL) 应排在 agent_tool_abuse(MEDIUM) 前，即便后者数量多
  assert.equal(a.categoryRanking[0]!.maxSeverityLabel, '严重');
});
