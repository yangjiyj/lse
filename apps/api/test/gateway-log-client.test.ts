import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  fetchGatewayAuditEvents,
  normalizeGatewayAuditEvents,
  postGatewayEvalFindings,
} from '../src/modules/gateway-logs/client.js';

const servers: http.Server[] = [];

function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}/admin/v1`);
    });
  });
}

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

test('fetchGatewayAuditEvents uses eval-integration auth headers and expands risky details', async () => {
  const seen = { listAuth: '', listTenant: '', listUrl: '', detailAuth: '', detailTenant: '' };
  const baseUrl = await listen((req, res) => {
    if (req.url?.startsWith('/admin/v1/eval-integration/audit-events?')) {
      seen.listAuth = req.headers.authorization ?? '';
      seen.listTenant = String(req.headers['x-newapi-tenant-id'] ?? '');
      seen.listUrl = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [listEvent('log-risk-1', 'flagged', 1)], total: 1 }));
      return;
    }
    if (req.url === '/admin/v1/eval-integration/audit-events/log-risk-1') {
      seen.detailAuth = req.headers.authorization ?? '';
      seen.detailTenant = String(req.headers['x-newapi-tenant-id'] ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: {
            ...listEvent('log-risk-1', 'blocked', 1),
            risk_level: 'critical',
            action: 'block',
            policy_hits: [policyHit()],
          },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  const events = await fetchGatewayAuditEvents({
    controlPlaneBaseUrl: baseUrl,
    internalToken: 'internal-secret',
    tenantId: 'tenant-a',
    startTime: '2026-06-10T00:00:00Z',
    endTime: '2026-06-10T02:00:00Z',
    limit: 50,
  });

  assert.equal(seen.listAuth, 'Bearer internal-secret');
  assert.equal(seen.listTenant, 'tenant-a');
  assert.match(seen.listUrl, /start_time=2026-06-10T00%3A00%3A00\.000Z/);
  assert.match(seen.listUrl, /end_time=2026-06-10T02%3A00%3A00\.000Z/);
  assert.match(seen.listUrl, /limit=50/);
  assert.equal(seen.detailAuth, 'Bearer internal-secret');
  assert.equal(seen.detailTenant, 'tenant-a');
  assert.equal(events[0]?.verdict, 'blocked');
  assert.equal(events[0]?.policyHits[0]?.ruleName, '系统提示词泄露');
});

test('postGatewayEvalFindings sends LSE findings to gateway eval integration endpoint', async () => {
  const seen = { auth: '', tenant: '', url: '', body: null as any };
  const baseUrl = await listen((req, res) => {
    if (req.url === '/admin/v1/eval-integration/findings' && req.method === 'POST') {
      seen.auth = req.headers.authorization ?? '';
      seen.tenant = String(req.headers['x-newapi-tenant-id'] ?? '');
      seen.url = req.url;
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        seen.body = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ created: 1, skipped: 0, ids: ['se_lse_1'], errors: [] }));
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  const result = await postGatewayEvalFindings({
    controlPlaneBaseUrl: baseUrl,
    internalToken: 'internal-secret',
    tenantId: 'tenant-a',
    requestId: 'req-lse-1',
    evalRunId: 'eval-1',
    taskId: 'task-1',
    sampleId: 'sample-1',
    targetId: 'target-1',
    findings: [
      {
        findingId: 'finding-1',
        riskDomain: '有害能力/高风险请求风险',
        category: 'should_refuse_violation',
        severity: 'HIGH',
        verdict: 'should_refuse_violation',
        expectedBehavior: 'should_refuse',
        actualBehavior: 'answered',
        reason: '模型回答命中高风险请求规则',
        evidence: '模型给出了实质性回答',
      },
    ],
  });

  assert.equal(seen.auth, 'Bearer internal-secret');
  assert.equal(seen.tenant, 'tenant-a');
  assert.equal(seen.url, '/admin/v1/eval-integration/findings');
  assert.equal(seen.body.request_id, 'req-lse-1');
  assert.equal(seen.body.eval_run_id, 'eval-1');
  assert.equal(seen.body.findings[0].verdict, 'should_refuse_violation');
  assert.deepEqual(result.ids, ['se_lse_1']);
});

test('normalizeGatewayAuditEvents maps gateway risk logs to LSE findings', () => {
  const { findings, summary } = normalizeGatewayAuditEvents([
    normalizedEvent('log-risk-1', 'blocked', 'critical', [normalizedPolicyHit()]),
    normalizedEvent('log-pass-1', 'passed', 'low', []),
  ]);

  assert.deepEqual(summary, { totalEvents: 2, passedEvents: 1, riskEvents: 1, blockedEvents: 1 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.engine, 'newapi-agent-security-gateway');
  assert.equal(findings[0]?.riskCategory, 'prompt_injection');
  assert.equal(findings[0]?.severity, 'CRITICAL');
  assert.equal(findings[0]?.verdict, 'FAIL');
  assert.match(findings[0]?.title ?? '', /系统提示词泄露/);
  assert.match(findings[0]?.evidence ?? '', /命中提示词泄露规则/);
  assert.equal(findings[0]?.detail.requestId, 'req-log-risk-1');
  assert.equal(findings[0]?.detail.rawPrompt, undefined);
  assert.equal(findings[0]?.detail.rawResponse, undefined);
});

test('normalizeGatewayAuditEvents 重判：网关仅告警放行的高危事件判 FAIL（标题仍标注告警放行=网关动作）', () => {
  const alertEvent = {
    ...normalizedEvent('log-alert-1', 'flagged', 'high', [normalizedPolicyHit()]),
    action: 'alert',
  };

  const { findings, summary } = normalizeGatewayAuditEvents([alertEvent]);

  assert.equal(summary.riskEvents, 1);
  assert.equal(summary.blockedEvents, 0);
  assert.equal(findings.length, 1);
  // 默认命中=prompt_injection/critical：网关只告警放行(未 block)，但 lse 评估尺重判为 FAIL（测堵验差异）。
  assert.equal(findings[0]?.verdict, 'FAIL');
  assert.match(findings[0]?.title ?? '', /告警放行/);
  assert.equal(findings[0]?.detail.gatewayAction, 'alert');
  assert.equal(findings[0]?.detail.lseRiskDomain, 'prompt_injection');
});

test('normalizeGatewayAuditEvents trims action/verdict whitespace before classifying blocked events', () => {
  const paddedActionEvent = {
    ...normalizedEvent('log-padded-1', 'flagged', 'high', [normalizedPolicyHit()]),
    action: 'block ',
  };
  const paddedVerdictEvent = {
    ...normalizedEvent('log-padded-2', ' Blocked ', 'high', [normalizedPolicyHit()]),
    action: 'allow',
  };

  const { findings, summary } = normalizeGatewayAuditEvents([
    paddedActionEvent,
    paddedVerdictEvent,
  ]);

  assert.equal(summary.blockedEvents, 2);
  assert.equal(findings.length, 2);
  assert.equal(findings[0]?.verdict, 'FAIL');
  assert.equal(findings[1]?.verdict, 'FAIL');
  assert.doesNotMatch(findings[0]?.title ?? '', /告警放行/);
  assert.doesNotMatch(findings[1]?.title ?? '', /告警放行/);
});

test('normalizeGatewayAuditEvents falls back to INFO when severity is missing or unrecognized', () => {
  const noSeverityEvent = {
    ...normalizedEvent('log-nosev-1', 'flagged', '', []),
    action: 'alert',
    evidence: { redacted: true, securityEventCount: 1 },
  };
  const weirdSeverityEvent = {
    ...normalizedEvent('log-weird-1', 'flagged', 'totally-unknown', []),
    action: 'alert',
    evidence: { redacted: true, securityEventCount: 1 },
  };

  const { findings } = normalizeGatewayAuditEvents([noSeverityEvent, weirdSeverityEvent]);

  assert.equal(findings.length, 2);
  assert.equal(findings[0]?.severity, 'INFO');
  assert.equal(findings[1]?.severity, 'INFO');
});

test('normalizeGatewayAuditEvents aggregates multiple policy hits into one finding per event', () => {
  const lowHit = {
    ...normalizedPolicyHit(),
    eventId: 'sec-low',
    severity: 'low',
    ruleId: 'pg-100',
    ruleName: '低危规则',
  };
  const criticalHit = {
    ...normalizedPolicyHit(),
    eventId: 'sec-crit',
    severity: 'critical',
    ruleId: 'pg-001',
    ruleName: '系统提示词泄露',
  };
  const event = normalizedEvent('log-multi-1', 'blocked', 'high', [lowHit, criticalHit]);

  const { findings, summary } = normalizeGatewayAuditEvents([event]);

  assert.equal(summary.riskEvents, 1);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'CRITICAL');
  assert.equal(findings[0]?.verdict, 'FAIL');
  assert.match(findings[0]?.title ?? '', /系统提示词泄露/);
  assert.equal(findings[0]?.detail.hitCount, 2);
  assert.equal(findings[0]?.detail.policyHits, undefined);
});

test('normalizeGatewayAuditEvents treats empty-verdict events without risk signals as passed', () => {
  const emptyEvent = {
    ...normalizedEvent('log-empty-1', '', 'low', []),
    action: '',
    verdict: '',
  };

  const { findings, summary } = normalizeGatewayAuditEvents([emptyEvent]);

  assert.equal(findings.length, 0);
  assert.deepEqual(summary, { totalEvents: 1, passedEvents: 1, riskEvents: 0, blockedEvents: 0 });
});

test('normalizeGatewayAuditEvents 不落库 correlation/source/metrics 等重字段(瘦身)，target 仍脱敏', () => {
  const event = {
    ...normalizedEvent('log-redact-1', 'blocked', 'critical', [normalizedPolicyHit()]),
    correlation: { traceId: 'trace-redact-1', authorization: 'Bearer sk-trace-secret' },
    source: { tenantId: 'tenant-a', apiKey: 'sk-live-source-123', token: 'tok-source-xyz' },
    target: { model: 'glm-5', authorization: 'Bearer sk-target-secret' },
    metrics: { latencyMs: 123, statusCode: 200, secret: 'canary-deadbeef' },
  };

  const { findings } = normalizeGatewayAuditEvents([event]);
  assert.equal(findings.length, 1);

  const detail = findings[0]!.detail;
  // 瘦身：correlation/source/metrics/policyHit 等重字段不再落库（从源头不存，连脱敏都不需要）。
  assert.equal(detail.correlation, undefined);
  assert.equal(detail.source, undefined);
  assert.equal(detail.metrics, undefined);
  assert.equal(detail.policyHit, undefined);
  // 来源以瘦字段保留（供报告/溯源）。
  assert.equal(detail.clientId, '');
  assert.equal(detail.sourceIp, '');
  // target 仍保留并脱敏。
  const target = detail.target as Record<string, unknown>;
  assert.equal(target.model, 'glm-5');
  assert.match(String(target.authorization), /^hash:/);
  assert.doesNotMatch(String(target.authorization), /sk-target-secret/);
});

test('normalizeGatewayAuditEvents 不落库原始 evidence 块(瘦身)', () => {
  const rawEvidenceToken = 'tok-evidence-secret-1234567890';
  const event = {
    ...normalizedEvent('log-evidence-redact-1', 'blocked', 'critical', [normalizedPolicyHit()]),
    evidence: {
      redacted: true,
      securityEventCount: 1,
      rawContentAvailable: false,
      summary: '安全事件摘要可读',
      token: rawEvidenceToken,
    },
  };

  const { findings } = normalizeGatewayAuditEvents([event]);
  assert.equal(findings.length, 1);

  // 瘦身：原始 evidence 块不再落 detail；命中证据用顶层 finding.evidence 字符串。
  assert.equal(findings[0]!.detail.evidence, undefined);
  assert.equal(typeof findings[0]!.evidence, 'string');
});

function listEvent(id: string, verdict: string, securityEventCount: number) {
  return {
    id,
    request_id: `req-${id}`,
    created_at: '2026-06-10T01:00:00Z',
    correlation: { trace_id: `trace-${id}` },
    source: { tenant_id: 'tenant-a', session_id: 'agent-session-1' },
    target: { model: 'glm-5', endpoint_type: 'chat_completions' },
    metrics: { status: 'completed', status_code: 200, latency_ms: 123 },
    action: verdict === 'blocked' ? 'block' : verdict === 'passed' ? 'allow' : 'alert',
    verdict,
    risk_level: verdict === 'passed' ? 'low' : 'high',
    policy_hits: [],
    evidence: { redacted: true, security_event_count: securityEventCount },
  };
}

function policyHit() {
  return {
    event_id: 'sec-1',
    event_type: 'prompt_guard',
    severity: 'critical',
    action: 'block',
    category: 'prompt_injection',
    rule_id: 'pg-001',
    rule_name: '系统提示词泄露',
    evidence: '命中提示词泄露规则',
  };
}

function normalizedEvent(id: string, verdict: string, riskLevel: string, policyHits: unknown[]) {
  return {
    id,
    requestId: `req-${id}`,
    createdAt: '2026-06-10T01:00:00Z',
    correlation: { traceId: `trace-${id}` },
    source: { tenantId: 'tenant-a', sessionId: 'agent-session-1' },
    target: { model: 'glm-5', endpointType: 'chat_completions' },
    metrics: { status: 'completed', statusCode: 200, latencyMs: 123 },
    action: verdict === 'blocked' ? 'block' : 'allow',
    verdict,
    riskLevel,
    policyHits,
    evidence: { redacted: true, securityEventCount: policyHits.length },
  };
}

function normalizedPolicyHit() {
  return {
    eventId: 'sec-1',
    eventType: 'prompt_guard',
    severity: 'critical',
    action: 'block',
    category: 'prompt_injection',
    ruleId: 'pg-001',
    ruleName: '系统提示词泄露',
    evidence: '命中提示词泄露规则',
  };
}
