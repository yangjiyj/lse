import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const TEST_NAME = '__m3_集成测试模型__';
const TEST_NAME_2 = '__m3_集成测试模型_改名__';
const TEST_AGENT_NAME = '__m3_Agent_API_接入对象__';
const TEST_MCP_NAME = '__m3_MCP_接入对象__';
const TEST_MCP_OK_NAME = '__m3_MCP_只填Schema__';
const TEST_GATEWAY_NAME = '__m3_智能体安全网关_接入对象__';
const TEST_GATEWAY_BAD_URL_NAME = `${TEST_GATEWAY_NAME}_bad_url`;
const TEST_JUDGE_NAME = '__m3_全局评审模型__';
const TEST_JUDGE_NO_KEY_NAME = `${TEST_JUDGE_NAME}_缺Key`;
const TEST_JUDGE_NO_MODEL_NAME = `${TEST_JUDGE_NAME}_缺Model`;
const TEST_AGENT_GW_NAME = `${TEST_AGENT_NAME}_网关绑定`;
const TEST_AGENT_UNBOUND_NAME = `${TEST_AGENT_NAME}_未绑定`;
const TEST_MODEL_GW_NAME = '__m3_被测对象_网关绑定__';
const TEST_MODEL_NOGW_NAME = '__m3_被测对象_未绑定网关__';
const TEST_MODEL_GW2_NAME = '__m3_被测对象_网关探活__';

let app!: FastifyInstance;
let token = '';
let fakeServer!: http.Server;
let fakeBaseUrl = '';
let createdId = '';
let originalTargetAllowlist: string | undefined;
let originalTargetPolicies: string | undefined;
let originalAllowPrivate: string | undefined;

function auth(): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

before(async () => {
  // 假 OpenAI 兼容服务：仅响应 POST /v1/chat/completions，回显 pong
  fakeServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'fake-echo-1',
            choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => fakeServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = fakeServer.address() as AddressInfo;
  fakeBaseUrl = `http://127.0.0.1:${addr.port}/v1`;
  originalTargetAllowlist = process.env.LSE_TARGET_EGRESS_ALLOWLIST;
  originalTargetPolicies = process.env.LSE_TARGET_EGRESS_POLICIES;
  originalAllowPrivate = process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;
  delete process.env.LSE_TARGET_EGRESS_POLICIES;
  process.env.LSE_TARGET_EGRESS_ALLOWLIST = new URL(fakeBaseUrl).origin;
  process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = 'true';

  app = await buildApp();
  await app.ready();

  await prisma.modelTarget.deleteMany({
    where: {
      name: {
        in: [
          TEST_NAME,
          TEST_NAME_2,
          TEST_AGENT_NAME,
          TEST_MCP_NAME,
          TEST_MCP_OK_NAME,
          TEST_GATEWAY_NAME,
          TEST_GATEWAY_BAD_URL_NAME,
          TEST_JUDGE_NAME,
          TEST_JUDGE_NO_KEY_NAME,
          TEST_JUDGE_NO_MODEL_NAME,
          TEST_AGENT_GW_NAME,
          TEST_AGENT_UNBOUND_NAME,
          TEST_MODEL_GW_NAME,
          TEST_MODEL_NOGW_NAME,
          TEST_MODEL_GW2_NAME,
        ],
      },
    },
  });

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
});

