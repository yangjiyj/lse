import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReportInputData } from '../src/modules/reports/report-builder.js';
import type { ReportAiJudgment, ReportJudgeInput } from '../src/modules/reports/report-judge.js';
import { buildReportRiskContext } from '../src/modules/reports/report-risk-context.js';
import {
  buildReportGenerationPlan,
  executeReportGenerationPlan,
} from '../src/modules/reports/report-generation-plan.js';
import type { ReportKind, SpecializedReport } from '../src/modules/reports/specialized/types.js';

const now = new Date('2026-07-12T10:00:00.000Z');

function deliveryData(): ReportInputData {
  return {
    task: {
      id: 'generation-plan',
      name: '报告生成计划测试',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: ['rule-judge'],
      totalQuestions: 1,
      processedQuestions: 1,
      passedCount: 1,
      failedCount: 0,
      errorCount: 0,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      modelTarget: { name: '测试模型', provider: 'openai-compatible', model: 'test' },
      questionSets: [{ name: '通用题集', type: 'GENERAL', language: 'zh' }],
    },
    verdictCounts: { PASS: 1 },
    results: [
      {
        id: 'result-1',
        finalVerdict: 'PASS',
        status: 'SUCCESS',
        question: {
          content: '正常题',
          type: 'GENERAL',
          shouldRefuse: false,
          language: 'zh',
          severity: 'LOW',
          category: 'general',
        },
      },
    ],
    findings: [],
    engineRuns: [],
    wrongAnswers: [],
    generatedAt: now,
  };
}

const judgeInput: ReportJudgeInput = {
  totalQuestions: 1,
  executionPassRatePercent: 100,
  riskCount: 0,
  bySeverity: {},
  topRiskCategories: [],
  topRiskDomains: [],
  remediationCategories: [],
  hasAgentRisk: false,
};

function judgment(marker: string): ReportAiJudgment {
  return {
    source: 'llm',
    configured: true,
    posture: marker,
    topRisks: '无',
    remediationPriority: '复测',
    focus: '覆盖',
  };
}

function fakeReport(kind: ReportKind): SpecializedReport {
  return {
    kind,
    title: '测试报告',
    format: 'markdown',
    content: '测试',
    summary: {} as SpecializedReport['summary'],
    passRate: 1,
    totalQuestions: 1,
    riskDistribution: {
      bySeverity: {},
      byRiskCategory: {},
      byRiskDomain: {},
    },
  };
}

test('buildReportGenerationPlan：context 恰好构建一次并同时供 judgeInput 与适用性使用', () => {
  const data = deliveryData();
  let contextCount = 0;
  let summarizeCount = 0;
  let applicableCount = 0;
  let builtContext: ReturnType<typeof buildReportRiskContext> | undefined;

  const plan = buildReportGenerationPlan(data, {
    buildContext(input) {
      contextCount += 1;
      assert.strictEqual(input, data);
      builtContext = buildReportRiskContext(input);
      return builtContext;
    },
    summarize(input, context) {
      summarizeCount += 1;
      assert.strictEqual(input, data);
      assert.strictEqual(context, builtContext);
      return judgeInput;
    },
    applicableKinds(input, context) {
      applicableCount += 1;
      assert.strictEqual(input, data);
      assert.strictEqual(context, builtContext);
      return ['safety_overview', 'usability_over_refusal'];
    },
  });

  assert.equal(contextCount, 1);
  assert.equal(summarizeCount, 1);
  assert.equal(applicableCount, 1);
  assert.strictEqual(plan.context, builtContext);
  assert.strictEqual(plan.judgeInput, judgeInput);
  assert.deepEqual(plan.allowedKinds, [
    'comprehensive',
    'safety_overview',
    'usability_over_refusal',
  ]);
});

interface Counters {
  context: number;
  summarize: number;
  applicable: number;
  judge: number;
  redactJudgment: number;
  build: number;
}

async function execute(kind: ReportKind) {
  const data = deliveryData();
  const counters: Counters = {
    context: 0,
    summarize: 0,
    applicable: 0,
    judge: 0,
    redactJudgment: 0,
    build: 0,
  };
  let builtContext: ReturnType<typeof buildReportRiskContext> | undefined;
  let sanitized: ReportAiJudgment | undefined;

  const result = await executeReportGenerationPlan(kind, data, {
    buildContext(input) {
      counters.context += 1;
      assert.strictEqual(input, data);
      builtContext = buildReportRiskContext(input);
      return builtContext;
    },
    summarize(input, context) {
      counters.summarize += 1;
      assert.strictEqual(input, data);
      assert.strictEqual(context, builtContext);
      return judgeInput;
    },
    applicableKinds(input, context) {
      counters.applicable += 1;
      assert.strictEqual(input, data);
      assert.strictEqual(context, builtContext);
      return ['safety_overview', 'usability_over_refusal'];
    },
    async generateJudgment(input) {
      counters.judge += 1;
      assert.strictEqual(input, judgeInput);
      return judgment('UNTRUSTED_JUDGMENT_CANARY');
    },
    redactJudgment(input) {
      counters.redactJudgment += 1;
      assert.match(input.posture, /UNTRUSTED_JUDGMENT_CANARY/);
      sanitized = judgment('已脱敏研判');
      return sanitized;
    },
    buildReport(requestedKind, input, context) {
      counters.build += 1;
      assert.equal(requestedKind, kind);
      assert.strictEqual(input, data, '不得 judge 后 deep-clone 整份 deliveryData');
      assert.strictEqual(context, builtContext, 'build 必须复用 plan 的同一 context');
      if (counters.judge > 0) {
        assert.strictEqual(input.aiJudgment, sanitized);
      } else {
        assert.equal(input.aiJudgment, undefined);
      }
      return fakeReport(requestedKind);
    },
  });

  return { data, counters, builtContext, result };
}

test('executeReportGenerationPlan：不适用 kind 先拦截，judge/build 均不调用', async () => {
  const { counters, result } = await execute('prompt_injection_resilience');
  assert.equal(counters.context, 1);
  assert.equal(counters.summarize, 1);
  assert.equal(counters.applicable, 1);
  assert.equal(counters.judge, 0);
  assert.equal(counters.redactJudgment, 0);
  assert.equal(counters.build, 0);
  assert.equal(result.report, null);
  assert.deepEqual(result.plan.allowedKinds, [
    'comprehensive',
    'safety_overview',
    'usability_over_refusal',
  ]);
});

test('executeReportGenerationPlan：普通专项不调用总体 judge，build 复用 context 和 deliveryData 身份', async () => {
  const { data, counters, builtContext, result } = await execute('usability_over_refusal');
  assert.equal(counters.context, 1);
  assert.equal(counters.judge, 0);
  assert.equal(counters.redactJudgment, 0);
  assert.equal(counters.build, 1);
  assert.strictEqual(result.plan.context, builtContext);
  assert.equal(result.report?.kind, 'usability_over_refusal');
  assert.equal(data.aiJudgment, undefined);
});

for (const kind of ['comprehensive', 'safety_overview'] as const) {
  test(
    'executeReportGenerationPlan：' + kind + ' 调用一次 judge，仅脱敏 judgment 并保持 context 身份',
    async () => {
      const { data, counters, builtContext, result } = await execute(kind);
      assert.equal(counters.context, 1);
      assert.equal(counters.judge, 1);
      assert.equal(counters.redactJudgment, 1);
      assert.equal(counters.build, 1);
      assert.strictEqual(result.plan.context, builtContext);
      assert.equal(result.report?.kind, kind);
      assert.equal(data.aiJudgment?.posture, '已脱敏研判');
    },
  );
}
