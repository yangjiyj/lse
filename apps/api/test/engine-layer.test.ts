import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type {
  ChatMessage,
  EngineResult,
  JudgeInput,
  LlmCallResult,
  LlmTargetConfig,
} from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { runEvalTask } from '../src/modules/eval-tasks/executor.js';
import { builtinPerQuestionEngines } from '../src/modules/engines/builtin.js';
import type { PerQuestionEngine, TaskLevelEngine } from '../src/modules/engines/types.js';

// 引擎层依赖注入（DI）冒烟：锁定 executor 接入 registry 后的三个接缝——
//  1) 额外单题引擎可叠加，且内置引擎照常 SUCCESS；
//  2) 单题引擎抛错被 safeJudge 兜底为 SKIPPED，不连累内置引擎/任务；
//  3) 任务级引擎产出独立的任务级 EngineRun + 任务级风险项（resultId/questionId 均为 null）。
// 约束对齐 judge-pipeline.test.ts：内置 rule-judge / sensitive-info 永远各落一条 SUCCESS EngineRun。

const PREFIX = 'M6ENG-';
const MODEL_NAME = `${PREFIX}引擎层模型`;
const SET_NAME = `${PREFIX}引擎层问题集`;

let app!: FastifyInstance;
let token = '';
let modelTargetId = '';
let questionSetId = '';

function auth(): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** 良性模型：永远 SUCCESS，回答普通、安全、合规，不含拒答词/禁止词/敏感凭据/PII。绝不发真实网络请求。 */
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

/** 构造单题引擎结果，默认 PASS，over 覆盖。 */
function mkResult(
  over: Partial<EngineResult> & Pick<EngineResult, 'engine' | 'taskId'>,
): EngineResult {
  const now = new Date().toISOString();
  return {
    questionId: null,
    status: 'success',
    riskCategory: 'ok',
    severity: 'INFO',
    score: 1,
    verdict: 'PASS',
    evidence: null,
    rawOutput: null,
    startedAt: now,
    endedAt: now,
    ...over,
  };
}

// —— 注入用伪引擎 ——

/** 单题引擎：恒判 FAIL(HIGH)。验证额外引擎会新增 SUCCESS EngineRun + 单题风险项/样本。 */
const failPqEngine: PerQuestionEngine = {
  engine: 'fake-pq-fail',
  judge: (input: JudgeInput) =>
    Promise.resolve(
      mkResult({
        engine: 'fake-pq-fail',
        taskId: input.taskId,
        questionId: input.questionId,
        riskCategory: 'fake_pq_risk',
        severity: 'HIGH',
        score: 0,
        verdict: 'FAIL',
        evidence: '注入的失败裁决',
        rawOutput: { foo: 'bar' },
      }),
    ),
};

/** 单题引擎：judge 抛错。验证 safeJudge 兜底为 skipped（EngineRun=SKIPPED），不连累内置引擎/任务。 */
const throwingPqEngine: PerQuestionEngine = {
  engine: 'fake-pq-throw',
  judge: async (_input: JudgeInput): Promise<EngineResult> => {
    throw new Error('boom-pq');
  },
};

/** 任务级引擎：SUCCESS + 2 个结果(1 FAIL/1 PASS)。验证任务级 EngineRun + 任务级风险项(resultId/questionId 均 null)。 */
const fakeTaskEngine: TaskLevelEngine = {
  engine: 'fake-task',
  scan: (ctx) => {
    const now = new Date().toISOString();
    const results: EngineResult[] = [
      mkResult({
        engine: 'fake-task',
        taskId: ctx.taskId,
        riskCategory: 'fake_task_risk',
        severity: 'CRITICAL',
        score: 0,
        verdict: 'FAIL',
        evidence: '任务级注入失败项',
        rawOutput: { a: 1 },
      }),
      mkResult({
        engine: 'fake-task',
        taskId: ctx.taskId,
        riskCategory: 'fake_task_ok',
        verdict: 'PASS',
      }),
    ];
    return Promise.resolve({
      engine: 'fake-task',
      taskId: ctx.taskId,
      status: 'SUCCESS' as const,
      startedAt: now,
      endedAt: now,
      durationMs: 5,
      rawOutput: { summary: 'ok' },
      results,
    });
  },
};

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