after(async () => {
  await prisma.modelTarget.deleteMany({
    where: {
      name: {
        in: [
          TEST_NAME,
          TEST_NAME_2,
          TEST_AGENT_NAME,
          TEST_MCP_NAME,
          TEST_MCP_OK_NAME,
          TEST_GATEWAY_NAME,
          TEST_GATEWAY_BAD_URL_NAME,
          TEST_JUDGE_NAME,
          TEST_JUDGE_NO_KEY_NAME,
          TEST_JUDGE_NO_MODEL_NAME,
          TEST_AGENT_GW_NAME,
          TEST_AGENT_UNBOUND_NAME,
          TEST_MODEL_GW_NAME,
          TEST_MODEL_NOGW_NAME,
          TEST_MODEL_GW2_NAME,
        ],
      },
    },
  });
  await app.close();
  await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
  if (originalTargetAllowlist === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOWLIST;
  else process.env.LSE_TARGET_EGRESS_ALLOWLIST = originalTargetAllowlist;
  if (originalTargetPolicies === undefined) delete process.env.LSE_TARGET_EGRESS_POLICIES;
  else process.env.LSE_TARGET_EGRESS_POLICIES = originalTargetPolicies;
  if (originalAllowPrivate === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;
  else process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = originalAllowPrivate;
  await prisma.$disconnect();
});

test('未认证访问列表返回 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/model-targets' });
  assert.equal(res.statusCode, 401);
});

test('创建模型对象成功且不回传明文 apiKey', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: TEST_NAME,
      provider: 'openai-compatible',
      baseUrl: fakeBaseUrl,
      apiKey: 'sk-secret-1234567890',
      model: 'fake-echo-1',
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const b = res.json();
  createdId = b.id;
  assert.ok(createdId);
  assert.equal(b.name, TEST_NAME);
  assert.equal(b.hasApiKey, true);
  assert.equal(b.apiKeyMasked, 'sk-s****7890');
  assert.equal(b.apiKey, undefined);
  assert.equal(b.isGlobal, true);
  assert.ok(b.createdBy && b.createdBy.username === 'admin');
});

test('重复名称返回 409', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: { name: TEST_NAME, baseUrl: fakeBaseUrl, apiKey: 'sk-x', model: 'm' },
  });
  assert.equal(res.statusCode, 409, res.body);
});

test('创建智能体应用 API 评估对象：返回对象类型和接入配置且不泄漏 apiKey', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: TEST_AGENT_NAME,
      targetType: 'AGENT_API',
      provider: 'custom-agent',
      baseUrl: 'http://127.0.0.1:18080/agent/chat',
      apiKey: 'agent-secret-token',
      model: 'customer-agent',
      accessConfig: {
        authType: 'bearer',
        requestTemplate: { input: '{{prompt}}', stream: false },
        responseTextPath: 'data.answer',
      },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const b = res.json();
  assert.equal(b.targetType, 'AGENT_API');
  assert.equal(b.accessConfig.responseTextPath, 'data.answer');
  assert.equal(b.accessConfig.authType, 'bearer');
  assert.equal(
    b.connectorCapabilities.find((cap: { key: string }) => cap.key === 'app_api')?.supported,
    true,
  );
  assert.equal(
    b.connectorCapabilities.find((cap: { key: string }) => cap.key === 'session_trace')?.supported,
    false,
  );
  assert.equal(b.apiKey, undefined);
  assert.equal(b.apiKeyMasked, 'agen****oken');
});

test('创建智能体对象并绑定网关证据源：派生 controlPlaneBaseUrl 且保留 Agent 接入字段', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: TEST_AGENT_GW_NAME,
      targetType: 'AGENT_API',
      provider: 'custom-agent',
      baseUrl: 'http://127.0.0.1:18080/agent/chat',
      apiKey: 'agent-secret-token',
      model: 'customer-agent',
      accessConfig: {
        authType: 'bearer',
        requestTemplate: { input: '{{prompt}}', stream: false },
        responseTextPath: 'data.answer',
        gatewayBaseUrl: 'http://gw.example.com:3000',
        tenantId: 'tenant_acme',
      },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const b = res.json();
  assert.equal(b.targetType, 'AGENT_API');
  assert.equal(b.accessConfig.responseTextPath, 'data.answer');
  assert.equal(b.accessConfig.authType, 'bearer');
  assert.equal(b.accessConfig.controlPlaneBaseUrl, 'http://gw.example.com:3000/admin/v1');
  assert.equal(b.accessConfig.tenantId, 'tenant_acme');
});

