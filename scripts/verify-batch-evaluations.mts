import '../apps/api/src/env.js';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { prisma } from '../apps/api/src/db.js';
import { assertSafeTestDatabaseUrl } from '../apps/api/src/test-db-safety.js';
import { loadCurrentUser } from '../apps/api/src/lib/rbac.js';
import {
  createBatchPlan,
  getBatchDetail,
} from '../apps/api/src/modules/batch-evaluations/service.js';
import { runBatchEvaluation } from '../apps/api/src/modules/batch-evaluations/executor.js';

if (process.env.LSE_TEST !== '1') throw new Error('容量模拟验收必须使用独立测试库与 LSE_TEST=1');
assertSafeTestDatabaseUrl(process.env.DATABASE_URL ?? '', {});
const count = Number(process.env.BATCH_ACCEPTANCE_SAMPLE_COUNT ?? 10000);
const targetCount = Number(process.env.BATCH_ACCEPTANCE_TARGET_COUNT ?? 10);
assert.ok(Number.isInteger(count) && count > 0 && count <= 100000);
assert.ok(Number.isInteger(targetCount) && targetCount > 0 && targetCount <= 50);
const label = `[模拟验收] ${randomUUID().slice(0, 8)}`;
const started = Date.now();
try {
  const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
  const user = (await loadCurrentUser(admin.id))!;
  const targetIds: string[] = [];
  for (let i = 0; i < targetCount; i++) {
    targetIds.push(
      (
        await prisma.modelTarget.create({
          data: {
            name: `${label} 模型 ${i + 1}`,
            provider: 'openai-compatible',
            model: `simulated-model-${i + 1}`,
            baseUrl: 'http://127.0.0.1:19491/v1',
            apiKey: 'simulation-only',
            createdById: user.id,
          },
        })
      ).id,
    );
  }
  const set = await prisma.questionSet.create({
    data: {
      name: `${label} 容量验收样本库`,
      tags: ['模拟验收'],
      source: 'simulation',
      createdById: user.id,
    },
  });
  for (let i = 0; i < count; i += 1000)
    await prisma.question.createMany({
      data: Array.from({ length: Math.min(1000, count - i) }, (_, n) => ({
        questionSetId: set.id,
        content: `模拟容量测试样本 ${i + n + 1}：请简要说明正常服务用途。`,
        type: 'GENERAL' as const,
        category: '正常服务',
        metadata: { expectedKeywords: ['模拟安全回答'] },
        tags: [],
      })),
    });
  const plan = await createBatchPlan(
    {
      name: `${label} ${targetCount} 个对象各 ${count} 样本`,
      targetIds,
      questionSetIds: [set.id],
      sampleCount: count,
      seed: 'capacity-acceptance',
      judgeMode: 'RULES',
      strategy: 'PARALLEL',
      concurrency: 16,
      targetConcurrency: 8,
      batchSize: 200,
      rpm: 60000,
      maxAttempts: 1,
      maxRequests: count * targetCount,
      maxDurationMinutes: 120,
    },
    user,
  );
  assert.equal(
    await prisma.batchEvaluationResult.count({ where: { run: { planId: plan.id } } }),
    count * targetCount,
  );
  console.log(
    JSON.stringify({
      phase: 'created',
      planId: plan.id,
      targets: targetCount,
      samplesPerTarget: count,
      expected: count * targetCount,
      creationMs: Date.now() - started,
    }),
  );
  let calls = 0;
  await runBatchEvaluation(plan.id, {
    acquireRateSlot: async () => true,
    invoke: async () => {
      calls++;
      return {
        status: 'SUCCESS',
        content: '模拟安全回答：服务用于正常的信息处理。',
        finishReason: 'stop',
        model: 'simulated',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        latencyMs: 1,
        httpStatus: 200,
        error: null,
        raw: null,
      };
    },
  });
  const result = await getBatchDetail(plan.id);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.processedSamples, count * targetCount);
  assert.equal(result.validSamples, count * targetCount);
  assert.equal(result.requestsUsed, calls);
  assert.equal(calls, count * targetCount);
  assert.equal(result.runs.length, targetCount);
  for (const run of result.runs) assert.equal(run.validSamples, count);
  assert.ok(result.summary.coverageComplete);
  assert.equal(
    await prisma.batchEvaluationAttempt.count({ where: { result: { run: { planId: plan.id } } } }),
    calls,
  );
  console.log(
    JSON.stringify({
      phase: 'completed',
      planId: plan.id,
      targets: targetCount,
      samplesPerTarget: count,
      calls,
      processed: result.processedSamples,
      valid: result.validSamples,
      elapsedMs: Date.now() - started,
      externalModelCalls: 0,
      evidenceBoundary: 'SIMULATED_TARGET_REAL_DATABASE_AND_EXECUTOR',
    }),
  );
} finally {
  await prisma.$disconnect();
}
