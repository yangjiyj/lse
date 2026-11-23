import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../src/db.js';
import { loadCurrentUser } from '../src/lib/rbac.js';
import { createBatchPlan, getBatchDetail } from '../src/modules/batch-evaluations/service.js';
import type { LlmCallResult } from '@lse/shared';

const executor = await import('../src/modules/batch-evaluations/executor.js').catch(() => null);
const recovery = await import('../src/modules/batch-evaluations/recovery.js').catch(() => null);
const PREFIX = '__batch_exec_';
let targetIds: string[] = [],
  setId: string;
let user: NonNullable<Awaited<ReturnType<typeof loadCurrentUser>>>;
const answer = (
  content: string,
  status: 'SUCCESS' | 'ERROR' = 'SUCCESS',
  httpStatus = 200,
): LlmCallResult => ({
  status,
  content,
  finishReason: 'stop',
  model: 'fake',
  usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
  latencyMs: 1,
  httpStatus,
  error: status === 'ERROR' ? 'test failure' : null,
  raw: null,
});
async function plan(extra = {}) {
  return createBatchPlan(
    {
      name: PREFIX + randomUUID(),
      targetIds,
      questionSetIds: [setId],
      sampleCount: 3,
      seed: 'execute',
      judgeMode: 'RULES',
      strategy: 'ROUND_ROBIN',
      concurrency: 1,
      targetConcurrency: 1,
      batchSize: 1,
      rpm: 60000,
      maxAttempts: 1,
      maxDurationMinutes: 60,
      ...extra,
    },
    user,
  );
}
before(async () => {
  const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
  user = (await loadCurrentUser(admin.id))!;
  for (let i = 0; i < 2; i++)
    targetIds.push(
      (
        await prisma.modelTarget.create({
          data: {
            name: PREFIX + randomUUID(),
            provider: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:9/v1',
            apiKey: 'test-only-placeholder',
            model: 'fake',
          },
        })
      ).id,
    );
  setId = (
    await prisma.questionSet.create({
      data: {
        name: PREFIX + randomUUID(),
        tags: [],
        questions: {
          create: [
            { content: '正常介绍', type: 'GENERAL', metadata: { expectedKeywords: ['正常'] } },
            { content: '安全拒答', type: 'SHOULD_REFUSE', shouldRefuse: true, severity: 'HIGH' },
            { content: '接口异常', type: 'GENERAL' },
          ],
        },
      },
    })
  ).id;
});
after(async () => {
  await prisma.batchEvaluation.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

test('轮询执行每对象样本，异常不参与有效判定', async () => {
  assert.ok(executor, '缺少可恢复批量执行器');
  const p = await plan();
  const calls: string[] = [];
  await executor.runBatchEvaluation(p.id, {
    acquireRateSlot: async () => true,
    invoke: async (target: any, messages: any) => {
      calls.push(target.baseUrl + ':' + target.model);
      const prompt = messages[0].content;
      return prompt === '接口异常'
        ? answer('', 'ERROR', 503)
        : answer(prompt === '安全拒答' ? '抱歉，我不能提供这些内容。' : '正常回答');
    },
  });
  const detail = await getBatchDetail(p.id);
  assert.equal(calls.length, 6);
  assert.equal(detail.processedSamples, 6);
  assert.equal(detail.validSamples, 4);
  assert.equal(detail.errorSamples, 2);
  assert.equal(detail.summary.state, 'INCOMPLETE');
  assert.equal(detail.summary.coverageComplete, false);
});

test('暂停后恢复只补判成功响应，不再次发送已成功样本', async () => {
  assert.ok(executor, '缺少可恢复批量执行器');
  const p = await plan();
  let calls = 0;
  const invoke = async () => {
    calls++;
    if (calls === 1)
      await prisma.batchEvaluation.update({ where: { id: p.id }, data: { status: 'PAUSED' } });
    return answer('正常回答，我不能提供危险内容。');
  };
  await executor.runBatchEvaluation(p.id, { acquireRateSlot: async () => true, invoke });
  assert.equal((await getBatchDetail(p.id)).status, 'PAUSED');
  await prisma.batchEvaluation.update({ where: { id: p.id }, data: { status: 'PENDING' } });
  await executor.runBatchEvaluation(p.id, { acquireRateSlot: async () => true, invoke });
  assert.equal(calls, 6);
  assert.equal((await getBatchDetail(p.id)).processedSamples, 6);
});

test('严格请求预算停止派发，保留已有结果', async () => {
  assert.ok(executor, '缺少可恢复批量执行器');
  const p = await plan();
  await prisma.batchEvaluation.update({ where: { id: p.id }, data: { maxRequests: 2 } });
  let calls = 0;
  await executor.runBatchEvaluation(p.id, {
    acquireRateSlot: async () => true,
    invoke: async () => {
      calls++;
      return answer('正常回答，我不能提供危险内容。');
    },
  });
  const detail = await getBatchDetail(p.id);
  assert.equal(calls, 2);
  assert.equal(detail.requestsUsed, 2);
  assert.equal(detail.status, 'PAUSED');
  assert.equal(detail.stopReason, 'REQUEST_BUDGET_EXHAUSTED');
});

test('两个执行器竞争同一计划，只有持租约者发送请求', async () => {
  assert.ok(executor, '缺少可恢复批量执行器');
  const p = await plan();
  let calls = 0;
  const deps = {
    acquireRateSlot: async () => true,
    invoke: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return answer('正常回答，我不能提供危险内容。');
    },
  };
  await Promise.all([
    executor.runBatchEvaluation(p.id, deps),
    executor.runBatchEvaluation(p.id, deps),
  ]);
  assert.equal(calls, 6);
  assert.equal((await getBatchDetail(p.id)).processedSamples, 6);
});

test('仅恢复已启动的失联计划，不自动执行未启动草稿', async () => {
  assert.ok(recovery, '缺少 Worker 恢复调度');
  const draft = await plan();
  const expired = await plan();
  await prisma.batchEvaluation.update({
    where: { id: expired.id },
    data: {
      status: 'RUNNING',
      startedAt: new Date(),
      leaseOwner: 'lost-worker',
      leaseUntil: new Date(Date.now() - 1000),
    },
  });
  const queued: string[] = [];
  await recovery.recoverBatchEvaluations(async (id: string) => {
    queued.push(id);
  });
  assert.ok(queued.includes(expired.id));
  assert.ok(!queued.includes(draft.id));
});

test('独立评审故障不规则降级为通过，重试仅补判已保存响应', async () => {
  assert.ok(executor);
  const judge = await prisma.modelTarget.create({
    data: {
      name: PREFIX + randomUUID(),
      provider: 'openai-compatible',
      targetType: 'JUDGE',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-only-placeholder',
      model: 'independent-judge',
    },
  });
  const p = await plan({ judgeMode: 'MODEL', sampleCount: 1 });
  let targetCalls = 0,
    judgeCalls = 0;
  const invoke = async () => {
    targetCalls++;
    return answer('正常回答，我不能提供危险内容。');
  };
  await executor.runBatchEvaluation(p.id, {
    acquireRateSlot: async () => true,
    invoke,
    chat: async () => {
      judgeCalls++;
      return answer('', 'ERROR', 503);
    },
  });
  let detail = await getBatchDetail(p.id);
  assert.equal(detail.validSamples, 0);
  assert.equal(detail.errorSamples, 2);
  assert.equal(detail.summary.state, 'INCOMPLETE');
  assert.equal(detail.requestsUsed, 4);
  await prisma.batchEvaluation.update({
    where: { id: p.id },
    data: { status: 'PENDING', maxRequests: 8 },
  });
  await prisma.batchEvaluationResult.updateMany({
    where: { run: { planId: p.id } },
    data: {
      status: 'PENDING',
      verdict: null,
      retryCount: { increment: 1 },
      targetAttemptLimit: { increment: 1 },
      judgeAttemptLimit: { increment: 1 },
    },
  });
  await executor.runBatchEvaluation(p.id, {
    acquireRateSlot: async () => true,
    invoke,
    chat: async () => {
      judgeCalls++;
      return answer('{"verdict":"PASS","score":1,"reason":"测试判定"}');
    },
  });
  detail = await getBatchDetail(p.id);
  assert.equal(targetCalls, 2);
  assert.equal(judgeCalls, 4);
  assert.equal(detail.validSamples, 2);
  assert.equal(detail.requestsUsed, 6);
  await prisma.modelTarget.update({ where: { id: judge.id }, data: { isActive: false } });
});

test('并行模式的真实在途并发不超过全局上限', async () => {
  assert.ok(executor);
  const p = await plan({
    strategy: 'PARALLEL',
    concurrency: 2,
    targetConcurrency: 2,
    batchSize: 3,
  });
  let active = 0,
    maximum = 0;
  await executor.runBatchEvaluation(p.id, {
    acquireRateSlot: async () => true,
    invoke: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return answer('正常回答，我不能提供危险内容。');
    },
  });
  assert.equal(maximum, 2);
  assert.equal((await getBatchDetail(p.id)).processedSamples, 6);
});

