import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = '__agent_eval_route_';
const MODEL_NAME = `${PREFIX}模型`;

let app!: FastifyInstance;
let token = '';
let modelTargetId = '';

function auth(): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.auditLog.deleteMany({ where: { action: { startsWith: 'agent_eval.' } } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;

  const target = await prisma.modelTarget.create({
    data: {
      name: MODEL_NAME,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-agent-route-test',
      model: 'fake-agent-route-model',
    },
  });
  modelTargetId = target.id;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('POST /api/agent-evals/run requires authentication', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/agent-evals/run',
    payload: { modelTargetId, level: 'smoke', seed: 'route-seed' },
  });
  assert.equal(res.statusCode, 401);
});

test('POST /api/agent-evals/preview rejects invalid level', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/agent-evals/preview',
    headers: auth(),
    payload: { level: 'extreme' },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('POST /api/agent-evals/preview rejects unsupported attack pack ids', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/agent-evals/preview',
    headers: auth(),
    payload: { level: 'smoke', packIds: ['third-party-pack'] },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'INVALID_AGENT_ATTACK_PACK');
});

test('POST /api/agent-evals/run rejects unsupported attack pack ids', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/agent-evals/run',
    headers: auth(),
    payload: { modelTargetId, level: 'smoke', packIds: ['third-party-pack'] },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'INVALID_AGENT_ATTACK_PACK');
});

test('POST /api/agent-evals/run rejects non executable target types', async () => {
  const mcpTarget = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}MCP 工具链对象`,
      targetType: 'MCP_OPENAPI',
      provider: 'mcp',
      baseUrl: 'http://127.0.0.1:18081/mcp',
      apiKey: 'mcp-token',
      model: 'mcp-openapi',
      accessConfig: { schemaUrl: 'http://127.0.0.1:18081/openapi.json' },
    },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/api/agent-evals/run',
    headers: auth(),
    payload: {
      modelTargetId: mcpTarget.id,
      level: 'smoke',
      seed: 'unsupported-target-type',
    },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'AGENT_EVAL_TARGET_UNSUPPORTED');
});

test('POST /api/agent-evals/run rejects gateway log source targets', async () => {
  const gatewayTarget = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}智能体安全网关日志源`,
      targetType: 'GATEWAY_LOG',
      provider: 'newapi-agent-security-gateway',
      baseUrl: 'http://127.0.0.1:18080/admin/v1',
      apiKey: '',
      model: 'gateway-log-source',
      accessConfig: {
        controlPlaneBaseUrl: 'http://127.0.0.1:18080/admin/v1',
        tenantId: 'tenant-a',
      },
    },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/api/agent-evals/run',
    headers: auth(),
    payload: {
      modelTargetId: gatewayTarget.id,
      level: 'smoke',
      seed: 'gateway-target-type',
    },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'AGENT_EVAL_TARGET_UNSUPPORTED');
});

