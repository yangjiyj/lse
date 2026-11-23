import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmCallResult } from '@lse/shared';
import type { ReportFinding, ReportInputData } from '../src/modules/reports/report-builder.js';
import {
  buildLocalReportJudgment,
  generateReportJudgment,
  summarizeForJudge,
  type ReportJudgeInput,
} from '../src/modules/reports/report-judge.js';
import { buildReportRiskContext } from '../src/modules/reports/report-risk-context.js';

const now = new Date('2026-07-12T08:00:00.000Z');

function finding(overrides: Partial<ReportFinding> = {}): ReportFinding {
  return {
    resultId: 'result-1',
    engine: 'rule-judge',
    riskCategory: 'forbidden_content',
    severity: 'HIGH',
    verdict: 'FAIL',
    evidence: '风险证据',
    title: '风险标题',
    reviewStatus: 'CONFIRMED',
    ...overrides,
  };
}

function reportData(overrides: Partial<ReportInputData> = {}): ReportInputData {
  return {
    task: {
      id: 'judge-risk-context',
      name: '研判风险上下文测试',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: ['rule-judge', 'agent-tool-guard'],
      totalQuestions: 3,
      processedQuestions: 3,
      passedCount: 1,
      failedCount: 9,
      errorCount: 0,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      modelTarget: { name: '测试模型', provider: 'openai-compatible', model: 'test' },
      questionSets: [{ name: '通用题集', type: 'GENERAL', language: 'zh' }],
    },
    verdictCounts: { PASS: 1, FAIL: 1, UNKNOWN: 1 },
    results: [
      {
        id: 'result-1',
        prompt: '普通输入',
        response: '普通输出',
        finalVerdict: 'FAIL',
        status: 'SUCCESS',
        question: {
          content: '普通题目',
          type: 'GENERAL',
          shouldRefuse: false,
          language: 'zh',
          severity: 'HIGH',
          category: 'general',
        },
      },
      {
        id: 'result-pass',
        prompt: '正常输入',
        response: '正常输出',
        finalVerdict: 'PASS',
        status: 'SUCCESS',
        question: {
          content: '正常题目',
          type: 'GENERAL',
          shouldRefuse: false,
          language: 'zh',
          severity: 'HIGH',
          category: 'general',
        },
      },
      {
        id: 'result-unknown',
        prompt: '待判输入',
        response: '待判输出',
        finalVerdict: 'UNKNOWN',
        status: 'SUCCESS',
        question: {
          content: '待判题目',
          type: 'GENERAL',
          shouldRefuse: false,
          language: 'zh',
          severity: 'HIGH',
          category: 'general',
        },
      },
    ],
    findings: [],
    engineRuns: [],
    wrongAnswers: [],
    generatedAt: now,
    ...overrides,
  };
}

test('summarizeForJudge：task.failedCount 不参与研判，同 result 双 Finding 只计一项题级风险', () => {
  const data = reportData({
    findings: [
      finding({ severity: 'CRITICAL', riskCategory: 'forbidden_content' }),
      finding({
        engine: 'llm-judge',
        severity: 'MEDIUM',
        riskCategory: 'prompt_injection',
      }),
    ],
  });
  const context = buildReportRiskContext(data);
  const input = summarizeForJudge(data, context);

  assert.equal(context.activeRisks.length, 1);
  assert.equal(input.riskCount, 1);
  assert.equal(input.totalQuestions, 3);
  assert.equal(input.executionPassRatePercent, 50);
  assert.deepEqual(input.bySeverity, { 严重: 1 });
  assert.equal('taskName' in input, false);
  assert.equal('failedCount' in input, false);
  assert.equal('passRatePercent' in input, false);
});

test('summarizeForJudge：FP-only 排除，ACCEPTED_RISK 仍计有效风险', () => {
  const fpData = reportData({
    findings: [finding({ reviewStatus: 'FALSE_POSITIVE' })],
  });
  const fpContext = buildReportRiskContext(fpData);
  assert.equal(summarizeForJudge(fpData, fpContext).riskCount, 0);

  const acceptedData = reportData({
    findings: [finding({ reviewStatus: 'ACCEPTED_RISK' })],
  });
  const acceptedContext = buildReportRiskContext(acceptedData);
  assert.equal(summarizeForJudge(acceptedData, acceptedContext).riskCount, 1);
});

