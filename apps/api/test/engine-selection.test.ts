import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { ChatMessage, LlmCallResult, LlmTargetConfig } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { runEvalTask } from '../src/modules/eval-tasks/executor.js';

// M10 自定义评估：EvalTask.engines[] 必须真正控制执行 + GET /api/engines 引擎目录。
//  1) engines:['rule-judge'] + judgeTarget:null → 仅 rule-judge 落一条 EngineRun（sensitive-info 被排除）；
//  2) engines:[] → 内置两条全跑（向后兼容，锁定既有语义）；
//  3) engines 仅选任务级引擎 → 单题引擎保底回退到内置（绝不出现 0 个单题判定）；
//  4) GET /api/engines 返回 8 个已知引擎 + 中文 label/kind/builtin/available。

const PREFIX = 'M10SEL-';
const MODEL_NAME = `${PREFIX}选择模型`;
const SET_NAME = `${PREFIX}选择问题集`;

let app!: FastifyInstance;
let token = '';
let modelTargetId = '';
let questionSetId = '';

function auth(): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function benignModel() {
  return async (_cfg: LlmTargetConfig, _messages: ChatMessage[]): Promise<LlmCallResult> => ({
    status: 'SUCCESS',
    content: '这是一段普通、安全、合规的回答，不包含任何敏感信息。',
    finishReason: 'stop',
    model: 'fake-model',
    usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
    latencyMs: 1,
    httpStatus: 200,
    error: null,
    raw: null,
  });
}

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

async function createTask(name: string, engines: string[]): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: auth(),
    payload: {
      name: `${PREFIX}${name}`,
      modelTargetId,
      questionSetIds: [questionSetId],
      engines,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
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

  const mt = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: MODEL_NAME,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-secret-engineselect-1234567890',
      model: 'fake-eval-model',
    },
  });
  assert.equal(mt.statusCode, 201, mt.body);
  modelTargetId = mt.json().id;

  const set = await prisma.questionSet.create({
    data: {
      name: SET_NAME,
      type: 'GENERAL',
      source: 'test',
      questions: {
        create: [{ content: `${PREFIX}通用良性问题：今天天气怎么样？`, type: 'GENERAL' }],
      },
    },
  });
  questionSetId = set.id;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('engines:[rule-judge] + 无全局 JUDGE → 仅 rule-judge 落一条 EngineRun（排除 sensitive-info）', async () => {
  const taskId = await createTask('仅规则引擎', ['rule-judge']);
  // 这里锁定任务级 engines 对内置引擎的选择语义；全局 JUDGE 自动复核由 executor-judge-wiring 覆盖。
  await runEvalTask(taskId, { callModel: benignModel(), judgeTarget: null });

  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } });
  assert.equal(task.status, 'COMPLETED');
  assert.equal(task.processedQuestions, 1);

  const runs = await prisma.engineRun.findMany({ where: { taskId } });
  assert.deepEqual(
    runs.map((r) => r.engine).sort(),
    ['rule-judge'],
    'engines 选了 rule-judge → 只应有 rule-judge 一条 EngineRun',
  );
});

test('engines:[] → 内置两条全跑（向后兼容）', async () => {
  const taskId = await createTask('默认全部', []);
  // judgeTarget: null → 不依赖线上激活的全局 JUDGE，断言只关注内置引擎。
  await runEvalTask(taskId, { callModel: benignModel(), judgeTarget: null });

  const runs = await prisma.engineRun.findMany({ where: { taskId } });
  assert.deepEqual(
    runs.map((r) => r.engine).sort(),
    ['rule-judge', 'sensitive-info'],
    'engines 为空 → 维持内置两引擎全跑',
  );
});

test('engines:[agent-tool-guard] + 无全局 JUDGE → 仅 Agent 工具守卫落一条 EngineRun', async () => {
  const taskId = await createTask('仅Agent工具守卫', ['agent-tool-guard']);
  await runEvalTask(taskId, { callModel: benignModel(), judgeTarget: null });

  const runs = await prisma.engineRun.findMany({ where: { taskId } });
  assert.deepEqual(
    runs.map((r) => r.engine).sort(),
    ['agent-tool-guard'],
    '显式选择 agent-tool-guard → 只应有 Agent 工具守卫一条 EngineRun',
  );
});

test('engines 仅选任务级引擎 → 单题保底回退内置 + 不可用任务级引擎显式落 SKIPPED（绝不静默 0 扫描）', async () => {
  const taskId = await createTask('仅任务级选择', ['garak']);
  // judgeTarget: null → 不依赖线上激活的全局 JUDGE，断言只关注内置兜底引擎 + 显式 SKIPPED 行。
  await runEvalTask(taskId, { callModel: benignModel(), judgeTarget: null });

  const runs = await prisma.engineRun.findMany({ where: { taskId } });
  // LSE_TEST=1 下任务级外部引擎被门控关闭：单题保底回退内置两条，且被勾选但不可用的
  // garak 显式落一条 SKIPPED，杜绝静默 0 扫描被误读为「无风险」。
  assert.deepEqual(
    runs.map((r) => r.engine).sort(),
    ['garak', 'rule-judge', 'sensitive-info'],
    '单题保底回退内置；不可用任务级引擎显式落 SKIPPED',
  );
  const garak = runs.find((r) => r.engine === 'garak');
  assert.ok(garak, '应存在 garak 的 EngineRun 行');
  assert.equal(garak!.status, 'SKIPPED', '不可用任务级引擎应落 SKIPPED 而非静默缺失');
  assert.equal(garak!.normalizedCount, 0);
  assert.ok(garak!.errorMessage && garak!.errorMessage.length > 0, '应写明跳过原因');
});

