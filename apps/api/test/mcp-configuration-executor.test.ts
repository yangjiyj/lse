import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runEvalTask } from '../src/modules/eval-tasks/executor.js';
import { generateMcpScenarios } from '../src/modules/agent-evals/generator.js';
import { deriveReachability, mcpExecutionStatus } from '../src/modules/reports/reachability.js';
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

test('缺少沙箱端点的实际executor持久化SKIPPED/UNKNOWN，无ERROR或Finding', async () => {
  const h = makeHarness(1);
  const task = await h.db.evalTask.findUnique();
  task.modelTarget.targetType = 'MCP_OPENAPI';
  task.engines = [];
  task.dimensions = [];
  h.questions[0]!.metadata = generateMcpScenarios({
    classes: ['tool_enumeration'],
    sampleCount: 1,
  })[0]!.metadata as any;
  await runEvalTask(h.taskId, {
    prisma: h.db,
    perQuestionEngines: [],
    taskLevelEngines: [],
    judgeTarget: null,
    gatewayLinkageEnabled: false,
    isCancelRequested: async () => false,
    callModel: async () => {
      throw new Error('不允许模型调用');
    },
  });
  assert.equal(h.createdResults.length, 1);
  assert.equal(h.createdResults[0].status, 'SUCCESS');
  assert.equal(h.createdResults[0].finalVerdict, 'UNKNOWN');
  assert.match(h.createdResults[0].response, /前提不满足，未执行/);
  const run = h.createdEngineRuns[0];
  assert.equal(run.status, 'SKIPPED');
  assert.equal(run.skippedCount, 1);
  assert.equal(run.normalizedCount, 0);
  assert.equal(
    deriveReachability({
      ...h.createdResults[0],
      engineRuns: [{ ...run, executionStatus: mcpExecutionStatus(run.rawOutput) }],
    }),
    'not_executed',
  );
  assert.equal(h.createdFindings.length, 0);
  assert.equal(h.updates.at(-1).data.errorCount, 0);
});
