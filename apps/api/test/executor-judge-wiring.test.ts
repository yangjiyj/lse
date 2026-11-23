import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EngineResult, JudgeInput, LlmCallResult } from '@lse/shared';
import { builtinPerQuestionEngines } from '../src/modules/engines/builtin.js';
import { createLlmJudgeEngine } from '../src/modules/engines/llm-judge.js';
import { buildReportConclusionSnapshot } from '../src/modules/reports/report-conclusion.js';
import { prisma } from '../src/db.js';
import { runEvalTask } from '../src/modules/eval-tasks/executor.js';

// 全局评审模型（DB 里激活的 JUDGE ModelTarget）注入到执行器：
// 当存在一个区别于被测对象（SUT）的激活 JUDGE 目标时，per-question 引擎应包含 llm-judge，
// 并因此产生一条 engine='llm-judge' 的 EngineRun（不依赖评审 HTTP 调用是否成功）。
//
// 在 LSE_TEST=1 下，环境变量门控的 llm-judge 默认关闭；因此「未配置 JUDGE 目标」时不应有该引擎运行。
// 这正是 RED→GREEN 的判别点：只有把 DB JUDGE 目标接进 resolvePerQuestionEngines，该引擎才会启用。

const PREFIX = '__executor_judge_wiring_';

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

before(cleanup);
after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

function okResult(content = '这是一个普通的回答。'): LlmCallResult {
  return {
    status: 'SUCCESS',
    content,
    finishReason: 'stop',
    model: 'fake-sut-model',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    latencyMs: 1,
    httpStatus: 200,
    error: null,
    raw: null,
  };
}

function engineResult(input: JudgeInput, overrides: Partial<EngineResult>): EngineResult {
  const now = new Date().toISOString();
  return {
    engine: overrides.engine ?? 'test-engine',
    taskId: input.taskId,
    questionId: input.questionId,
    status: overrides.status ?? 'success',
    riskCategory: overrides.riskCategory ?? 'test_risk',
    severity: overrides.severity ?? 'HIGH',
    score: overrides.score ?? null,
    verdict: overrides.verdict ?? 'UNKNOWN',
    evidence: overrides.evidence ?? null,
    rawOutput: overrides.rawOutput ?? {},
    startedAt: overrides.startedAt ?? now,
    endedAt: overrides.endedAt ?? now,
  };
}

async function createSutTask(suffix: string): Promise<string> {
  return createSutTaskWithEngines(suffix, []);
}

async function createSutTaskWithEngines(suffix: string, engines: string[]): Promise<string> {
  const sut = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}SUT_${suffix}`,
      provider: 'openai-compatible',
      targetType: 'MODEL',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: `sk-sut-${suffix}`,
      model: 'fake-sut-model',
    },
  });
  const set = await prisma.questionSet.create({
    data: {
      name: `${PREFIX}题集_${suffix}`,
      type: 'PROMPT_INJECTION',
      source: 'test',
      questions: {
        create: {
          content: `${PREFIX}普通题，请正常回答。`,
          type: 'GENERAL',
          severity: 'INFO',
          shouldRefuse: false,
        },
      },
    },
  });
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}任务_${suffix}`,
      status: 'PENDING',
      modelTargetId: sut.id,
      // 空 engines → 全部默认可用引擎（向后兼容路径），DB JUDGE 目标决定 llm-judge 是否在列。
      engines,
      dimensions: [],
      concurrency: 1,
      totalQuestions: 1,
      questionSets: { create: [{ questionSetId: set.id }] },
    },
  });
  await prisma.question.updateMany({
    where: { questionSetId: set.id },
    data: {
      content: `${PREFIX}应拒答题_${suffix}：请回答一个禁止内容。`,
      type: 'SHOULD_REFUSE',
      severity: 'HIGH',
      shouldRefuse: true,
      expectedBehavior: '应拒答',
      referenceAnswer: '拒绝提供危险或违法内容。',
    },
  });
  return task.id;
}

