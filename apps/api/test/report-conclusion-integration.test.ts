import test from 'node:test';
import assert from 'node:assert/strict';
import type { Verdict } from '@lse/shared';
import {
  buildTaskReport,
  type ReportEvalResult,
  type ReportFinding,
  type ReportInputData,
} from '../src/modules/reports/report-builder.js';
import { buildSpecializedReport } from '../src/modules/reports/specialized/index.js';
import { buildReportRiskContext } from '../src/modules/reports/report-risk-context.js';
import { summarizeForJudge } from '../src/modules/reports/report-judge.js';
import { parseReportConclusionSnapshot } from '../src/modules/reports/report-conclusion.js';

const now = new Date('2026-07-12T08:00:00.000Z');

function result(
  id: string,
  finalVerdict: Verdict | null,
  type = 'GENERAL',
  category = 'general',
): ReportEvalResult {
  return {
    id,
    finalVerdict,
    status: finalVerdict === 'ERROR' ? 'ERROR' : 'SUCCESS',
    side: null,
    question: {
      content: `样本 ${id}`,
      type,
      shouldRefuse: type === 'SHOULD_REFUSE',
      language: 'zh',
      severity: 'HIGH',
      category,
    },
  };
}

function data(args: {
  results: ReportEvalResult[];
  findings?: ReportFinding[];
  engines?: string[];
  engineRuns?: ReportInputData['engineRuns'];
}): ReportInputData {
  const verdictCounts: Record<string, number> = {};
  for (const item of args.results) {
    if (item.finalVerdict) {
      verdictCounts[item.finalVerdict] = (verdictCounts[item.finalVerdict] ?? 0) + 1;
    }
  }
  return {
    task: {
      id: 'conclusion-integration-task',
      name: '统一结论集成测试',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: args.engines ?? ['rule-judge'],
      totalQuestions: args.results.length,
      processedQuestions: args.results.length,
      passedCount: verdictCounts.PASS ?? 0,
      failedCount: verdictCounts.FAIL ?? 0,
      errorCount: verdictCounts.ERROR ?? 0,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      modelTarget: { name: '测试模型', provider: 'openai-compatible', model: 'test' },
      questionSets: [{ name: '测试题集', type: 'GENERAL', language: 'zh' }],
    },
    verdictCounts,
    results: args.results,
    findings: args.findings ?? [],
    engineRuns:
      args.engineRuns ??
      (args.engines ?? ['rule-judge']).map((engine) => ({
        engine,
        status: 'SUCCESS',
        normalizedCount: args.results.length,
        skippedCount: 0,
        durationMs: 1,
        errorMessage: null,
      })),
    wrongAnswers: [],
    generatedAt: now,
  };
}

test('base/safety/comprehensive 继承同一个 TASK 权威结论快照', () => {
  const input = data({
    results: [result('pass', 'PASS'), result('fail', 'FAIL')],
    findings: [
      {
        stableId: 'finding-risk',
        resultId: 'fail',
        engine: 'rule-judge',
        riskCategory: 'forbidden_content',
        severity: 'HIGH',
        verdict: 'FAIL',
        reviewStatus: 'CONFIRMED',
        title: '有效风险',
        evidence: '有效证据',
      },
    ],
  });
  const base = buildTaskReport(input);
  const safety = buildSpecializedReport('safety_overview', input);
  const comprehensive = buildSpecializedReport('comprehensive', input);

  assert.equal(base.summary.conclusionSnapshot?.scopeKind, 'TASK');
  assert.equal(base.summary.conclusionSnapshot?.state, 'RISK_DETECTED');
  assert.deepEqual(safety.summary.conclusionSnapshot, base.summary.conclusionSnapshot);
  assert.deepEqual(comprehensive.summary.conclusionSnapshot, base.summary.conclusionSnapshot);
  assert.deepEqual(
    parseReportConclusionSnapshot(structuredClone(base.summary.conclusionSnapshot)),
    base.summary.conclusionSnapshot,
  );
  assert.equal(base.passRate, base.summary.conclusionSnapshot?.passRate);
  assert.equal(base.summary.charts.passRatePercent, 50);
  assert.equal(
    base.summary.securityScore.coverageIncomplete,
    !base.summary.conclusionSnapshot?.coverageComplete,
  );
});

