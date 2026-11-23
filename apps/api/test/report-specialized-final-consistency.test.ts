import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Verdict } from '@lse/shared';
import type {
  ReportEngineRun,
  ReportEvalResult,
  ReportFinding,
  ReportInputData,
} from '../src/modules/reports/report-builder.js';
import { buildSpecializedReport } from '../src/modules/reports/specialized/index.js';
import type { ReportKind, SpecializedReport } from '../src/modules/reports/specialized/types.js';

const now = new Date('2026-07-12T06:00:00.000Z');

function makeResult(args: {
  id: string;
  verdict: Verdict | null;
  type?: string;
  category?: string;
  shouldRefuse?: boolean;
  language?: string;
}): ReportEvalResult {
  return {
    id: args.id,
    finalVerdict: args.verdict,
    status: args.verdict === null ? 'PENDING' : args.verdict === 'ERROR' ? 'ERROR' : 'SUCCESS',
    question: {
      content: '测试样本 ' + args.id,
      type: args.type ?? 'GENERAL',
      shouldRefuse: args.shouldRefuse ?? false,
      language: args.language ?? 'zh',
      severity: 'HIGH',
      category: args.category ?? 'general',
    },
  };
}

function makeData(
  args: {
    results?: ReportEvalResult[];
    findings?: ReportFinding[];
    engineRuns?: ReportEngineRun[];
    questionSetType?: string;
  } = {},
): ReportInputData {
  const results = args.results ?? [];
  const verdictCounts: Record<string, number> = {};
  for (const result of results) {
    if (result.finalVerdict) {
      verdictCounts[result.finalVerdict] = (verdictCounts[result.finalVerdict] ?? 0) + 1;
    }
  }
  return {
    task: {
      id: 'final-consistency-task',
      name: '专项终审一致性测试',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: ['rule-judge', 'agent-tool-guard', 'ai-infra-guard'],
      totalQuestions: results.length,
      processedQuestions: results.filter((result) => result.finalVerdict !== null).length,
      passedCount: verdictCounts.PASS ?? 0,
      failedCount: verdictCounts.FAIL ?? 0,
      errorCount: verdictCounts.ERROR ?? 0,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      modelTarget: { name: '测试模型', provider: 'openai-compatible', model: 'test' },
      questionSets: [{ name: '专项题集', type: args.questionSetType ?? 'GENERAL', language: 'zh' }],
    },
    verdictCounts,
    results,
    findings: args.findings ?? [],
    engineRuns: args.engineRuns ?? [],
    wrongAnswers: [],
    generatedAt: now,
  };
}

function finding(args: {
  resultId: string;
  engine: string;
  riskCategory: string;
  reviewStatus: string;
  severity?: ReportFinding['severity'];
}): ReportFinding {
  return {
    resultId: args.resultId,
    engine: args.engine,
    riskCategory: args.riskCategory,
    severity: args.severity ?? 'HIGH',
    verdict: 'FAIL',
    title: args.riskCategory,
    evidence: args.riskCategory + ' evidence',
    reviewStatus: args.reviewStatus,
  };
}

const scopeCases: Array<{
  kind: ReportKind;
  type: string;
  category: string;
  shouldRefuse?: boolean;
  specificEngine: string;
  specificCategory: string;
  otherEngine: string;
  otherCategory: string;
}> = [
  {
    kind: 'prompt_injection_resilience',
    type: 'PROMPT_INJECTION',
    category: 'prompt injection',
    specificEngine: 'rule-judge',
    specificCategory: 'prompt_injection',
    otherEngine: 'agent-tool-guard',
    otherCategory: 'agent_tool_abuse',
  },
  {
    kind: 'refusal_capability',
    type: 'SHOULD_REFUSE',
    category: 'refusal',
    shouldRefuse: true,
    specificEngine: 'rule-judge',
    specificCategory: 'should_refuse_violation',
    otherEngine: 'rule-judge',
    otherCategory: 'prompt_injection',
  },
  {
    kind: 'component_vulnerability',
    type: 'GENERAL',
    category: 'MCP component',
    specificEngine: 'ai-infra-guard',
    specificCategory: 'component_vulnerability',
    otherEngine: 'rule-judge',
    otherCategory: 'prompt_injection',
  },
  {
    kind: 'agent_tool_abuse',
    type: 'GENERAL',
    category: 'Agent 工具调用',
    specificEngine: 'agent-tool-guard',
    specificCategory: 'agent_tool_abuse',
    otherEngine: 'rule-judge',
    otherCategory: 'prompt_injection',
  },
];

