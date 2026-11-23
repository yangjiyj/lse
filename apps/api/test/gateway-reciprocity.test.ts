import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchGatewayVerifyReciprocal,
  gatewayReciprocityMessage,
} from '../src/modules/gateway-logs/client.js';

function mockFetch(status: number, body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

const BASE = {
  controlPlaneBaseUrl: 'http://gw.example/admin/v1',
  tenantId: 'tenant_default',
  internalToken: 'shared',
};

test('互证：nonce 回显一致 → reciprocal + nonceEchoed 匹配', async () => {
  const r = await fetchGatewayVerifyReciprocal({
    ...BASE,
    nonce: 'abc123def456aa',
    fetchFn: mockFetch(200, {
      reciprocal: true,
      reason: 'ok',
      nonce_echoed: 'abc123def456aa',
      lse_service: 'lse-api',
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.reciprocal, true);
  assert.equal(r.nonceEchoed, 'abc123def456aa');
});

test('互证：网关回连不到 LSE（错填地址）→ reciprocal:false + 原因码', async () => {
  const r = await fetchGatewayVerifyReciprocal({
    ...BASE,
    nonce: 'abc123def456aa',
    fetchFn: mockFetch(200, { reciprocal: false, reason: 'peer_unreachable' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.reciprocal, false);
  assert.equal(r.reason, 'peer_unreachable');
});

test('互证：网关 5xx → ok:false', async () => {
  const r = await fetchGatewayVerifyReciprocal({
    ...BASE,
    nonce: 'abc123def456aa',
    fetchFn: mockFetch(500, {}),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reciprocal, false);
});

test('文案：原因码全部映射为中文且不外泄英文枚举', () => {
  const reasons = [
    'lse_not_configured',
    'peer_unreachable',
    'peer_not_same_instance',
    'peer_not_reciprocal',
    'token_mismatch',
    'peer_not_lse',
    null,
  ];
  for (const reason of reasons) {
    const m = gatewayReciprocityMessage(reason);
    assert.ok(m.length > 0, `空文案: ${reason}`);
    assert.ok(!/[a-z_]{6,}/.test(m), `不应泄露英文枚举: ${m}`);
  }
});