test('POST /api/agent-evals/preview returns generated samples without writing a question set', async () => {
  const beforeCount = await prisma.questionSet.count({ where: { name: { startsWith: PREFIX } } });
  const res = await app.inject({
    method: 'POST',
    url: '/api/agent-evals/preview',
    headers: auth(),
    payload: {
      level: 'smoke',
      seed: 'preview-seed',
      riskSurfaces: ['ssrf'],
      packIds: ['builtin-agent-attacks'],
      maxConcurrency: 6,
      timeoutMs: 120000,
      // 新版按"招式 × 风险面"去重抽样,smoke ∩ ssrf 候选池只有 2 条;minSampleCount=4 会重复抽样到 4
      sampleCount: 4,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.seed, 'preview-seed');
  assert.equal(body.sampleCount, 4);
  assert.equal(body.strength.level, 'smoke');
  assert.deepEqual(body.riskSurfaces, ['ssrf']);
  assert.deepEqual(body.packIds, ['builtin-agent-attacks']);
  assert.equal(body.maxConcurrency, 6);
  assert.equal(body.timeoutMs, 120000);
  assert.equal(body.samples.length, 4);
  assert.equal(body.samples[0].metadata.kind, 'agent_runtime');
  assert.equal(body.samples[0].metadata.attackPackId, 'builtin-agent-attacks');
  assert.equal(body.samples[0].metadata.attackTechnique, 'boundary_reframe');
  assert.equal(body.samples[0].metadata.timeoutMs, 120000);
  const afterCount = await prisma.questionSet.count({ where: { name: { startsWith: PREFIX } } });
  assert.equal(afterCount, beforeCount);
});

test('POST /api/agent-evals/run creates a temporary question set and pending eval task with advanced config', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/agent-evals/run',
    headers: auth(),
    payload: {
      modelTargetId,
      level: 'smoke',
      seed: 'route-run-seed',
      riskSurfaces: ['ssrf'],
      packIds: ['builtin-agent-attacks'],
      maxConcurrency: 7,
      timeoutMs: 180000,
      sampleCount: 4,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.ok(body.taskId);
  assert.equal(body.sampleCount, 4);
  assert.equal(body.seed, 'route-run-seed');
  assert.equal(body.level, 'smoke');
  assert.deepEqual(body.packIds, ['builtin-agent-attacks']);
  assert.equal(body.maxConcurrency, 7);
  assert.equal(body.targetType, 'MODEL');
  assert.equal(body.timeoutMs, 180000);
  // 新版路由会从 agent_eval.config 读自适应配置(默认 enabled=false,不注入 attacker)
  assert.equal(body.adaptive.enabled, false);
  assert.equal(body.adaptive.rounds, 0);

  const task = await prisma.evalTask.findUnique({
    where: { id: body.taskId },
    include: { questionSets: true },
  });
  assert.ok(task);
  assert.equal(task.name.startsWith(PREFIX), true);
  assert.deepEqual(task.engines, ['agent-tool-guard']);
  assert.deepEqual(task.dimensions, ['agent_tool_call']);
  assert.equal(task.concurrency, 7);
  assert.equal(task.totalQuestions, 4);
  assert.equal(task.questionSets.length, 1);
  // 任务描述只写客户能读懂的档位，不带 seed / packIds / 并发 / 超时等参数。
  assert.equal(task.description, '智能体工具安全评估（快速档）');
  assert.doesNotMatch(task.description ?? '', /seed=|packIds=|maxConcurrency=|timeoutMs=/);

  const set = await prisma.questionSet.findUnique({
    where: { id: task.questionSets[0]!.questionSetId },
    include: { _count: { select: { questions: true } } },
  });
  assert.ok(set);
  assert.equal(set.source, `agent-runtime:${body.taskId}`);
  assert.doesNotMatch(set.name, /临时/);
  assert.match(set.name, /运行记录/);
  assert.doesNotMatch(set.description ?? '', /临时/);
  assert.equal(set._count.questions, 4);

  const firstQuestion = await prisma.question.findFirst({ where: { questionSetId: set.id } });
  assert.equal((firstQuestion?.metadata as { kind?: string } | null)?.kind, 'agent_runtime');
  assert.equal(
    (firstQuestion?.metadata as { attackPackId?: string } | null)?.attackPackId,
    'builtin-agent-attacks',
  );
  assert.equal((firstQuestion?.metadata as { timeoutMs?: number } | null)?.timeoutMs, 180000);

  const audit = await prisma.auditLog.findFirst({
    where: { action: 'agent_eval.run', targetId: body.taskId },
  });
  assert.ok(audit);
  assert.deepEqual((audit.detail as { packIds?: string[] }).packIds, ['builtin-agent-attacks']);
  assert.equal((audit.detail as { maxConcurrency?: number }).maxConcurrency, 7);
  assert.equal((audit.detail as { targetType?: string }).targetType, 'MODEL');
  assert.equal((audit.detail as { timeoutMs?: number }).timeoutMs, 180000);
});

test('GET /api/agent-evals/packs returns builtin attack pack metadata', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/agent-evals/packs',
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, 'builtin-agent-attacks');
  assert.match(body.items[0].version, /^builtin-agent-attacks@/);
  assert.ok(body.items[0].templateCount >= 8);
  assert.ok(body.items[0].sourceRefs.includes('builtin'));
});

test('任务2: POST /api/agent-evals/run 带 techniques 时过滤生成的样本', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/agent-evals/run',
    headers: auth(),
    payload: {
      modelTargetId,
      level: 'smoke',
      seed: 'task2-techniques',
      techniques: ['boundary_reframe', 'authority_override'],
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  // 跑 smoke 级别,过滤后样本数应 <= 全量 smoke
  assert.ok(body.sampleCount > 0, '过滤后应有样本');
  // 校验数据库里的 question metadata.attackTechnique 都在白名单内
  const questions = await prisma.question.findMany({
    where: { questionSet: { name: { contains: body.taskId.slice(0, 8) } } },
  });
  const used = new Set(questions.map((q) => (q.metadata as any)?.attackTechnique).filter(Boolean));
  for (const t of used) {
    assert.ok(
      ['boundary_reframe', 'authority_override'].includes(t as string),
      `technique ${t} 不在勾选白名单`,
    );
  }
});

test('任务2: POST /api/agent-evals/run 带 adaptiveOverride 覆盖全局关闭状态', async () => {
  // 确保全局 agent_eval.enabled = false
  await prisma.systemSetting.deleteMany({ where: { key: 'agent_eval.config' } });

  // 创建 attacker target
  const atk = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}attacker`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-task2-attacker',
      model: 'fake-attacker',
    },
  });

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent-evals/run',
      headers: auth(),
      payload: {
        modelTargetId,
        level: 'smoke',
        seed: 'task2-override',
        adaptiveOverride: {
          enabled: true,
          rounds: 5,
          attackerTargetId: atk.id,
        },
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(body.adaptive.enabled, true, 'override 应启用自适应');
    assert.equal(body.adaptive.rounds, 5, 'override 轮数应为 5');
  } finally {
    await prisma.modelTarget.deleteMany({ where: { id: atk.id } });
  }
});

test('POST /api/agent-evals/preview agenticScenarios=true 追加四类沙箱场景并标注五维度', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/agent-evals/preview',
    headers: auth(),
    payload: { level: 'smoke', seed: 'agentic-preview', agenticScenarios: true },
  });
  assert.equal(res.statusCode, 200, res.body);
  const samples = res.json().samples as Array<{
    metadata: { sandboxScenario?: string; agenticDimension?: string };
  }>;
  const agentic = samples.filter((s) => s.metadata.sandboxScenario);
  assert.equal(agentic.length, 4);
  assert.deepEqual(agentic.map((s) => s.metadata.agenticDimension).sort(), [
    'cascading_failure',
    'goal_hijack',
    'memory_poisoning',
    'privilege_abuse',
  ]);
});
