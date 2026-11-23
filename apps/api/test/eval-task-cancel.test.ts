import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { evalTaskCancelKey, EVAL_TASK_CANCEL_TTL_SECONDS } from '../src/lib/queue.js';
import { runEvalTask, type PrismaLike } from '../src/modules/eval-tasks/executor.js';

const PREFIX = '__cancel_';

async function login(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token;
}

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

test('eval task cancel signal uses the shared Valkey key namespace and TTL', () => {
  const id = randomUUID();
  assert.equal(evalTaskCancelKey(id), `evaltask:cancel:${id}`);
  assert.equal(EVAL_TASK_CANCEL_TTL_SECONDS, 3600);
});

test('POST /eval-tasks/:id/cancel marks running task canceling and sets cancel signal', async () => {
  const setCalls: Array<{ key: string; value: string; mode: string; ttl: number }> = [];
  const app = await buildApp({
    cancelEvalTask: async (taskId) => {
      setCalls.push({
        key: evalTaskCancelKey(taskId),
        value: '1',
        mode: 'EX',
        ttl: EVAL_TASK_CANCEL_TTL_SECONDS,
      });
    },
  });
  await app.ready();
  await cleanup();
  const token = await login(app);

  const target = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}target`,
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'dummy-cancel-key', // pragma: allowlist secret
      model: 'fake-model',
    },
  });
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}running-task`,
      status: 'RUNNING',
      modelTargetId: target.id,
      totalQuestions: 3,
      processedQuestions: 1,
      progress: 1 / 3,
    },
  });

  const res = await app.inject({
    method: 'POST',
    url: `/api/eval-tasks/${task.id}/cancel`,
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(setCalls, [
    { key: evalTaskCancelKey(task.id), value: '1', mode: 'EX', ttl: EVAL_TASK_CANCEL_TTL_SECONDS },
  ]);
  const refreshed = await prisma.evalTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(refreshed.status, 'CANCELED');
  assert.equal(refreshed.finishedAt, null);
  assert.equal(res.json().status, 'CANCELED');

  await cleanup();
  await app.close();
});

test('runEvalTask stops before dispatching a new sample when cancel signal is already set', async () => {
  const taskId = randomUUID();
  const targetId = randomUUID();
  const questionSetId = randomUUID();
  const q1 = randomUUID();
  const q2 = randomUUID();
  const updates: any[] = [];
  const createdResults: any[] = [];
  let calls = 0;
  let cancelAfterFirstSample = false;
  const now = new Date('2026-06-22T00:00:00.000Z');
  const db = makePrismaLike({
    taskId,
    targetId,
    questionSetId,
    questions: [
      { id: q1, content: 'sample 1', createdAt: now },
      { id: q2, content: 'sample 2', createdAt: now },
    ],
    updates,
    createdResults,
  });

  await runEvalTask(taskId, {
    prisma: db,
    isCancelRequested: async () => cancelAfterFirstSample,
    callModel: async () => {
      calls += 1;
      return {
        status: 'SUCCESS',
        content: 'ok',
        finishReason: 'stop',
        model: 'fake',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 1,
        httpStatus: 200,
        error: null,
        raw: null,
      };
    },
    perQuestionEngines: [
      {
        engine: 'fake-pass',
        builtin: true,
        judge: async () => {
          cancelAfterFirstSample = true;
          return {
            engine: 'fake-pass',
            taskId,
            questionId: q1,
            status: 'success',
            verdict: 'PASS',
            riskCategory: 'ok',
            severity: 'INFO',
            score: 1,
            evidence: null,
            rawOutput: null,
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
          };
        },
      },
    ],
    taskLevelEngines: [],
    judgeTarget: null,
  });

  assert.equal(calls, 1);
  assert.equal(createdResults.length, 1);
  assert.equal(updates.at(-1).data.status, 'CANCELED');
  assert.equal(updates.at(-1).data.processedQuestions, 1);
  assert.equal(updates.at(-1).data.progress, 1 / 2);
});