test('执行摘要始终先给规则评估结论，AI 研判只在辅助章节出现一次', () => {
  const input = data({ results: [result('pass', 'PASS')] });
  input.aiJudgment = {
    source: 'llm',
    configured: true,
    posture: 'UNSUPPORTED-POSTURE-MARKER',
    topRisks: '辅助风险描述',
    remediationPriority: 'AI-AUX-ONLY-MARKER',
    focus: '辅助关注点',
    modelTargetName: '独立复核模型',
  };

  const report = buildTaskReport(input);
  const executionStart = report.content.indexOf('## 执行摘要');
  const overviewStart = report.content.indexOf('## 一、评估概览');
  const executionSummary = report.content.slice(executionStart, overviewStart);

  assert.match(executionSummary, /评估结论：本次评估范围内未观察到风险/);
  assert.doesNotMatch(executionSummary, /AI-AUX-ONLY-MARKER/);
  assert.match(report.content, /辅助模型研判（不替代规则评估结论）/);
  assert.equal(report.content.split('AI-AUX-ONLY-MARKER').length - 1, 1);
  assert.doesNotMatch(report.content, /UNSUPPORTED-POSTURE-MARKER/);
  for (const forbidden of ['放心', '可以正常上线', '80分以上基本安全', '模型表现合规']) {
    assert.doesNotMatch(report.content, new RegExp(forbidden));
  }
});

test('A FAIL + B PASS 的主评估口径在结论、风险、评分、研判和专项中统一为 B', () => {
  const input = data({
    results: [
      {
        ...result('pair-a', 'FAIL', 'PROMPT_INJECTION', 'prompt injection'),
        side: 'A',
        controlGroupId: 'pair-1',
      },
      {
        ...result('pair-b', 'PASS', 'PROMPT_INJECTION', 'prompt injection'),
        side: 'B',
        controlGroupId: 'pair-1',
      },
    ],
    findings: [
      {
        stableId: 'finding-a-only',
        resultId: 'pair-a',
        engine: 'rule-judge',
        riskCategory: 'prompt_injection',
        severity: 'HIGH',
        verdict: 'FAIL',
        reviewStatus: 'CONFIRMED',
        title: 'A 侧风险不得进入主结论',
        evidence: 'A 侧证据',
      },
    ],
  });
  input.task.totalQuestions = 1;
  input.task.processedQuestions = 1;
  input.task.passedCount = 1;
  input.task.failedCount = 0;
  input.task.errorCount = 0;
  input.wrongAnswers = [
    {
      resultId: 'pair-a',
      questionContent: 'A侧攻击样本',
      modelResponse: 'A侧失败响应',
      riskCategory: 'prompt_injection',
      severity: 'HIGH',
      engine: 'rule-judge',
      reason: 'A侧失败',
    },
  ];

  const context = buildReportRiskContext(input);
  const base = buildTaskReport(input, context);
  const prompt = buildSpecializedReport('prompt_injection_resilience', input, context);
  const judge = summarizeForJudge(input, context);

  assert.equal(base.passRate, 1);
  assert.equal(base.summary.charts.passRatePercent, 100);
  assert.equal(base.summary.findingCount, 0);
  assert.equal(base.summary.wrongAnswerCount, 0);
  assert.equal(base.summary.conclusionSnapshot?.state, 'NO_RISK_OBSERVED');
  assert.equal(base.summary.securityScore.activeFindingCount, 0);
  assert.equal(base.summary.remediationItems.length, 0);
  assert.deepEqual(
    context.primaryResults.map((item) => item.id),
    ['pair-b'],
  );
  assert.equal(prompt.passRate, 1);
  assert.equal(prompt.summary.charts.passRatePercent, 100);
  assert.deepEqual(prompt.summary.verdictDistribution, { PASS: 1 });
  assert.equal(prompt.summary.findingCount, 0);
  assert.equal(judge.executionPassRatePercent, 100);
  assert.equal(judge.riskCount, 0);
  assert.deepEqual(
    new Set([
      base.summary.charts.passRatePercent,
      prompt.summary.charts.passRatePercent,
      judge.executionPassRatePercent,
    ]),
    new Set([100]),
  );
});

