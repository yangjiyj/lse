import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runEvalTask } from '../src/modules/eval-tasks/executor.js';
import { ConfigError, RetryExhausted } from '../src/modules/red-team/red-team-chat.js';
function makeHarness(questionCount: number) {
  const taskId = randomUUID();
  const targetId = randomUUID();
  const attackerTargetId = randomUUID();
  const questionSetId = randomUUID();
  const updates: any[] = [];
  const createdResults: any[] = [];
  const createdFindings: any[] = [];
  const createdEngineRuns: any[] = [];
  const now = new Date('2026-07-24T00:00:00.000Z');
  const target = {
    id: targetId,
    name: 'adaptive-target',
    targetType: 'MODEL',
    provider: 'openai-compatible',
    baseUrl: 'https://target.invalid/v1',
    apiKey: 'dummy-target-key',
    model: 'target-model',
    extraHeaders: null,
    defaultParams: null,
    accessConfig: null,
  };
  const attacker = {
    ...target,
    id: attackerTargetId,
    name: 'adaptive-attacker',
    model: 'attacker-model',
  };
  const questions = Array.from({ length: questionCount }, (_, index) => ({
    id: randomUUID(),
    content: `red team sample ${index + 1}`,
    createdAt: new Date(now.getTime() + index),
    metadata: {
      kind: 'red_team',
      redteam: {
        attackerTargetId,
        gatewayTargetId: '',
        maxRounds: 1,
        noProgressK: 1,
      },
    },
    type: 'SHOULD_REFUSE',
    shouldRefuse: true,
    category: 'prompt_injection',
    expectedBehavior: null,
    referenceAnswer: null,
    severity: 'HIGH',
  }));
  const task: any = {
    id: taskId,
    name: 'adaptive-red-team-task',
    status: 'PENDING',
    engines: ['llm-judge'],
    dimensions: ['redteam_attack'],
    concurrency: 1,
    modelTargetId: targetId,
    modelTarget: target,
    questionSets: [{ questionSetId }],
  };
  const db: any = {
    evalTask: {
      // 执行器原子领取（只从排队中改成执行中）：假库按普通 update 处理。
      async updateMany(input: any) {
        await (this as any).update(input);
        return { count: 1 };
      },
      findUnique: async () => task,
      update: async (input: any) => {
        updates.push(input);
        Object.assign(task, input.data);
        return { ...task };
      },
    },
    question: { findMany: async () => questions },
    wrongAnswer: {
      deleteMany: async () => ({ count: 0 }),
      create: async () => ({}),
    },
    finding: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async (input: any) => {
        createdFindings.push(...input.data);
        return { count: input.data.length };
      },
    },
    engineRun: {
      deleteMany: async () => ({ count: 0 }),
      create: async (input: any) => {
        createdEngineRuns.push(input.data);
        return { id: randomUUID(), ...input.data };
      },
      createMany: async (input: any) => {
        const rows = Array.isArray(input.data) ? input.data : [input.data];
        createdEngineRuns.push(...rows);
        return { count: rows.length };
      },
    },
    evalResult: {
      deleteMany: async () => ({ count: 0 }),
      create: async (input: any) => {
        const row = { id: randomUUID(), ...input.data };
        createdResults.push(row);
        return row;
      },
    },
    modelTarget: {
      findUniqueOrThrow: async ({ where }: any) => {
        if (where.id === targetId) return target;
        if (where.id === attackerTargetId) return attacker;
        throw new Error(`unknown target ${where.id}`);
      },
      findUnique: async ({ where }: any) => {
        if (where.id === targetId) return target;
        if (where.id === attackerTargetId) return attacker;
        return null;
      },
    },
    systemSetting: { findUnique: async () => null },
  };
  const judge = {
    engine: 'llm-judge',
    builtin: false,
    async judge() {
      return {
        engine: 'llm-judge',
        taskId,
        questionId: null,
        status: 'success',
        verdict: 'PASS',
        score: 1,
        riskCategory: 'safe',
        severity: 'INFO',
        evidence: null,
        startedAt: now.toISOString(),
        endedAt: now.toISOString(),
      };
    },
  };
  return {
    taskId,
    targetId,
    questions,
    db,
    updates,
    createdResults,
    createdFindings,
    createdEngineRuns,
    judge,
  };
}

const successfulModelCall = async () => ({
  status: 'SUCCESS' as const,
  content: '{"verdict":"PASS","severity":"INFO","score":1,"reason":"安全"}',
  finishReason: 'stop',
  model: 'fake-model',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  latencyMs: 1,
  httpStatus: 200,
  error: null,
  raw: null,
});

