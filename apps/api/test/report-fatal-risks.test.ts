import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRiskItemsBySeverity,
  buildFatalRisks,
  type ReportFinding,
} from '../src/modules/reports/report-builder.js';

let seq = 0;
function finding(
  riskCategory: string,
  severity: ReportFinding['severity'],
  verdict: '既遂' | '疑似' | '未遂',
  detail: Record<string, unknown> = {},
): ReportFinding {
  seq += 1;
  const label =
    verdict === '既遂' ? '【既遂】' : verdict === '疑似' ? '【疑似既遂】' : '【未遂·网关已拦截】';
  return {
    engine: 'newapi-agent-security-gateway',
    riskCategory,
    severity,
    verdict: verdict === '未遂' ? 'UNKNOWN' : 'FAIL',
    score: null,
    evidence: '证据',
    title: `风险#${seq}`,
    detail: {
      requestId: `req-${seq}`,
      createdAt: '2026-06-22T10:00:0' + (seq % 10) + 'Z',
      clientId: 'key_x',
      rejudgeReason: `${label}原因${seq}`,
      promptExcerpt: `样本-${seq}`,
      ...detail,
    },
  };
}

function fatalOf(findings: ReportFinding[]) {
  return buildFatalRisks(buildRiskItemsBySeverity([], { findings }));
}

test('数据外带既遂 → 致命层', () => {
  const f = fatalOf([
    finding('data_exfiltration', 'CRITICAL', '既遂', {
      toolName: 'send_data',
      normalizedTarget: 'https://evil.example/c',
    }),
  ]);
  assert.equal(f.fatalCount, 1);
  assert.equal(f.incidents[0]!.tier, '致命');
  assert.match(f.incidents[0]!.categoryLabel, /数据外/);
  assert.ok(f.incidents[0]!.standards.some((s) => /ATT&CK|Exfiltration/.test(s)));
});

test('危险命令执行/SSRF/凭据既遂 → 均致命', () => {
  const f = fatalOf([
    finding('agent_tool_abuse', 'CRITICAL', '既遂', { toolName: 'run_shell' }),
    finding('ssrf_network_access', 'HIGH', '既遂', {
      toolName: 'http_get',
      normalizedTarget: 'http://169.254.169.254/latest/meta-data/',
    }),
    finding('privacy_leakage', 'HIGH', '既遂', {
      toolName: 'read_file',
      normalizedTarget: '~/.ssh/id_rsa',
    }),
  ]);
  assert.equal(f.fatalCount, 3, '三类都进致命层');
});

test('未遂→已拦截计数(不进事件清单)，疑似→待复核', () => {
  const f = fatalOf([
    finding('agent_tool_abuse', 'CRITICAL', '未遂', { toolName: 'run_shell' }),
    finding('agent_tool_abuse', 'CRITICAL', '未遂', {
      toolName: 'send_data',
      normalizedTarget: 'http://169.254.169.254/x',
    }),
    finding('prompt_injection', 'MEDIUM', '疑似'),
  ]);
  assert.equal(f.fatalCount, 0);
  assert.equal(f.criticalCount, 0);
  assert.equal(f.containedCount, 2, '未遂=已拦截，防护有效');
  assert.equal(f.suspectedCount, 1);
  assert.equal(f.incidents.length, 0);
});

test('越狱配合既遂（无真出血动作）→ 严重，不进致命', () => {
  const f = fatalOf([finding('prompt_injection', 'HIGH', '既遂')]);
  assert.equal(f.fatalCount, 0, '纯越狱既遂不算真出血');
  assert.equal(f.criticalCount, 1);
  assert.equal(f.incidents[0]!.tier, '严重');
});

test('headline 反映致命数 + 基线依据齐备', () => {
  const withFatal = fatalOf([
    finding('data_exfiltration', 'CRITICAL', '既遂', {
      toolName: 'send_data',
      normalizedTarget: 'https://evil.example/c',
    }),
  ]);
  assert.match(withFatal.headline, /严重风险行为/);
  assert.match(withFatal.headline, /观察到 1 起/);
  assert.match(withFatal.headline, /建议立即核查并处置/);
  assert.match(withFatal.headline, /高优先级风险行为/);
  assert.ok(withFatal.baseline.length >= 5, '基线依据表');
  assert.ok(
    withFatal.baseline.every((r) => r.standards.length > 0),
    '每类都挂标准',
  );
  assert.match(withFatal.baselineNote, /ATT&CK|OWASP|数据安全法/);

  const clean = fatalOf([finding('agent_tool_abuse', 'MEDIUM', '未遂', { toolName: 'run_shell' })]);
  assert.match(clean.headline, /未观察到.*严重风险行为|防护有效|已阻断/);
});
