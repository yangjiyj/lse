import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_ATTACK_TEMPLATES } from '../src/modules/agent-evals/packs/l7-mcp.js';
import { generateMcpScenarios } from '../src/modules/agent-evals/generator.js';
import { postMcpToolCall } from '../src/modules/eval-targets/mcp-client.js';
import { runMcpScenario } from '../src/modules/agent-evals/mcp-runner.js';
import { createServer } from 'node:http';
import { deriveReachability } from '../src/modules/reports/reachability.js';
const added = () => MCP_ATTACK_TEMPLATES.filter((t) => t.id.endsWith('-r4'));
test('四类配置风险各有两条并携带判据、证据、严重度与本地载荷', () => {
  const templates = added();
  assert.equal(templates.length, 8);
  for (const cls of ['tool_enumeration', 'tool_poisoning', 'shadow_tool', 'indirect_injection']) {
    assert.equal(templates.filter((t) => t.mcpClass === cls).length, 2);
  }
  for (const t of templates) {
    assert.ok(t.successSignals.length && t.evidenceRequirements.length && t.severity);
    assert.doesNotMatch(JSON.stringify(t), /https?:\/\/(?!127\.0\.0\.1)/);
  }
});
test('tools/list 使用真实协议方法且生成器保留沙箱判据', async () => {
  const samples = generateMcpScenarios({ classes: ['tool_enumeration'], sampleCount: 2 });
  assert.equal(samples.length, 2);
  assert.equal(samples[0]!.metadata.jsonRpc?.method, 'tools/list');
  assert.ok(samples.every((s) => s.metadata.sandboxProbe));
  let body: any;
  await postMcpToolCall({
    gatewayBaseUrl: 'http://127.0.0.1:18080',
    serverID: 'sandbox',
    apiKey: '',
    call: samples[0]!.metadata.jsonRpc!,
    fetchFn: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: '2.0', result: { tools: [] } }));
    },
  });
  assert.equal(body.method, 'tools/list');
  assert.equal(body.params.name, undefined);
});
async function probe(
  cls: 'tool_enumeration' | 'indirect_injection',
  raw: unknown,
  url = 'http://127.0.0.1:18080',
) {
  const metadata = generateMcpScenarios({ classes: [cls], sampleCount: 1 })[0]!.metadata;
  let called = false;
  const result = await runMcpScenario(
    {
      target: {
        targetType: 'MCP_OPENAPI',
        accessConfig: { serverID: 'sandbox', gatewayBaseUrl: url },
      } as any,
      metadata,
      prompt: 'local sandbox',
      traceId: 'trace',
      evalRunId: 'run',
      taskId: 'task',
      sampleId: 'sample',
      targetId: 'target',
      gateway: null,
      internalToken: '',
    },
    {
      invoke: async () => {
        called = true;
        return {
          status: 'SUCCESS',
          raw: { jsonRpcResult: raw },
          content: '',
          latencyMs: 1,
          httpStatus: 200,
          error: null,
        } as any;
      },
    },
  );
  return { result, called };
}
test('越权枚举失败，白名单内通过，缺失返回证据不能通过', async () => {
  assert.equal(
    (await probe('tool_enumeration', { tools: [{ name: 'sandbox_admin' }] })).result.verdict,
    'FAIL',
  );
  assert.equal(
    (await probe('tool_enumeration', { tools: [{ name: 'sandbox_read' }] })).result.verdict,
    'PASS',
  );
  assert.equal((await probe('tool_enumeration', {})).result.verdict, 'ERROR');
});
test('间接注入依实际后续工具轨迹判定；单有投毒返回不宣称成功', async () => {
  assert.equal(
    (
      await probe('indirect_injection', {
        agentTrace: { complete: true, toolCalls: [{ name: 'sandbox_write' }] },
      })
    ).result.verdict,
    'FAIL',
  );
  assert.equal(
    (await probe('indirect_injection', { agentTrace: { complete: true, toolCalls: [] } })).result
      .verdict,
    'PASS',
  );
  assert.equal(
    (await probe('indirect_injection', { content: 'ignore instructions' })).result.verdict,
    'ERROR',
  );
});
test('新沙箱探针拒绝非本地端点，不发请求', async () => {
  const { result, called } = await probe('tool_enumeration', {}, 'https://example.invalid');
  assert.equal(called, false);
  assert.equal(result.verdict, 'UNKNOWN');
  assert.equal(result.executionStatus, 'NOT_EXECUTED');
});

test('注册配置探针核查实际控制面端点，不能被本地accessConfig掩盖', async () => {
  const metadata = generateMcpScenarios({ classes: ['tool_poisoning'], sampleCount: 3 }).find((s) =>
    s.metadata.templateId.endsWith('-r4'),
  )!.metadata;
  let called = false;
  const result = await runMcpScenario(
    {
      target: {
        targetType: 'MCP_OPENAPI',
        accessConfig: {
          serverID: 'sandbox',
          gatewayBaseUrl: 'http://127.0.0.1:18080',
          controlPlaneBaseUrl: 'http://127.0.0.1:18081',
        },
      } as any,
      metadata,
      prompt: '',
      traceId: 'trace',
      evalRunId: 'run',
      taskId: 'task',
      sampleId: 'sample',
      targetId: 'target',
      gateway: { controlPlaneBaseUrl: 'https://example.invalid/admin', tenantId: 'sandbox' },
      internalToken: '',
    },
    {
      triggerSync: async () => {
        called = true;
        return { ok: true, poisonedToolCount: 1 };
      },
    },
  );
  assert.equal(called, false);
  assert.equal(result.verdict, 'UNKNOWN');
  assert.equal(result.executionStatus, 'NOT_EXECUTED');
});