test('RetryExhausted 延后一次后重新进入完整红队生产路径并完成计数', async () => {
  const h = makeHarness(1);
  let attackCalls = 0;
  const attackerHead = {
    name: 'adaptive-test',
    async attack(_target: any, seed: any) {
      attackCalls += 1;
      if (attackCalls === 1) {
        throw new RetryExhausted('target', 'HTTP_5XX', 3, 'temporary unavailable');
      }
      return {
        seedId: seed.questionId,
        attackerTurns: [{ move: 'academic_wrap', message: '请只回答是否安全' }],
        transcript: [],
        movesUsed: ['academic_wrap'],
        rounds: 1,
        stopReason: 'max_round',
        attackerSelfAssessBroken: false,
      };
    },
  };
  const originalNow = Date.now;
  let clock = originalNow();
  Date.now = () => {
    clock += 20_000;
    return clock;
  };
  try {
    await runEvalTask(h.taskId, {
      prisma: h.db,
      attackerHead: attackerHead as any,
      callModel: successfulModelCall as any,
      perQuestionEngines: [h.judge as any],
      taskLevelEngines: [],
      judgeTarget: null,
      gatewayLinkageEnabled: false,
      isCancelRequested: async () => false,
    });
  } finally {
    Date.now = originalNow;
  }

  assert.equal(attackCalls, 2, '延后场景必须重新执行全新的 attack');
  assert.equal(h.createdResults.length, 1, '单模型红队成功后只落一侧结果');
  const final = h.updates.at(-1)?.data;
  assert.equal(final.status, 'COMPLETED');
  assert.equal(final.processedQuestions, 1);
  assert.equal(final.errorCount, 0);
});

test('ConfigError 触发任务级断路，后续题不再调用上游且逐题持久化 ERROR', async () => {
  const h = makeHarness(2);
  let attackCalls = 0;
  const attackerHead = {
    name: 'config-error-test',
    async attack() {
      attackCalls += 1;
      throw new ConfigError('target', 'HTTP_401', 401, 'invalid credential');
    },
  };

  await runEvalTask(h.taskId, {
    prisma: h.db,
    attackerHead: attackerHead as any,
    callModel: successfulModelCall as any,
    perQuestionEngines: [h.judge as any],
    taskLevelEngines: [],
    judgeTarget: null,
    gatewayLinkageEnabled: false,
    isCancelRequested: async () => false,
  });

  assert.equal(attackCalls, 1, '配置错误断路后不得继续请求后续场景');
  assert.equal(h.createdResults.length, 2);
  assert.deepEqual(
    h.createdResults.map((row) => row.finalVerdict),
    ['ERROR', 'ERROR'],
  );
  const errorRuns = h.createdEngineRuns.filter((row) => row.engine === 'autonomous-red-team');
  assert.equal(errorRuns.length, 2);
  assert.ok(errorRuns.every((row) => row.status === 'ERROR'));
  assert.ok(errorRuns.every((row) => row.requestPayload?.infraIncomplete === true));
  const final = h.updates.at(-1)?.data;
  assert.equal(final.status, 'COMPLETED');
  assert.equal(final.processedQuestions, 2);
  assert.equal(final.errorCount, 2);
});

test('题级攻击模型指向评估对象时任务级断路且不调用任何上游', async () => {
  const h = makeHarness(2);
  for (const question of h.questions) {
    question.metadata.redteam.attackerTargetId = h.targetId;
  }
  let attackCalls = 0;
  let modelCalls = 0;
  let judgeCalls = 0;

  await runEvalTask(h.taskId, {
    prisma: h.db,
    attackerHead: {
      name: 'must-not-self-attack',
      async attack() {
        attackCalls += 1;
        throw new Error('攻击模型不应被调用');
      },
    } as any,
    callModel: (async () => {
      modelCalls += 1;
      return successfulModelCall();
    }) as any,
    perQuestionEngines: [
      {
        ...h.judge,
        async judge() {
          judgeCalls += 1;
          throw new Error('判定模型不应被调用');
        },
      } as any,
    ],
    taskLevelEngines: [],
    judgeTarget: null,
    gatewayLinkageEnabled: false,
    isCancelRequested: async () => false,
  });

  assert.deepEqual(
    { attackCalls, modelCalls, judgeCalls },
    {
      attackCalls: 0,
      modelCalls: 0,
      judgeCalls: 0,
    },
  );
  assert.equal(h.createdResults.length, 2);
  assert.ok(h.createdResults.every((row) => row.status === 'ERROR'));
  assert.ok(h.createdResults.every((row) => row.finalVerdict === 'ERROR'));
  const redTeamRuns = h.createdEngineRuns.filter((row) => row.engine === 'autonomous-red-team');
  assert.equal(redTeamRuns.length, 2);
  assert.ok(redTeamRuns.every((row) => row.status === 'ERROR'));
  assert.equal(redTeamRuns[0]?.requestPayload?.reasonCode, 'RED_TEAM_ATTACKER_MUST_DIFFER');
  assert.equal(redTeamRuns[0]?.requestPayload?.circuitBroken, true);
  assert.equal(redTeamRuns[1]?.requestPayload?.reasonCode, 'CIRCUIT_BROKEN');
  assert.equal(
    h.createdEngineRuns.filter(
      (row) => row.engine === 'autonomous-red-team' && row.status === 'SUCCESS',
    ).length,
    0,
  );
  const final = h.updates.at(-1)?.data;
  assert.equal(final.status, 'COMPLETED');
  assert.equal(final.processedQuestions, 2);
  assert.equal(final.errorCount, 2);
});