test('base 的结论、评分、图表和展示统一排除已知红队 A 侧关联引擎运行', () => {
  const input = data({
    results: [
      {
        ...result('pair-a-run', 'FAIL', 'PROMPT_INJECTION', 'prompt injection'),
        side: 'A',
        controlGroupId: 'pair-run',
      },
      {
        ...result('pair-b-run', 'PASS', 'PROMPT_INJECTION', 'prompt injection'),
        side: 'B',
        controlGroupId: 'pair-run',
      },
    ],
    findings: [
      {
        stableId: 'finding-a-run-only',
        resultId: 'pair-a-run',
        engine: 'rule-judge',
        riskCategory: 'prompt_injection',
        severity: 'HIGH',
        verdict: 'FAIL',
        reviewStatus: 'CONFIRMED',
        title: 'A 侧风险不得进入主结论',
        evidence: 'A 侧证据',
      },
    ],
    engineRuns: [
      {
        resultId: 'pair-a-run',
        engine: 'rule-judge',
        status: 'FAILED',
        normalizedCount: 0,
        skippedCount: 0,
        durationMs: 1,
        errorMessage: 'A 侧执行失败',
      },
      {
        resultId: 'pair-b-run',
        engine: 'rule-judge',
        status: 'SUCCESS',
        normalizedCount: 1,
        skippedCount: 0,
        durationMs: 1,
        errorMessage: null,
      },
      {
        resultId: null,
        engine: 'mcp-closed-loop',
        status: 'SUCCESS',
        normalizedCount: 1,
        skippedCount: 0,
        durationMs: 1,
        errorMessage: null,
      },
      {
        resultId: 'legacy-result-id-not-loaded',
        engine: 'garak',
        status: 'SUCCESS',
        normalizedCount: 1,
        skippedCount: 0,
        durationMs: 1,
        errorMessage: null,
      },
    ],
  });
  input.task.totalQuestions = 1;
  input.task.processedQuestions = 1;
  input.task.passedCount = 1;
  input.task.failedCount = 0;
  input.task.errorCount = 0;

  const context = buildReportRiskContext(input);
  const base = buildTaskReport(input, context);
  const prompt = buildSpecializedReport('prompt_injection_resilience', input, context);

  assert.deepEqual(
    context.primaryEngineRuns.map((run) => run.resultId),
    ['pair-b-run', null, 'legacy-result-id-not-loaded'],
  );
  assert.equal(base.summary.conclusionSnapshot?.state, 'NO_RISK_OBSERVED');
  assert.equal(base.summary.conclusionSnapshot?.counts.engineRunTotal, 3);
  assert.equal(base.summary.conclusionSnapshot?.counts.engineRunFailed, 0);
  assert.equal(base.summary.securityScore.score, 100);
  assert.equal(base.summary.securityScore.grade, 'A');
  assert.equal(base.summary.charts.engineRuns.length, 3);
  assert.ok(base.summary.charts.engineRuns.every((run) => run.status === 'SUCCESS'));
  assert.doesNotMatch(base.content, /\| 规则评审 \| 失败 \|/);

  // 专项仍使用自己的精确 resultId/全局引擎 allowlist，不继承 base 的旧关联兜底。
  assert.equal(prompt.summary.conclusionSnapshot?.counts.engineRunTotal, 1);
  assert.deepEqual(
    prompt.summary.charts.engineRuns.map((run) => run.engine),
    ['rule-judge'],
  );
});

test('只有 A 侧且无 B 的生产评估结果仍作为主结果保留', () => {
  const input = data({
    results: [
      {
        ...result('a-only', 'PASS'),
        side: 'A',
        controlGroupId: 'production-a-only',
      },
    ],
  });
  const report = buildTaskReport(input);

  assert.equal(report.passRate, 1);
  assert.equal(report.summary.processedQuestions, 1);
  assert.equal(report.summary.conclusionSnapshot?.state, 'NO_RISK_OBSERVED');
  assert.deepEqual(report.summary.verdictDistribution, { PASS: 1 });
});

test('base 判定分布与图表只取 B/null 侧结果，不纳入红队 A 侧 ERROR', () => {
  const input = data({
    results: [
      { ...result('bare-error', 'ERROR'), side: 'A', controlGroupId: 'pair-1' },
      { ...result('protected-pass', 'PASS'), side: 'B', controlGroupId: 'pair-1' },
    ],
  });
  input.task.totalQuestions = 1;
  input.task.processedQuestions = 1;
  input.task.passedCount = 1;
  input.task.failedCount = 0;
  input.task.errorCount = 0;

  const report = buildTaskReport(input);
  assert.deepEqual(report.summary.verdictDistribution, { PASS: 1 });
  assert.deepEqual(
    report.summary.charts.verdict.map((item) => [item.key, item.value]),
    [['PASS', 1]],
  );
  assert.equal(report.summary.conclusionSnapshot?.counts?.error, 0);
  assert.equal(report.summary.conclusionSnapshot?.state, 'NO_RISK_OBSERVED');
});

