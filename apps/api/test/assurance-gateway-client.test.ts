import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  fetchGatewayAssuranceContract,
  fetchGatewayAssuranceEvidence,
} from '../src/modules/assurance/gateway-client.js';

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

test('fetchGatewayAssuranceContract calls gateway contract endpoint with shared-secret auth', async () => {
  let seenAuth = '';
  let seenTenant = '';
  const baseUrl = await listen((req, res) => {
    seenAuth = String(req.headers.authorization ?? '');
    seenTenant = String(req.headers['x-newapi-tenant-id'] ?? '');
    assert.equal(req.url, '/admin/v1/eval-integration/assurance-contract');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        schema_version: 'gateway-assurance-contract/v1',
        tenant_id: 'tenant-a',
        policies: [{ policy_id: 'secret.api_key.leak', category: 'secret' }],
        link_contracts: [{ link_id: 'request_log', required: true }],
      }),
    );
  });

  const contract = await fetchGatewayAssuranceContract({
    controlPlaneBaseUrl: baseUrl,
    internalToken: 'internal-secret',
    tenantId: 'tenant-a',
  });

  assert.equal(seenAuth, 'Bearer internal-secret');
  assert.equal(seenTenant, 'tenant-a');
  assert.equal(contract.schemaVersion, 'gateway-assurance-contract/v1');
  assert.equal(contract.policies[0]?.policyId, 'secret.api_key.leak');
  assert.equal(contract.linkContracts[0]?.linkId, 'request_log');
});

test('fetchGatewayAssuranceEvidence sends trace filter and normalizes checks', async () => {
  const baseUrl = await listen((req, res) => {
    assert.equal(
      req.url,
      '/admin/v1/eval-integration/assurance-evidence?trace_id=trace-1&sample_id=sample-1',
    );
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        schema_version: 'gateway-assurance-evidence/v1',
        tenant_id: 'tenant-a',
        query: { trace_id: 'trace-1', sample_id: 'sample-1' },
        checks: { request_log: true, security_event: false, alert: false },
        sources: { request_log: 'request_logs' },
        events: [],
      }),
    );
  });

  const evidence = await fetchGatewayAssuranceEvidence({
    controlPlaneBaseUrl: baseUrl,
    internalToken: 'internal-secret',
    tenantId: 'tenant-a',
    traceId: 'trace-1',
    sampleId: 'sample-1',
  });

  assert.equal(evidence.schemaVersion, 'gateway-assurance-evidence/v1');
  assert.equal(evidence.query.traceId, 'trace-1');
  assert.equal(evidence.checks.requestLog, true);
  assert.equal(evidence.checks.securityEvent, false);
});