for (const scope of scopeCases) {
  test(scope.kind + '：同题专项 FP 与通用有效风险均保留，其他专项有效风险不串入', () => {
    const results = ['generic-active', 'other-active'].map((id) =>
      makeResult({
        id,
        verdict: 'FAIL',
        type: scope.type,
        category: scope.category,
        shouldRefuse: scope.shouldRefuse,
      }),
    );
    const findings = [
      finding({
        resultId: 'generic-active',
        engine: scope.specificEngine,
        riskCategory: scope.specificCategory,
        reviewStatus: 'FALSE_POSITIVE',
        severity: 'CRITICAL',
      }),
      finding({
        resultId: 'generic-active',
        engine: 'rule-judge',
        riskCategory: 'unsafe_content',
        reviewStatus: 'CONFIRMED',
      }),
      finding({
        resultId: 'other-active',
        engine: scope.specificEngine,
        riskCategory: scope.specificCategory,
        reviewStatus: 'FALSE_POSITIVE',
        severity: 'CRITICAL',
      }),
      finding({
        resultId: 'other-active',
        engine: scope.otherEngine,
        riskCategory: scope.otherCategory,
        reviewStatus: 'CONFIRMED',
      }),
    ];
    const engineRuns =
      scope.kind === 'component_vulnerability'
        ? [
            {
              engine: 'ai-infra-guard',
              status: 'SUCCESS',
              normalizedCount: 0,
              skippedCount: 0,
              durationMs: 10,
              errorMessage: null,
            },
          ]
        : [];
    const report = buildSpecializedReport(
      scope.kind,
      makeData({ results, findings, engineRuns, questionSetType: scope.type }),
    );
    const portfolio = report.summary.riskEvidencePortfolio!;

    assert.equal(report.summary.findingCount, 1);
    assert.equal(portfolio.activeRisks.length, 1);
    assert.equal(portfolio.excludedRisks.length, 1);
    assert.deepEqual(
      new Set(portfolio.activeRisks[0]!.evidence.map((item) => item.riskCategory)),
      new Set([scope.specificCategory, 'unsafe_content']),
    );
    assert.deepEqual(
      portfolio.excludedRisks[0]!.evidence.map((item) => item.riskCategory),
      [scope.specificCategory],
    );
    assert.ok(
      !portfolio.excludedRisks[0]!.evidence.some(
        (item) => item.riskCategory === scope.otherCategory,
      ),
    );
  });
}

function rateData(
  scope: 'prompt' | 'refusal' | 'agent' | 'usability',
  verdicts: Array<Verdict | null>,
): ReportInputData {
  const config = {
    prompt: { type: 'PROMPT_INJECTION', category: 'prompt injection', shouldRefuse: false },
    refusal: { type: 'SHOULD_REFUSE', category: 'refusal', shouldRefuse: true },
    agent: { type: 'GENERAL', category: 'Agent 工具调用', shouldRefuse: false },
    usability: { type: 'GENERAL', category: 'general', shouldRefuse: false },
  }[scope];
  return makeData({
    results: verdicts.map((verdict, index) =>
      makeResult({
        id: scope + '-' + index,
        verdict,
        ...config,
      }),
    ),
    questionSetType: config.type,
  });
}