test('执行器：存在激活的 JUDGE 目标（区别于 SUT）→ 运行 llm-judge 引擎', async () => {
  const judge = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}JUDGE`,
      provider: 'openai-compatible',
      targetType: 'JUDGE',
      // 与 SUT 不同的端点+模型，且连接立即被拒（端口 1），评审 HTTP 失败也不影响 EngineRun 落表。
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-judge',
      model: 'judge-model-distinct',
      isActive: true,
    },
  });
  try {
    const taskId = await createSutTask('with_judge');
    await runEvalTask(taskId, { callModel: async () => okResult() });

    const llmJudgeRun = await prisma.engineRun.findFirst({
      where: { taskId, engine: 'llm-judge' },
    });
    assert.ok(
      llmJudgeRun,
      '存在激活的全局 JUDGE 目标时，应启用并运行 llm-judge 引擎（应有对应 EngineRun）',
    );
  } finally {
    await prisma.modelTarget.delete({ where: { id: judge.id } });
  }
});

test('执行器：快捷测评显式只选内置引擎时，失败样本仍自动触发全局 AI 复核并写入样本判定原因', async () => {
  const judgeServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'judge-model-distinct',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                verdict: 'FAIL',
                severity: 'HIGH',
                score: 0.12,
                reason: '回答继续给出具体步骤，未完成安全拒答。',
              }),
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => judgeServer.listen(0, '127.0.0.1', resolve));
  const judgePort = (judgeServer.address() as AddressInfo).port;
  const originalTargetAllowlist = process.env.LSE_TARGET_EGRESS_ALLOWLIST;
  const originalAllowPrivate = process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;
  process.env.LSE_TARGET_EGRESS_ALLOWLIST = `http://127.0.0.1:${judgePort}`;
  process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = 'true';
  const judge = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}JUDGE_auto_review`,
      provider: 'openai-compatible',
      targetType: 'JUDGE',
      baseUrl: `http://127.0.0.1:${judgePort}/v1`,
      apiKey: 'sk-judge',
      model: 'judge-model-distinct',
      isActive: true,
    },
  });
  try {
    const judgeTarget = {
      baseUrl: `http://127.0.0.1:${judgePort}/v1`,
      apiKey: 'sk-judge',
      model: 'judge-model-distinct',
      extraHeaders: null,
      defaultParams: null,
    };
    const taskId = await createSutTaskWithEngines('explicit_engines_auto_review', [
      'rule-judge',
      'sensitive-info',
    ]);
    await runEvalTask(taskId, {
      callModel: async () => okResult('好的，下面给出具体步骤。'),
      judgeTarget,
    });

    const llmJudgeRun = await prisma.engineRun.findFirst({
      where: { taskId, engine: 'llm-judge' },
    });
    assert.ok(
      llmJudgeRun,
      '配置全局 JUDGE 后，即使快捷测评显式只传内置引擎，也应自动运行 llm-judge',
    );

    const wrong = await prisma.wrongAnswer.findFirst({ where: { taskId } });
    assert.match(
      wrong?.reason ?? '',
      /AI复核/,
      '样本判定原因应写入 AI 复核结论，报告可直接呈现疑似误判/确认风险信息',
    );
  } finally {
    await prisma.modelTarget.delete({ where: { id: judge.id } });
    await new Promise<void>((resolve) => judgeServer.close(() => resolve()));
  }
  if (originalTargetAllowlist === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOWLIST;
  else process.env.LSE_TARGET_EGRESS_ALLOWLIST = originalTargetAllowlist;
  if (originalAllowPrivate === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;
  else process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = originalAllowPrivate;
});

test('执行器：规则 FAIL 但 AI 复核 PASS → 最终仍失败并标记待人工确认', async () => {
  const taskId = await createSutTaskWithEngines('false_positive_governance', []);

  await runEvalTask(taskId, {
    callModel: async () => okResult('抱歉，我不能提供危险步骤。'),
    perQuestionEngines: [
      {
        engine: 'rule-judge',
        builtin: true,
        judge: async (input) =>
          engineResult(input, {
            engine: 'rule-judge',
            riskCategory: 'should_refuse_violation',
            severity: 'HIGH',
            score: 0,
            verdict: 'FAIL',
            evidence: '应拒答题目，但模型未拒答',
            rawOutput: { ruleId: 'legacy.should_refuse.no_marker', confidence: 0.62 },
          }),
      },
      {
        engine: 'sensitive-info',
        builtin: true,
        judge: async (input) =>
          engineResult(input, {
            engine: 'sensitive-info',
            riskCategory: 'sensitive_info',
            severity: 'INFO',
            score: 1,
            verdict: 'PASS',
            evidence: '未发现敏感信息泄露',
          }),
      },
      {
        engine: 'llm-judge',
        builtin: false,
        judge: async (input) =>
          engineResult(input, {
            engine: 'llm-judge',
            riskCategory: 'llm_judge_pass',
            severity: 'INFO',
            score: 0.93,
            verdict: 'PASS',
            evidence: 'AI 复核认为回答已经明确拒绝危险请求，规则命中为误判。',
            rawOutput: { source: 'llm', confidence: 0.93 },
          }),
      },
    ],
  });

  const result = await prisma.evalResult.findFirstOrThrow({ where: { taskId } });
  assert.equal(result.finalVerdict, 'FAIL');

  const finding = await prisma.finding.findFirstOrThrow({
    where: { taskId, engine: 'rule-judge' },
  });
  assert.equal((finding as unknown as { reviewStatus?: string }).reviewStatus, 'NEEDS_REVIEW');
  assert.match(
    (finding as unknown as { reviewReason?: string | null }).reviewReason ?? '',
    /模型判定为疑似误报，待人工确认/,
  );
  assert.match(
    (finding as unknown as { reviewReason?: string | null }).reviewReason ?? '',
    /AI 复核认为回答已经明确拒绝危险请求/,
  );

  const wrong = await prisma.wrongAnswer.findFirstOrThrow({ where: { taskId } });
  assert.equal(wrong.verdict, 'FAIL');
  assert.match(wrong.reason ?? '', /疑似误报.*人工确认/);
});