test('summarizeForJudge：hasAgentRisk 只取 context.activeFindings 的有效 Agent 证据', () => {
  const noRiskData = reportData({
    task: {
      ...reportData().task,
      dimensions: ['agent_tool_call'],
    },
  });
  assert.equal(
    summarizeForJudge(noRiskData, buildReportRiskContext(noRiskData)).hasAgentRisk,
    false,
  );

  const fpAgentData = reportData({
    findings: [
      finding({
        engine: 'agent-tool-guard',
        riskCategory: 'agent_tool_abuse',
        reviewStatus: 'FALSE_POSITIVE',
      }),
    ],
  });
  assert.equal(
    summarizeForJudge(fpAgentData, buildReportRiskContext(fpAgentData)).hasAgentRisk,
    false,
  );

  const acceptedAgentData = reportData({
    findings: [
      finding({
        engine: 'agent-tool-guard',
        riskCategory: 'agent_tool_abuse',
        reviewStatus: 'ACCEPTED_RISK',
      }),
    ],
  });
  assert.equal(
    summarizeForJudge(acceptedAgentData, buildReportRiskContext(acceptedAgentData)).hasAgentRisk,
    true,
  );

  const mixedRepresentativeData = reportData({
    findings: [
      finding({
        engine: 'rule-judge',
        riskCategory: 'forbidden_content',
        severity: 'CRITICAL',
      }),
      finding({
        engine: 'agent-tool-guard',
        riskCategory: 'agent_tool_abuse',
        severity: 'MEDIUM',
      }),
    ],
  });
  const mixedContext = buildReportRiskContext(mixedRepresentativeData);
  assert.equal(mixedContext.activeRisks[0]!.representative.riskCategory, 'forbidden_content');
  assert.equal(summarizeForJudge(mixedRepresentativeData, mixedContext).hasAgentRisk, true);
});

const judgeCategoryCases = [
  { code: 'prompt_injection', engine: 'rule-judge', expected: '提示注入' },
  { code: 'redteam_finding_17', engine: 'ai-infra-guard', expected: '红队发现项 #17' },
  { code: 'CANARY_UNKNOWN_CATEGORY_51Z', engine: 'rule-judge', expected: '其他安全风险' },
  { code: '__proto__', engine: 'rule-judge', expected: '其他安全风险' },
  { code: 'constructor', engine: 'rule-judge', expected: '其他安全风险' },
  {
    code: 'CANARY_GATEWAY_CATEGORY_52Y',
    engine: 'newapi-agent-security-gateway',
    expected: '网关策略事件',
  },
  { code: 'CANARY_GARAK_CATEGORY_53X', engine: 'garak', expected: '红队发现' },
  { code: 'CANARY_PYRIT_CATEGORY_54W', engine: 'pyrit', expected: '红队发现' },
] as const;

for (const categoryCase of judgeCategoryCases) {
  for (const hasDetails of [true, false]) {
    test(`summarizeForJudge：封闭类别标签 ${categoryCase.code}（${hasDetails ? '有' : '无'}证据标题）`, () => {
      const data = reportData({
        findings: [
          finding({
            riskCategory: categoryCase.code,
            engine: categoryCase.engine,
            evidence: hasDetails ? '已脱敏证据' : null,
            title: hasDetails ? '已脱敏标题' : null,
          }),
        ],
      });
      const input = summarizeForJudge(data, buildReportRiskContext(data));
      const serialized = JSON.stringify(input);

      assert.equal(input.riskCount, 1);
      assert.deepEqual(input.topRiskCategories, [{ label: categoryCase.expected, count: 1 }]);
      assert.deepEqual(input.remediationCategories, [categoryCase.expected]);
      assert.equal(
        serialized.includes(categoryCase.code),
        false,
        `总体研判不得外发原始类别 ${categoryCase.code}`,
      );
    });
  }
}

function judgeInput(overrides: Partial<ReportJudgeInput> = {}): ReportJudgeInput {
  return {
    totalQuestions: 5,
    executionPassRatePercent: 60,
    riskCount: 2,
    bySeverity: { 高危: 1, 中危: 1 },
    topRiskCategories: [{ label: '高风险请求越界', count: 1 }],
    topRiskDomains: [{ label: '有害能力/高风险请求风险', count: 1 }],
    remediationCategories: ['高风险请求越界'],
    hasAgentRisk: false,
    ...overrides,
  };
}

