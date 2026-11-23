import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = '__asset_disc_';
const OP_USER = `${PREFIX}operator`;
const OP_PASS = ['Operator', 'Disc9', '123'].join('@');
const ADMIN_PASS = ['Admin', '@', '12345'].join('');
const SCOPE_KEY = 'asset_discovery.scope';

let app!: FastifyInstance;
let adminToken = '';
let opToken = '';
let ollama!: http.Server;
let openai!: http.Server;
let ollamaPort = 0;
let openaiPort = 0;
let savedScope: unknown = null;
const requests: Array<{ method: string; url: string; auth?: string }> = [];
const runs = new Map<string, Promise<void>>();

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

function listen(s: http.Server): Promise<number> {
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
}

before(async () => {
  ollama = http.createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          models: [
            {
              name: 'qwen2.5:7b',
              details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' },
            },
          ],
        }),
      );
    }
    if (req.method === 'POST' && req.url === '/api/show') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ model_info: { 'qwen2.context_length': 32768 } }));
    }
    res.writeHead(404).end();
  });
  openai = http.createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'shadow-llm', owned_by: 'acme', max_model_len: 4096 },
            { id: 'known-llm', owned_by: 'acme' },
          ],
        }),
      );
    }
    res.writeHead(404).end();
  });
  ollamaPort = await listen(ollama);
  openaiPort = await listen(openai);

  app = await buildApp({
    assetDiscovery: {
      execute: { hostIntervalMs: 0, probe: { timeoutMs: 2000 } },
      onRunStarted: (id, done) => runs.set(id, done),
    },
  });
  await app.ready();
  savedScope =
    (await prisma.systemSetting.findUnique({ where: { key: SCOPE_KEY } }))?.value ?? null;
  await prisma.systemSetting.deleteMany({ where: { key: SCOPE_KEY } });
  await prisma.user.deleteMany({ where: { username: OP_USER } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'operator' } });
  await prisma.user.create({
    data: {
      username: OP_USER,
      passwordHash: await argon2.hash(OP_PASS, { type: argon2.argon2id }),
      displayName: '资产测绘测试操作员',
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}已登记`,
      provider: 'openai-compatible-local',
      baseUrl: `http://127.0.0.1:${openaiPort}/v1`,
      apiKey: 'EMPTY',
      model: 'known-llm',
    },
  });
  const login = async (username: string, password: string) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().token as string;
  };
  adminToken = await login('admin', ADMIN_PASS);
  opToken = await login(OP_USER, OP_PASS);
});

after(async () => {
  await Promise.all([...runs.values()]);
  await prisma.assetDiscoveryRun.deleteMany({
    where: { createdByName: { in: ['admin', OP_USER] } },
  });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { username: OP_USER } });
  await prisma.systemSetting.deleteMany({ where: { key: SCOPE_KEY } });
  if (savedScope)
    await prisma.systemSetting.create({ data: { key: SCOPE_KEY, value: savedScope as object } });
  await app.close();
  await Promise.all([ollama, openai].map((s) => new Promise((r) => s.close(() => r(null)))));
});

test('默认范围为空，发起扫描被拒绝', async () => {
  const scope = await app.inject({
    method: 'GET',
    url: '/api/asset-discovery/scope',
    headers: auth(adminToken),
  });
  assert.equal(scope.statusCode, 200);
  assert.deepEqual(scope.json().entries, []);
  const r = await app.inject({
    method: 'POST',
    url: '/api/asset-discovery/runs',
    headers: auth(adminToken),
    payload: { targets: ['127.0.0.1'], ports: [ollamaPort], confirm: true },
  });
  assert.equal(r.statusCode, 403, r.body);
  assert.match(r.json().error.message, /尚未配置/);
});

