import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const prefix = '__platform_v2_canary_';
const KB = 'LSE-CANARY-KB-target01';
const SYS = 'LSE-CANARY-SYS-target01';
const BASE = 'http://127.0.0.1:9/v1';
let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
let withCanary = '';
let withoutCanary = '';
const prev = process.env.LSE_PLATFORM_APP_ENABLED;

async function cleanup() {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.questionSet.deleteMany({ where: { name: { contains: prefix } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: prefix } } });
}
before(async () => {
  process.env.LSE_PLATFORM_APP_ENABLED = 'true';
  await cleanup();
  withCanary = (await prisma.modelTarget.create({ data: { name: `${prefix}有暗号`, targetType: 'PLATFORM_APP', provider: 'dify', baseUrl: BASE, apiKey: 'app-local-secret', model: 'platform-app',
    accessConfig: { platform: 'dify', baseUrl: BASE, appMode: 'agent-chat', knowledgeCanary: KB, systemCanary: SYS } } })).id;
  withoutCanary = (await prisma.modelTarget.create({ data: { name: `${prefix}无暗号`, targetType: 'PLATFORM_APP', provider: 'dify', baseUrl: BASE, apiKey: 'app-local-secret', model: 'platform-app',
    accessConfig: { platform: 'dify', baseUrl: BASE, appMode: 'agent-chat' } } })).id;
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
  // 改名后由 cleanup 统一清理。
  await prisma.evalTask.update({ where: { id: taskId }, data: { name: `${prefix}任务${taskId.slice(0, 6)}` } });
  return task.questionSets.flatMap(s => s.questionSet.questions);
}
const kbOf = (items: any[]) => items.find(q => q.metadata?.templateId === 'knowledge_access');

test('保存评估对象时 knowledgeCanary 和 systemCanary 不会丢失，格式错误会被拒绝', async () => {
  const stored = await prisma.modelTarget.findUniqueOrThrow({ where: { id: withCanary } });
  assert.equal((stored.accessConfig as any).knowledgeCanary, KB);
  const patch = await app.inject({ method: 'PATCH', url: `/api/model-targets/${withCanary}`, headers: headers(),
    payload: { accessConfig: { platform: 'dify', baseUrl: BASE, appMode: 'agent-chat', knowledgeCanary: 'LSE-CANARY-KB-edited', systemCanary: SYS } } });
  assert.equal(patch.statusCode, 200, patch.body);
  const edited = await prisma.modelTarget.findUniqueOrThrow({ where: { id: withCanary } });
  assert.equal((edited.accessConfig as any).knowledgeCanary, 'LSE-CANARY-KB-edited');
  assert.equal((edited.accessConfig as any).systemCanary, SYS);
  const bad = await app.inject({ method: 'PATCH', url: `/api/model-targets/${withCanary}`, headers: headers(),
    payload: { accessConfig: { platform: 'dify', baseUrl: BASE, knowledgeCanary: '不是暗号格式' } } });
  assert.ok(bad.statusCode >= 400 && bad.statusCode < 500, bad.body);
  await prisma.modelTarget.update({ where: { id: withCanary }, data: { accessConfig: { platform: 'dify', baseUrl: BASE, appMode: 'agent-chat', knowledgeCanary: KB, systemCanary: SYS } } });
});

test('run：请求体没给暗号时用评估对象配置补齐，知识库和系统提示词场景都带上', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/agent-evals/run', headers: headers(), payload: { modelTargetId: withCanary, packIds: ['platform-app-v1'], sampleCount: 5, seed: 'target-canary', adaptiveOverride: { enabled: false } } });
  assert.equal(res.statusCode, 201, res.body);
  const questions = await questionsOf(res.json().taskId);
  const kb = kbOf(questions)!;
  assert.equal((kb.metadata as any).safeCanary, KB);
  assert.deepEqual((kb.metadata as any).canaries, [KB]);
  assert.equal((kb.metadata as any).knowledgeCanaryMissing, undefined);
  const sys = questions.find(q => (q.metadata as any).templateId === 'orchestration_leakage')!;
  assert.deepEqual((sys.metadata as any).canaries, [SYS]);
});

test('run：请求体里显式给的暗号优先于评估对象配置', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/agent-evals/run', headers: headers(), payload: { modelTargetId: withCanary, packIds: ['platform-app-v1'], sampleCount: 5, seed: 'override',
    platformPackConfig: { knowledgeCanary: 'LSE-CANARY-KB-fromrequest' }, adaptiveOverride: { enabled: false } } });
  assert.equal(res.statusCode, 201, res.body);
  const questions = await questionsOf(res.json().taskId);
  assert.equal((kbOf(questions)!.metadata as any).safeCanary, 'LSE-CANARY-KB-fromrequest');
  const sys = questions.find(q => (q.metadata as any).templateId === 'orchestration_leakage')!;
  assert.deepEqual((sys.metadata as any).canaries, [SYS], '没显式给的字段仍用评估对象里的值');
});

test('run：评估对象和请求都没有知识库暗号，知识库场景标记未配置', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/agent-evals/run', headers: headers(), payload: { modelTargetId: withoutCanary, packIds: ['platform-app-v1'], sampleCount: 5, seed: 'none', adaptiveOverride: { enabled: false } } });
  assert.equal(res.statusCode, 201, res.body);
  const questions = await questionsOf(res.json().taskId);
  const kb = kbOf(questions)!;
  assert.equal((kb.metadata as any).knowledgeCanaryMissing, true);
  assert.deepEqual((kb.metadata as any).canaries, []);
  assert.match(JSON.stringify((kb.metadata as any).prerequisites), /知识库蜜罐文档的暗号未配置，本场景未检查/);
});

test('preview：带评估对象编号时同样用其配置补齐；不带则不补；显式值优先', async () => {
  const withTarget = await app.inject({ method: 'POST', url: '/api/agent-evals/preview', headers: headers(), payload: { modelTargetId: withCanary, packIds: ['platform-app-v1'], sampleCount: 5, seed: 'p1' } });
  assert.equal(withTarget.statusCode, 200, withTarget.body);
  assert.equal(kbOf(withTarget.json().samples)!.metadata.safeCanary, KB);
  const without = await app.inject({ method: 'POST', url: '/api/agent-evals/preview', headers: headers(), payload: { packIds: ['platform-app-v1'], sampleCount: 5, seed: 'p2' } });
  assert.equal(without.statusCode, 200, without.body);
  assert.equal(kbOf(without.json().samples)!.metadata.knowledgeCanaryMissing, true);
  const explicit = await app.inject({ method: 'POST', url: '/api/agent-evals/preview', headers: headers(), payload: { modelTargetId: withCanary, packIds: ['platform-app-v1'], sampleCount: 5, seed: 'p3', platformPackConfig: { knowledgeCanary: 'LSE-CANARY-KB-explicit' } } });
  assert.equal(kbOf(explicit.json().samples)!.metadata.safeCanary, 'LSE-CANARY-KB-explicit');
});
