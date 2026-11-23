import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AgentShieldClient } from '../src/modules/endpoint-evals/agentshield-client.js';

/**
 * 平台的 posture 接口（/connectors/lse/endpoints/{id}/posture）对已删除、已吊销、停用、退役或根本不存在的登记
 * 返回 404 + {"error":{"code":"not_found"}}；登记还在就返回 200，哪怕它没有任何可测智能体。
 * 功能开关关闭时平台对整个连接器返回纯文本 404，那不是「登记不存在」。
 */
async function withConnector(respond: (url: string) => { status: number; type: string; body: string },
  run: (client: AgentShieldClient, urls: string[]) => Promise<void>) {
  const urls: string[] = [];
  const server = createServer((req, res) => {
    urls.push(req.url!);
    const { status, type, body } = respond(req.url!);
    res.statusCode = status;
    res.setHeader('content-type', type);
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number };
    await run(new AgentShieldClient({ baseUrl: `http://127.0.0.1:${port}`, secret: 'secret',
      egress: { policy: { allowlist: [`http://127.0.0.1:${port}`], allowPrivateNetworks: true } } }), urls);
  } finally {
    server.close();
  }
}
const json = (status: number, body: unknown) => ({ status, type: 'application/json', body: JSON.stringify(body) });

test('endpointExists：登记还在返回 true，平台明确回答不存在返回 false', async () => {
  await withConnector((url) => url.includes('/alive/')
    ? json(200, { endpoint_id: 'alive', product: 'codex', collected_fields: [] })
    : json(404, { error: { code: 'not_found', message: '任务或端点不存在' } }),
  async (client, urls) => {
    assert.equal(await client.endpointExists('alive', 'codex'), true);
    assert.equal(await client.endpointExists('revoked', 'codex'), false);
    assert.deepEqual(urls, ['/connectors/lse/endpoints/alive/posture?product=codex', '/connectors/lse/endpoints/revoked/posture?product=codex']);
  });
});

test('endpointExists：功能开关关闭的纯文本 404、其他错误码和服务不可用都算调用失败，不当成不存在', async () => {
  const cases = [
    { status: 404, type: 'text/plain', body: '404 page not found\n' },
    json(404, { error: { code: 'something_else', message: 'x' } }),
    json(400, { error: { code: 'invalid_request', message: '测评载荷不合法' } }),
    json(503, { error: { code: 'unavailable', message: '测评服务暂不可用' } }),
    json(401, { error: { code: 'invalid_signature', message: '签名无效或已过期' } }),
  ];
  for (const reply of cases) {
    await withConnector(() => reply, async (client) => {
      await assert.rejects(client.endpointExists('any', 'codex'), new RegExp(`终端测评连接器返回 ${reply.status}`), JSON.stringify(reply));
    });
  }
});