test('仅管理员可配置范围，非法条目被拒绝', async () => {
  const payload = {
    entries: ['127.0.0.1/32'],
    ports: [ollamaPort, openaiPort],
    maxHostsPerRun: 16,
  };
  const denied = await app.inject({
    method: 'PUT',
    url: '/api/asset-discovery/scope',
    headers: auth(opToken),
    payload,
  });
  assert.equal(denied.statusCode, 403);
  const bad = await app.inject({
    method: 'PUT',
    url: '/api/asset-discovery/scope',
    headers: auth(adminToken),
    payload: { ...payload, entries: ['169.254.169.254'] },
  });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({
    method: 'PUT',
    url: '/api/asset-discovery/scope',
    headers: auth(adminToken),
    payload,
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'asset_discovery.scope.update' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(audit);
});

test('未带 confirm:true 或越界目标/端口均被拒绝', async () => {
  const noConfirm = await app.inject({
    method: 'POST',
    url: '/api/asset-discovery/runs',
    headers: auth(opToken),
    payload: { targets: ['127.0.0.1'], ports: [ollamaPort] },
  });
  assert.equal(noConfirm.statusCode, 400);
  assert.equal(noConfirm.json().error.code, 'ASSET_DISCOVERY_CONFIRM_REQUIRED');
  for (const payload of [
    { targets: ['127.0.0.2'], ports: [ollamaPort], confirm: true },
    { targets: ['127.0.0.1'], ports: [22], confirm: true },
    { targets: ['127.0.0.0/24'], ports: [ollamaPort], confirm: true },
  ]) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/asset-discovery/runs',
      headers: auth(opToken),
      payload,
    });
    assert.equal(r.statusCode, 403, r.body);
  }
});

test('异步扫描识别 Ollama 与 OpenAI 兼容服务，并与已登记对象比对', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/asset-discovery/runs',
    headers: auth(opToken),
    payload: { targets: ['127.0.0.1'], ports: [ollamaPort, openaiPort], confirm: true },
  });
  assert.equal(r.statusCode, 202, r.body);
  const id = r.json().id as string;
  await runs.get(id);
  const detail = await app.inject({
    method: 'GET',
    url: `/api/asset-discovery/runs/${id}`,
    headers: auth(opToken),
  });
  assert.equal(detail.statusCode, 200, detail.body);
  const run = detail.json();
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.hostCount, 1);
  assert.equal(run.hitCount, 2);
  const byType = Object.fromEntries(
    run.hits.map((h: { serviceType: string }) => [h.serviceType, h]),
  );
  assert.deepEqual(byType.OLLAMA.models, ['qwen2.5:7b']);
  assert.deepEqual(byType.OLLAMA.modelDetails, [
    {
      name: 'qwen2.5:7b',
      family: 'qwen2',
      parameterSize: '7.6B',
      quantization: 'Q4_K_M',
      contextLength: 32768,
    },
  ]);
  assert.deepEqual(byType.OPENAI_COMPATIBLE.modelDetails, [
    { name: 'shadow-llm', contextLength: 4096 },
    { name: 'known-llm' },
  ]);
  assert.equal(byType.OLLAMA.matches[0].registered, false);
  const oa = byType.OPENAI_COMPATIBLE.matches as Array<{
    model: string;
    registered: boolean;
    targetName: string | null;
  }>;
  assert.equal(oa.find((m) => m.model === 'shadow-llm')!.registered, false);
  assert.equal(oa.find((m) => m.model === 'known-llm')!.targetName, `${PREFIX}已登记`);
  assert.ok(
    requests.length > 0 &&
      requests.every(
        (q) => (q.method === 'GET' || (q.method === 'POST' && q.url === '/api/show')) && !q.auth,
      ),
  );
  const actions = (await prisma.auditLog.findMany({ where: { targetId: id } }))
    .map((a) => a.action)
    .sort();
  assert.deepEqual(actions, ['asset_discovery.run.finish', 'asset_discovery.run.start']);
  const list = await app.inject({
    method: 'GET',
    url: '/api/asset-discovery/runs',
    headers: auth(opToken),
  });
  assert.ok(list.json().some((x: { id: string }) => x.id === id));
});