function assertRate(
  report: SpecializedReport,
  metric: string,
  rate: number,
  percent: number,
  executionGapCount: number,
) {
  assert.equal(report.passRate, rate);
  assert.equal(report.summary.charts.passRatePercent, percent);
  assert.equal(report.summary.metrics[metric], percent);
  assert.equal(report.summary.metrics.executionGapCount, executionGapCount);
  assert.match(report.summary.headline, new RegExp(String(percent) + '%'));
}

test('UNKNOWN/null：提示注入 PASS+UNKNOWN 以已判定样本计算为 100%', () => {
  const report = buildSpecializedReport(
    'prompt_injection_resilience',
    rateData('prompt', ['PASS', 'UNKNOWN']),
  );
  assertRate(report, 'resistanceRatePercent', 1, 100, 1);
});

test('UNKNOWN/null：拒答、Agent、可用性全页统一 PASS+FAIL 分母', () => {
  const verdicts: Array<Verdict | null> = ['PASS', 'FAIL', 'UNKNOWN', null];
  assertRate(
    buildSpecializedReport('refusal_capability', rateData('refusal', verdicts)),
    'refusalPassRatePercent',
    0.5,
    50,
    2,
  );
  assertRate(
    buildSpecializedReport('agent_tool_abuse', rateData('agent', verdicts)),
    'agentPassRatePercent',
    0.5,
    50,
    2,
  );
  assertRate(
    buildSpecializedReport('usability_over_refusal', rateData('usability', verdicts)),
    'usableAnswerRatePercent',
    0.5,
    50,
    2,
  );
});

test('UNKNOWN/null：多语言总体与每语言通过率统一，未判定单列', () => {
  const report = buildSpecializedReport(
    'multilingual_coverage',
    makeData({
      results: [
        makeResult({ id: 'zh-pass', verdict: 'PASS', language: 'zh' }),
        makeResult({ id: 'zh-unknown', verdict: 'UNKNOWN', language: 'zh' }),
        makeResult({ id: 'en-pass', verdict: 'PASS', language: 'en' }),
        makeResult({ id: 'en-fail', verdict: 'FAIL', language: 'en' }),
        makeResult({ id: 'en-unknown', verdict: 'UNKNOWN', language: 'en' }),
        makeResult({ id: 'en-null', verdict: null, language: 'en' }),
      ],
    }),
  );
  assertRate(report, 'passRatePercent', 2 / 3, 66.7, 3);
  assert.equal(report.summary.metrics.zhPassRatePercent, 100);
  assert.equal(report.summary.metrics.enPassRatePercent, 50);
  assert.match(report.content, /zh[^\n]*100%/);
  assert.match(report.content, /en[^\n]*50%/);
});

test('ERROR：五类 RESULT_SET 专项统一计入执行覆盖缺口并服从结论快照', () => {
  const errorCases: Array<{
    kind: ReportKind;
    metric: string;
    data: ReportInputData;
  }> = [
    {
      kind: 'prompt_injection_resilience',
      metric: 'resistanceRatePercent',
      data: rateData('prompt', ['PASS', 'ERROR']),
    },
    {
      kind: 'refusal_capability',
      metric: 'refusalPassRatePercent',
      data: rateData('refusal', ['PASS', 'ERROR']),
    },
    {
      kind: 'multilingual_coverage',
      metric: 'passRatePercent',
      data: makeData({
        results: [
          makeResult({ id: 'multi-pass', verdict: 'PASS', language: 'zh' }),
          makeResult({ id: 'multi-error', verdict: 'ERROR', language: 'en' }),
        ],
      }),
    },
    {
      kind: 'agent_tool_abuse',
      metric: 'agentPassRatePercent',
      data: rateData('agent', ['PASS', 'ERROR']),
    },
    {
      kind: 'usability_over_refusal',
      metric: 'usableAnswerRatePercent',
      data: rateData('usability', ['PASS', 'ERROR']),
    },
  ];

  for (const item of errorCases) {
    const report = buildSpecializedReport(item.kind, item.data);
    assertRate(report, item.metric, 1, 100, 1);
    assert.equal(report.summary.conclusionSnapshot?.counts.error, 1, item.kind);
    assert.equal(report.summary.conclusionSnapshot?.coverageComplete, false, item.kind);
    assert.equal(report.summary.metrics.coverageStatus, '不完整', item.kind);
    assert.match(report.summary.headline, /执行不完整/, item.kind);
    assert.match(report.summary.headline, /执行覆盖缺口 1/, item.kind);
    assert.doesNotMatch(report.summary.headline, /未判定 0/, item.kind);
  }
});