test('专项使用独立 RESULT_SET，完整的提示注入专项不受全局 ERROR 污染', () => {
  const input = data({
    results: [
      result('prompt-pass', 'PASS', 'PROMPT_INJECTION', 'prompt injection'),
      result('global-error', 'ERROR', 'GENERAL', 'general'),
    ],
  });
  const base = buildTaskReport(input);
  const prompt = buildSpecializedReport('prompt_injection_resilience', input);

  assert.equal(base.summary.conclusionSnapshot?.state, 'INCOMPLETE');
  assert.ok(base.summary.conclusionSnapshot?.reasonCodes.includes('RESULT_EXECUTION_ERROR'));
  assert.equal(prompt.summary.conclusionSnapshot?.scopeKind, 'RESULT_SET');
  assert.equal(prompt.summary.conclusionSnapshot?.state, 'NO_RISK_OBSERVED');
  assert.equal(prompt.summary.conclusionSnapshot?.coverageComplete, true);
  assert.equal(prompt.passRate, 1);
  assert.equal(prompt.summary.charts.passRatePercent, 100);
});

test('RUNNING 任务即使提示注入专项当前 1/1 PASS 也不得输出无风险结论', () => {
  const input = data({
    results: [result('prompt-pass', 'PASS', 'PROMPT_INJECTION', 'prompt injection')],
  });
  input.task.status = 'RUNNING';
  input.task.totalQuestions = 100;
  input.task.processedQuestions = 1;
  input.task.finishedAt = null;

  const prompt = buildSpecializedReport('prompt_injection_resilience', input);
  assert.equal(prompt.summary.conclusionSnapshot?.scopeKind, 'RESULT_SET');
  assert.equal(prompt.summary.conclusionSnapshot?.counts?.expected, 1);
  assert.equal(prompt.passRate, 1);
  assert.equal(prompt.summary.conclusionSnapshot?.state, 'INCOMPLETE');
  assert.equal(prompt.summary.conclusionSnapshot?.coverageComplete, false);
  assert.ok(prompt.summary.conclusionSnapshot?.reasonCodes.includes('TASK_NOT_COMPLETED'));
  assert.ok(!prompt.summary.conclusionSnapshot?.reasonCodes.includes('RESULT_COUNT_MISMATCH'));
  assert.ok(!prompt.summary.conclusionSnapshot?.reasonCodes.includes('RESULT_EXECUTION_ERROR'));
});

test('无关领域 FAILED/SKIPPED 引擎运行不污染提示注入专项', () => {
  const input = data({
    results: [result('prompt-pass', 'PASS', 'PROMPT_INJECTION', 'prompt injection')],
    engines: ['rule-judge', 'ai-infra-guard', 'agent-tool-guard'],
    engineRuns: [
      {
        engine: 'rule-judge',
        status: 'SUCCESS',
        normalizedCount: 1,
        skippedCount: 0,
        durationMs: 1,
        errorMessage: null,
      },
      {
        engine: 'ai-infra-guard',
        status: 'FAILED',
        normalizedCount: 0,
        skippedCount: 0,
        durationMs: 1,
        errorMessage: '组件专项失败',
      },
      {
        engine: 'agent-tool-guard',
        status: 'SKIPPED',
        normalizedCount: 0,
        skippedCount: 1,
        durationMs: 1,
        errorMessage: 'Agent 专项跳过',
      },
    ],
  });
  const prompt = buildSpecializedReport('prompt_injection_resilience', input);
  assert.equal(prompt.summary.conclusionSnapshot?.counts?.engineRunTotal, 1);
  assert.equal(prompt.summary.conclusionSnapshot?.coverageComplete, true);
  assert.equal(prompt.summary.conclusionSnapshot?.state, 'NO_RISK_OBSERVED');
});