test('runEvalTask aborts in-flight red-team chat when cancel signal appears', async () => {
  const taskId = randomUUID();
  const targetId = randomUUID();
  const attackerTargetId = randomUUID();
  const questionSetId = randomUUID();
  const questionId = randomUUID();
  const updates: any[] = [];
  const createdResults: any[] = [];
  let cancelRequested = false;
  const observedSignals: AbortSignal[] = [];
  const now = new Date('2026-06-22T00:00:00.000Z');
  const db = makePrismaLike({
    taskId,
    targetId,
    attackerTargetId,
    questionSetId,
    questions: [
      {
        id: questionId,
        content: 'red team sample',
        createdAt: now,
        metadata: {
          kind: 'red_team',
          redteam: {
            attackerTargetId,
            judgeTargetId: attackerTargetId,
            maxRounds: 1,
            noProgressK: 1,
          },
        },
        type: 'SHOULD_REFUSE',
        shouldRefuse: true,
      },
    ],
    updates,
    createdResults,
  });

  await runEvalTask(taskId, {
    prisma: db,
    isCancelRequested: async () => cancelRequested,
    cancelPollIntervalMs: 1,
    callModel: async (_cfg, _messages, opts) => {
      if (!cancelRequested) cancelRequested = true;
      if (opts?.signal) observedSignals.push(opts.signal);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        status: opts?.signal?.aborted ? 'ERROR' : 'SUCCESS',
        content: opts?.signal?.aborted
          ? ''
          : '{"move":"academic_wrap","message":"try","rationale":"r"}',
        finishReason: 'stop',
        model: 'fake',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 20,
        httpStatus: opts?.signal?.aborted ? null : 200,
        error: opts?.signal?.aborted ? 'aborted' : null,
        raw: null,
      };
    },
    perQuestionEngines: [
      {
        engine: 'llm-judge',
        builtin: false,
        judge: async () =>
          ({
            engine: 'llm-judge',
            status: 'success',
            verdict: 'PASS',
            score: 1,
            riskCategory: 'ok',
            severity: 'INFO',
            evidence: null,
          }) as any,
      },
    ],
    taskLevelEngines: [],
    judgeTarget: { baseUrl: 'https://judge.invalid/v1', apiKey: 'judge-key', model: 'judge' }, // pragma: allowlist secret
  });

  assert.ok(observedSignals.length >= 1);
  assert.equal(
    observedSignals.some((signal) => signal.aborted),
    true,
  );
  assert.equal(updates.at(-1).data.status, 'CANCELED');
});

test('runEvalTask treats cancel-check errors as non-canceling so Redis blips do not fail the task', async () => {
  const taskId = randomUUID();
  const targetId = randomUUID();
  const questionSetId = randomUUID();
  const questionId = randomUUID();
  const updates: any[] = [];
  const createdResults: any[] = [];
  let cancelChecks = 0;
  const now = new Date('2026-06-22T00:00:00.000Z');
  const db = makePrismaLike({
    taskId,
    targetId,
    questionSetId,
    questions: [{ id: questionId, content: 'sample', createdAt: now }],
    updates,
    createdResults,
  });

  await runEvalTask(taskId, {
    prisma: db,
    isCancelRequested: async () => {
      cancelChecks += 1;
      throw new Error('redis unavailable');
    },
    callModel: async () => ({
      status: 'SUCCESS',
      content: 'ok',
      finishReason: 'stop',
      model: 'fake',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      httpStatus: 200,
      error: null,
      raw: null,
    }),
    perQuestionEngines: [],
    taskLevelEngines: [],
    judgeTarget: null,
  });

  assert.ok(cancelChecks > 0);
  assert.equal(createdResults.length, 1);
  assert.equal(updates.at(-1).data.status, 'COMPLETED');
});

test('runEvalTask 持久化单题引擎的部分跳过数量', async () => {
  const taskId = randomUUID();
  const targetId = randomUUID();
  const questionSetId = randomUUID();
  const updates: any[] = [];
  const createdResults: any[] = [];
  const createdEngineRuns: any[] = [];
  const now = new Date('2026-07-11T00:00:00.000Z');
  const db = makePrismaLike({
    taskId,
    targetId,
    questionSetId,
    questions: [
      { id: randomUUID(), content: '应正常判定', createdAt: now },
      { id: randomUUID(), content: '应跳过判定', createdAt: now },
    ],
    updates,
    createdResults,
    createdEngineRuns,
  });

  await runEvalTask(taskId, {
    prisma: db,
    isCancelRequested: async () => false,
    callModel: async () => ({
      status: 'SUCCESS',
      content: 'ok',
      finishReason: 'stop',
      model: 'fake',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      httpStatus: 200,
      error: null,
      raw: null,
    }),
    perQuestionEngines: [
      {
        engine: 'fake-partial-skip',
        builtin: false,
        judge: async (input) => ({
          engine: 'fake-partial-skip',
          taskId,
          questionId: input.questionId,
          status: input.prompt.includes('跳过') ? 'skipped' : 'success',
          verdict: input.prompt.includes('跳过') ? 'UNKNOWN' : 'PASS',
          riskCategory: 'coverage',
          severity: 'INFO',
          score: input.prompt.includes('跳过') ? null : 1,
          evidence: input.prompt.includes('跳过') ? '模拟部分跳过' : null,
          rawOutput: null,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        }),
      },
    ],
    taskLevelEngines: [],
    judgeTarget: null,
  });

  const run = createdEngineRuns.find((item) => item.engine === 'fake-partial-skip');
  assert.ok(run, '应写入单题引擎汇总运行');
  assert.equal(run.status, 'SUCCESS', '部分成功仍保留既有 SUCCESS 状态语义');
  assert.equal(run.normalizedCount, 1);
  assert.equal(run.skippedCount, 1, '部分跳过必须写入结构化计数');
});

