import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchGatewayAuditEvents,
  normalizeGatewayAuditEvents,
  type GatewayAuditEvent,
} from '../src/modules/gateway-logs/client.js';

// P0：被动网关日志分析支持按 api-key(client_id) 与 源IP(source_ip) 过滤，
// 并把这两维提升到 Finding.detail 顶层，供报告页筛选/展示「针对单个 key / 单个 IP」。

test('fetchGatewayAuditEvents 在提供 clientId/sourceIp 时作为 client_id/source_ip 查询参数下传网关', async () => {
  let capturedUrl = '';
  const fetchFn = async (input: string | URL) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify({ data: [], has_more: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await fetchGatewayAuditEvents({
    controlPlaneBaseUrl: 'http://gw.local:8080/admin/v1',
    internalToken: 'tok',
    tenantId: 'tenant_x',
    clientId: 'key-123',
    sourceIp: '203.0.113.9',
    startTime: '2026-06-01T00:00:00.000Z',
    endTime: '2026-06-02T00:00:00.000Z',
    fetchFn,
  });

  const url = new URL(capturedUrl);
  assert.equal(url.searchParams.get('client_id'), 'key-123');
  assert.equal(url.searchParams.get('source_ip'), '203.0.113.9');
});

test('fetchGatewayAuditEvents 不提供 clientId/sourceIp 时不带这两个查询参数', async () => {
  let capturedUrl = '';
  const fetchFn = async (input: string | URL) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify({ data: [], has_more: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await fetchGatewayAuditEvents({
    controlPlaneBaseUrl: 'http://gw.local:8080/admin/v1',
    internalToken: 'tok',
    tenantId: 'tenant_x',
    fetchFn,
  });

  const url = new URL(capturedUrl);
  assert.equal(url.searchParams.has('client_id'), false);
  assert.equal(url.searchParams.has('source_ip'), false);
});

test('normalizeGatewayAuditEvents 把 clientId/sourceIp 提升到 Finding.detail 顶层(供报告筛选)', () => {
  const event: GatewayAuditEvent = {
    id: 'evt-1',
    requestId: 'req-1',
    createdAt: '2026-06-01T00:00:00.000Z',
    correlation: {},
    source: { clientId: 'key-abc', sourceIp: '203.0.113.9', userId: 'u1' },
    target: { model: 'gpt-x' },
    metrics: {},
    action: 'block',
    verdict: 'blocked',
    riskLevel: 'high',
    policyHits: [],
    evidence: { redacted: true, securityEventCount: 0, rawContentAvailable: false },
  };

  const { findings } = normalizeGatewayAuditEvents([event]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.detail.clientId, 'key-abc');
  assert.equal(findings[0]!.detail.sourceIp, '203.0.113.9');
});
