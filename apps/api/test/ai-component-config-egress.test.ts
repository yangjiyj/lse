import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

// GET /api/engines/ai-components/config：mcpFetch.egress 只回传出站策略布尔摘要，不回传允许清单内容。
const KEYS = ['LSE_TARGET_EGRESS_POLICIES', 'LSE_TARGET_EGRESS_ALLOWLIST', 'LSE_TARGET_EGRESS_ALLOW_PRIVATE'] as const;
const saved: Record<string, string | undefined> = {};
let app!: FastifyInstance;
let token = '';

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, values);
}

async function getConfig() {
  const r = await app.inject({ method: 'GET', url: '/api/engines/ai-components/config', headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.statusCode, 200, r.body);
  return { body: r.body, json: r.json() as { mcpFetch: { egress: Record<string, unknown> } } };
}

before(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  app = await buildApp();
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'Admin@12345' } }); // pragma: allowlist secret
  token = login.json().token;
});

after(async () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await app.close();
  await prisma.$disconnect();
});

test('未配置出站策略：allowlistConfigured=false、allowPrivateNetworks=false', async () => {
  setEnv({});
  const { json } = await getConfig();
  assert.deepEqual(json.mcpFetch.egress, { allowlistConfigured: false, allowPrivateNetworks: false });
});

test('配置扁平允许清单：返回布尔摘要，响应中不含清单明文', async () => {
  setEnv({ LSE_TARGET_EGRESS_ALLOWLIST: 'https://secret-mcp.corp.example:8443', LSE_TARGET_EGRESS_ALLOW_PRIVATE: 'true' });
  const { json, body } = await getConfig();
  assert.deepEqual(json.mcpFetch.egress, { allowlistConfigured: true, allowPrivateNetworks: true });
  assert.ok(!body.includes('secret-mcp'), '不得回传允许清单内容');
  setEnv({ LSE_TARGET_EGRESS_ALLOWLIST: 'https://secret-mcp.corp.example:8443' });
  assert.deepEqual((await getConfig()).json.mcpFetch.egress, { allowlistConfigured: true, allowPrivateNetworks: false });
});

test('配置租户/项目策略映射：按服务端上下文解析是否允许私网，不回传清单', async () => {
  setEnv({ LSE_TARGET_EGRESS_POLICIES: JSON.stringify({ '*/*': { allowlist: ['http://10.1.2.3:9000'], allowPrivateNetworks: true } }) });
  const { json, body } = await getConfig();
  assert.deepEqual(json.mcpFetch.egress, { allowlistConfigured: true, allowPrivateNetworks: true });
  assert.ok(!body.includes('10.1.2.3'), '不得回传允许清单内容');
  const keys = Object.keys(json.mcpFetch.egress).sort();
  assert.deepEqual(keys, ['allowPrivateNetworks', 'allowlistConfigured']);
});
