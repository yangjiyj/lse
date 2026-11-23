import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReportInputData } from '../src/modules/reports/report-builder.js';
import { buildTaskReport } from '../src/modules/reports/report-builder.js';
import { summarizeForJudge } from '../src/modules/reports/report-judge.js';
import { buildReportRiskContext } from '../src/modules/reports/report-risk-context.js';
import { buildSafetyOverviewReport } from '../src/modules/reports/specialized/safety-overview.js';
import { buildComprehensiveReport } from '../src/modules/reports/specialized/comprehensive.js';

const now = new Date('2026-07-12T09:00:00.000Z');

function invariantData(): ReportInputData {
  return {
    task: {
      id: 'risk-consumer-invariants',
      name: '风险消费者一致性测试',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: ['rule-judge', 'agent-tool-guard', 'ai-infra-guard'],
      totalQuestions: 3,
      processedQuestions: 3,
      passedCount: 0,
      failedCount: 9,
      errorCount: 0,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      modelTarget: { name: '测试模型', provider: 'openai-compatible', model: 'test' },
      questionSets: [
        { name: '综合题集', type: 'GENERAL', language: 'zh' },
        { name: '提示注入题集', type: 'PROMPT_INJECTION', language: 'zh' },
      ],
    },
    verdictCounts: { FAIL: 3 },
    results: [
      {
        id: 'risk-shared',
        finalVerdict: 'FAIL',
        status: 'SUCCESS',
        question: {
          content: '综合风险题',
          type: 'GENERAL',
          shouldRefuse: false,
          language: 'zh',
          severity: 'CRITICAL',
          category: 'Agent 工具调用',
        },
      },
      {
        id: 'risk-accepted',
        finalVerdict: 'FAIL',
        status: 'SUCCESS',
        question: {
          content: '提示注入题',
          type: 'PROMPT_INJECTION',
          shouldRefuse: false,
          language: 'zh',
          severity: 'HIGH',
          category: 'prompt injection',
        },
      },
      {
        id: 'risk-fp',
        finalVerdict: 'FAIL',
        status: 'SUCCESS',
        question: {
          content: '组件误报题',
          type: 'GENERAL',
          shouldRefuse: false,
          language: 'zh',
          severity: 'HIGH',
          category: 'component',
        },
      },
    ],
    findings: [
      {
        resultId: 'risk-shared',
        engine: 'rule-judge',
        riskCategory: 'forbidden_content',
        severity: 'CRITICAL',
        verdict: 'FAIL',
        evidence: '禁止内容有效风险',
        title: '禁止内容',
        reviewStatus: 'CONFIRMED',
      },
      {
        resultId: 'risk-shared',
        engine: 'agent-tool-guard',
        riskCategory: 'agent_tool_abuse',
        severity: 'MEDIUM',
        verdict: 'FAIL',
        evidence: 'Agent 有效旁证',
        title: 'Agent 越权',
        reviewStatus: 'CONFIRMED',
      },
      {
        resultId: 'risk-accepted',
        engine: 'rule-judge',
        riskCategory: 'prompt_injection',
        severity: 'HIGH',
        verdict: 'FAIL',
        evidence: '已接受提示注入残余风险',
        title: '提示注入',
        reviewStatus: 'ACCEPTED_RISK',
      },
      {
        resultId: 'risk-fp',
        engine: 'ai-infra-guard',
        riskCategory: 'component_vulnerability',
        severity: 'HIGH',
        verdict: 'FAIL',
        evidence: '组件误报',
        title: '组件误报',
        reviewStatus: 'FALSE_POSITIVE',
      },
    ],
    engineRuns: [
      {
        engine: 'rule-judge',
        status: 'SUCCESS',
        normalizedCount: 3,
        skippedCount: 0,
        durationMs: 10,
        errorMessage: null,
      },
      {
        engine: 'agent-tool-guard',
        status: 'SUCCESS',
        normalizedCount: 1,
        skippedCount: 0,
        durationMs: 10,
        errorMessage: null,
      },
    ],
    wrongAnswers: [
      {
        resultId: 'risk-shared',
        questionContent: '综合风险题',
        modelResponse: '风险回答',
        riskCategory: 'forbidden_content',
        severity: 'CRITICAL',
        engine: 'rule-judge',
        reason: '综合风险原因',
      },
      {
        resultId: 'risk-accepted',
        questionContent: '提示注入题',
        modelResponse: '注入回答',
        riskCategory: 'prompt_injection',
        severity: 'HIGH',
        engine: 'rule-judge',
        reason: '提示注入原因',
      },
      {
        resultId: 'risk-fp',
        questionContent: '组件误报题',
        modelResponse: '误报回答',
        riskCategory: 'component_vulnerability',
        severity: 'HIGH',
        engine: 'ai-infra-guard',
        reason: '误报原因',
      },
    ],
    generatedAt: now,
  };
}

test('总体 base / safety / comprehensive 与 judge 共享同一题级有效风险不变量', () => {
  const data = invariantData();
  const context = buildReportRiskContext(data);
  const judge = summarizeForJudge(data, context);
  const base = buildTaskReport(data, context);
  const safety = buildSafetyOverviewReport(data, base, context);
  const comprehensive = buildComprehensiveReport(data, {}, context);
  const expectedRiskCount = context.activeRisks.length;

  assert.equal(expectedRiskCount, 2);
  assert.equal(judge.riskCount, expectedRiskCount);
  for (const summary of [base.summary, safety.summary, comprehensive.summary]) {
    assert.equal(summary.findingCount, expectedRiskCount);
    assert.equal(summary.securityScore.activeFindingCount, expectedRiskCount);
    assert.equal(summary.wrongAnswerCount, expectedRiskCount);
  }

  const remediationCategories = [
    ...new Set(base.summary.remediationItems.map((item) => item.riskCategoryLabel)),
  ];
  assert.deepEqual(judge.remediationCategories, remediationCategories);
  assert.ok(base.summary.remediationItems.length < expectedRiskCount + 1);
});
