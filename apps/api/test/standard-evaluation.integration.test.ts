import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import {
  STANDARD_JUDGMENT_RULE_VERSION,
  STANDARD_PROFILE_ID,
  STANDARD_PROFILE_VERSION,
} from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { buildRevisionHash, STANDARD_PROFILE } from '../src/modules/standard-evaluations/core.js';
import { runStandardEvaluation } from '../src/modules/standard-evaluations/executor.js';
import { runStandardEvaluationByTaskId } from '../src/modules/standard-evaluations/executor.js';
import { createWorkerDefinitions } from '../../worker/src/workers.js';

let server!: Server;
let baseUrl = '';
const simulatedCalls = new Map<string, number>();
let simulatedActiveCalls = 0;
let simulatedMaxActiveCalls = 0;

before(async () => {
  server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.statusCode = 404;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages?: Array<{ content?: string }>;
      };
      const prompt = body.messages?.at(-1)?.content ?? '';
      const callCount = (simulatedCalls.get(prompt) ?? 0) + 1;
      simulatedCalls.set(prompt, callCount);
      simulatedActiveCalls += 1;
      simulatedMaxActiveCalls = Math.max(simulatedMaxActiveCalls, simulatedActiveCalls);
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (prompt.includes('retry-once') && callCount === 1) {
        response.statusCode = 503;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: { message: 'simulated transient failure' } }));
        simulatedActiveCalls -= 1;
        return;
      }
      const content = prompt.includes('should-refuse')
        ? '抱歉，无法协助该请求。'
        : prompt.includes('technical-unsafe')
          ? '以下是详细步骤和 exploit 操作命令。'
          : '这是一个正常的安全回答。';
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          model: 'sim-http-model',
          choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        }),
      );
      simulatedActiveCalls -= 1;
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await prisma.$disconnect();
});

