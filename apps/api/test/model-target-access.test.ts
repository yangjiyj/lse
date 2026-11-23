import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { decryptCredential } from '../src/lib/credential-crypto.js';

const PREFIX = '__c_access_接入诊断__';
const SECRET = ['sk', 'diag', 'Qqq1112223334445556'].join('-');
let app!: FastifyInstance;
let token = '';
let server!: http.Server;
let origin = '';
const saved: Record<string, string | undefined> = {};

function auth() {
  return { authorization: `Bearer ${token}` };
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/v1/info') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: '测试平台应用' }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        if (req.headers.authorization !== `Bearer ${SECRET}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
        return;
      }
      if (req.url === '/agent/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          'data: {"event":"message","answer":"流式","conversation_id":"c-1"}\n\n' +
            'data: {"event":"message","answer":"回答","conversation_id":"c-1"}\n\n',
        );
        return;
      }
      if (req.url === '/agent/async') {
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ task_id: 'job-1', status: 'pending' }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const k of [
    'LSE_TARGET_EGRESS_ALLOWLIST',
    'LSE_TARGET_EGRESS_POLICIES',
    'LSE_TARGET_EGRESS_ALLOW_PRIVATE',
  ]) {
    saved[k] = process.env[k];
  }
  delete process.env.LSE_TARGET_EGRESS_POLICIES;
  process.env.LSE_TARGET_EGRESS_ALLOWLIST = origin;
  process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = 'true';
  app = await buildApp();
  await app.ready();
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
});

after(async () => {
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await prisma.$disconnect();
});

test('诊断接口需要认证', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/model-targets/diagnose', payload: {} });
  assert.equal(res.statusCode, 401);
});

test('诊断 OpenAI 兼容模型：错误密钥判定为认证失败，且响应不回显密钥', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets/diagnose',
    headers: auth(),
    payload: {
      targetType: 'MODEL',
      baseUrl: `${origin}/v1`,
      apiKey: 'sk-wrong-key-000000',
      model: 'm',
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const b = res.json();
  assert.equal(b.ok, false);
  assert.equal(b.checks.find((c: { key: string }) => c.key === 'auth').status, 'fail');
  assert.ok(!res.body.includes('sk-wrong-key-000000'));
});

test('诊断智能体 SSE 接口：识别流式并聚合，提示固定会话', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets/diagnose',
    headers: auth(),
    payload: {
      targetType: 'AGENT_API',
      baseUrl: `${origin}/agent/sse`,
      accessConfig: {
        authType: 'none',
        requestTemplate: { query: '{{prompt}}' },
        responseTextPath: 'answer',
      },
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const b = res.json();
  assert.equal(b.streamFormat, 'sse');
  assert.equal(b.answerSample, '流式回答');
  assert.equal(b.checks.find((c: { key: string }) => c.key === 'session').status, 'warn');
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'model_target.diagnose' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(audit);
});

test('诊断异步接口给出异步轮询提示', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets/diagnose',
    headers: auth(),
    payload: {
      targetType: 'AGENT_API',
      baseUrl: `${origin}/agent/async`,
      accessConfig: { authType: 'none' },
    },
  });
  const b = res.json();
  assert.equal(b.checks.find((c: { key: string }) => c.key === 'async').status, 'warn');
});

test('诊断不放宽出站策略：不在允许清单的地址被拦截', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets/diagnose',
    headers: auth(),
    payload: { targetType: 'MODEL', baseUrl: 'http://169.254.169.254/v1', apiKey: 'x', model: 'm' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const b = res.json();
  assert.equal(b.ok, false);
  const network = b.checks.find((c: { key: string }) => c.key === 'network');
  assert.equal(network.status, 'fail');
  assert.match(network.suggestion, /出站/);
});