test('URL 目标：按 URL 的协议、端口和前缀探测，不需要另填端口', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/asset-discovery/runs',
    headers: auth(opToken),
    payload: { targets: [`http://127.0.0.1:${openaiPort}/v1`], confirm: true },
  });
  assert.equal(r.statusCode, 202, r.body);
  assert.deepEqual(r.json().ports, [openaiPort]);
  assert.equal(r.json().hostCount, 1);
  assert.equal(r.json().endpointCount, 1);
  const id = r.json().id as string;
  await runs.get(id);
  const detail = await app.inject({
    method: 'GET',
    url: `/api/asset-discovery/runs/${id}`,
    headers: auth(opToken),
  });
  const run = detail.json();
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.probedCount, 1);
  assert.equal(run.hits.length, 1);
  assert.equal(run.hits[0].baseUrl, `http://127.0.0.1:${openaiPort}/v1`);
  assert.equal(run.hits[0].serviceType, 'OPENAI_COMPATIBLE');
});

test('URL 目标：非法 URL 返回 400，越界主机或端口返回 403', async () => {
  for (const bad of [
    'http://',
    'ftp://127.0.0.1/x',
    `http://u:p@127.0.0.1:${openaiPort}/v1`,
    `http://127.0.0.1:${openaiPort}/v1?api_key=x`,
  ]) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/asset-discovery/runs',
      headers: auth(opToken),
      payload: { targets: [bad], ports: [openaiPort], confirm: true },
    });
    assert.equal(r.statusCode, 400, `${bad} ${r.body}`);
    assert.equal(r.json().error.code, 'ASSET_DISCOVERY_TARGET_INVALID');
  }
  for (const target of [`http://127.0.0.2:${openaiPort}/v1`, 'http://127.0.0.1:22/v1']) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/asset-discovery/runs',
      headers: auth(opToken),
      payload: { targets: [target], confirm: true },
    });
    assert.equal(r.statusCode, 403, `${target} ${r.body}`);
  }
  const noPorts = await app.inject({
    method: 'POST',
    url: '/api/asset-discovery/runs',
    headers: auth(opToken),
    payload: { targets: ['127.0.0.1'], ports: [], confirm: true },
  });
  assert.equal(noPorts.statusCode, 400, noPorts.body);
});

test('「主机:端口」当作 http://主机:端口 探测，不需要另填端口', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/asset-discovery/runs',
    headers: auth(opToken),
    payload: { targets: [`127.0.0.1:${openaiPort}`], confirm: true },
  });
  assert.equal(r.statusCode, 202, r.body);
  assert.deepEqual(r.json().ports, [openaiPort]);
  const id = r.json().id as string;
  await runs.get(id);
  const run = (
    await app.inject({
      method: 'GET',
      url: `/api/asset-discovery/runs/${id}`,
      headers: auth(opToken),
    })
  ).json();
  assert.equal(run.hits.length, 1);
  assert.equal(run.hits[0].baseUrl, `http://127.0.0.1:${openaiPort}/v1`);
});

test('目标格式错误一律返回 400（含非标准写法的 IP），越界仍是 403', async () => {
  for (const bad of [
    'bad entry',
    '127.0.0.1/33',
    '169.254.169.254',
    `http://0177.0.0.1:${openaiPort}/v1`,
    `http://2130706433:${openaiPort}/v1`,
    '127.0.0.1:0',
  ]) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/asset-discovery/runs',
      headers: auth(opToken),
      payload: { targets: [bad], ports: [openaiPort], confirm: true },
    });
    assert.equal(r.statusCode, 400, `${bad} ${r.body}`);
    assert.equal(r.json().error.code, 'ASSET_DISCOVERY_TARGET_INVALID', bad);
  }
  const octal = await app.inject({
    method: 'POST',
    url: '/api/asset-discovery/runs',
    headers: auth(opToken),
    payload: { targets: [`http://0177.0.0.1:${openaiPort}/v1`], confirm: true },
  });
  assert.match(octal.json().error.message, /请写成标准 IP/);
  const out = await app.inject({
    method: 'POST',
    url: '/api/asset-discovery/runs',
    headers: auth(opToken),
    payload: { targets: [`127.0.0.2:${openaiPort}`], confirm: true },
  });
  assert.equal(out.statusCode, 403, out.body);
});

