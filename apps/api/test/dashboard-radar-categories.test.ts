import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

// 2.2.3 风险类别雷达图取风险类别接口的前 6 类：接口须按数量从多到少排好，limit 取的就是最多的几类。
const PREFIX = `__dash_radar_${randomUUID().slice(0, 8)}_`;
let app!: FastifyInstance;
let token = '';
let modelId = '';
let taskId = '';

type Categories = { items: Array<{ key: string; count: number }> };

async function categories(limit: number): Promise<Categories> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/dashboard/risk-categories?range=all&limit=${limit}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
  modelId = (
    await prisma.modelTarget.create({
      data: {
        name: `${PREFIX}model`,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'test-placeholder',
        model: 'test',
      },
    })
  ).id;
  taskId = (
    await prisma.evalTask.create({ data: { name: `${PREFIX}task`, modelTargetId: modelId } })
  ).id;
  // 7 个类别，条数各不相同，保证至少有 7 类可排。
  const plan: Array<[string, number]> = [
    ['agent_tool_abuse', 7],
    ['prompt_injection', 6],
    ['privacy_leakage', 5],
    ['data_exfiltration', 4],
    ['cyber_abuse', 3],
    ['legal_compliance', 2],
    ['model_theft', 1],
  ];
  await prisma.finding.createMany({
    data: plan.flatMap(([riskCategory, n]) =>
      Array.from({ length: n }, (_, i) => ({
        taskId,
        engine: 'rule-judge',
        riskCategory,
        title: `${PREFIX}${riskCategory}-${i}`,
        severity: 'MEDIUM' as const,
        verdict: 'FAIL' as const,
      })),
    ),
  });
});

after(async () => {
  if (taskId) {
    await prisma.finding.deleteMany({ where: { taskId } });
    await prisma.evalTask.delete({ where: { id: taskId } });
  }
  if (modelId) await prisma.modelTarget.delete({ where: { id: modelId } });
  await app.close();
  await prisma.$disconnect();
});

test('风险类别按数量从多到少排列，limit=6 正好是最多的 6 类', async () => {
  const all = await categories(20);
  assert.ok(all.items.length >= 7, `至少应有 7 类，实际 ${all.items.length}`);
  for (let i = 1; i < all.items.length; i++) {
    assert.ok(all.items[i - 1]!.count >= all.items[i]!.count, '应按数量从多到少排列');
  }
  const top6 = await categories(6);
  assert.deepEqual(
    top6.items.map((it) => it.key),
    all.items.slice(0, 6).map((it) => it.key),
  );
});