test('批量连通性测试：逐个返回结果并写回最近测试', async () => {
  const ok = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}ok`,
      provider: 'openai-compatible',
      baseUrl: `${origin}/v1`,
      apiKey: SECRET,
      model: 'm',
    },
  });
  const bad = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}bad`,
      provider: 'openai-compatible',
      baseUrl: `${origin}/v1`,
      apiKey: 'sk-bad-0000000000',
      model: 'm',
    },
  });
  const agent = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}agent`,
      targetType: 'AGENT_API',
      provider: 'custom-agent',
      baseUrl: `${origin}/agent/sse`,
      apiKey: '',
      model: 'agent-api',
      accessConfig: { authType: 'none', requestTemplate: { query: '{{prompt}}' } },
    },
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/model-targets/batch-test',
    headers: auth(),
    payload: { ids: [ok.id, bad.id, agent.id] },
  });
  assert.equal(res.statusCode, 200, res.body);
  const b = res.json();
  assert.equal(b.concurrency, 4);
  assert.deepEqual(b.summary, { total: 3, success: 2, failed: 1, skipped: 0 });
  const byId = Object.fromEntries(b.results.map((r: { id: string }) => [r.id, r]));
  assert.equal(byId[ok.id].status, 'SUCCESS');
  assert.equal(byId[bad.id].status, 'ERROR');
  assert.equal(byId[agent.id].status, 'SUCCESS');
  assert.ok(!res.body.includes(SECRET));
  const reloaded = await prisma.modelTarget.findUnique({ where: { id: bad.id } });
  assert.equal(reloaded?.lastTestStatus, 'ERROR');
  assert.ok(reloaded?.lastTestedAt);
});

test('已保存对象诊断：沿用已保存密钥', async () => {
  const t = await prisma.modelTarget.findFirstOrThrow({ where: { name: `${PREFIX}ok` } });
  const res = await app.inject({
    method: 'POST',
    url: `/api/model-targets/${t.id}/diagnose`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().answerSample, 'pong');
  const viaForm = await app.inject({
    method: 'POST',
    url: '/api/model-targets/diagnose',
    headers: auth(),
    payload: { targetId: t.id, targetType: 'MODEL', baseUrl: `${origin}/v1`, model: 'm' },
  });
  assert.equal(viaForm.json().ok, true);
});

test('编辑时回传脱敏占位的请求头会还原为已保存原值，新值原样保存', async () => {
  const headerSecret = ['tok', 'hdr', 'Www1112223334445556'].join('-');
  const created = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: `${PREFIX}headers`,
      targetType: 'AGENT_API',
      provider: 'custom-agent',
      baseUrl: `${origin}/agent/sse`,
      model: 'agent-api',
      accessConfig: {
        authType: 'none',
        headers: { 'X-App-Token': headerSecret, 'X-Trace': 'visible' },
        requestTemplate: { query: '{{prompt}}' },
      },
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const view = created.json();
  assert.match(view.accessConfig.headers['X-App-Token'], /^hash:/);
  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/model-targets/${view.id}`,
    headers: auth(),
    payload: {
      accessConfig: {
        ...view.accessConfig,
        headers: { ...view.accessConfig.headers, 'X-New': 'n1' },
        sessionHeaderName: 'X-Session-Id',
      },
    },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  const row = await prisma.modelTarget.findUniqueOrThrow({ where: { id: view.id } });
  const cfg = row.accessConfig as { headers: Record<string, string>; sessionHeaderName: string };
  assert.equal(cfg.headers['X-App-Token'], headerSecret);
  assert.equal(cfg.headers['X-New'], 'n1');
  assert.equal(cfg.sessionHeaderName, 'X-Session-Id');
});