test('注入 deps.taskLevelEngines → 休眠引擎由注入方决定，执行器不再补落 SKIPPED', async () => {
  // 锁定 DI 守卫契约：dormantTaskLevelEngines = deps.taskLevelEngines ? [] : resolve(...)。
  // 一旦调用方显式注入任务级引擎集（这里注入空集，模拟「我自己管任务级引擎」），
  // 执行器不得再根据 task.engines 自行解析休眠引擎、补落 SKIPPED —— 避免与注入方重复落账。
  const taskId = await createTask('注入任务级引擎覆盖休眠', ['garak']);
  await runEvalTask(taskId, {
    callModel: benignModel(),
    judgeTarget: null,
    taskLevelEngines: [],
  });

  const runs = await prisma.engineRun.findMany({ where: { taskId } });
  assert.deepEqual(
    runs.map((r) => r.engine).sort(),
    ['rule-judge', 'sensitive-info'],
    '注入 deps.taskLevelEngines 时，执行器只跑单题保底回退，绝不自行补落休眠 SKIPPED',
  );
  assert.ok(
    !runs.some((r) => r.engine === 'garak'),
    'DI 注入任务级引擎集后不应出现执行器自行补落的 garak SKIPPED 行',
  );
});

test('MCP_OPENAPI 对象 + engines:[] → agent-tool-guard 随内置两引擎默认落 EngineRun', async () => {
  // 不联网即可验证默认接线：MCP_OPENAPI 适配器同步返回「未实现」错误，所有问题判定=0，
  // 但 perQuestionEngines 仍逐一落 EngineRun，故 agent-tool-guard 是否默认启用可被直接观测。
  const mt = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: `${PREFIX}MCP默认守卫对象`,
      targetType: 'MCP_OPENAPI',
      provider: 'mcp-openapi',
      model: 'mcp-openapi',
      accessConfig: { schemaUrl: 'https://agent.example.com/openapi.json' },
    },
  });
  assert.equal(mt.statusCode, 201, mt.body);
  const mcpTargetId = mt.json().id as string;

  const res = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: auth(),
    payload: {
      name: `${PREFIX}MCP默认守卫`,
      modelTargetId: mcpTargetId,
      questionSetIds: [questionSetId],
      engines: [],
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const taskId = res.json().id as string;

  // judgeTarget: null → 隔离全局 JUDGE，断言只观测「Agent 类对象默认接入 agent-tool-guard」。
  await runEvalTask(taskId, { callModel: benignModel(), judgeTarget: null });

  const runs = await prisma.engineRun.findMany({ where: { taskId } });
  assert.deepEqual(
    runs.map((r) => r.engine).sort(),
    ['agent-tool-guard', 'rule-judge', 'sensitive-info'],
    'MCP_OPENAPI 等 Agent 类对象在 engines:[] 时应默认启用 agent-tool-guard（无需显式勾选）',
  );
});

test('GET /api/engines 返回引擎目录（8 个现役引擎 + 元数据）', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/engines', headers: auth() });
  assert.equal(res.statusCode, 200, res.body);
  const list = res.json() as Array<{
    engine: string;
    kind: string;
    builtin: boolean;
    available: boolean;
    label: string;
  }>;
  assert.deepEqual(list.map((e) => e.engine).sort(), [
    'agent-llm-judge',
    'agent-tool-guard',
    'garak',
    'llm-judge',
    'pyrit',
    'python-judge',
    'rule-judge',
    'sensitive-info',
  ]);

  const rj = list.find((e) => e.engine === 'rule-judge')!;
  assert.equal(rj.kind, 'per-question');
  assert.equal(rj.builtin, true);
  assert.equal(rj.available, true, '内置引擎恒可用');
  assert.ok(rj.label && rj.label.length > 0, '应有中文 label');

  const agent = list.find((e) => e.engine === 'agent-tool-guard')!;
  assert.equal(agent.kind, 'per-question');
  assert.equal(agent.builtin, true);
  assert.equal(agent.available, true, '内置可选引擎恒可用');
  assert.ok(agent.label && agent.label.length > 0, '应有中文 label');

  assert.equal(
    list.some((e) => e.engine === 'ai-infra-guard'),
    false,
    '已退役 AIG 不再进入目录',
  );

  const garak = list.find((e) => e.engine === 'garak')!;
  assert.equal(garak.kind, 'task-level');
  assert.equal(garak.builtin, false);
  assert.equal(garak.available, false, 'LSE_TEST 下外部引擎不可用');
  assert.ok(garak.label && garak.label.length > 0, '应有中文 label');

  const pyrit = list.find((e) => e.engine === 'pyrit')!;
  assert.equal(pyrit.kind, 'task-level');
  assert.equal(pyrit.builtin, false);
  assert.equal(pyrit.available, false, 'LSE_TEST 下外部引擎不可用');
  assert.ok(pyrit.label && pyrit.label.length > 0, '应有中文 label');

  const llmJudge = list.find((e) => e.engine === 'llm-judge')!;
  assert.equal(llmJudge.kind, 'per-question');
  assert.equal(llmJudge.builtin, false);
  // available 取决于是否配置了激活的裁判模型(JUDGE)，不再纯由 env 决定；
  // 可用性判定的确定性用例见 engine-catalog-route.test.ts。
  assert.equal(typeof llmJudge.available, 'boolean');
  assert.ok(llmJudge.label && llmJudge.label.length > 0, '应有中文 label');
});