/** 用同一模型对象 + 问题集，新建一个任务并返回 taskId。 */
async function createTask(name: string): Promise<string> {
  const task = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: auth(),
    payload: { name: `${PREFIX}${name}`, modelTargetId, questionSetIds: [questionSetId] },
  });
  assert.equal(task.statusCode, 201, task.body);
  return task.json().id as string;
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
      apiKey: 'sk-secret-enginelayer-1234567890',
      model: 'fake-eval-model',
    },
  });
  assert.equal(mt.statusCode, 201, mt.body);
  modelTargetId = mt.json().id;

  // 单道良性通用题：内置 rule-judge(UNKNOWN/success) + sensitive-info(PASS) 均不报错，便于隔离验证注入引擎。
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

test('DI-额外单题引擎：内置引擎照常 SUCCESS，额外引擎新增一条 SUCCESS EngineRun，并落单题风险项/样本', async () => {
  const taskId = await createTask('额外单题引擎任务');
  await runEvalTask(taskId, {
    callModel: benignModel(),
    perQuestionEngines: [...builtinPerQuestionEngines, failPqEngine],
  });

  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } });
  assert.equal(task.status, 'COMPLETED');
  assert.equal(task.totalQuestions, 1);
  assert.equal(task.processedQuestions, 1);
  assert.equal(task.passedCount, 0);
  assert.equal(task.failedCount, 1);
  assert.equal(task.errorCount, 0);

  const runs = await prisma.engineRun.findMany({ where: { taskId } });
  assert.equal(runs.length, 3, '内置 2 + 注入 1 = 3 条 EngineRun');
  assert.deepEqual(runs.map((r) => r.engine).sort(), [
    'fake-pq-fail',
    'rule-judge',
    'sensitive-info',
  ]);
  for (const run of runs) assert.equal(run.status, 'SUCCESS', `${run.engine} 应为 SUCCESS`);
  const fakeRun = runs.find((r) => r.engine === 'fake-pq-fail')!;
  assert.equal(fakeRun.normalizedCount, 1);

  // 单题风险项：resultId / questionId 均应非空（区别于任务级）
  const findings = await prisma.finding.findMany({ where: { taskId } });
  assert.equal(findings.length, 1, '仅注入引擎判 FAIL → 1 条风险项');
  const f = findings[0]!;
  assert.equal(f.engine, 'fake-pq-fail');
  assert.equal(f.riskCategory, 'fake_pq_risk');
  assert.equal(f.severity, 'HIGH');
  assert.notEqual(f.resultId, null, '单题风险项 resultId 应非空');
  assert.notEqual(f.questionId, null, '单题风险项 questionId 应非空');

  const wrong = await prisma.wrongAnswer.findMany({ where: { taskId } });
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0]!.engine, 'fake-pq-fail');
  assert.equal(wrong[0]!.severity, 'HIGH');
});

test('DI-抛错单题引擎：safeJudge 兜底为 SKIPPED，内置引擎仍 SUCCESS，任务不失败', async () => {
  const taskId = await createTask('抛错单题引擎任务');
  await runEvalTask(taskId, {
    callModel: benignModel(),
    perQuestionEngines: [...builtinPerQuestionEngines, throwingPqEngine],
  });

  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } });
  assert.equal(task.status, 'COMPLETED', '抛错引擎不应使任务失败');
  assert.equal(task.processedQuestions, 1);
  assert.equal(task.passedCount, 0, '无充分规则的回答保持未知，DLP 未命中不能证明通过');
  assert.equal(task.failedCount, 0);
  assert.equal(task.errorCount, 0);

  const runs = await prisma.engineRun.findMany({ where: { taskId } });
  assert.equal(runs.length, 3);
  const thrown = runs.find((r) => r.engine === 'fake-pq-throw')!;
  assert.equal(thrown.status, 'SKIPPED', '抛错引擎应为 SKIPPED');
  assert.equal(thrown.normalizedCount, 0);
  assert.ok(
    thrown.errorMessage &&
      thrown.errorMessage.includes('引擎异常') &&
      thrown.errorMessage.includes('boom-pq'),
    `SKIPPED 行应记录异常信息，实际：${thrown.errorMessage}`,
  );
  for (const r of runs.filter((x) => x.engine !== 'fake-pq-throw')) {
    assert.equal(r.status, 'SUCCESS', `${r.engine} 应为 SUCCESS`);
  }

  assert.equal(
    (await prisma.finding.findMany({ where: { taskId } })).length,
    0,
    '无 FAIL → 无风险项',
  );
  assert.equal(
    (await prisma.wrongAnswer.findMany({ where: { taskId } })).length,
    0,
    '无 FAIL → 无样本',
  );
});

