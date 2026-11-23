import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = '__agent_eval_config_';

let app!: FastifyInstance;
let token = '';

function auth() {
  return { authorization: `Bearer ${token}` };
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await prisma.systemSetting.deleteMany({ where: { key: 'agent_eval.config' } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
});

after(async () => {
  await prisma.systemSetting.deleteMany({ where: { key: 'agent_eval.config' } });
  await app.close();
  await prisma.$disconnect();
});

test('GET /api/agent-evals/config 返回 6 级技术元数据 + 全局自适应配置（任务 4）', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/agent-evals/config',
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.techniques.length, 6);
  for (const t of body.techniques) {
    assert.ok(t.id, '每条技术应有 id');
    assert.ok(t.label, '每条技术应有 label');
    assert.ok(t.level, '每条技术应有 level');
    assert.ok(t.description, '每条技术应有 description');
  }
  assert.equal(body.techniques[0].id, 'boundary_reframe');
  assert.equal(body.techniques[0].level, 'L1');
  assert.equal(body.techniques[5].id, 'authority_override');
  assert.equal(body.techniques[5].level, 'L6');
  assert.ok(body.adaptive, '应有 adaptive 配置块');
  assert.equal(typeof body.adaptive.enabled, 'boolean');
  assert.equal(typeof body.adaptive.defaultRounds, 'number');
  assert.equal(typeof body.adaptive.noProgressK, 'number');
});

test('GET /api/agent-evals/config 反映全局 agent_eval.config 变更（任务 4）', async () => {
  await prisma.systemSetting.upsert({
    where: { key: 'agent_eval.config' },
    update: {
      value: {
        enabled: true,
        adaptiveRounds: 5,
        noProgressK: 7,
        attackerTargetId: '',
        judgeTargetId: '',
      },
    },
    create: {
      key: 'agent_eval.config',
      value: {
        enabled: true,
        adaptiveRounds: 5,
        noProgressK: 7,
        attackerTargetId: '',
        judgeTargetId: '',
      },
    },
  });
  const res = await app.inject({
    method: 'GET',
    url: '/api/agent-evals/config',
    headers: auth(),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.adaptive.enabled, true);
  assert.equal(body.adaptive.defaultRounds, 5);
  assert.equal(body.adaptive.noProgressK, 7);
});