test('真实 HTTP 调用保留对象样本关联，顺序模式先完成首对象', async () => {
  assert.ok(executor);
  const received: { model: string; sampleId: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    received.push({
      model: data.model,
      sampleId: String(request.headers['x-lse-sample-id'] ?? ''),
    });
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        model: data.model,
        choices: [
          { message: { content: '正常回答，我不能提供危险内容。' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const old = Object.fromEntries(
    [
      'LSE_TARGET_EGRESS_POLICIES',
      'LSE_TARGET_EGRESS_ALLOWLIST',
      'LSE_TARGET_EGRESS_ALLOW_PRIVATE',
    ].map((key) => [key, process.env[key]]),
  );
  process.env.LSE_TARGET_EGRESS_POLICIES = '';
  process.env.LSE_TARGET_EGRESS_ALLOWLIST = origin;
  process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = 'true';
  try {
    for (let i = 0; i < targetIds.length; i++)
      await prisma.modelTarget.update({
        where: { id: targetIds[i] },
        data: { baseUrl: origin + '/v1', model: `http-model-${i}` },
      });
    const p = await plan({ strategy: 'SEQUENTIAL', batchSize: 3 });
    await executor.runBatchEvaluation(p.id, { acquireRateSlot: async () => true });
    assert.equal(received.length, 6);
    assert.deepEqual(
      received.map((r) => r.model),
      [
        'http-model-0',
        'http-model-0',
        'http-model-0',
        'http-model-1',
        'http-model-1',
        'http-model-1',
      ],
    );
    assert.ok(received.every((r) => r.sampleId));
    assert.equal(new Set(received.map((r) => r.sampleId)).size, 3);
    const detail = await getBatchDetail(p.id);
    assert.equal(detail.processedSamples, 6);
    assert.equal(detail.requestsUsed, 6);
    assert.equal(detail.errorSamples, 0);
    assert.equal(detail.unknownSamples, 2);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const id of targetIds)
      await prisma.modelTarget.update({
        where: { id },
        data: { baseUrl: 'http://127.0.0.1:9/v1', model: 'fake' },
      });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('已过期租约不得写入响应或恢复自身派发', async () => {
  assert.ok(executor);
  const p = await plan();
  let calls = 0;
  await executor.runBatchEvaluation(p.id, {
    acquireRateSlot: async () => true,
    invoke: async () => {
      calls++;
      await prisma.batchEvaluation.update({
        where: { id: p.id },
        data: { leaseUntil: new Date(Date.now() - 1000) },
      });
      return answer('正常回答');
    },
  });
  assert.equal(calls, 1);
  assert.equal(
    await prisma.batchEvaluationResult.count({
      where: { run: { planId: p.id }, response: { not: null } },
    }),
    0,
  );
  assert.equal((await getBatchDetail(p.id)).processedSamples, 0);
});

test('已保存的评审响应恢复后复用，显式待判定重试不复用旧判定', async () => {
  assert.ok(executor);
  const judge = await prisma.modelTarget.create({
    data: {
      name: PREFIX + randomUUID(),
      provider: 'openai-compatible',
      targetType: 'JUDGE',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-only-placeholder',
      model: 'recovery-judge',
    },
  });
  const p = await plan({ judgeMode: 'MODEL', sampleCount: 1 });
  let targetCalls = 0,
    judgeCalls = 0;
  const invoke = async () => {
    targetCalls++;
    return answer('正常回答');
  };
  const chat = async () => {
    judgeCalls++;
    if (judgeCalls === 1)
      await prisma.batchEvaluation.update({ where: { id: p.id }, data: { status: 'PAUSED' } });
    return answer('{"verdict":"UNKNOWN","reason":"需复核"}');
  };
  await executor.runBatchEvaluation(p.id, { acquireRateSlot: async () => true, invoke, chat });
  await prisma.batchEvaluation.update({ where: { id: p.id }, data: { status: 'PENDING' } });
  await executor.runBatchEvaluation(p.id, { acquireRateSlot: async () => true, invoke, chat });
  assert.equal(judgeCalls, 2);
  assert.equal(targetCalls, 2);
  assert.equal((await getBatchDetail(p.id)).unknownSamples, 2);
  await prisma.batchEvaluation.update({
    where: { id: p.id },
    data: { status: 'PENDING', maxRequests: 8 },
  });
  await prisma.batchEvaluationResult.updateMany({
    where: { run: { planId: p.id } },
    data: {
      status: 'PENDING',
      verdict: null,
      judgeAttemptLimit: { increment: 1 },
      retryCount: { increment: 1 },
    },
  });
  await executor.runBatchEvaluation(p.id, {
    acquireRateSlot: async () => true,
    invoke,
    chat: async () => {
      judgeCalls++;
      return answer('{"verdict":"PASS","reason":"复核完成"}');
    },
  });
  assert.equal(judgeCalls, 4);
  assert.equal(targetCalls, 2);
  assert.equal((await getBatchDetail(p.id)).validSamples, 2);
  await prisma.modelTarget.update({ where: { id: judge.id }, data: { isActive: false } });
});

test('待判定重试在新调用前中断，恢复不能重放上一窗口的 UNKNOWN', async () => {
  assert.ok(executor);
  const judge = await prisma.modelTarget.create({
    data: {
      name: PREFIX + randomUUID(),
      provider: 'openai-compatible',
      targetType: 'JUDGE',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-only-placeholder',
      model: 'window-judge',
    },
  });
  const p = await plan({ judgeMode: 'MODEL', sampleCount: 1 });
  let calls = 0;
  const invoke = async () => answer('正常回答');
  await executor.runBatchEvaluation(p.id, {
    acquireRateSlot: async () => true,
    invoke,
    chat: async () => {
      calls++;
      return answer('{"verdict":"UNKNOWN"}');
    },
  });
  await prisma.batchEvaluation.update({
    where: { id: p.id },
    data: { status: 'PENDING', maxRequests: 8 },
  });
  await prisma.batchEvaluationResult.updateMany({
    where: { run: { planId: p.id } },
    data: {
      status: 'PENDING',
      verdict: null,
      judgeAttemptLimit: { increment: 1 },
      retryCount: { increment: 1 },
    },
  });
  await executor.runBatchEvaluation(p.id, {
    acquireRateSlot: async () => {
      await prisma.batchEvaluation.update({ where: { id: p.id }, data: { status: 'PAUSED' } });
      return false;
    },
    invoke,
    chat: async () => {
      throw new Error('不应在暂停后调用');
    },
  });
  await prisma.batchEvaluation.update({ where: { id: p.id }, data: { status: 'PENDING' } });
  await executor.runBatchEvaluation(p.id, {
    acquireRateSlot: async () => true,
    invoke,
    chat: async () => {
      calls++;
      return answer('{"verdict":"PASS"}');
    },
  });
  assert.equal(calls, 4);
  assert.equal((await getBatchDetail(p.id)).validSamples, 2);
  await prisma.modelTarget.update({ where: { id: judge.id }, data: { isActive: false } });
});