function componentData(
  status?: 'SUCCESS' | 'FAILED' | 'SKIPPED',
  skippedCount = 0,
): ReportInputData {
  return makeData({
    engineRuns: status
      ? [
          {
            engine: 'ai-infra-guard',
            status,
            normalizedCount: 0,
            skippedCount,
            durationMs: 10,
            errorMessage: status === 'FAILED' ? 'scanner failed' : null,
          },
        ]
      : [],
    questionSetType: 'COMPONENT',
  });
}

for (const status of [undefined, 'FAILED', 'SKIPPED'] as const) {
  test('组件执行不完整：' + (status ?? '0 run') + ' 不得输出满分或 A', () => {
    const report = buildSpecializedReport('component_vulnerability', componentData(status));
    assert.equal(report.passRate, null);
    assert.equal(report.summary.charts.passRatePercent, null);
    assert.equal(report.summary.securityScore.coverageIncomplete, true);
    assert.equal(report.summary.securityScore.coverageDeduction, 20);
    assert.ok(report.summary.securityScore.score < 100);
    assert.notEqual(report.summary.securityScore.grade, 'A');
  });
}

test('组件 SUCCESS 但存在 partial skip 时快照、摘要与指标均标记执行不完整', () => {
  const report = buildSpecializedReport('component_vulnerability', componentData('SUCCESS', 2));
  assert.equal(report.summary.conclusionSnapshot?.state, 'INCOMPLETE');
  assert.ok(report.summary.conclusionSnapshot?.reasonCodes.includes('ENGINE_RUN_PARTIAL_SKIP'));
  assert.equal(report.summary.metrics.coverageStatus, '不完整');
  assert.match(report.content, /执行不完整/);
  assert.equal(report.summary.securityScore.coverageIncomplete, true);
  assert.equal(report.summary.securityScore.coverageDeduction, 20);
});

test('组件扫描 SUCCESS 但结果 UNKNOWN 时标题和指标必须服从统一结论快照', () => {
  const results = [
    makeResult({
      id: 'component-unknown',
      verdict: 'UNKNOWN',
      type: 'COMPONENT',
      category: 'MCP component',
    }),
  ];
  const report = buildSpecializedReport(
    'component_vulnerability',
    makeData({
      results,
      questionSetType: 'COMPONENT',
      engineRuns: [
        {
          resultId: 'component-unknown',
          engine: 'ai-infra-guard',
          status: 'SUCCESS',
          normalizedCount: 1,
          skippedCount: 0,
          durationMs: 10,
          errorMessage: null,
        },
      ],
    }),
  );
  assert.equal(report.summary.conclusionSnapshot?.state, 'INCOMPLETE');
  assert.equal(report.summary.conclusionSnapshot?.coverageComplete, false);
  assert.ok(report.summary.conclusionSnapshot?.reasonCodes.includes('RESULT_UNKNOWN'));
  assert.equal(report.summary.metrics.coverageStatus, '不完整');
  assert.match(report.summary.headline, /执行不完整/);
  assert.match(report.content, /执行不完整/);
});

test('组件完整 SUCCESS 且无风险可输出 100 分，但零判定样本通过率为 null', () => {
  const report = buildSpecializedReport('component_vulnerability', componentData('SUCCESS'));
  assert.equal(report.passRate, null);
  assert.equal(report.summary.charts.passRatePercent, null);
  assert.equal(report.summary.securityScore.coverageIncomplete, false);
  assert.equal(report.summary.securityScore.coverageDeduction, 0);
  assert.equal(report.summary.securityScore.score, 100);
  assert.equal(report.summary.securityScore.grade, 'A');
});
