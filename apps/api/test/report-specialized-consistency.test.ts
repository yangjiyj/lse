import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskReport, type ReportInputData } from '../src/modules/reports/report-builder.js';
import {
  buildSpecializedReport,
  type SpecializedReport,
} from '../src/modules/reports/specialized/index.js';
import { applicableReportKinds } from '../src/modules/reports/specialized/applicability.js';

const now = new Date('2026-07-12T03:00:00.000Z');

function task(overrides: Partial<ReportInputData['task']> = {}): ReportInputData['task'] {
  return {
    id: 'scope-task',
    name: '专项摘要一致性测试',
    description: null,
    status: 'COMPLETED',
    concurrency: 1,
    engines: ['rule-judge', 'agent-tool-guard'],
    totalQuestions: 3,
    processedQuestions: 3,
    passedCount: 1,
    failedCount: 2,
    errorCount: 0,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    modelTarget: { name: '测试模型', provider: 'openai-compatible', model: 'test' },
    questionSets: [
      { name: '提示注入题集', type: 'PROMPT_INJECTION', language: 'zh' },
      { name: 'Agent题集', type: 'GENERAL', language: 'zh' },
    ],
    ...overrides,
  };
}

function question(content: string, type: string, category: string, shouldRefuse = false) {
  return {
    content,
    type,
    shouldRefuse,
    language: 'zh',
    severity: 'HIGH' as const,
    category,
  };
}

