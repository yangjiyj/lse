import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmCallResult } from '@lse/shared';
import { prisma } from '../src/db.js';
import { loadTaskQuestions } from '../src/modules/eval-tasks/sampling.js';
import { runEvalTask } from '../src/modules/eval-tasks/executor.js';

// 显式题目冻结：任务有 EvalTaskQuestion 清单时只跑清单内题目（仍限定在关联样本库内），跳过抽样；
// 无清单时行为与原来完全一致。
const PREFIX = '__pinned_questions_';
let targetId = '';
let setId = '';
let otherSetId = '';
let qIds: string[] = [];
let foreignQuestionId = '';

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

function okResult(): LlmCallResult {
  return {
    status: 'SUCCESS',
    content: '这是一个普通的回答。',
    finishReason: 'stop',
    model: 'fake',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    latencyMs: 1,
    httpStatus: 200,
    error: null,
    raw: null,
  };
}

async function makeSet(name: string, n: number) {
  const set = await prisma.questionSet.create({
    data: { name: `${PREFIX}${name}`, type: 'PROMPT_INJECTION', source: 'test' },
  });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const q = await prisma.question.create({
      data: {
        questionSetId: set.id,
        content: `${PREFIX}${name}_题${i}`,
        type: 'GENERAL',
        severity: 'INFO',
        shouldRefuse: false,
        category: i % 2 === 0 ? 'A' : 'B',
      },
    });
    ids.push(q.id);
  }
  return { setId: set.id, ids };
}

async function makeTask(name: string, pins: string[], sampleSize: number | null = null) {
  return prisma.evalTask.create({
    data: {
      name: `${PREFIX}${name}`,
      status: 'PENDING',
      modelTargetId: targetId,
      engines: [],
      dimensions: [],
      concurrency: 1,
      sampleSize,
      sampleSeed: sampleSize ? 'seed' : null,
      questionSets: { create: [{ questionSetId: setId }] },
      pinnedQuestions: { create: pins.map((questionId) => ({ questionId })) },
    },
  });
}

before(async () => {
  await cleanup();
  const t = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}SUT`,
      provider: 'openai-compatible',
      targetType: 'MODEL',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-pinned-test',
      model: 'fake',
    },
  });
  targetId = t.id;
  const a = await makeSet('主库', 4);
  setId = a.setId;
  qIds = a.ids;
  const b = await makeSet('他库', 1);
  otherSetId = b.setId;
  foreignQuestionId = b.ids[0]!;
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test('loadTaskQuestions：无显式清单时全量与抽样行为不变', async () => {
  const all = await loadTaskQuestions(prisma, [setId], null, null);
  assert.deepEqual(all.map((q) => q.id).sort(), [...qIds].sort());
  const sampled = await loadTaskQuestions(prisma, [setId], 2, 'seed');
  assert.equal(sampled.length, 2);
  const sampledEmptyPins = await loadTaskQuestions(prisma, [setId], 2, 'seed', []);
  assert.deepEqual(
    sampledEmptyPins.map((q) => q.id),
    sampled.map((q) => q.id),
  );
});

test('loadTaskQuestions：显式清单只取清单题，跳过抽样，越出关联样本库的题被剔除', async () => {
  const pins = [qIds[1]!, qIds[3]!, foreignQuestionId];
  const got = await loadTaskQuestions(prisma, [setId], 1, 'seed', pins);
  assert.deepEqual(got.map((q) => q.id).sort(), [qIds[1]!, qIds[3]!].sort());
  const none = await loadTaskQuestions(prisma, [otherSetId], null, null, [qIds[0]!]);
  assert.equal(none.length, 0);
});

test('执行器：有显式清单的任务只产生清单题结果；普通任务仍跑全量', async () => {
  const pinned = await makeTask('冻结任务', [qIds[0]!, qIds[2]!], 1);
  await runEvalTask(pinned.id, { callModel: async () => okResult(), judgeTarget: null });
  const pinnedResults = await prisma.evalResult.findMany({ where: { taskId: pinned.id } });
  assert.deepEqual(
    [...new Set(pinnedResults.map((r) => r.questionId))].sort(),
    [qIds[0]!, qIds[2]!].sort(),
  );
  const pinnedTask = await prisma.evalTask.findUniqueOrThrow({ where: { id: pinned.id } });
  assert.equal(pinnedTask.totalQuestions, 2);

  const normal = await makeTask('普通任务', []);
  await runEvalTask(normal.id, { callModel: async () => okResult(), judgeTarget: null });
  const normalResults = await prisma.evalResult.findMany({ where: { taskId: normal.id } });
  assert.deepEqual([...new Set(normalResults.map((r) => r.questionId))].sort(), [...qIds].sort());
});