test('buildLocalReportJudgment：只陈述有效风险与本次覆盖，不写失败样本、上线或合规硬结论', () => {
  const withRisk = buildLocalReportJudgment(judgeInput());
  assert.match(withRisk.posture, /本次定向样本范围标记 2 项风险/);
  assert.match(withRisk.posture, /待人工复核 2 项/);
  assert.doesNotMatch(JSON.stringify(withRisk), /失败样本|上线|合规/);

  const noRisk = buildLocalReportJudgment(
    judgeInput({
      executionPassRatePercent: 100,
      riskCount: 0,
      bySeverity: {},
      topRiskCategories: [],
      topRiskDomains: [],
      remediationCategories: [],
    }),
  );
  assert.match(noRisk.posture, /本次已完成范围.*未形成风险项/);
  assert.match(JSON.stringify(noRisk), /仅覆盖本次样本与引擎/);
  assert.doesNotMatch(JSON.stringify(noRisk), /上线|合规/);
});

function okResult(content: string): LlmCallResult {
  return {
    status: 'SUCCESS',
    content,
    finishReason: 'stop',
    model: 'test-model',
    usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    latencyMs: 1,
    httpStatus: 200,
    error: null,
    raw: {},
  };
}

test('研判模型输入只含聚合标签与计数，不泄漏 result、WrongAnswer、Finding 文本 canary', async () => {
  const canaries = {
    task: 'CANARY_TASK_NAME_91A',
    resultPrompt: 'CANARY_RESULT_PROMPT_92B',
    resultResponse: 'CANARY_RESULT_RESPONSE_93C',
    question: 'CANARY_QUESTION_CONTENT_94D',
    wrongQuestion: 'CANARY_WA_QUESTION_95E',
    wrongResponse: 'CANARY_WA_RESPONSE_96F',
    wrongCategory: 'CANARY_WA_CATEGORY_97G',
    wrongEngine: 'CANARY_WA_ENGINE_98H',
    wrongReason: 'CANARY_WA_REASON_99I',
    findingCategory: 'CANARY_FINDING_CATEGORY_83M',
    findingTitle: 'CANARY_FINDING_TITLE_90J',
    findingEvidence: 'CANARY_FINDING_EVIDENCE_81K',
    findingDetail: 'CANARY_FINDING_DETAIL_82L',
  };
  const data = reportData({
    task: { ...reportData().task, name: canaries.task },
    results: [
      {
        id: 'result-1',
        prompt: canaries.resultPrompt,
        response: canaries.resultResponse,
        finalVerdict: 'FAIL',
        status: 'SUCCESS',
        question: {
          content: canaries.question,
          type: 'GENERAL',
          shouldRefuse: false,
          language: 'zh',
          severity: 'HIGH',
          category: 'general',
        },
      },
    ],
    findings: [
      finding({
        riskCategory: canaries.findingCategory,
        title: canaries.findingTitle,
        evidence: canaries.findingEvidence,
        detail: { marker: canaries.findingDetail },
      }),
    ],
    wrongAnswers: [
      {
        resultId: 'result-1',
        questionContent: canaries.wrongQuestion,
        modelResponse: canaries.wrongResponse,
        riskCategory: canaries.wrongCategory,
        severity: 'HIGH',
        engine: canaries.wrongEngine,
        reason: canaries.wrongReason,
      },
    ],
  });
  const context = buildReportRiskContext(data);
  const input = summarizeForJudge(data, context);
  let captured = '';

  await generateReportJudgment(input, {
    target: {
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      model: 'test-model',
      extraHeaders: null,
      defaultParams: null,
    },
    callModel: async (_target, messages) => {
      captured = messages.map((message) => message.content).join('\n');
      return okResult(
        JSON.stringify({
          posture: '聚合态势',
          topRisks: '聚合风险',
          remediationPriority: '聚合整改',
          focus: '聚合重点',
          gatewayNote: '',
        }),
      );
    },
  });

  const serializedInput = JSON.stringify(input);
  for (const canary of Object.values(canaries)) {
    assert.doesNotMatch(serializedInput, new RegExp(canary));
    assert.doesNotMatch(captured, new RegExp(canary));
  }
  assert.match(captured, /riskCount|executionPassRatePercent|topRiskCategories/);
});
