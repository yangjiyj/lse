import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRiskItemsBySeverity,
  buildEntityProfile,
  type ReportFinding,
} from '../src/modules/reports/report-builder.js';

let seq = 0;
function finding(
  riskCategory: string,
  severity: ReportFinding['severity'],
  verdictLabel: '既遂' | '疑似' | '未遂',
  detail: Record<string, unknown> = {},
): ReportFinding {
  seq += 1;
  const label =
    verdictLabel === '既遂'
      ? '【既遂】'
      : verdictLabel === '疑似'
        ? '【疑似既遂】'
        : '【未遂·网关已拦截】';
  return {
    engine: 'newapi-agent-security-gateway',
    riskCategory,
    severity,
    verdict: verdictLabel === '未遂' ? 'UNKNOWN' : 'FAIL',
    score: null,
    evidence: '证据',
    title: `风险#${seq}`,
    detail: {
      requestId: `req-${seq}`,
      createdAt: '2026-06-22T10:00:0' + (seq % 10) + 'Z',
      clientId: 'key_x',
      sourceIp: '1.2.3.4',
      agentType: 'openclaw',
      rejudgeReason: `${label}原因${seq}`,
      promptExcerpt: `样本-${seq}`,
      responseExcerpt: 'r',
      ...detail,
    },
    ...({} as object),
  };
}

function profileOf(findings: ReportFinding[]) {
  const groups = buildRiskItemsBySeverity([], { findings });
  return buildEntityProfile(groups, { kind: 'key', id: 'key_x' });
}

test('buildEntityProfile：危害分/判定漏斗/铁证计数', () => {
  const p = profileOf([
    finding('data_exfiltration', 'CRITICAL', '既遂', {
      toolName: 'send_data',
      normalizedTarget: 'https://evil.example/c',
    }),
    finding('agent_tool_abuse', 'MEDIUM', '未遂', { toolName: 'run_shell' }),
    finding('ssrf_network_access', 'HIGH', '疑似', {
      toolName: 'http_get',
      normalizedTarget: 'http://169.254.169.254/latest/meta-data/',
    }),
  ]);
  assert.ok(p.harmScore >= 80, `含严重既遂危害分应高: ${p.harmScore}`);
  assert.equal(p.harmLevel, '极高危');
  assert.equal(p.consummatedCount, 1);
  assert.equal(p.suspectedCount, 1);
  assert.equal(p.attemptedCount, 1);
  assert.equal(p.ironProofCount, 1, '严重既遂=1条铁证');
});

test('buildEntityProfile：数据外带既遂 → 杀伤链闭环 + 立即处置', () => {
  const p = profileOf([
    finding('data_exfiltration', 'CRITICAL', '既遂', {
      toolName: 'send_data',
      normalizedTarget: 'https://evil.example/c',
    }),
  ]);
  assert.equal(p.killChainClosed, true);
  assert.equal(p.dispositionLevel, '立即处置');
  assert.match(p.disposition, /吊销/);
});

test('buildEntityProfile：敏感目标分类（凭据/系统/元数据/外带）', () => {
  const p = profileOf([
    finding('privacy_leakage', 'HIGH', '既遂', {
      toolName: 'read_file',
      normalizedTarget: '~/.ssh/id_rsa',
    }),
    finding('agent_tool_abuse', 'CRITICAL', '未遂', {
      toolName: 'read_file',
      normalizedTarget: '/etc/passwd',
    }),
    finding('ssrf_network_access', 'HIGH', '疑似', {
      toolName: 'http_get',
      normalizedTarget: 'http://169.254.169.254/latest/meta-data/',
    }),
    finding('data_exfiltration', 'HIGH', '既遂', {
      toolName: 'send_data',
      normalizedTarget: 'https://evil.example/collect',
    }),
  ]);
  const groups = new Set(p.sensitiveTargets.map((t) => t.group));
  assert.ok(groups.has('凭据/密钥'));
  assert.ok(groups.has('系统敏感文件'));
  assert.ok(groups.has('云元数据端点'));
  assert.ok(groups.has('外带去向'));
});

test('buildEntityProfile：攻击面覆盖 + 合规/TTP 聚合', () => {
  const p = profileOf([
    finding('prompt_injection', 'HIGH', '既遂'),
    finding('data_exfiltration', 'CRITICAL', '既遂', {
      toolName: 'send_data',
      normalizedTarget: 'https://evil.example/c',
    }),
    finding('ssrf_network_access', 'MEDIUM', '未遂'),
  ]);
  assert.equal(p.domainCount, 3, '覆盖3个风险域');
  assert.ok(p.domainCoverage[0]!.hasConsummated, '既遂域排前');
  assert.ok(p.atlasTactics.length > 0, '应聚合 ATLAS 战术');
  assert.ok(p.owaspClauses.length > 0, '应聚合 OWASP 条款');
});

test('buildEntityProfile：既遂证据清单只含既遂/疑似、既遂排前', () => {
  const p = profileOf([
    finding('agent_tool_abuse', 'LOW', '未遂'),
    finding('data_exfiltration', 'CRITICAL', '既遂', {
      toolName: 'send_data',
      normalizedTarget: 'https://evil.example/c',
    }),
    finding('prompt_injection', 'MEDIUM', '疑似'),
  ]);
  assert.equal(p.incidents.length, 2, '未遂不进证据清单');
  assert.equal(p.incidents[0]!.verdictLabel, '既遂', '既遂排最前');
});

test('buildEntityProfile：低风险实体 → 处置=低风险', () => {
  const p = profileOf([finding('general_safety', 'LOW', '未遂')]);
  assert.equal(p.dispositionLevel, '低风险');
  assert.equal(p.killChainClosed, false);
});
