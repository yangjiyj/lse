import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { collectGatewayFindingsByTask } from '../src/modules/gateway-logs/client.js';

test('collectGatewayFindingsByTask 按 taskId 查询网关审计并归一为 findings', async () => {
  let seenUrl = '';
  let seenAuth = '';
  const server = http.createServer((req, res) => {
    seenUrl = req.url ?? '';
    seenAuth = req.headers.authorization ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [], has_more: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const findings = await collectGatewayFindingsByTask({
      controlPlaneBaseUrl: `http://127.0.0.1:${port}`,
      internalToken: 'tok',
      tenantId: 'tenant_default',
      taskId: 'task-1',
    });
    assert.deepEqual(findings, []);
    assert.match(seenUrl, /task_id=task-1/);
    assert.equal(seenAuth, 'Bearer tok');
  } finally {
    server.close();
  }
});
