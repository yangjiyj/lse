import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatMessage, LlmCallResult, LlmTargetConfig } from '@lse/shared';
import { invokeEvaluationTarget } from '../src/modules/eval-targets/invoker.js';

const servers: http.Server[] = [];
const originalTargetAllowlist = process.env.LSE_TARGET_EGRESS_ALLOWLIST;
const originalAllowPrivate = process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;

function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}/agent/chat`;
      process.env.LSE_TARGET_EGRESS_ALLOWLIST = new URL(baseUrl).origin;
      process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = 'true';
      resolve(baseUrl);
    });
  });
}

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  if (originalTargetAllowlist === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOWLIST;
  else process.env.LSE_TARGET_EGRESS_ALLOWLIST = originalTargetAllowlist;
  if (originalAllowPrivate === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;
  else process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = originalAllowPrivate;
});

function lastUser(messages: ChatMessage[]): string {
  return messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
}

test('Agent API 对象按 requestTemplate 发送样本并从 responseTextPath 提取回答', async () => {
  let capturedBody: unknown = null;
  let capturedAuth = '';
  const baseUrl = await listen((req, res) => {
    capturedAuth = req.headers.authorization ?? '';
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      capturedBody = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { answer: 'Agent 回答：已按测试环境处理' } }));
    });
  });

  const result = await invokeEvaluationTarget(
    {
      targetType: 'AGENT_API',
      baseUrl,
      apiKey: 'agent-secret-token',
      model: 'customer-agent',
      extraHeaders: null,
      defaultParams: null,
      accessConfig: {
        authType: 'bearer',
        requestTemplate: { input: '{{prompt}}', stream: false, meta: { source: 'lse' } },
        responseTextPath: 'data.answer',
      },
    },
    [{ role: 'user', content: '请测试 Agent 是否会越权调用工具' }],
  );

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.content, 'Agent 回答：已按测试环境处理');
  assert.equal(result.httpStatus, 200);
  assert.equal(capturedAuth, 'Bearer agent-secret-token');
  assert.deepEqual(capturedBody, {
    input: '请测试 Agent 是否会越权调用工具',
    stream: false,
    meta: { source: 'lse' },
  });
});

test('Agent API 响应路径不会读取对象原型链字段', async () => {
  const objectPrototype = Object.prototype as Record<string, unknown>;
  objectPrototype.pollutedAnswer = '不应被读取的原型链内容';
  const baseUrl = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({}));
    });
  });

  try {
    const result = await invokeEvaluationTarget(
      {
        targetType: 'AGENT_API',
        baseUrl,
        apiKey: 'agent-secret-token',
        model: 'customer-agent',
        extraHeaders: null,
        defaultParams: null,
        accessConfig: {
          authType: 'bearer',
          requestTemplate: { input: '{{prompt}}' },
          responseTextPath: '__proto__.pollutedAnswer',
        },
      },
      [{ role: 'user', content: '测试原型链路径读取' }],
    );

    assert.equal(result.status, 'ERROR');
    assert.equal(result.content, '');
    assert.match(result.error ?? '', /响应缺少可识别的回答字段/);
  } finally {
    delete objectPrototype.pollutedAnswer;
  }
});

test('模型对象仍委托 OpenAI-compatible 调用器', async () => {
  const seen: { cfg?: LlmTargetConfig; prompt?: string } = {};
  const result = await invokeEvaluationTarget(
    {
      targetType: 'MODEL',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-model-secret',
      model: 'fake-model',
      extraHeaders: null,
      defaultParams: null,
      accessConfig: null,
    },
    [{ role: 'user', content: 'hello model' }],
    {
      callModel: async (cfg, messages): Promise<LlmCallResult> => {
        seen.cfg = cfg;
        seen.prompt = lastUser(messages);
        return {
          status: 'SUCCESS',
          content: 'model ok',
          finishReason: 'stop',
          model: 'fake-model',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          latencyMs: 1,
          httpStatus: 200,
          error: null,
          raw: { ok: true },
        };
      },
    },
  );

  assert.equal(result.content, 'model ok');
  assert.equal(seen.prompt, 'hello model');
  assert.equal(seen.cfg?.apiKey, 'sk-model-secret');
});

test('智能体安全网关对象按会话 Header 注入网关归因标识', async () => {
  const seen: { cfg?: LlmTargetConfig; prompt?: string } = {};
  const result = await invokeEvaluationTarget(
    {
      targetType: 'GATEWAY_LOG',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'gw-runtime-token',
      model: 'gpt-4',
      extraHeaders: null,
      defaultParams: null,
      accessConfig: { sessionHeaderName: 'X-NewAPI-Session-Id' },
    },
    [{ role: 'user', content: 'hello gateway' }],
    {
      sessionId: 'task-1:question-1',
      correlationHeaders: {
        'X-LSE-Eval-Run-Id': 'eval-1',
        'X-LSE-Task-Id': 'task-1',
        'X-LSE-Sample-Id': 'question-1',
        'X-LSE-Target-Id': 'target-1',
        'X-LSE-Trace-Id': 'task-1:question-1',
      },
      callModel: async (cfg, messages): Promise<LlmCallResult> => {
        seen.cfg = cfg;
        seen.prompt = lastUser(messages);
        return {
          status: 'SUCCESS',
          content: 'gateway ok',
          finishReason: 'stop',
          model: 'gpt-4',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          latencyMs: 1,
          httpStatus: 200,
          error: null,
          raw: { ok: true },
        };
      },
    },
  );

  assert.equal(result.content, 'gateway ok');
  assert.equal(seen.prompt, 'hello gateway');
  assert.equal(seen.cfg?.apiKey, 'gw-runtime-token');
  assert.equal(seen.cfg?.extraHeaders?.['X-NewAPI-Session-Id'], 'task-1:question-1');
  assert.equal(seen.cfg?.extraHeaders?.['X-LSE-Eval-Run-Id'], 'eval-1');
  assert.equal(seen.cfg?.extraHeaders?.['X-LSE-Sample-Id'], 'question-1');
  assert.equal(seen.cfg?.extraHeaders?.['X-LSE-Trace-Id'], 'task-1:question-1');
});

test('PublicAgent 对象复用 Agent API 调用路径而非退回模型调用', async () => {
  let capturedBody: unknown = null;
  let capturedAuth = '';
  const baseUrl = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      capturedAuth = req.headers.authorization ?? '';
      capturedBody = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { answer: 'PublicAgent 已处理样本' } }));
    });
  });
  const result = await invokeEvaluationTarget(
    {
      targetType: 'PUBLIC_AGENT',
      baseUrl,
      apiKey: 'public-agent-token',
      model: 'public-agent',
      extraHeaders: null,
      defaultParams: null,
      accessConfig: {
        authType: 'bearer',
        requestTemplate: { input: '{{prompt}}' },
        responseTextPath: 'data.answer',
      },
    },
    [{ role: 'user', content: '公开智能体是否会执行越权指令' }],
  );
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.content, 'PublicAgent 已处理样本');
  assert.equal(result.httpStatus, 200);
  assert.equal(capturedAuth, 'Bearer public-agent-token');
  assert.deepEqual(capturedBody, { input: '公开智能体是否会执行越权指令' });
});

test('MCP/OpenAPI 对象在适配器实现前返回明确错误而非静默退回模型调用', async () => {
  let modelCalled = false;
  const result = await invokeEvaluationTarget(
    {
      targetType: 'MCP_OPENAPI',
      baseUrl: 'http://127.0.0.1:9/openapi.json',
      apiKey: 'mcp-token',
      model: 'mcp-openapi',
      extraHeaders: null,
      defaultParams: null,
      accessConfig: { schemaUrl: 'http://127.0.0.1:9/openapi.json' },
    },
    [{ role: 'user', content: '列出可用工具并尝试调用' }],
    {
      callModel: async (): Promise<LlmCallResult> => {
        modelCalled = true;
        return {
          status: 'SUCCESS',
          content: '不应被调用',
          finishReason: 'stop',
          model: 'x',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs: 0,
          httpStatus: 200,
          error: null,
          raw: null,
        };
      },
    },
  );

  assert.equal(modelCalled, false);
  assert.equal(result.status, 'ERROR');
  assert.equal(result.content, '');
  assert.match(result.error ?? '', /适配器尚未实现|MCP\/OpenAPI/);
});

test('Agent API 返回 SSE 流式响应时聚合增量为完整回答', async () => {
  const baseUrl = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"event":"message","answer":"流式"}\n\n');
      res.write('data: {"event":"message","answer":"回答"}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  const result = await invokeEvaluationTarget(
    {
      targetType: 'AGENT_API',
      baseUrl,
      apiKey: '',
      model: 'sse-agent',
      accessConfig: { authType: 'none', requestTemplate: { query: '{{prompt}}' } },
    },
    [{ role: 'user', content: '测试流式' }],
  );
  assert.equal(result.status, 'SUCCESS', result.error ?? '');
  assert.equal(result.content, '流式回答');
});

test('Agent API 返回 NDJSON 流式响应时按行聚合', async () => {
  const baseUrl = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end('{"response":"逐行"}\n{"response":"输出"}\n{"response":"","done":true}\n');
    });
  });
  const result = await invokeEvaluationTarget(
    {
      targetType: 'AGENT_API',
      baseUrl,
      apiKey: '',
      model: 'ndjson-agent',
      accessConfig: { authType: 'none', requestTemplate: { prompt: '{{prompt}}' } },
    },
    [{ role: 'user', content: '测试 NDJSON' }],
  );
  assert.equal(result.status, 'SUCCESS', result.error ?? '');
  assert.equal(result.content, '逐行输出');
});

test('Agent API 配置固定会话请求头后携带会话标识，并替换模板中的 {{session_id}}', async () => {
  let sessionHeader = '';
  let body: unknown = null;
  const baseUrl = await listen((req, res) => {
    sessionHeader = String(req.headers['x-session-id'] ?? '');
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '会话已续接' } }] }));
    });
  });
  const result = await invokeEvaluationTarget(
    {
      targetType: 'AGENT_API',
      baseUrl,
      apiKey: '',
      model: 'session-agent',
      accessConfig: {
        authType: 'none',
        sessionHeaderName: 'X-Session-Id',
        requestTemplate: { query: '{{prompt}}', conversation_id: '{{session_id}}' },
        responseTextPath: 'choices[0].message.content',
      },
    },
    [{ role: 'user', content: '第二轮' }],
    { sessionId: 'task-1:q-1' },
  );
  assert.equal(result.status, 'SUCCESS', result.error ?? '');
  assert.equal(result.content, '会话已续接');
  assert.equal(sessionHeader, 'task-1:q-1');
  assert.deepEqual(body, { query: '第二轮', conversation_id: 'task-1:q-1' });
});
