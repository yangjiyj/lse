import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGatewayAuditEvents,
  type GatewayAuditEvent,
} from '../src/modules/gateway-logs/client.js';

// mode3 honeytoken 演练：分析时传入「本次演练预埋的诱饵串」，
// 捕获流量里若出现该具体诱饵 → 确认破防（业务部门真 agent 把我们埋的诱饵从出口发了出去）。

function riskEvent(policyEvidence: string): GatewayAuditEvent {
  return {
    id: 'evt-drill-1',
    requestId: 'req-drill-1',
    createdAt: '2026-06-30T01:00:00.000Z',
    correlation: {},
    source: { clientId: 'key-emp-1', sourceIp: '10.0.0.9' },
    target: { model: 'glm-5' },
    metrics: {},
    action: 'alert',
    verdict: 'flagged',
    riskLevel: 'low',
    policyHits: [
      {
        eventId: 'sec-1',
        eventType: 'custom_rule',
        severity: 'low',
        action: 'alert',
        category: 'custom',
        ruleId: 'drill-canary',
        ruleName: '演练诱饵规则',
        evidence: policyEvidence,
      },
    ],
    evidence: { redacted: true, securityEventCount: 1, rawContentAvailable: false },
  };
}

test('演练诱饵命中：捕获事件含本次诱饵串 → 确认破防 FAIL/CRITICAL + detail.drillCanary', () => {
  const event = riskEvent('出口载荷命中诱饵 LSE-DRILL-abc123');
  const { findings } = normalizeGatewayAuditEvents([event], { canaryTokens: ['LSE-DRILL-abc123'] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.verdict, 'FAIL');
  assert.equal(findings[0]!.severity, 'CRITICAL');
  assert.equal(findings[0]!.riskCategory, 'data_exfiltration');
  assert.equal(findings[0]!.detail.drillCanary, 'LSE-DRILL-abc123');
});

test('不传 canaryTokens 时行为不变(不误判为演练破防)', () => {
  const event = riskEvent('出口载荷命中诱饵 LSE-DRILL-abc123');
  const { findings } = normalizeGatewayAuditEvents([event]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.detail.drillCanary, undefined);
});

test('传了 canaryTokens 但事件不含该诱饵 → 不标记演练破防', () => {
  const event = riskEvent('普通低危访问控制告警');
  const { findings } = normalizeGatewayAuditEvents([event], { canaryTokens: ['LSE-DRILL-abc123'] });
  assert.equal(findings[0]!.detail.drillCanary, undefined);
});