test('DI-AI 复核引擎：没有需要复核的题时记 SUCCESS，不当作跳过', async () => {
  const taskId = await createTask('AI复核无需复核任务');
  let reviewCalls = 0;
  const passEngine: PerQuestionEngine = {
    engine: 'fake-pq-pass',
    judge: (input: JudgeInput) =>
      Promise.resolve(mkResult({ engine: 'fake-pq-pass', taskId: input.taskId, questionId: input.questionId })),
  };
  const reviewEngine: PerQuestionEngine = {
    engine: 'llm-judge',
    judge: (input: JudgeInput) => {
      reviewCalls += 1;
      return Promise.resolve(mkResult({ engine: 'llm-judge', taskId: input.taskId, questionId: input.questionId }));
    },
  };
  await runEvalTask(taskId, {
    callModel: benignModel(),
    perQuestionEngines: [passEngine, reviewEngine],
    judgeTarget: null,
  });

  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } });
  assert.equal(task.status, 'COMPLETED');
  assert.equal(task.passedCount, 1);
  assert.equal(reviewCalls, 0, '初判通过且无高风险，不应触发 AI 复核');
  const review = await prisma.engineRun.findFirstOrThrow({ where: { taskId, engine: 'llm-judge' } });
  assert.equal(review.status, 'SUCCESS', '复核引擎可用但没有需要复核的题，不是覆盖缺口');
  assert.equal(review.normalizedCount, 0);
});

test('DI-任务级引擎：新增任务级 EngineRun(SUCCESS) + 任务级风险项(resultId/questionId 均为 null)', async () => {
  const taskId = await createTask('任务级引擎任务');
  // perQuestionEngines 留空 → 走默认 resolver（LSE_TEST=1 下仅内置）；仅覆盖 taskLevelEngines。
  // judgeTarget:null 显式声明「无评审目标」，避免执行器查询到 DB 里激活的全局 JUDGE 而多落一条 llm-judge。
  await runEvalTask(taskId, {
    callModel: benignModel(),
    taskLevelEngines: [fakeTaskEngine],
    judgeTarget: null,
  });

  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } });
  assert.equal(task.status, 'COMPLETED');
  assert.equal(task.passedCount, 0, '任务级扫描不替代回答的内容判定');

  const runs = await prisma.engineRun.findMany({ where: { taskId } });
  assert.equal(runs.length, 3, '内置 2 单题 + 1 任务级 = 3');
  assert.deepEqual(runs.map((r) => r.engine).sort(), ['fake-task', 'rule-judge', 'sensitive-info']);
  const taskRun = runs.find((r) => r.engine === 'fake-task')!;
  assert.equal(taskRun.status, 'SUCCESS');
  assert.equal(taskRun.normalizedCount, 2, '任务级引擎返回 2 条结果');
  assert.equal(taskRun.resultId, null, '任务级 EngineRun 不挂单题结果');

  // 任务级风险项：仅 FAIL 项落库，resultId / questionId 均为 null
  const findings = await prisma.finding.findMany({ where: { taskId } });
  assert.equal(findings.length, 1, '仅任务级 FAIL 项落库（内置判 PASS 无风险项）');
  const f = findings[0]!;
  assert.equal(f.engine, 'fake-task');
  assert.equal(f.riskCategory, 'fake_task_risk');
  assert.equal(f.severity, 'CRITICAL');
  assert.equal(f.resultId, null, '任务级风险项 resultId 应为 null');
  assert.equal(f.questionId, null, '任务级风险项 questionId 应为 null');
});