test('创建智能体对象不填网关地址：accessConfig 不含网关字段（不绑定）', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: TEST_AGENT_UNBOUND_NAME,
      targetType: 'AGENT_API',
      provider: 'custom-agent',
      baseUrl: 'http://127.0.0.1:18080/agent/chat',
      apiKey: 'agent-secret-token',
      model: 'customer-agent',
      accessConfig: {
        authType: 'bearer',
        requestTemplate: { input: '{{prompt}}' },
        responseTextPath: 'data.answer',
      },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const b = res.json();
  assert.equal(b.accessConfig.controlPlaneBaseUrl, undefined);
  assert.equal(b.accessConfig.tenantId, undefined);
});

test('被测对象(MODEL)绑定网关证据源：派生 controlPlaneBaseUrl', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: TEST_MODEL_GW_NAME,
      targetType: 'MODEL',
      provider: 'openai-compatible',
      baseUrl: 'http://gateway-core:8080/v1',
      apiKey: 'sk-model-key',
      model: 'qwen2.5',
      accessConfig: { gatewayBaseUrl: 'http://control-plane:8081', tenantId: 'tenant_acme' },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const b = res.json();
  assert.equal(b.targetType, 'MODEL');
  assert.equal(b.accessConfig.controlPlaneBaseUrl, 'http://control-plane:8081/admin/v1');
  assert.equal(b.accessConfig.tenantId, 'tenant_acme');
});

test('test-gateway：未配置网关证据源的评估对象返回 ok:false', async () => {
  const create = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: TEST_MODEL_NOGW_NAME,
      targetType: 'MODEL',
      provider: 'openai-compatible',
      baseUrl: 'https://api.invalid/v1',
      apiKey: 'sk-x',
      model: 'm',
    },
  });
  assert.equal(create.statusCode, 201, create.body);
  const id = create.json().id;
  const res = await app.inject({
    method: 'POST',
    url: `/api/model-targets/${id}/test-gateway`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().ok, false);
  assert.match(res.json().message, /未配置网关证据源/);
});

test('test-gateway：绑定网关的被测对象会去探活（不可达→ok:false）', async () => {
  const create = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: TEST_MODEL_GW2_NAME,
      targetType: 'MODEL',
      provider: 'openai-compatible',
      baseUrl: 'https://api.invalid/v1',
      apiKey: 'sk-x',
      model: 'm',
      accessConfig: { gatewayBaseUrl: 'http://gw-unreachable.invalid:9' },
    },
  });
  assert.equal(create.statusCode, 201, create.body);
  const id = create.json().id;
  const res = await app.inject({
    method: 'POST',
    url: `/api/model-targets/${id}/test-gateway`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().ok, false);
});

test('MCP/OpenAPI 评估对象缺少 schemaUrl 时返回 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: TEST_MCP_NAME,
      targetType: 'MCP_OPENAPI',
      provider: 'mcp',
      baseUrl: 'http://127.0.0.1:18081/mcp',
      apiKey: 'mcp-secret-token',
      model: 'mcp-tools',
      accessConfig: { authType: 'bearer' },
    },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('创建 MCP/OpenAPI 对象时只需要 schemaUrl，不要求额外 Base URL', async () => {
  const schemaUrl = 'https://agent.example.com/openapi.json';
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: TEST_MCP_OK_NAME,
      targetType: 'MCP_OPENAPI',
      provider: 'mcp-openapi',
      accessConfig: { schemaUrl },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const b = res.json();
  assert.equal(b.targetType, 'MCP_OPENAPI');
  assert.equal(b.baseUrl, schemaUrl);
  assert.equal(b.model, 'mcp-openapi');
  assert.equal(b.accessConfig.schemaUrl, schemaUrl);
  assert.equal(
    b.connectorCapabilities.find((cap: { key: string }) => cap.key === 'mcp_skill_schema')
      ?.supported,
    true,
  );
  assert.equal(
    b.connectorCapabilities.find((cap: { key: string }) => cap.key === 'controlled_execution')
      ?.supported,
    false,
  );
});