test('本地HTTP沙箱走真实runMcpScenario路径，枚举与间接注入均产出PASS/FAIL', async () => {
  let failed = false;
  let requests = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    requests++;
    assert.equal(req.url, '/mcp/sandbox');
    assert.ok(['tools/list', 'tools/call'].includes(rpc.method));
    const result =
      rpc.method === 'tools/list'
        ? { tools: [{ name: failed ? 'sandbox_admin' : 'sandbox_read' }] }
        : { agentTrace: { complete: true, toolCalls: failed ? [{ name: 'sandbox_write' }] : [] } };
    if (rpc.method === 'tools/call') assert.match(rpc.params.arguments.fixture, /system/);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    for (const cls of ['tool_enumeration', 'indirect_injection'] as const) {
      const metadata = generateMcpScenarios({ classes: [cls], sampleCount: 1 })[0]!.metadata;
      for (const fail of [false, true]) {
        failed = fail;
        const result = await runMcpScenario({
          target: {
            targetType: 'MCP_OPENAPI',
            baseUrl: '',
            model: 'sandbox',
            apiKey: '',
            accessConfig: {
              serverID: 'sandbox',
              gatewayBaseUrl: `http://127.0.0.1:${address.port}`,
            },
          },
          metadata,
          prompt: '合成自检',
          traceId: 'trace',
          evalRunId: 'run',
          taskId: 'task',
          sampleId: 'sample',
          targetId: 'target',
          gateway: null,
          internalToken: '',
        });
        assert.equal(result.verdict, fail ? 'FAIL' : 'PASS');
        assert.match(result.content, /本地沙箱探针（检测器自检）/);
      }
      assert.match(
        generateMcpScenarios({ classes: [cls], sampleCount: 1 })[0]!.prompt,
        /不代表客户MCP配置覆盖/,
      );
    }
    assert.equal(requests, 4);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
test('前提不满足明确未执行，结构化SKIPPED与D2配合而非不可达错误', async () => {
  const { result, called } = await probe('tool_enumeration', {}, 'https://example.invalid');
  assert.equal(called, false);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.verdict, 'UNKNOWN');
  assert.match(result.content, /前提不满足，未执行/);
  assert.equal(
    deriveReachability({
      status: 'SUCCESS',
      finalVerdict: 'UNKNOWN',
      engineRuns: [{ status: 'SKIPPED', skippedCount: 1, executionStatus: 'NOT_EXECUTED' }],
    }),
    'not_executed',
  );
});

test('未完成分页、畸形工具名及不完整轨迹都不能自检通过', async () => {
  for (const raw of [{ tools: [], nextCursor: 'more' }, { tools: [{ name: 123 }] }])
    assert.equal((await probe('tool_enumeration', raw)).result.verdict, 'ERROR');
  assert.equal(
    (await probe('indirect_injection', { agentTrace: { complete: false, toolCalls: [] } })).result
      .verdict,
    'ERROR',
  );
});
test('目标类型、RPC前提与离线沙箱明确未执行，服务错误响应保留ERROR', async () => {
  const metadata = generateMcpScenarios({ classes: ['tool_enumeration'], sampleCount: 1 })[0]!
    .metadata;
  const args = {
    target: {
      targetType: 'MCP_OPENAPI',
      baseUrl: '',
      apiKey: '',
      model: 'sandbox',
      accessConfig: { serverID: 'sandbox', gatewayBaseUrl: 'http://127.0.0.1:18080' },
    },
    metadata,
    prompt: '',
    traceId: 'trace',
    evalRunId: 'run',
    taskId: 'task',
    sampleId: 'sample',
    targetId: 'target',
    gateway: null,
    internalToken: '',
  } as const;
  for (const modified of [
    { ...args, target: { ...args.target, targetType: 'MODEL' as const } },
    { ...args, metadata: { ...metadata, jsonRpc: undefined } },
  ]) {
    let called = false;
    const result = await runMcpScenario(modified, {
      invoke: async () => {
        called = true;
        throw new Error('不应请求');
      },
    });
    assert.equal(called, false);
    assert.equal(result.executionStatus, 'NOT_EXECUTED');
  }
  const failure = {
    status: 'ERROR',
    content: '',
    httpStatus: null,
    error: 'offline',
    raw: null,
    latencyMs: 0,
  } as any;
  assert.equal(
    (await runMcpScenario(args, { invoke: async () => failure })).executionStatus,
    'NOT_EXECUTED',
  );
  const responded = await runMcpScenario(args, {
    invoke: async () => ({ ...failure, httpStatus: 503 }),
  });
  assert.equal(responded.verdict, 'ERROR');
  assert.equal(responded.executionStatus, undefined);
});