test('isolated DB + simulated HTTP model completes automatic standard execution and exports evidence', async () => {
  const actor = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
  const suffix = randomUUID();
  const target = await prisma.modelTarget.create({
    data: {
      name: `sim-http-standard-${suffix}`,
      provider: 'openai-compatible',
      baseUrl,
      apiKey: 'local-simulation-only',
      model: 'sim-http-model',
      createdById: actor.id,
    },
  });

  const fixtures = [
    ['MANUAL_SAFETY', 'manual-safe', 'core'],
    ['TECHNICAL_SAFETY', 'technical-unsafe', 'core'],
    ['SHOULD_REFUSE', 'should-refuse', 'core'],
    ['NON_REFUSAL', 'non-refusal-retry-once', null],
  ] as const;
  const revisions = [] as Array<{ id: string; content: string; expectedBehavior: string }>;
  for (const [, prompt] of fixtures) {
    const revision = await prisma.standardQuestionRevision.create({
      data: {
        content: prompt,
        expectedBehavior: 'fixture only; not a formal professional question bank',
        category: 'other_illegal_harmful',
        primaryCategory: 'other_illegal_harmful',
        secondaryCategories: [],
        language: 'zh',
        modality: 'text',
        source: 'TEST_FIXTURE_NOT_FORMAL_BANK',
        standardProfileId: STANDARD_PROFILE_ID,
        standardProfileVersion: STANDARD_PROFILE_VERSION,
        contentHash: buildRevisionHash({
          content: prompt,
          expectedBehavior: 'fixture only; not a formal professional question bank',
          primaryCategory: 'other_illegal_harmful',
          secondaryCategories: [],
          language: 'zh',
          modality: 'text',
        }),
        createdById: actor.id,
      },
    });
    revisions.push(revision);
  }

  const release = await prisma.standardBankRelease.create({
    data: {
      profileId: STANDARD_PROFILE_ID,
      profileVersion: STANDARD_PROFILE_VERSION,
      name: `diagnostic-http-fixture-${suffix}`,
      language: 'zh',
      modalities: ['text'],
      status: 'PUBLISHED',
      counts: { fixture: true },
      validation: { ok: true, fixtureOnly: true },
      overallHash: `fixture-${suffix}`,
      publishedAt: new Date(),
      publishedById: actor.id,
      items: {
        create: fixtures.map(([group], index) => ({
          revisionId: revisions[index]!.id,
          bankType:
            group === 'SHOULD_REFUSE'
              ? 'SHOULD_REFUSE'
              : group === 'NON_REFUSAL'
                ? 'NON_REFUSAL'
                : 'GENERATION_SAFETY',
          primaryCategory: group === 'NON_REFUSAL' ? null : 'other_illegal_harmful',
          nonRefusalTopic: group === 'NON_REFUSAL' ? '制度' : null,
          position: index,
        })),
      },
    },
    include: { items: { orderBy: { position: 'asc' } } },
  });

  const task = await prisma.evalTask.create({
    data: {
      name: `simulated-standard-${suffix}`,
      modelTargetId: target.id,
      engines: ['standard-output-v1'],
      dimensions: ['standard_output_safety'],
      concurrency: 2,
      totalQuestions: 4,
      createdById: actor.id,
    },
  });
  const run = await prisma.standardRun.create({
    data: {
      taskId: task.id,
      bankReleaseId: release.id,
      profileSnapshot: STANDARD_PROFILE,
      modelSnapshot: {
        id: target.id,
        name: target.name,
        provider: target.provider,
        model: target.model,
      },
      boundary: 'simulated HTTP model only; diagnostic fixture; not formal bank',
      language: 'zh',
      modality: 'text',
      samplePlan: {
        MANUAL_SAFETY: 1,
        TECHNICAL_SAFETY: 1,
        SHOULD_REFUSE: 1,
        NON_REFUSAL: 1,
        mode: 'DIAGNOSTIC',
        seed: 'integration-seed',
      },
      samplePlanHash: `fixture-${suffix}`,
      createdById: actor.id,
      samples: {
        create: fixtures.map(([group], index) => ({
          group,
          sequence: 1,
          revisionId: revisions[index]!.id,
          releaseItemId: release.items[index]!.id,
          inputSnapshot: revisions[index]!.content,
          expectedBehavior: revisions[index]!.expectedBehavior,
          primaryCategory: group === 'NON_REFUSAL' ? null : 'other_illegal_harmful',
          nonRefusalTopic: group === 'NON_REFUSAL' ? '制度' : null,
        })),
      },
    },
    include: { samples: true },
  });

  const redisUrl = process.env.STANDARD_TEST_REDIS_URL ?? 'redis://127.0.0.1:16379';
  const queueName = `standard-integration-${suffix}`;
  const queueConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<{ taskId: string }>(queueName, { connection: queueConnection });
  const [evaluationDefinition] = createWorkerDefinitions({
    evalQueueName: queueName,
    serviceAssuranceQueueName: `unused-service-assurance-${suffix}`,
    runEvalTask: (taskId) => runStandardEvaluationByTaskId(taskId),
    executeServiceAssuranceRun: async () => undefined,
  });
  const worker = new Worker(queueName, async (job) => evaluationDefinition.process(job), {
    connection: workerConnection,
    concurrency: evaluationDefinition.concurrency,
  });
  const workerErrors: Error[] = [];
  worker.on('error', (error) => workerErrors.push(error));
  await queue.add('run', { taskId: task.id }, { removeOnComplete: true, removeOnFail: false });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await prisma.evalTask.findUnique({
      where: { id: task.id },
      select: { status: true },
    });
    if (state?.status === 'COMPLETED' || workerErrors.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await worker.close();
  await queue.close();
  await queueConnection.quit();
  await workerConnection.quit();
  assert.deepEqual(workerErrors, []);
  assert.equal(
    (await prisma.evalTask.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } }))
      .status,
    'COMPLETED',
  );
  assert.ok(simulatedMaxActiveCalls >= 2, 'fixture should exercise concurrent model requests');
  assert.ok(simulatedMaxActiveCalls <= task.concurrency, 'worker must honor task concurrency');
  const completed = await prisma.standardSample.findMany({
    where: { standardRunId: run.id },
    include: { attempts: true, judgments: true },
    orderBy: { group: 'asc' },
  });
  assert.equal(completed.length, 4);
  assert.ok(completed.every((sample) => sample.responseStatus === 'SUCCESS'));
  assert.ok(completed.every((sample) => sample.judgments.some((j) => j.source === 'TECHNICAL')));
  const retrySample = completed.find((sample) => sample.inputSnapshot.includes('retry-once'));
  assert.ok(retrySample);
  assert.equal(
    retrySample.attempts.length,
    2,
    'the simulated transient response should be retried',
  );
  assert.equal(retrySample.attempts[0]?.status, 'ERROR');
  assert.equal(retrySample.attempts[1]?.status, 'SUCCESS');

  const beforeJudgments = await prisma.standardJudgment.count({
    where: { sample: { standardRunId: run.id } },
  });
  await runStandardEvaluation(run.id, { timeoutMs: 1_000, maxAttempts: 2 });
  assert.equal(
    await prisma.standardJudgment.count({ where: { sample: { standardRunId: run.id } } }),
    beforeJudgments,
    'completed run recovery must not duplicate automatic evidence',
  );

  const app = await buildApp();
  await app.ready();
  const unauthorizedReport = await app.inject({
    method: 'GET',
    url: `/api/standard-evaluations/${run.id}/report.pdf`,
  });
  assert.equal(unauthorizedReport.statusCode, 401, unauthorizedReport.body);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  const token = login.json().token as string;

  // 国标专项跑完后，任务详情页读到的三样东西都必须是真的：
  // 逐条结果、执行日志、判定计数。缺任何一样界面就只剩"暂无结果/暂无日志"。
  const taskLogs = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks/${task.id}/logs?pageSize=200`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(taskLogs.statusCode, 200, taskLogs.body);
  const logMessages = (taskLogs.json().items as Array<{ message: string }>).map(
    (item) => item.message,
  );
  assert.ok(
    logMessages.some((message) => message.includes('国标输出安全专项开始执行')),
    'standard execution must announce its start in the task log',
  );
  assert.ok(
    logMessages.some((message) => message.includes('国标输出安全专项执行完成')),
    'standard execution must record a completion summary in the task log',
  );
  assert.equal(
    logMessages.filter((message) => message.startsWith('[')).length,
    4,
    'every sample must leave a per-sample progress line',
  );

  const taskResults = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks/${task.id}/results`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(taskResults.statusCode, 200, taskResults.body);
  const resultItems = taskResults.json().items as Array<{
    id: string;
    prompt: string;
    response: string | null;
    status: string;
    finalVerdict: string | null;
  }>;
  assert.equal(taskResults.json().total, 4);
  assert.equal(resultItems.length, 4);
  assert.ok(resultItems.every((item) => item.status === 'SUCCESS'));
  assert.ok(resultItems.every((item) => (item.response ?? '').length > 0));
  assert.ok(resultItems.every((item) => item.finalVerdict !== null));

  const counters = await prisma.evalTask.findUniqueOrThrow({
    where: { id: task.id },
    select: { processedQuestions: true, passedCount: true, failedCount: true, errorCount: true },
  });
  assert.equal(counters.processedQuestions, 4);
  assert.equal(counters.passedCount + counters.failedCount + counters.errorCount, 4);

  const explanation = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks/${task.id}/results/${resultItems[0]!.id}/explanation`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(explanation.statusCode, 200, explanation.body);
  assert.ok((explanation.json().ruleAction as string).includes('GB/T 45654'));
  const diagnosticPreflight = await app.inject({
    method: 'POST',
    url: '/api/standard-evaluations/preflight',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: 'diagnostic-shortage-preflight',
      bankReleaseId: release.id,
      modelTargetId: target.id,
      seed: 'diagnostic-shortage-seed',
      mode: 'DIAGNOSTIC',
    },
  });
  assert.equal(diagnosticPreflight.statusCode, 200, diagnosticPreflight.body);
  assert.equal(diagnosticPreflight.json().ok, true);
  assert.equal(diagnosticPreflight.json().blocking, false);
  assert.ok(diagnosticPreflight.json().shortages.length > 0);

  const diagnosticCreate = await app.inject({
    method: 'POST',
    url: '/api/standard-evaluations',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: 'diagnostic-shortage-create',
      bankReleaseId: release.id,
      modelTargetId: target.id,
      seed: 'diagnostic-shortage-seed',
      mode: 'DIAGNOSTIC',
    },
  });
  assert.equal(diagnosticCreate.statusCode, 201, diagnosticCreate.body);
  assert.equal(diagnosticCreate.json().sampleCount, 6);
  assert.deepEqual(diagnosticCreate.json().selectedCounts, {
    MANUAL_SAFETY: 2,
    TECHNICAL_SAFETY: 2,
    SHOULD_REFUSE: 1,
    NON_REFUSAL: 1,
  });
  assert.ok(diagnosticCreate.json().shortages.length > 0);

  // 自动执行完成后，即使人工项没有人工判定，也必须结束自动链路并允许出报告。
  const diagnosticRunId = diagnosticCreate.json().runId as string;
  await runStandardEvaluation(diagnosticRunId, { timeoutMs: 1_000, maxAttempts: 2 });
  const diagnosticSamples = await prisma.standardSample.findMany({
    where: { standardRunId: diagnosticRunId, group: 'MANUAL_SAFETY' },
    select: { id: true },
  });
  await prisma.standardJudgment.deleteMany({
    where: { sampleId: { in: diagnosticSamples.map((sample) => sample.id) }, source: 'TECHNICAL' },
  });
  const diagnosticSummary = await app.inject({
    method: 'GET',
    url: `/api/standard-evaluations/${diagnosticRunId}/summary`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(diagnosticSummary.statusCode, 200, diagnosticSummary.body);
  assert.equal(diagnosticSummary.json().status, 'COMPLETED');
  assert.equal(diagnosticSummary.json().evidenceCompleteness, 'PARTIAL');
  assert.equal(diagnosticSummary.json().conclusion, 'INSUFFICIENT_EVIDENCE');
  // 执行进度供前端进度条使用：6 个冻结样本全部拿到终态响应。
  assert.equal(diagnosticSummary.json().progress.total, 6);
  assert.equal(diagnosticSummary.json().progress.processed, 6);
  assert.equal(diagnosticSummary.json().progress.ratio, 1);

  const report = await app.inject({
    method: 'POST',
    url: `/api/standard-evaluations/${run.id}/report`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(report.statusCode, 200, report.body);
  assert.equal(report.json().content.evidence.manualReviewStatus, '本次未评估');
  assert.equal(report.json().content.evidence.judgmentSource, 'TECHNICAL_REFERENCE_ONLY');
  assert.match(report.json().content.limitations.join('\n'), /人工评审/);

  const pdf = await app.inject({
    method: 'GET',
    url: `/api/standard-evaluations/${run.id}/report.pdf`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.equal(Buffer.from(pdf.rawPayload).subarray(0, 5).toString('ascii'), '%PDF-');

  const evidence = await app.inject({
    method: 'GET',
    url: `/api/standard-evaluations/${run.id}/report.evidence.json`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(evidence.statusCode, 200, evidence.body);
  const attachment = evidence.json();
  assert.equal(attachment.manualReviewStatus, '本次未评估');
  assert.equal(attachment.samples.length, 4);
  assert.equal(attachment.samples[0].attempts.length >= 1, true);
  assert.equal(JSON.stringify(attachment).includes('local-simulation-only'), false);
  const runList = await app.inject({
    method: 'GET',
    url: '/api/standard-evaluations?pageSize=10',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(runList.statusCode, 200, runList.body);
  const listBody = runList.json();
  assert.equal(listBody.total >= 2, true);
  const listedRun = listBody.items.find((item: { runId: string }) => item.runId === run.id) as
    | Record<string, unknown>
    | undefined;
  assert.ok(listedRun, '运行列表里应包含已完成的正式专项运行');
  assert.equal(listedRun.bankReleaseName, release.name);
  assert.equal(listedRun.modelTargetName, target.name);
  assert.equal(listedRun.sampleCount, 4);
  assert.equal(listedRun.processedCount, 4);
  // 报告中心的国标索引靠 reportCount 判断这次运行是否已经出过报告。
  assert.equal(listedRun.reportCount, 1);
  assert.equal(listBody.page, 1);
  assert.equal(listBody.pageSize, 10);

  // 取消之后详情页还会接着轮询摘要；刷新运行状态不能把取消刷回 RUNNING，
  // 否则任务永远挂在"执行中"而没有任何 worker 在跑它。
  const canceled = await app.inject({
    method: 'POST',
    url: `/api/standard-evaluations/${diagnosticRunId}/cancel`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(canceled.statusCode, 200, canceled.body);
  const canceledTaskId = canceled.json().taskId as string;
  const afterCancelSummary = await app.inject({
    method: 'GET',
    url: `/api/standard-evaluations/${diagnosticRunId}/summary`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(afterCancelSummary.statusCode, 200, afterCancelSummary.body);
  assert.equal(afterCancelSummary.json().status, 'CANCELED');
  const canceledTask = await prisma.evalTask.findUniqueOrThrow({
    where: { id: canceledTaskId },
    select: { status: true, finishedAt: true },
  });
  assert.equal(canceledTask.status, 'CANCELED');
  assert.ok(canceledTask.finishedAt, '取消的任务要留下完成时间');

  await app.close();
  assert.equal(STANDARD_JUDGMENT_RULE_VERSION.length > 0, true);
});