test('创建智能体安全网关日志源时只保存管理面配置且不要求模型密钥', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: TEST_GATEWAY_NAME,
      targetType: 'GATEWAY_LOG',
      provider: 'newapi-agent-security-gateway',
      accessConfig: {
        gatewayBaseUrl: '192.168.1.20:8081',
        tenantId: 'tenant-a',
      },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const b = res.json();
  assert.equal(b.targetType, 'GATEWAY_LOG');
  assert.equal(b.provider, 'newapi-agent-security-gateway');
  assert.equal(b.baseUrl, 'http://192.168.1.20:8081/admin/v1');
  assert.equal(b.model, 'gateway-log-source');
  assert.equal(b.apiKey, undefined);
  assert.equal(b.hasApiKey, false);
  assert.equal(b.apiKeyMasked, '');
  assert.equal(b.accessConfig.gatewayBaseUrl, 'http://192.168.1.20:8081');
  assert.equal(b.accessConfig.controlPlaneBaseUrl, 'http://192.168.1.20:8081/admin/v1');
  assert.equal(b.accessConfig.tenantId, 'tenant-a');
  assert.equal(b.accessConfig.adminToken, undefined);
  assert.equal(b.accessConfig.runtimeApiKey, undefined);
  assert.equal(b.accessConfig.sessionHeaderName, undefined);
});

test('智能体安全网关对象的 controlPlaneBaseUrl 非法时返回 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: TEST_GATEWAY_BAD_URL_NAME,
      targetType: 'GATEWAY_LOG',
      provider: 'newapi-agent-security-gateway',
      accessConfig: {
        gatewayBaseUrl: 'http://',
      },
    },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('创建全局评审模型(JUDGE)成功：类型正确且不回传明文 apiKey', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: TEST_JUDGE_NAME,
      targetType: 'JUDGE',
      provider: 'openai-compatible',
      baseUrl: fakeBaseUrl,
      apiKey: 'sk-judge-secret-7890',
      model: 'judge-model-1',
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const b = res.json();
  assert.equal(b.targetType, 'JUDGE');
  assert.equal(b.model, 'judge-model-1');
  assert.equal(b.hasApiKey, true);
  assert.equal(b.apiKey, undefined);
  assert.match(b.apiKeyMasked, /\*\*\*\*/);
});

test('列表默认隐藏 JUDGE，系统配置显式 includeSystem 才返回', async () => {
  const defaultRes = await app.inject({
    method: 'GET',
    url: '/api/model-targets',
    headers: auth(),
  });
  assert.equal(defaultRes.statusCode, 200, defaultRes.body);
  const defaultBody = defaultRes.json();
  assert.equal(
    defaultBody.items.some((x: { name: string }) => x.name === TEST_JUDGE_NAME),
    false,
  );

  const systemRes = await app.inject({
    method: 'GET',
    url: '/api/model-targets?includeSystem=true',
    headers: auth(),
  });
  assert.equal(systemRes.statusCode, 200, systemRes.body);
  const systemBody = systemRes.json();
  assert.ok(
    systemBody.items.some(
      (x: { name: string; targetType: string }) =>
        x.name === TEST_JUDGE_NAME && x.targetType === 'JUDGE',
    ),
  );
});

test('创建评审模型(JUDGE)缺少 apiKey 时返回 400（与模型对象同等校验）', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: TEST_JUDGE_NO_KEY_NAME,
      targetType: 'JUDGE',
      provider: 'openai-compatible',
      baseUrl: fakeBaseUrl,
      model: 'judge-model-1',
    },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('创建评审模型(JUDGE)缺少 model 时返回 400（与模型对象同等校验）', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: TEST_JUDGE_NO_MODEL_NAME,
      targetType: 'JUDGE',
      provider: 'openai-compatible',
      baseUrl: fakeBaseUrl,
      apiKey: 'sk-judge-secret-7890',
    },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('列表可按关键字查询到新建对象且 apiKey 脱敏', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/model-targets?keyword=${encodeURIComponent('集成测试')}`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.ok(Array.isArray(b.items));
  assert.equal(typeof b.total, 'number');
  const found = b.items.find((x: { id: string }) => x.id === createdId);
  assert.ok(found, '应能在列表中找到新建对象');
  assert.equal(found.apiKey, undefined);
  assert.match(found.apiKeyMasked, /\*\*\*\*/);
});

test('详情查询返回脱敏对象', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/model-targets/${createdId}`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().id, createdId);
  assert.equal(res.json().apiKey, undefined);
});

