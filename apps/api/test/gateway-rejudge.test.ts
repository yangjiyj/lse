import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RISK_DOMAIN } from '@lse/shared';
import { rejudgeGatewayEvent } from '../src/modules/gateway-logs/rejudge.js';

// mode1 被动重判：lse 按自己的评估尺重判网关事件，而非复述网关 verdict。
// 核心差异——高危风险面即使网关只 alert/给 low，lse 也要判 FAIL 并升级 severity。

test('高危面(工具越权)即使网关只 alert/给 low，重判为 FAIL 且 severity 升到 HIGH', () => {
  const r = rejudgeGatewayEvent({
    policyHits: [{ category: 'agent_tool_abuse', severity: 'low', ruleName: '越权调用 send_data' }],
    riskLevel: 'low',
    action: 'alert',
    blocked: false,
  });
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.severity, 'HIGH');
  assert.equal(r.riskDomain, 'agent_tool_abuse');
});

test('数据外泄且命中 canary/凭据信号 → CRITICAL + FAIL', () => {
  const r = rejudgeGatewayEvent({
    policyHits: [
      {
        category: 'data_exfiltration',
        severity: 'medium',
        ruleName: 'canary token egress blocked',
      },
    ],
    riskLevel: 'medium',
    action: 'alert',
    blocked: false,
  });
  assert.equal(r.severity, 'CRITICAL');
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.riskDomain, 'data_exfiltration');
});

test('纯访问控制类 alert(非高危面) → UNKNOWN + 低 severity，不照搬网关', () => {
  const r = rejudgeGatewayEvent({
    policyHits: [{ category: 'access_control', severity: 'low', ruleName: '速率限制提醒' }],
    riskLevel: 'low',
    action: 'alert',
    blocked: false,
  });
  assert.equal(r.verdict, 'UNKNOWN');
  assert.equal(r.severity, 'LOW');
});

test('网关 block → FAIL', () => {
  const r = rejudgeGatewayEvent({
    policyHits: [{ category: 'access_control', severity: 'low' }],
    riskLevel: 'low',
    action: 'block',
    blocked: true,
  });
  assert.equal(r.verdict, 'FAIL');
});

test('不下调网关原级：网关判 critical 而 lse 面级较低时，取较高者', () => {
  const r = rejudgeGatewayEvent({
    policyHits: [{ category: 'access_control', severity: 'critical' }],
    riskLevel: 'critical',
    action: 'alert',
    blocked: false,
  });
  assert.equal(r.severity, 'CRITICAL');
});

test('riskDomain/riskCategory 永远是合法 RiskDomain(可被 GB/T 映射直接命中)', () => {
  const samples = [
    {
      policyHits: [{ category: 'pii', ruleName: '身份证号外发' }],
      riskLevel: 'high',
      action: 'block',
      blocked: true,
    },
    {
      policyHits: [{ category: 'tool_definition_drift' }],
      riskLevel: 'medium',
      action: 'alert',
      blocked: false,
    },
    {
      policyHits: [{ category: '什么都不像的类别', eventType: '' }],
      riskLevel: '',
      action: '',
      blocked: false,
    },
    { policyHits: [], riskLevel: 'low', action: 'alert', blocked: false },
  ];
  const valid = new Set<string>(RISK_DOMAIN as readonly string[]);
  for (const s of samples) {
    const r = rejudgeGatewayEvent(s);
    assert.ok(valid.has(r.riskDomain), `riskDomain 非法: ${r.riskDomain}`);
    assert.equal(r.riskCategory, r.riskDomain);
  }
});