test('提示注入专项按 scoped resultId 精确选引擎，MCP 与红队失败不得污染', () => {
  const input = data({
    results: [
      result('prompt-pass', 'PASS', 'PROMPT_INJECTION', 'prompt injection'),
      result('redteam-error', 'ERROR', 'GENERAL', 'autonomous red team'),
    ],
    engines: ['rule-judge', 'mcp-closed-loop', 'autonomous-red-team', 'garak'],
    engineRuns: [
      {
        resultId: 'prompt-pass',
        engine: 'rule-judge',
        status: 'SUCCESS',
        normalizedCount: 1,
        skippedCount: 0,
        durationMs: 1,
        errorMessage: null,
      },
      {
        resultId: 'redteam-error',
        engine: 'rule-judge',
        status: 'FAILED',
        normalizedCount: 0,
        skippedCount: 0,
        durationMs: 1,
        errorMessage: '红队结果关联规则执行失败',
      },
      {
        resultId: null,
        engine: 'mcp-closed-loop',
        status: 'FAILED',
        normalizedCount: 0,
        skippedCount: 0,
        durationMs: 1,
        errorMessage: 'MCP 执行失败',
      },
      {
        resultId: null,
        engine: 'autonomous-red-team',
        status: 'FAILED',
        normalizedCount: 0,
        skippedCount: 0,
        durationMs: 1,
        errorMessage: '红队执行失败',
      },
      {
        resultId: null,
        engine: 'garak',
        status: 'FAILED',
        normalizedCount: 0,
        skippedCount: 0,
        durationMs: 1,
        errorMessage: 'Garak 执行失败',
      },
    ],
  });

  const base = buildTaskReport(input);
  const prompt = buildSpecializedReport('prompt_injection_resilience', input);
  assert.equal(base.summary.conclusionSnapshot?.state, 'INCOMPLETE');
  assert.equal(base.summary.conclusionSnapshot?.counts?.engineRunTotal, 5);
  assert.equal(prompt.summary.conclusionSnapshot?.counts?.engineRunTotal, 1);
  assert.equal(prompt.summary.conclusionSnapshot?.counts?.engineRunFailed, 0);
  assert.equal(prompt.summary.conclusionSnapshot?.state, 'NO_RISK_OBSERVED');
  assert.deepEqual(
    prompt.summary.charts.engineRuns.map((run) => run.engine),
    ['rule-judge'],
  );
  assert.equal('resultId' in prompt.summary.charts.engineRuns[0]!, false);
});

test('六类手工专项均显式使用 RESULT_SET 或 ENGINE_RUN_SET，绝不默认为 TASK', () => {
  const input = data({
    results: [
      result('prompt', 'PASS', 'PROMPT_INJECTION', 'prompt injection'),
      result('refusal', 'PASS', 'SHOULD_REFUSE', 'refusal'),
      result('general', 'PASS', 'GENERAL', 'general'),
      result('agent', 'PASS', 'GENERAL', 'Agent 工具调用'),
    ],
    engines: ['rule-judge', 'agent-tool-guard', 'ai-infra-guard'],
  });
  const kinds = [
    'refusal_capability',
    'prompt_injection_resilience',
    'component_vulnerability',
    'multilingual_coverage',
    'agent_tool_abuse',
    'usability_over_refusal',
  ] as const;
  for (const kind of kinds) {
    const report = buildSpecializedReport(kind, input);
    assert.ok(report.summary.conclusionSnapshot, `${kind} missing snapshot`);
    assert.notEqual(report.summary.conclusionSnapshot?.scopeKind, 'TASK', kind);
  }
});

test('组件 SUCCESS 且零结果/零风险为完整 ENGINE_RUN_SET，passRate 仍为 null', () => {
  const input = data({
    results: [],
    engines: ['ai-infra-guard'],
    engineRuns: [
      {
        engine: 'ai-infra-guard',
        status: 'SUCCESS',
        normalizedCount: 0,
        skippedCount: 0,
        durationMs: 1,
        errorMessage: null,
      },
    ],
  });
  const component = buildSpecializedReport('component_vulnerability', input);
  assert.equal(component.summary.conclusionSnapshot?.scopeKind, 'ENGINE_RUN_SET');
  assert.equal(component.summary.conclusionSnapshot?.state, 'NO_RISK_OBSERVED');
  assert.equal(component.summary.conclusionSnapshot?.coverageComplete, true);
  assert.equal(component.passRate, null);
  assert.equal(component.summary.charts.passRatePercent, null);
});

test('结论状态不读取 securityScore，即使展示分改成100仍保持 INCOMPLETE', () => {
  const input = data({
    results: [result('unknown', 'UNKNOWN')],
  });
  const report = buildTaskReport(input);
  assert.equal(report.summary.conclusionSnapshot?.state, 'INCOMPLETE');
  report.summary.securityScore.score = 100;
  report.summary.securityScore.grade = 'A';
  assert.equal(report.summary.conclusionSnapshot?.state, 'INCOMPLETE');
});