test('编辑对象：改名并改模型，未传 apiKey 时保留原值', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/model-targets/${createdId}`,
    headers: auth(),
    payload: { name: TEST_NAME_2, model: 'fake-echo-2' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const b = res.json();
  assert.equal(b.name, TEST_NAME_2);
  assert.equal(b.model, 'fake-echo-2');
  assert.equal(b.hasApiKey, true);
  assert.equal(b.apiKeyMasked, 'sk-s****7890');
});

test('已保存对象连接测试成功并落库状态', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/model-targets/${createdId}/test`,
    headers: auth(),
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body);
  const b = res.json();
  assert.equal(b.status, 'SUCCESS');
  assert.equal(b.sample, 'pong');
  assert.equal(b.usage.totalTokens, 8);
  assert.ok(b.latencyMs >= 0);
  const t = await prisma.modelTarget.findUnique({ where: { id: createdId } });
  assert.equal(t?.lastTestStatus, 'SUCCESS');
  assert.ok(t?.lastTestedAt);
});

test('未保存配置连接测试成功', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets/test',
    headers: auth(),
    payload: { baseUrl: fakeBaseUrl, apiKey: 'sk-temp', model: 'whatever', prompt: '测试' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'SUCCESS');
  assert.equal(res.json().sample, 'pong');
});

test('未保存连接测试忽略 body 中的 tenant/project，不能越界到其他项目 allowlist', async () => {
  const originalPolicies = process.env.LSE_TARGET_EGRESS_POLICIES;
  const originalAllowlist = process.env.LSE_TARGET_EGRESS_ALLOWLIST;
  const originalTenant = process.env.LSE_TENANT_ID;
  const originalProject = process.env.LSE_PROJECT_ID;
  delete process.env.LSE_TARGET_EGRESS_ALLOWLIST;
  process.env.LSE_TENANT_ID = 'tenant_default';
  process.env.LSE_PROJECT_ID = 'project_default';
  process.env.LSE_TARGET_EGRESS_POLICIES = JSON.stringify({
    'tenant_default/project_default': {
      allowlist: [new URL(fakeBaseUrl).origin],
      allowPrivateNetworks: true,
    },
    'attacker/project': ['https://evil.example.com'],
  });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-targets/test',
      headers: auth(),
      payload: {
        baseUrl: fakeBaseUrl,
        apiKey: 'sk-temp',
        model: 'whatever',
        tenantId: 'attacker',
        projectId: 'project',
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, 'SUCCESS');
  } finally {
    if (originalPolicies === undefined) delete process.env.LSE_TARGET_EGRESS_POLICIES;
    else process.env.LSE_TARGET_EGRESS_POLICIES = originalPolicies;
    if (originalAllowlist === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOWLIST;
    else process.env.LSE_TARGET_EGRESS_ALLOWLIST = originalAllowlist;
    if (originalTenant === undefined) delete process.env.LSE_TENANT_ID;
    else process.env.LSE_TENANT_ID = originalTenant;
    if (originalProject === undefined) delete process.env.LSE_PROJECT_ID;
    else process.env.LSE_PROJECT_ID = originalProject;
  }
});

test('连接测试失败时返回 200 + ERROR（而非抛错）', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets/test',
    headers: auth(),
    payload: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-x', model: 'm' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'ERROR');
  assert.ok(res.json().error);
});