test('runEvalTask unrefs and clears the cancel watcher timer', async () => {
  const taskId = randomUUID();
  const targetId = randomUUID();
  const questionSetId = randomUUID();
  const questionId = randomUUID();
  const updates: any[] = [];
  const createdResults: any[] = [];
  const now = new Date('2026-06-22T00:00:00.000Z');
  const db = makePrismaLike({
    taskId,
    targetId,
    questionSetId,
    questions: [{ id: questionId, content: 'sample', createdAt: now }],
    updates,
    createdResults,
  });
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let unrefCalls = 0;
  let clearCalls = 0;
  const fakeTimer = {
    unref: () => {
      unrefCalls += 1;
      return fakeTimer;
    },
  };
  globalThis.setInterval = (() => fakeTimer) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = ((timer: unknown) => {
    assert.equal(timer, fakeTimer);
    clearCalls += 1;
  }) as unknown as typeof globalThis.clearInterval;

  try {
    await runEvalTask(taskId, {
      prisma: db,
      isCancelRequested: async () => false,
      callModel: async () => ({
        status: 'SUCCESS',
        content: 'ok',
        finishReason: 'stop',
        model: 'fake',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 1,
        httpStatus: 200,
        error: null,
        raw: null,
      }),
      perQuestionEngines: [],
      taskLevelEngines: [],
      judgeTarget: null,
    });
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }

  assert.equal(unrefCalls, 1);
  assert.equal(clearCalls, 1);
  assert.equal(updates.at(-1).data.status, 'COMPLETED');
});

function makePrismaLike(args: {
  taskId: string;
  targetId: string;
  attackerTargetId?: string;
  questionSetId: string;
  questions: any[];
  updates: any[];
  createdResults: any[];
  createdEngineRuns?: any[];
}): PrismaLike {
  const target = {
    id: args.targetId,
    name: `${PREFIX}target`,
    targetType: 'MODEL',
    provider: 'openai-compatible',
    baseUrl: 'https://target.invalid/v1',
    apiKey: 'dummy-target-key', // pragma: allowlist secret
    model: 'target-model',
    extraHeaders: null,
    defaultParams: null,
    accessConfig: null,
  };
  const attacker = {
    ...target,
    id: args.attackerTargetId ?? randomUUID(),
    name: `${PREFIX}attacker`,
    model: 'attacker-model',
  };
  const task = {
    id: args.taskId,
    name: `${PREFIX}task`,
    status: 'PENDING',
    engines: [],
    dimensions: [],
    concurrency: 1,
    modelTargetId: args.targetId,
    modelTarget: target,
    questionSets: [{ questionSetId: args.questionSetId }],
  };
  const normalizeQuestion = (q: any) => ({
    metadata: null,
    type: 'GENERAL',
    shouldRefuse: false,
    category: null,
    expectedBehavior: null,
    referenceAnswer: null,
    severity: null,
    ...q,
  });

  return {
    evalTask: {
      // 执行器原子领取（只从排队中改成执行中）：假库按普通 update 处理。
      async updateMany(input: any) {
        await (this as any).update(input);
        return { count: 1 };
      },
      findUnique: async () => task,
      update: async (input: any) => {
        args.updates.push(input);
        Object.assign(task, input.data);
        return { ...task };
      },
    },
    question: {
      findMany: async () => args.questions.map(normalizeQuestion),
    },
    wrongAnswer: {
      deleteMany: async () => ({ count: 0 }),
      create: async () => ({}),
    },
    finding: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 }),
    },
    engineRun: {
      deleteMany: async () => ({ count: 0 }),
      create: async () => ({}),
      createMany: async (input: any) => {
        const rows = Array.isArray(input.data) ? input.data : [input.data];
        args.createdEngineRuns?.push(...rows);
        return { count: rows.length };
      },
    },
    evalResult: {
      deleteMany: async () => ({ count: 0 }),
      create: async (input: any) => {
        const row = { id: randomUUID(), ...input.data };
        args.createdResults.push(row);
        return row;
      },
    },
    modelTarget: {
      findUniqueOrThrow: async ({ where }: any) => {
        if (where.id === attacker.id) return attacker;
        if (where.id === target.id) return target;
        throw new Error(`unknown target ${where.id}`);
      },
      findUnique: async ({ where }: any) => {
        if (where.id === attacker.id) return attacker;
        if (where.id === target.id) return target;
        return null;
      },
    },
    systemSetting: {
      findUnique: async () => null,
    },
  } as unknown as PrismaLike;
}