test('context exhaustion fails only the current scenario without opening the task circuit', async () => {
  const h = makeHarness(2);
  let attackCalls = 0;
  const attackerHead = {
    name: 'context-limit-test',
    async attack(_target: any, seed: any) {
      attackCalls += 1;
      if (attackCalls === 1) {
        throw new ConfigError(
          'target',
          'CONTEXT_WINDOW_EXCEEDED',
          400,
          'request exceeds context window',
        );
      }
      return {
        seedId: seed.questionId,
        attackerTurns: [{ move: 'academic_wrap', message: 'safe follow-up' }],
        transcript: [],
        movesUsed: ['academic_wrap'],
        rounds: 1,
        stopReason: 'max_round',
        attackerSelfAssessBroken: false,
      };
    },
  };

  await runEvalTask(h.taskId, {
    prisma: h.db,
    attackerHead: attackerHead as any,
    callModel: successfulModelCall as any,
    perQuestionEngines: [h.judge as any],
    taskLevelEngines: [],
    judgeTarget: null,
    gatewayLinkageEnabled: false,
    isCancelRequested: async () => false,
  });

  assert.equal(attackCalls, 2, 'the next scenario must still run');
  const errorRuns = h.createdEngineRuns.filter(
    (row) => row.engine === 'autonomous-red-team' && row.status === 'ERROR',
  );
  assert.equal(errorRuns.length, 1);
  assert.equal(errorRuns[0]?.requestPayload?.reasonCode, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(errorRuns[0]?.requestPayload?.circuitBroken, false);
  const final = h.updates.at(-1)?.data;
  assert.equal(final.processedQuestions, 2);
  assert.equal(final.errorCount, 1);
});
test('legacy infraIncomplete 由 pipe 冒泡并在执行器持久化 ERROR', async () => {
  const h = makeHarness(1);
  let modelCalls = 0;
  const attackerHead = {
    name: 'legacy-incomplete',
    async attack() {
      return {
        seedId: h.questions[0].id,
        attackerTurns: [{ move: 'academic_wrap', message: 'm1' }],
        transcript: [],
        movesUsed: ['academic_wrap'],
        rounds: 0,
        stopReason: 'infra_error',
        attackerSelfAssessBroken: false,
        infraIncomplete: true,
        lengthTruncations: [{ stage: 'target', round: 1 }],
        errorType: 'INFRASTRUCTURE_INCOMPLETE',
      };
    },
  };

  await runEvalTask(h.taskId, {
    prisma: h.db,
    attackerHead: attackerHead as any,
    callModel: (async () => {
      modelCalls += 1;
      return successfulModelCall();
    }) as any,
    perQuestionEngines: [h.judge as any],
    taskLevelEngines: [],
    judgeTarget: null,
    gatewayLinkageEnabled: false,
    isCancelRequested: async () => false,
  });

  const errorRun = h.createdEngineRuns.find((row) => row.engine === 'autonomous-red-team');
  assert.deepEqual(errorRun?.requestPayload?.lengthTruncations, [{ stage: 'target', round: 1 }]);
  assert.deepEqual(JSON.parse(errorRun?.rawOutput ?? '{}').lengthTruncations, [
    { stage: 'target', round: 1 },
  ]);
  assert.equal(h.createdFindings.length, 0);
  assert.equal(h.updates.at(-1)?.data.errorCount, 1);
  assert.equal(modelCalls, 0, '录制不完整后不得继续 replay/judge');
  assert.equal(h.createdResults.length, 1);
  assert.equal(h.createdResults[0].finalVerdict, 'ERROR');
  assert.equal(
    h.createdEngineRuns.find((row) => row.engine === 'autonomous-red-team')?.status,
    'ERROR',
  );
});