test('删除模型对象', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/model-targets/${createdId}`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().ok, true);
  const gone = await app.inject({
    method: 'GET',
    url: `/api/model-targets/${createdId}`,
    headers: auth(),
  });
  assert.equal(gone.statusCode, 404);
});

test('GET /:id 序列化时 extraHeaders 与 accessConfig 中的凭据必须脱敏（非网关类型）', async () => {
  const REDACT_NAME = '__m3_脱敏_接入对象__';
  const rawHeaderSecret = ['sk', 'hdr', 'Aaa1112223334445556'].join('-');
  const rawCfgBearer = ['tok', 'cfg', 'Bbb1112223334445556'].join('-');
  const rawCfgApiKey = ['sk', 'cfgkey', 'Ccc1112223334445556'].join('-');

  // 幂等清理：保证 name 唯一约束下可重复运行
  await prisma.modelTarget.deleteMany({ where: { name: REDACT_NAME } });

  const createRes = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: REDACT_NAME,
      targetType: 'AGENT_API',
      provider: 'custom-agent',
      baseUrl: 'http://127.0.0.1:18080/agent/chat',
      apiKey: 'agent-secret-token',
      model: 'customer-agent',
      extraHeaders: {
        Authorization: `Bearer ${rawHeaderSecret}`,
        'X-Trace-Id': 'trace-visible-123',
      },
      accessConfig: {
        authType: 'bearer',
        responseTextPath: 'data.answer',
        notes: 'api_key_rotation_days=90 仅作策略说明',
        session_timeout: '3600',
        requestTemplate: { input: '{{prompt}}', stream: false },
        headers: { Authorization: `Bearer ${rawCfgBearer}` },
        apiKey: rawCfgApiKey,
      },
    },
  });
  assert.equal(createRes.statusCode, 201, createRes.body);
  const created = createRes.json();
  const id = created.id as string;

  const res = await app.inject({
    method: 'GET',
    url: `/api/model-targets/${id}`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const b = res.json();
  const bodyStr = JSON.stringify(b);

  // 原始凭据绝不能出现在序列化结果中
  assert.ok(!bodyStr.includes(rawHeaderSecret), 'extraHeaders 中的密钥泄露了');
  assert.ok(!bodyStr.includes(rawCfgBearer), 'accessConfig.headers 中的密钥泄露了');
  assert.ok(!bodyStr.includes(rawCfgApiKey), 'accessConfig.apiKey 泄露了');
  // 敏感值应被替换为 hash:xxxxxxxxxxxx
  assert.match(bodyStr, /hash:[0-9a-f]{12}/);

  // 非敏感字段必须原样保留（authType / responseTextPath / 普通追踪头）
  assert.equal(b.accessConfig.authType, 'bearer');
  assert.equal(b.accessConfig.responseTextPath, 'data.answer');
  assert.equal(b.accessConfig.notes, 'api_key_rotation_days=90 仅作策略说明');
  assert.equal(b.accessConfig.requestTemplate.input, '{{prompt}}');
  assert.equal(b.extraHeaders['X-Trace-Id'], 'trace-visible-123');
  assert.match(String(b.accessConfig.session_timeout), /^hash:/);
  assert.doesNotMatch(String(b.accessConfig.session_timeout), /3600/);

  await prisma.modelTarget.deleteMany({ where: { name: REDACT_NAME } });
});

test('修改实际连接配置清除旧测试状态；改名、重复保存和 JSON 键排序不清除', async () => {
  const testedAt = new Date('2026-09-01T00:00:00Z');
  const target = await prisma.modelTarget.create({
    data: {
      name: '__m3_connection_revision__',
      provider: 'openai-compatible',
      baseUrl: fakeBaseUrl,
      apiKey: 'fixture-key',
      model: 'fixture-model',
      extraHeaders: { 'X-Route': 'one', 'X-Tenant': 'two' },
      lastTestStatus: 'SUCCESS',
      lastTestedAt: testedAt,
    },
  });
  try {
    const unchanged = await app.inject({
      method: 'PATCH',
      url: `/api/model-targets/${target.id}`,
      headers: auth(),
      payload: {
        name: '__m3_connection_revision_renamed__',
        isActive: false,
        isGlobal: false,
        provider: target.provider,
        targetType: target.targetType,
        baseUrl: ` ${fakeBaseUrl} `,
        apiKey: target.apiKey,
        model: target.model,
        extraHeaders: { 'X-Tenant': 'two', 'X-Route': 'one' },
        defaultParams: null,
        accessConfig: null,
      },
    });
    assert.equal(unchanged.statusCode, 200, unchanged.body);
    const preserved = await prisma.modelTarget.findUniqueOrThrow({ where: { id: target.id } });
    assert.equal(preserved.lastTestStatus, 'SUCCESS');
    assert.deepEqual(preserved.lastTestedAt, testedAt);

    const changes = [
      { baseUrl: `${fakeBaseUrl}/changed` },
      { apiKey: 'new-fixture-key' },
      { model: 'changed-model' },
      { provider: 'changed-provider' },
      { targetType: 'JUDGE' },
      { extraHeaders: { 'X-Route': 'changed' } },
      { extraHeaders: null },
      { defaultParams: { temperature: 0.5 } },
      { defaultParams: null },
      { accessConfig: { connectionMode: 'changed' } },
      { accessConfig: null },
    ];
    for (const [index, payload] of changes.entries()) {
      await prisma.modelTarget.update({
        where: { id: target.id },
        data: { lastTestStatus: index % 2 ? 'SUCCESS' : 'ERROR', lastTestedAt: testedAt },
      });
      const changed = await app.inject({
        method: 'PATCH',
        url: `/api/model-targets/${target.id}`,
        headers: auth(),
        payload,
      });
      assert.equal(changed.statusCode, 200, changed.body);
      const row = await prisma.modelTarget.findUniqueOrThrow({ where: { id: target.id } });
      assert.equal(row.lastTestStatus, null, `status for ${Object.keys(payload)[0]}`);
      assert.equal(row.lastTestedAt, null, `testedAt for ${Object.keys(payload)[0]}`);
    }
  } finally {
    await prisma.modelTarget.delete({ where: { id: target.id } });
  }
});

test('删除对象仅清理匹配的角色引用，保留其他配置和历史任务', async () => {
  const keys = ['redteam.config', 'agent_eval.config'];
  const priorSettings = await prisma.systemSetting.findMany({ where: { key: { in: keys } } });
  const target = await prisma.modelTarget.create({
    data: {
      name: '__m3_delete_role_references__',
      provider: 'openai-compatible',
      baseUrl: fakeBaseUrl,
      apiKey: 'fixture-key',
      model: 'fixture-model',
    },
  });
  const historyTarget = await prisma.modelTarget.create({
    data: {
      name: '__m3_role_history_target__',
      provider: 'openai-compatible',
      baseUrl: fakeBaseUrl,
      apiKey: 'fixture-key',
      model: 'other-model',
    },
  });
  const history = await prisma.evalTask.create({
    data: {
      name: '__m3_role_history__',
      modelTargetId: historyTarget.id,
      engines: [],
      dimensions: [],
    },
  });
  const redteam = {
    attackerTargetId: target.id,
    secondaryAttackerTargetId: historyTarget.id,
    judgeTargetId: target.id,
    gatewayTargetId: target.id,
    maxRounds: 9,
    moves: ['preserved'],
    unrelatedTargetId: target.id,
  };
  const agentEval = {
    attackerTargetId: historyTarget.id,
    judgeTargetId: target.id,
    adaptiveRounds: 5,
  };
  try {
    for (const [key, value] of [
      ['redteam.config', redteam],
      ['agent_eval.config', agentEval],
    ] as const) {
      await prisma.systemSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }
    // A target referenced by an actual task must still be protected from deletion.
    const denied = await app.inject({
      method: 'DELETE',
      url: `/api/model-targets/${historyTarget.id}`,
      headers: auth(),
    });
    assert.equal(denied.statusCode, 400, denied.body);
    assert.deepEqual(
      (await prisma.systemSetting.findUniqueOrThrow({ where: { key: keys[0] } })).value,
      redteam,
    );
    assert.deepEqual(
      (await prisma.systemSetting.findUniqueOrThrow({ where: { key: keys[1] } })).value,
      agentEval,
    );

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/model-targets/${target.id}`,
      headers: auth(),
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(await prisma.modelTarget.findUnique({ where: { id: target.id } }), null);
    assert.deepEqual(
      (await prisma.systemSetting.findUniqueOrThrow({ where: { key: keys[0] } })).value,
      { ...redteam, attackerTargetId: '', judgeTargetId: '', gatewayTargetId: '' },
    );
    assert.deepEqual(
      (await prisma.systemSetting.findUniqueOrThrow({ where: { key: keys[1] } })).value,
      { ...agentEval, judgeTargetId: '' },
    );
    assert.deepEqual(
      await prisma.evalTask.findUniqueOrThrow({ where: { id: history.id } }),
      history,
    );

    // The other role slots are also cleared when their referenced target can be deleted.
    await prisma.evalTask.delete({ where: { id: history.id } });
    const removedRemaining = await app.inject({
      method: 'DELETE',
      url: `/api/model-targets/${historyTarget.id}`,
      headers: auth(),
    });
    assert.equal(removedRemaining.statusCode, 200, removedRemaining.body);
    assert.deepEqual(
      (await prisma.systemSetting.findUniqueOrThrow({ where: { key: keys[0] } })).value,
      {
        ...redteam,
        attackerTargetId: '',
        secondaryAttackerTargetId: '',
        judgeTargetId: '',
        gatewayTargetId: '',
      },
    );
    assert.deepEqual(
      (await prisma.systemSetting.findUniqueOrThrow({ where: { key: keys[1] } })).value,
      { ...agentEval, attackerTargetId: '', judgeTargetId: '' },
    );
  } finally {
    await prisma.systemSetting.deleteMany({ where: { key: { in: keys } } });
    for (const setting of priorSettings) {
      await prisma.systemSetting.create({
        data: { ...setting, value: setting.value === null ? Prisma.JsonNull : setting.value },
      });
    }
    await prisma.evalTask.deleteMany({ where: { id: history.id } });
    await prisma.modelTarget.deleteMany({ where: { id: { in: [target.id, historyTarget.id] } } });
  }
});