test('平台智能体默认关闭且能力接口如实返回，开启后验证配置并创建', async () => {
  const old = process.env.LSE_PLATFORM_APP_ENABLED;
  try {
    delete process.env.LSE_PLATFORM_APP_ENABLED;
    const capability = await app.inject({ method: 'GET', url: '/api/model-targets/capabilities', headers: auth() });
    assert.equal(capability.statusCode, 200, capability.body);
    assert.equal(capability.json().platformAppEnabled, false);
    const payload = { name: `${PREFIX}平台`, targetType: 'PLATFORM_APP', apiKey: SECRET,
      accessConfig: { platform: 'dify', baseUrl: `${origin}/v1`, appMode: 'agent-chat' } };
    const disabled = await app.inject({ method: 'POST', url: '/api/model-targets', headers: auth(), payload });
    assert.equal(disabled.statusCode, 403, disabled.body);
    process.env.LSE_PLATFORM_APP_ENABLED = 'true';
    const enabled = await app.inject({ method: 'GET', url: '/api/model-targets/capabilities', headers: auth() });
    assert.equal(enabled.json().platformAppEnabled, true);
    const invalid = await app.inject({ method: 'POST', url: '/api/model-targets', headers: auth(), payload: { ...payload, accessConfig: { platform: 'coze', baseUrl: origin } } });
    assert.equal(invalid.statusCode, 400, invalid.body);
    const created = await app.inject({ method: 'POST', url: '/api/model-targets', headers: auth(), payload });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().baseUrl, `${origin}/v1`);
    assert.equal(created.json().targetType, 'PLATFORM_APP');
    const stored = await prisma.modelTarget.findUniqueOrThrow({ where: { id: created.json().id } });
    assert.ok(stored.apiKey.startsWith('enc:v1:'));
    assert.equal(decryptCredential(stored.apiKey), SECRET);
    const updated = await app.inject({ method: 'PATCH', url: `/api/model-targets/${stored.id}`, headers: auth(), payload: { apiKey: `${SECRET}-new` } });
    assert.equal(updated.statusCode, 200, updated.body);
    const next = await prisma.modelTarget.findUniqueOrThrow({ where: { id: stored.id } });
    assert.equal(decryptCredential(next.apiKey), `${SECRET}-new`);
    const changedType = await app.inject({ method: 'PATCH', url: `/api/model-targets/${stored.id}`, headers: auth(), payload: { targetType: 'MODEL', model: 'test-model' } });
    assert.equal(changedType.statusCode, 200, changedType.body);
    assert.equal((await prisma.modelTarget.findUniqueOrThrow({ where: { id: stored.id } })).apiKey, `${SECRET}-new`);
    assert.ok(!created.body.includes(SECRET));
  } finally {
    if (old === undefined) delete process.env.LSE_PLATFORM_APP_ENABLED;
    else process.env.LSE_PLATFORM_APP_ENABLED = old;
  }
});


test('平台应用诊断调用应用信息接口，不拼接模型接口', async () => {
  const old = process.env.LSE_PLATFORM_APP_ENABLED;
  process.env.LSE_PLATFORM_APP_ENABLED = 'true';
  try {
    const res = await app.inject({ method: 'POST', url: '/api/model-targets/diagnose', headers: auth(),
      payload: { targetType: 'PLATFORM_APP', baseUrl: `${origin}/v1`, apiKey: SECRET,
        accessConfig: { platform: 'dify', baseUrl: `${origin}/v1`, appMode: 'agent-chat' } } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().ok, true, res.body);
    assert.ok(!res.body.includes(SECRET));
  } finally {
    if (old === undefined) delete process.env.LSE_PLATFORM_APP_ENABLED;
    else process.env.LSE_PLATFORM_APP_ENABLED = old;
  }
});


test('平台诊断拒绝配置基地址与表单基地址不一致，防止沿用密钥发往新地址', async () => {
  const old = process.env.LSE_PLATFORM_APP_ENABLED;
  process.env.LSE_PLATFORM_APP_ENABLED = 'true';
  try {
    const res = await app.inject({ method: 'POST', url: '/api/model-targets/diagnose', headers: auth(),
      payload: { targetType: 'PLATFORM_APP', baseUrl: `${origin}/v1`, apiKey: SECRET,
        accessConfig: { platform: 'dify', baseUrl: `${origin}/other`, appMode: 'agent-chat' } } });
    assert.equal(res.statusCode, 400, res.body);
  } finally {
    if (old === undefined) delete process.env.LSE_PLATFORM_APP_ENABLED;
    else process.env.LSE_PLATFORM_APP_ENABLED = old;
  }
});
