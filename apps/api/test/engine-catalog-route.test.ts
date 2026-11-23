import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = 'ENGCAT-';
let app!: FastifyInstance;
let token = '';

async function cleanup() {
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  token = (
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
    })
  ).json().token;

  // 配置一个激活、凭据完整的裁判模型（JUDGE）。
  await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}裁判`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-engcat-judge', // pragma: allowlist secret
      model: 'judge-model',
      targetType: 'JUDGE',
      isActive: true,
    },
  });
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

function catalog() {
  return app.inject({
    method: 'GET',
    url: '/api/engines',
    headers: { authorization: `Bearer ${token}` },
  });
}

test('有激活裁判模型时 AI 评审复核(llm-judge) 标记为可用，而非未部署', async () => {
  const res = await catalog();
  assert.equal(res.statusCode, 200, res.body);
  const items = res.json() as Array<{ engine: string; available: boolean }>;
  const llmJudge = items.find((e) => e.engine === 'llm-judge');
  assert.ok(llmJudge, '目录应包含 llm-judge');
  assert.equal(llmJudge.available, true, '配置了裁判模型后 llm-judge 应可用');
});

test('已退役 AIG 不再进入目录，未部署的现役边车仍标记为不可用', async () => {
  const res = await catalog();
  const items = res.json() as Array<{ engine: string; available: boolean }>;
  assert.equal(
    items.some((e) => e.engine === 'ai-infra-guard'),
    false,
  );
  const garak = items.find((e) => e.engine === 'garak');
  assert.ok(garak);
  assert.equal(garak.available, false, 'garak 未部署应不可用');
});

test('内置引擎恒可用', async () => {
  const res = await catalog();
  const items = res.json() as Array<{ engine: string; builtin: boolean; available: boolean }>;
  for (const code of ['rule-judge', 'sensitive-info']) {
    const e = items.find((x) => x.engine === code);
    assert.ok(e, `目录应含 ${code}`);
    assert.equal(e.builtin, true);
    assert.equal(e.available, true);
  }
});

test('已退役 AIG 专用 API 路由不再注册', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/engines/ai-infra-guard/readiness',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 404, response.body);
});
