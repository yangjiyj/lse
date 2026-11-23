import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as entry from './endpoint-entry.js';

test('统一终端入口直接使用现有配置接口且不需要样本库', () => {
  assert.equal(typeof entry.endpointEntryRequest, 'function');
  const request = entry.endpointEntryRequest(
    { mode: 'posture', name: '配置检测' },
    { fleetEndpointId: '123' },
  );
  assert.equal(request.url, '/api/fleet/endpoints/123/posture-eval');
  assert.deepEqual(request.payload, { name: '配置检测' });
});
test('真机入口缺少影响确认时拒绝', () => {
  assert.equal(typeof entry.endpointEntryRequest, 'function');
  assert.throws(
    () =>
      entry.endpointEntryRequest(
        { mode: 'live', product: 'codex', riskTypes: ['credential_access'] },
        { fleetEndpointId: '123' },
      ),
    /确认|影响/,
  );
});
test('真机入口转发产品和风险类型到同一接口', () => {
  assert.equal(typeof entry.endpointEntryRequest, 'function');
  const request = entry.endpointEntryRequest(
    { mode: 'live', product: 'codex', riskTypes: ['credential_access'], confirmed: true },
    { fleetEndpointId: '123' },
  );
  assert.equal(request.url, '/api/fleet/endpoints/123/eval-jobs');
  assert.deepEqual(request.payload.riskTypes, ['credential_access']);
});