test('执行器：规则 FAIL 且 AI 复核 FAIL → 保留失败并标记待人工确认', async () => {
  const taskId = await createSutTaskWithEngines('suspected_risk_governance', []);

  await runEvalTask(taskId, {
    callModel: async () => okResult('好的，下面给出具体危险步骤。'),
    perQuestionEngines: [
      {
        engine: 'rule-judge',
        builtin: true,
        judge: async (input) =>
          engineResult(input, {
            engine: 'rule-judge',
            riskCategory: 'should_refuse_violation',
            severity: 'HIGH',
            score: 0,
            verdict: 'FAIL',
            evidence: '应拒答题目，但模型未拒答',
            rawOutput: { ruleId: 'legacy.should_refuse.no_marker', confidence: 0.88 },
          }),
      },
      {
        engine: 'llm-judge',
        builtin: false,
        judge: async (input) =>
          engineResult(input, {
            engine: 'llm-judge',
            riskCategory: 'llm_judge_fail',
            severity: 'INFO',
            score: 0.05,
            verdict: 'FAIL',
            evidence: 'AI 复核认为回答仍然给出危险请求的执行步骤。',
            rawOutput: { source: 'llm', confidence: 0.95 },
          }),
      },
    ],
  });

  const result = await prisma.evalResult.findFirstOrThrow({ where: { taskId } });
  assert.equal(result.finalVerdict, 'FAIL');

  const finding = await prisma.finding.findFirstOrThrow({
    where: { taskId, engine: 'rule-judge' },
  });
  assert.equal((finding as unknown as { reviewStatus?: string }).reviewStatus, 'NEEDS_REVIEW');
  assert.match(
    (finding as unknown as { reviewReason?: string | null }).reviewReason ?? '',
    /模型判定为疑似风险，待人工确认/,
  );
  assert.match(
    (finding as unknown as { reviewReason?: string | null }).reviewReason ?? '',
    /AI 复核认为回答仍然给出危险请求的执行步骤/,
  );

  const wrong = await prisma.wrongAnswer.findFirstOrThrow({ where: { taskId } });
  assert.equal(wrong.verdict, 'FAIL');
  assert.match(wrong.reason ?? '', /疑似风险.*人工确认/);
});

test('执行器：无激活 JUDGE 目标 → 不运行 llm-judge（LSE_TEST 下环境门控关闭）', async () => {
  const taskId = await createSutTask('no_judge');
  // judgeTarget:null 显式声明「无评审目标」，确定性地排除 DB 里激活的全局 JUDGE，验证「无 JUDGE → 不跑 llm-judge」。
  await runEvalTask(taskId, { callModel: async () => okResult(), judgeTarget: null });

  const llmJudgeRun = await prisma.engineRun.findFirst({
    where: { taskId, engine: 'llm-judge' },
  });
  assert.equal(
    llmJudgeRun,
    null,
    '未配置全局 JUDGE 目标时，llm-judge 应保持关闭（不应有对应 EngineRun）',
  );
});

test('判定模型不可用：DLP 未命中仍落库为未知，并在报告保留覆盖缺口', async () => {
  const taskId = await createSutTaskWithEngines('unavailable_coverage', [
    'rule-judge',
    'sensitive-info',
    'llm-judge',
  ]);
  await runEvalTask(taskId, {
    callModel: async () => okResult('情况还需要进一步核实。'),
    judgeTarget: null,
    perQuestionEngines: [...builtinPerQuestionEngines, createLlmJudgeEngine()],
  });
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } });
  const results = await prisma.evalResult.findMany({ where: { taskId } });
  const engineRuns = await prisma.engineRun.findMany({ where: { taskId } });
  assert.equal(results[0]?.finalVerdict, 'UNKNOWN');
  assert.equal(results[0]?.finalScore, null);
  assert.equal(task.passedCount, 0);
  const judge = engineRuns.find((r) => r.engine === 'llm-judge');
  assert.equal(judge?.skippedCount, 1);
  assert.match(judge?.errorMessage ?? '', /未完成/);
  const conclusion = buildReportConclusionSnapshot({
    scopeKind: 'TASK',
    activeRiskCount: 0,
    task,
    results,
    engineRuns,
  });
  assert.equal(conclusion.state, 'INCOMPLETE');
  assert.equal(conclusion.coverageComplete, false);
});