test('扫描记录给出实际端点数；审计记下 URL 与「主机:端口」目标解析后的端点', async () => {
  const urlTarget = `HTTP://127.0.0.1:${openaiPort}/v1/`;
  const r = await app.inject({
    method: 'POST',
    url: '/api/asset-discovery/runs',
    headers: auth(opToken),
    payload: { targets: ['127.0.0.1', urlTarget], ports: [ollamaPort, openaiPort], confirm: true },
  });
  assert.equal(r.statusCode, 202, r.body);
  const created = r.json();
  assert.equal(created.hostCount, 1);
  assert.equal(created.portCount, 2);
  assert.equal(created.endpointCount, 3, '两个端口各一个端点，加上带 /v1 前缀的 URL 端点');
  await runs.get(created.id);
  const list = await app.inject({
    method: 'GET',
    url: '/api/asset-discovery/runs',
    headers: auth(opToken),
  });
  assert.equal(list.json().find((x: { id: string }) => x.id === created.id).endpointCount, 3);
  const start = await prisma.auditLog.findFirstOrThrow({
    where: { action: 'asset_discovery.run.start', targetId: created.id },
  });
  const detail = start.detail as { endpointCount: number; urlEndpoints: unknown };
  assert.equal(detail.endpointCount, 3);
  assert.deepEqual(detail.urlEndpoints, [
    { target: urlTarget, endpoint: `http://127.0.0.1:${openaiPort}/v1` },
  ]);

  const outTarget = `0x7f.0.0.2:${openaiPort}`;
  const rejectedBefore = new Date();
  const denied = await app.inject({
    method: 'POST',
    url: '/api/asset-discovery/runs',
    headers: auth(opToken),
    payload: { targets: [`127.0.0.2:${openaiPort}`], confirm: true },
  });
  assert.equal(denied.statusCode, 403);
  const rejected = await prisma.auditLog.findFirstOrThrow({
    where: { action: 'asset_discovery.run.rejected', createdAt: { gte: rejectedBefore } },
    orderBy: { createdAt: 'desc' },
  });
  assert.deepEqual((rejected.detail as { urlEndpoints: unknown }).urlEndpoints, [
    { target: `127.0.0.2:${openaiPort}`, endpoint: `http://127.0.0.2:${openaiPort}` },
  ]);
  const bad = await app.inject({
    method: 'POST',
    url: '/api/asset-discovery/runs',
    headers: auth(opToken),
    payload: { targets: [outTarget], confirm: true },
  });
  assert.equal(bad.statusCode, 400);
});

test('网关未接入时线索接口返回受限状态', async () => {
  const saved = await prisma.systemSetting.findUnique({ where: { key: 'gateway' } });
  await prisma.systemSetting.deleteMany({ where: { key: 'gateway' } });
  try {
    const r = await app.inject({
      method: 'GET',
      url: '/api/asset-discovery/gateway-clues',
      headers: auth(adminToken),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().status, 'NOT_CONNECTED');
    assert.equal(r.json().message, '网关未接入，无法获取审计线索');
    const op = await app.inject({
      method: 'GET',
      url: '/api/asset-discovery/gateway-clues',
      headers: auth(opToken),
    });
    assert.equal(op.statusCode, 403);
  } finally {
    if (saved)
      await prisma.systemSetting.create({ data: { key: 'gateway', value: saved.value as object } });
  }
});