test('列表 ?untested=1：只列启用中、可做连通性测试且从未测试的对象', async () => {
  const tag = `__m3_untested_${Date.now()}`;
  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
  const make = (suffix: string, data: Record<string, unknown>) =>
    prisma.modelTarget.create({
      data: {
        name: `${tag}_${suffix}`,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: '',
        model: 'm',
        createdById: admin.id,
        ...data,
      } as Prisma.ModelTargetUncheckedCreateInput,
    });
  try {
    await make('model_untested', {});
    await make('model_tested', { lastTestStatus: 'SUCCESS', lastTestedAt: new Date() });
    await make('model_failed', { lastTestStatus: 'FAILED', lastTestedAt: new Date() });
    await make('model_inactive', { isActive: false });
    await make('agent_untested', { targetType: 'AGENT_API' });
    await make('gateway_untested', { targetType: 'GATEWAY_LOG' });
    await make('endpoint_untested', { targetType: 'ENDPOINT_AGENT' });

    const names = async (query: string) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/model-targets?pageSize=200&keyword=${tag}${query}`,
        headers: auth(),
      });
      assert.equal(res.statusCode, 200, res.body);
      return (res.json().items as Array<{ name: string }>)
        .map((t) => t.name.slice(tag.length + 1))
        .sort();
    };
    assert.deepEqual(await names('&untested=1'), ['agent_untested', 'model_untested']);
    assert.deepEqual(await names('&untested=true'), ['agent_untested', 'model_untested']);
    // 不带参数：全部对象，口径不受影响
    assert.equal((await names('')).length, 7);
    assert.equal((await names('&untested=0')).length, 7);
  } finally {
    await prisma.modelTarget.deleteMany({ where: { name: { startsWith: tag } } });
  }
});
