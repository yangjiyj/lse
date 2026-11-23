import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const TARGET_NAME = '__rs_被测对象__';
let app!: FastifyInstance;
let token = '';
let targetId = '';
let taskId = '';

function auth() {
  return { authorization: `Bearer ${token}` };
}

async function riskCount(): Promise<number> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/eval-tasks/risk-summary',
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().agentRiskCount as number;
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await prisma.modelTarget.deleteMany({ where: { name: TARGET_NAME } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
  const target = await prisma.modelTarget.create({
    data: {
      name: TARGET_NAME,
      targetType: 'MODEL',
      provider: 'openai-compatible',
      baseUrl: 'https://api.invalid/v1',
      apiKey: 'sk-x',
      model: 'm',
    },
  });
  targetId = target.id;
  const task = await prisma.evalTask.create({
    data: { name: '__rs_task__', modelTargetId: targetId, status: 'COMPLETED' },
  });
  taskId = task.id;
});

after(async () => {
  await prisma.finding.deleteMany({ where: { taskId } }).catch(() => undefined);
  await prisma.evalTask.deleteMany({ where: { id: taskId } }).catch(() => undefined);
  await prisma.modelTarget.deleteMany({ where: { name: TARGET_NAME } }).catch(() => undefined);
  await app.close();
  await prisma.$disconnect();
});

test('GET /risk-summary 只计入智能体风险类别/引擎的 finding', async () => {
  const before0 = await riskCount();
  // 一条智能体风险类别 + 一条普通内容风险
  await prisma.finding.createMany({
    data: [
      {
        taskId,
        engine: 'rule-judge',
        riskCategory: 'agent_tool_abuse',
        severity: 'HIGH',
        verdict: 'FAIL',
        title: '工具越权',
        score: null,
        evidence: null,
        detail: {},
      },
      {
        taskId,
        engine: 'rule-judge',
        riskCategory: 'forbidden_content',
        severity: 'HIGH',
        verdict: 'FAIL',
        title: '禁止内容',
        score: null,
        evidence: null,
        detail: {},
      },
    ],
  });
  assert.equal((await riskCount()) - before0, 1, '仅 agent_tool_abuse 计入智能体风险');

  // 一条网关引擎 finding（按 engine 兜底也算智能体风险）
  await prisma.finding.create({
    data: {
      taskId,
      engine: 'newapi-agent-security-gateway',
      riskCategory: 'gateway_policy_event',
      severity: 'HIGH',
      verdict: 'FAIL',
      title: '网关命中',
      score: null,
      evidence: null,
      detail: {},
    },
  });
  assert.equal((await riskCount()) - before0, 2, '网关引擎 finding 按 engine 计入');
});