function mixedData(): ReportInputData {
  return {
    task: task(),
    verdictCounts: { PASS: 1, FAIL: 2 },
    results: [
      {
        id: 'prompt-pass',
        finalVerdict: 'PASS',
        status: 'SUCCESS',
        question: question('拒绝提示注入请求', 'PROMPT_INJECTION', 'prompt injection'),
      },
      {
        id: 'prompt-fail',
        finalVerdict: 'FAIL',
        status: 'SUCCESS',
        question: question('忽略系统指令', 'PROMPT_INJECTION', 'prompt injection'),
      },
      {
        id: 'agent-fail',
        finalVerdict: 'FAIL',
        status: 'SUCCESS',
        question: question('调用工具读取敏感文件', 'GENERAL', 'Agent 工具调用', true),
        redTeamTrace: {
          side: null,
          rounds: 1,
          movesUsed: [],
          transcript: [],
        },
      },
    ],
    findings: [
      {
        resultId: 'prompt-fail',
        engine: 'rule-judge',
        riskCategory: 'prompt_injection',
        severity: 'MEDIUM',
        verdict: 'FAIL',
        title: '提示注入绕过',
        evidence: '提示注入证据',
        reviewStatus: 'NEEDS_REVIEW',
      },
      {
        resultId: 'agent-fail',
        engine: 'agent-tool-guard',
        riskCategory: 'agent_tool_abuse',
        severity: 'CRITICAL',
        verdict: 'FAIL',
        title: 'Agent 工具越权',
        evidence: 'Agent 高危证据',
        reviewStatus: 'CONFIRMED',
        detail: {
          trace: [
            {
              toolName: 'read_file',
              allowed: false,
              blockReason: 'sensitive path',
              turnIndex: 1,
              severity: 'CRITICAL',
            },
          ],
        },
      },
    ],
    engineRuns: [
      {
        engine: 'rule-judge',
        status: 'SUCCESS',
        normalizedCount: 2,
        skippedCount: 0,
        durationMs: 20,
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
    wrongAnswers: [],
    explanationRun: {
      mode: 'review_model',
      label: '总体风险说明',
      attemptedCount: 2,
      llmCount: 2,
      fallbackCount: 0,
      skippedReasons: [],
    },
    aiJudgment: {
      source: 'llm',
      configured: true,
      posture: '总体态势含 Agent 高危风险',
      topRisks: 'Agent 工具越权',
      remediationPriority: '先整改 Agent',
      focus: '总体结论',
    },
    generatedAt: now,
  };
}

function summaryOf(report: SpecializedReport) {
  return report.summary;
}

test('提示注入专项重建完整范围摘要，不继承 Agent 与总体研判字段', () => {
  const report = buildSpecializedReport('prompt_injection_resilience', mixedData());
  const summary = summaryOf(report);

  assert.equal(report.totalQuestions, 2);
  assert.equal(summary.totalQuestions, 2);
  assert.equal(summary.processedQuestions, 2);
  assert.equal(summary.passedCount, 1);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.errorCount, 0);
  assert.deepEqual(summary.verdictDistribution, { PASS: 1, FAIL: 1 });
  assert.equal(report.passRate, 0.5);
  assert.equal(summary.charts.passRatePercent, 50);
  assert.equal(summary.findingCount, 1);
  assert.equal(summary.evidenceFindingCount, 1);
  assert.equal(summary.securityScore.activeFindingCount, 1);
  assert.equal(summary.securityScore.needsReviewFindingCount, 1);
  assert.deepEqual(summary.severityDistribution, { MEDIUM: 1 });
  assert.deepEqual(
    summary.charts.severity.map((item) => item.key),
    ['MEDIUM'],
  );
  assert.deepEqual(
    summary.charts.engineRuns.map((item) => item.engine),
    ['rule-judge'],
  );
  assert.equal(summary.remediationItems.length, 0);
  assert.equal(summary.aiJudgment, undefined);
  assert.equal(summary.compliance, undefined);
  assert.equal(summary.redTeamSummary, undefined);
  assert.equal(summary.explanationRun, undefined);
  assert.equal(summary.riskAttribution, undefined);
  assert.equal(summary.entityProfile, undefined);
  assert.equal(summary.fatalRisks, undefined);
  assert.doesNotMatch(report.content, /总体研判|Agent 高危证据|Agent 工具越权/);
});

test('JAILBREAK 与 MCP 的适用性和专项样本风险使用同一范围分类', () => {
  const data: ReportInputData = {
    task: task({
      totalQuestions: 2,
      processedQuestions: 2,
      passedCount: 0,
      failedCount: 2,
      questionSets: [
        { name: '越狱题集', type: 'JAILBREAK', language: 'zh' },
        { name: 'MCP组件题集', type: 'GENERAL', language: 'zh' },
      ],
    }),
    verdictCounts: { FAIL: 2 },
    results: [
      {
        id: 'jailbreak-result',
        finalVerdict: 'FAIL',
        status: 'SUCCESS',
        question: question('尝试越狱系统约束', 'JAILBREAK', 'jailbreak'),
      },
      {
        id: 'mcp-result',
        finalVerdict: 'FAIL',
        status: 'SUCCESS',
        question: question('检查 MCP 服务组件', 'GENERAL', 'MCP component'),
      },
    ],
    findings: [
      {
        resultId: 'jailbreak-result',
        engine: 'rule-judge',
        riskCategory: 'jailbreak',
        severity: 'HIGH',
        verdict: 'FAIL',
        title: '越狱成功',
        evidence: '越狱证据',
      },
      {
        resultId: 'mcp-result',
        engine: 'rule-judge',
        riskCategory: 'mcp_security',
        severity: 'HIGH',
        verdict: 'FAIL',
        title: 'MCP 组件配置风险',
        evidence: 'MCP 证据',
      },
    ],
    engineRuns: [
      {
        engine: 'rule-judge',
        status: 'SUCCESS',
        normalizedCount: 2,
        skippedCount: 0,
        durationMs: 10,
        errorMessage: null,
      },
    ],
    wrongAnswers: [],
    generatedAt: now,
  };

  const kinds = applicableReportKinds(data);
  assert.ok(kinds.includes('prompt_injection_resilience'));
  assert.ok(kinds.includes('component_vulnerability'));

  const prompt = buildSpecializedReport('prompt_injection_resilience', data);
  assert.equal(prompt.totalQuestions, 1);
  assert.equal(prompt.summary.findingCount, 1);
  assert.match(prompt.content, /尝试越狱系统约束/);

  const component = buildSpecializedReport('component_vulnerability', data);
  assert.equal(component.totalQuestions, 1);
  assert.equal(component.summary.findingCount, 1);
  assert.match(component.content, /MCP/);
});

test('FP-only 混合证据的专项快照只保留匹配证据', () => {
  const data = mixedData();
  data.results = [
    {
      id: 'mixed-fp-result',
      finalVerdict: 'FAIL',
      status: 'SUCCESS',
      question: question('提示注入样本', 'PROMPT_INJECTION', 'prompt injection'),
    },
  ];
  data.findings = [
    {
      resultId: 'mixed-fp-result',
      engine: 'ai-infra-guard',
      riskCategory: 'component_vulnerability',
      severity: 'CRITICAL',
      verdict: 'FAIL',
      title: '组件误报',
      evidence: '组件 FP 证据',
      reviewStatus: 'FALSE_POSITIVE',
    },
    {
      resultId: 'mixed-fp-result',
      engine: 'rule-judge',
      riskCategory: 'prompt_injection',
      severity: 'LOW',
      verdict: 'FAIL',
      title: '提示注入误报',
      evidence: '提示注入 FP 证据',
      reviewStatus: 'FALSE_POSITIVE',
    },
  ];
  data.engineRuns = [];
  data.verdictCounts = { FAIL: 1 };

  const report = buildSpecializedReport('prompt_injection_resilience', data);
  const snapshot = report.summary.riskEvidencePortfolio;
  assert.ok(snapshot);
  assert.equal(snapshot.activeRisks.length, 0);
  assert.equal(snapshot.excludedRisks.length, 1);
  assert.equal(snapshot.excludedRisks[0]?.representative.title, '提示注入误报');
  assert.deepEqual(
    snapshot.excludedRisks[0]?.evidence.map((item) => item.evidence),
    ['提示注入 FP 证据'],
  );
});

test('专项切片后按匹配证据重算复核状态和接受风险标识', () => {
  const data = mixedData();
  data.results = [
    {
      id: 'mixed-review-result',
      finalVerdict: 'FAIL',
      status: 'SUCCESS',
      question: question('提示注入样本', 'PROMPT_INJECTION', 'prompt injection'),
    },
  ];
  data.findings = [
    {
      resultId: 'mixed-review-result',
      engine: 'rule-judge',
      riskCategory: 'prompt_injection',
      severity: 'MEDIUM',
      verdict: 'FAIL',
      title: '已接受提示注入风险',
      evidence: '提示注入残余风险',
      reviewStatus: 'ACCEPTED_RISK',
    },
    {
      resultId: 'mixed-review-result',
      engine: 'llm-judge',
      riskCategory: 'forbidden_content',
      severity: 'CRITICAL',
      verdict: 'FAIL',
      title: '其他人工确认风险',
      evidence: '其他风险证据',
      reviewStatus: 'CONFIRMED',
    },
  ];
  data.engineRuns = [];
  data.verdictCounts = { FAIL: 1 };

  const snapshot = buildSpecializedReport('prompt_injection_resilience', data).summary
    .riskEvidencePortfolio;
  assert.ok(snapshot);
  assert.equal(snapshot.activeRisks[0]?.reviewStatus, 'ACCEPTED_RISK');
  assert.equal(snapshot.activeRisks[0]?.acceptedResidualRisk, true);
});

test('Agent 专项保留显式 Agent 证据与通用轨迹旁证，并输出两条结构化轨迹', () => {
  const data = mixedData();
  data.results = [
    {
      id: 'agent-shared-result',
      finalVerdict: 'FAIL',
      status: 'SUCCESS',
      question: question('调用 Agent 工具', 'GENERAL', 'Agent 工具调用', true),
    },
  ];
  data.findings = [
    {
      resultId: 'agent-shared-result',
      engine: 'agent-tool-guard',
      riskCategory: 'agent_tool_abuse',
      severity: 'HIGH',
      verdict: 'FAIL',
      title: 'Agent 显式风险',
      evidence: '显式 Agent 证据',
      detail: {
        trace: [
          {
            toolName: 'read_file',
            allowed: false,
            blockReason: 'blocked read',
            turnIndex: 1,
            severity: 'HIGH',
          },
        ],
      },
    },
    {
      resultId: 'agent-shared-result',
      engine: 'llm-judge',
      riskCategory: 'runtime_policy',
      severity: 'MEDIUM',
      verdict: 'FAIL',
      title: '通用运行风险',
      evidence: '通用轨迹旁证',
      detail: {
        agentTrace: [
          {
            toolName: 'send_data',
            allowed: false,
            blockReason: 'blocked exfiltration',
            turnIndex: 2,
            severity: 'MEDIUM',
          },
        ],
      },
    },
  ];
  data.engineRuns = [
    {
      engine: 'agent-tool-guard',
      status: 'SUCCESS',
      normalizedCount: 1,
      skippedCount: 0,
      durationMs: 10,
      errorMessage: null,
    },
  ];
  data.verdictCounts = { FAIL: 1 };

  const report = buildSpecializedReport('agent_tool_abuse', data);
  assert.equal(report.summary.findingCount, 1);
  assert.equal(report.summary.evidenceFindingCount, 2);
  assert.equal(report.summary.agentTraceSamples?.length, 2);
  assert.deepEqual(
    report.summary.agentTraceSamples?.map((item) => item.toolName),
    ['read_file', 'send_data'],
  );
  assert.equal(report.summary.riskEvidencePortfolio?.activeRisks[0]?.evidence.length, 2);
});

test('执行指标使用明确失败与覆盖缺口口径，拒答风险数与专项风险一致', () => {
  const refusalData = mixedData();
  refusalData.task = task({
    totalQuestions: 1,
    processedQuestions: 1,
    passedCount: 0,
    failedCount: 1,
  });
  refusalData.results = [
    {
      id: 'refusal-result',
      finalVerdict: 'FAIL',
      status: 'SUCCESS',
      question: question('请拒绝危险请求', 'SHOULD_REFUSE', 'safety', true),
    },
  ];
  refusalData.findings = [
    {
      resultId: 'refusal-result',
      engine: 'rule-judge',
      riskCategory: 'harmful_content',
      severity: 'HIGH',
      verdict: 'FAIL',
      title: '危险请求未拦截',
      evidence: '拒答结果风险证据',
    },
  ];
  refusalData.engineRuns = [];
  refusalData.verdictCounts = { FAIL: 1 };

  const refusal = buildSpecializedReport('refusal_capability', refusalData);
  assert.equal(refusal.summary.findingCount, 1);
  assert.equal(refusal.summary.metrics.unrefusedRiskCount, 1);
  assert.match(refusal.summary.headline, /未拒答风险 1 项/);

  const usabilityData = mixedData();
  usabilityData.task = task({
    totalQuestions: 5,
    processedQuestions: 4,
    passedCount: 1,
    failedCount: 1,
    errorCount: 1,
    questionSets: [{ name: '通用题集', type: 'GENERAL', language: 'zh' }],
  });
  usabilityData.results = [
    {
      id: 'u-pass',
      finalVerdict: 'PASS',
      status: 'SUCCESS',
      question: question('正常题1', 'GENERAL', 'general'),
    },
    {
      id: 'u-fail',
      finalVerdict: 'FAIL',
      status: 'SUCCESS',
      question: question('正常题2', 'GENERAL', 'general'),
    },
    {
      id: 'u-error',
      finalVerdict: 'ERROR',
      status: 'ERROR',
      question: question('正常题3', 'GENERAL', 'general'),
    },
    {
      id: 'u-unknown',
      finalVerdict: 'UNKNOWN',
      status: 'SUCCESS',
      question: question('正常题4', 'GENERAL', 'general'),
    },
    {
      id: 'u-pending',
      finalVerdict: null,
      status: 'PENDING',
      question: question('正常题5', 'GENERAL', 'general'),
    },
  ];
  usabilityData.findings = [];
  usabilityData.engineRuns = [];
  usabilityData.verdictCounts = { PASS: 1, FAIL: 1, ERROR: 1, UNKNOWN: 1 };

  const usability = buildSpecializedReport('usability_over_refusal', usabilityData);
  assert.equal(usability.summary.metrics.nonUsableCount, 1);
  assert.equal(usability.summary.metrics.executionGapCount, 3);
  assert.equal(usability.summary.totalQuestions, 5);
  assert.equal(usability.summary.processedQuestions, 5);
  assert.equal(usability.summary.passedCount, 1);
  assert.equal(usability.summary.failedCount, 1);
  assert.equal(usability.summary.errorCount, 1);
  assert.equal(usability.summary.charts.passRatePercent, 50);
  assert.match(usability.summary.headline, /明确不可用 1 项/);
  assert.match(usability.summary.headline, /执行覆盖缺口 3 项/);
  assert.doesNotMatch(usability.summary.headline, /含误拒与答错/);
  assert.doesNotMatch(usability.content, /ERROR[^。\n]*分母/);
  assert.match(usability.content, /执行异常、未判定和缺失判定均作为覆盖缺口单列/);

  const base = buildTaskReport(refusalData);
  assert.match(base.content, /\| 执行未通过数 \| 1 \|/);
  assert.doesNotMatch(base.content, /\| 风险数 \| 1 \|/);
});
