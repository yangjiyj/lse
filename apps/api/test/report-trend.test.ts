import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReportConclusionSnapshot,
  legacyReportConclusionSnapshot,
} from '../src/modules/reports/report-conclusion.js';
import {
  buildReportTrend,
  REPORT_TREND_SELECT,
  type TrendReportInput,
} from '../src/modules/reports/trend.js';

interface ListSummaryOptions {
  pass?: number;
  fail?: number;
  severityDistribution?: Record<string, number>;
  scopeKind?: 'TASK' | 'RESULT_SET';
}

function listSummary(options: ListSummaryOptions = {}) {
  const pass = options.pass ?? 5;
  const fail = options.fail ?? 5;
  const results = [
    ...Array.from({ length: pass }, () => ({ finalVerdict: 'PASS' as const })),
    ...Array.from({ length: fail }, () => ({ finalVerdict: 'FAIL' as const })),
  ];
  const severityDistribution = options.severityDistribution ?? (fail > 0 ? { HIGH: 1 } : {});
  const findingCount = Object.values(severityDistribution).reduce((sum, count) => sum + count, 0);
  return {
    totalQuestions: results.length,
    processedQuestions: results.length,
    passedCount: pass,
    failedCount: fail,
    errorCount: 0,
    wrongAnswerCount: fail,
    evidenceFindingCount: findingCount,
    findingCount,
    conclusionSnapshot: buildReportConclusionSnapshot({
      scopeKind: options.scopeKind ?? 'TASK',
      activeRiskCount: findingCount,
      task: {
        status: 'COMPLETED',
        engines: [],
        totalQuestions: results.length,
        processedQuestions: results.length,
        passedCount: pass,
        failedCount: fail,
        errorCount: 0,
      },
      results,
      engineRuns: [],
      failDisposition: {
        activeFailCount: findingCount > 0 ? fail : 0,
        excludedFailCount: 0,
        unexplainedFailCount: findingCount > 0 ? 0 : fail,
      },
    }),
    verdictDistribution: { PASS: pass, FAIL: fail },
    severityDistribution,
  };
}

function incompleteListSummary() {
  const summary = listSummary();
  const results = [
    ...Array.from({ length: 5 }, () => ({ finalVerdict: 'PASS' as const })),
    ...Array.from({ length: 5 }, () => ({ finalVerdict: 'FAIL' as const })),
  ];
  return {
    ...summary,
    conclusionSnapshot: buildReportConclusionSnapshot({
      scopeKind: 'TASK',
      activeRiskCount: 0,
      task: {
        status: 'RUNNING',
        engines: [],
        totalQuestions: 10,
        processedQuestions: 10,
        passedCount: 5,
        failedCount: 5,
        errorCount: 0,
      },
      results,
      engineRuns: [],
    }),
  };
}

function coverageIncompleteRiskListSummary() {
  const summary = listSummary({ pass: 5, fail: 5, severityDistribution: { HIGH: 1 } });
  const results = [
    ...Array.from({ length: 5 }, () => ({ finalVerdict: 'PASS' as const })),
    ...Array.from({ length: 5 }, () => ({ finalVerdict: 'FAIL' as const })),
  ];
  return {
    ...summary,
    conclusionSnapshot: buildReportConclusionSnapshot({
      scopeKind: 'TASK',
      activeRiskCount: 1,
      task: {
        status: 'COMPLETED',
        engines: ['rule-judge'],
        totalQuestions: 10,
        processedQuestions: 10,
        passedCount: 5,
        failedCount: 5,
        errorCount: 0,
      },
      results,
      engineRuns: [{ engine: 'rule-judge', status: 'FAILED', skippedCount: 0 }],
      failDisposition: {
        activeFailCount: 5,
        excludedFailCount: 0,
        unexplainedFailCount: 0,
      },
    }),
  };
}

function legacyListSummary() {
  return {
    ...listSummary(),
    conclusionSnapshot: legacyReportConclusionSnapshot('TASK'),
    securityScore: {
      score: 100,
      grade: 'A',
      activeFindingCount: 0,
      confirmedFindingCount: 0,
      unreviewedFindingCount: 0,
      needsReviewFindingCount: 0,
      falsePositiveFindingCount: 0,
      acceptedRiskFindingCount: 0,
      skippedEngineCount: 0,
      riskDeduction: 0,
      reviewDeduction: 0,
      coverageDeduction: 0,
      totalDeduction: 0,
    },
  };
}

function input(
  over: Partial<TrendReportInput> & { id: string; createdAt: Date },
): TrendReportInput {
  return {
    taskId: `task-${over.id}`,
    taskName: `任务 ${over.id}`,
    kind: 'comprehensive',
    listSummary: listSummary(),
    ...over,
  };
}

test('buildReportTrend：空报告列表返回空趋势', () => {
  const trend = buildReportTrend('mt-1', []);
  assert.equal(trend.modelTargetId, 'mt-1');
  assert.deepEqual(trend.points, []);
  assert.equal(trend.summary.reportCount, 0);
  assert.equal(trend.summary.firstPassRatePercent, null);
  assert.equal(trend.summary.latestPassRatePercent, null);
  assert.equal(trend.summary.passRateDeltaPercent, null);
  assert.equal(trend.summary.direction, 'unknown');
});

test('buildReportTrend：按 createdAt 升序排序（输入乱序）', () => {
  const trend = buildReportTrend('mt-1', [
    input({ id: 'c', createdAt: new Date('2026-03-01T00:00:00Z') }),
    input({ id: 'a', createdAt: new Date('2026-01-01T00:00:00Z') }),
    input({ id: 'b', createdAt: new Date('2026-02-01T00:00:00Z') }),
  ]);
  assert.deepEqual(
    trend.points.map((p) => p.reportId),
    ['a', 'b', 'c'],
  );
});

test('buildReportTrend：单点字段计算正确（含严重度归一化）', () => {
  const trend = buildReportTrend('mt-1', [
    input({
      id: 'x',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      listSummary: listSummary({
        pass: 10,
        fail: 20,
        severityDistribution: { HIGH: 2, CRITICAL: 1, LOW: 3 },
      }),
    }),
  ]);
  assert.equal(trend.points.length, 1);
  const p = trend.points[0]!;
  assert.equal(p.reportId, 'x');
  assert.equal(p.kind, 'comprehensive');
  assert.equal(p.taskId, 'task-x');
  assert.equal(p.taskName, '任务 x');
  assert.equal(p.passRatePercent, 33.3);
  assert.equal(p.totalQuestions, 30);
  assert.equal(p.conclusionState, 'RISK_DETECTED');
  assert.deepEqual(
    p.conclusionSnapshot,
    listSummary({ pass: 10, fail: 20, severityDistribution: { HIGH: 2, CRITICAL: 1, LOW: 3 } })
      .conclusionSnapshot,
  );
  // 严重度归一化为全部 5 个键，缺失补 0
  assert.deepEqual(p.severityCounts, {
    INFO: 0,
    LOW: 3,
    MEDIUM: 0,
    HIGH: 2,
    CRITICAL: 1,
  });
  assert.equal(p.findingCount, 6); // 2+1+3
  assert.equal(p.highRiskCount, 3); // HIGH 2 + CRITICAL 1
});

test('buildReportTrend：通过率上升判定为 improving', () => {
  const trend = buildReportTrend('mt-1', [
    input({
      id: 'a',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      listSummary: listSummary({ pass: 5, fail: 5 }),
    }),
    input({
      id: 'b',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      listSummary: listSummary({ pass: 6, fail: 4 }),
    }),
  ]);
  assert.equal(trend.summary.firstPassRatePercent, 50);
  assert.equal(trend.summary.latestPassRatePercent, 60);
  assert.equal(trend.summary.passRateDeltaPercent, 10);
  assert.equal(trend.summary.direction, 'improving');
});

test('buildReportTrend：综合 TASK 0% 到提示注入 RESULT_SET 100% 不得判为改善', () => {
  const trend = buildReportTrend('mt-1', [
    input({
      id: 'comprehensive-task',
      kind: 'comprehensive',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      listSummary: listSummary({ pass: 0, fail: 10, scopeKind: 'TASK' }),
    }),
    input({
      id: 'prompt-result-set',
      kind: 'prompt_injection_resilience',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      listSummary: listSummary({ pass: 10, fail: 0, scopeKind: 'RESULT_SET' }),
    }),
  ]);

  assert.deepEqual(
    trend.points.map((point) => point.kind),
    ['comprehensive', 'prompt_injection_resilience'],
  );
  assert.deepEqual(
    trend.points.map((point) => point.conclusionSnapshot.scopeKind),
    ['TASK', 'RESULT_SET'],
  );
  assert.equal(trend.summary.firstPassRatePercent, 0);
  assert.equal(trend.summary.latestPassRatePercent, 100);
  assert.equal(trend.summary.passRateDeltaPercent, null);
  assert.equal(trend.summary.direction, 'unknown');
});

test('buildReportTrend：区间内任一点 INCOMPLETE 都不得计算端点改善', () => {
  const trend = buildReportTrend('mt-1', [
    input({
      id: 'first-complete',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      listSummary: listSummary({ pass: 5, fail: 5 }),
    }),
    input({
      id: 'middle-incomplete',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      listSummary: incompleteListSummary(),
    }),
    input({
      id: 'latest-complete',
      createdAt: new Date('2026-03-01T00:00:00Z'),
      listSummary: listSummary({ pass: 6, fail: 4 }),
    }),
  ]);

  assert.equal(trend.points[0]!.conclusionState, 'RISK_DETECTED');
  assert.equal(trend.points[1]!.conclusionState, 'INCOMPLETE');
  assert.equal(trend.points[2]!.conclusionState, 'RISK_DETECTED');
  assert.equal(trend.summary.firstPassRatePercent, 50);
  assert.equal(trend.summary.latestPassRatePercent, 60);
  assert.equal(trend.summary.passRateDeltaPercent, null);
  assert.equal(trend.summary.direction, 'unknown');
});

test('buildReportTrend：RISK_DETECTED 但覆盖不完整的点也不得参与趋势比较', () => {
  const trend = buildReportTrend('mt-1', [
    input({
      id: 'risk-with-coverage-gap',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      listSummary: coverageIncompleteRiskListSummary(),
    }),
    input({
      id: 'risk-complete',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      listSummary: listSummary({
        pass: 6,
        fail: 4,
        severityDistribution: { HIGH: 1 },
      }),
    }),
  ]);

  assert.deepEqual(
    trend.points.map((point) => point.conclusionState),
    ['RISK_DETECTED', 'RISK_DETECTED'],
  );
  assert.deepEqual(
    trend.points.map((point) => point.conclusionSnapshot.coverageComplete),
    [false, true],
  );
  assert.equal(trend.summary.firstPassRatePercent, 50);
  assert.equal(trend.summary.latestPassRatePercent, 60);
  assert.equal(trend.summary.passRateDeltaPercent, null);
  assert.equal(trend.summary.direction, 'unknown');
});

test('buildReportTrend：端点相同但中间混入不同 DB kind/scope 仍不可比较', () => {
  const trend = buildReportTrend('mt-1', [
    input({
      id: 'first-comprehensive',
      kind: 'comprehensive',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      listSummary: listSummary({ pass: 5, fail: 5, scopeKind: 'TASK' }),
    }),
    input({
      id: 'middle-prompt',
      kind: 'prompt_injection_resilience',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      listSummary: listSummary({ pass: 10, fail: 0, scopeKind: 'RESULT_SET' }),
    }),
    input({
      id: 'latest-comprehensive',
      kind: 'comprehensive',
      createdAt: new Date('2026-03-01T00:00:00Z'),
      listSummary: listSummary({ pass: 6, fail: 4, scopeKind: 'TASK' }),
    }),
  ]);

  assert.deepEqual(
    trend.points.map((point) => point.conclusionState),
    ['RISK_DETECTED', 'NO_RISK_OBSERVED', 'RISK_DETECTED'],
  );
  assert.equal(trend.summary.firstPassRatePercent, 50);
  assert.equal(trend.summary.latestPassRatePercent, 60);
  assert.equal(trend.summary.passRateDeltaPercent, null);
  assert.equal(trend.summary.direction, 'unknown');
});

test('buildReportTrend：通过率下降判定为 declining', () => {
  const trend = buildReportTrend('mt-1', [
    input({
      id: 'a',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      listSummary: listSummary({ pass: 6, fail: 4 }),
    }),
    input({
      id: 'b',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      listSummary: listSummary({ pass: 5, fail: 5 }),
    }),
  ]);
  assert.equal(trend.summary.passRateDeltaPercent, -10);
  assert.equal(trend.summary.direction, 'declining');
});

test('buildReportTrend：通过率持平判定为 flat', () => {
  const trend = buildReportTrend('mt-1', [
    input({
      id: 'a',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      listSummary: listSummary({ pass: 5, fail: 5 }),
    }),
    input({
      id: 'b',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      listSummary: listSummary({ pass: 5, fail: 5 }),
    }),
  ]);
  assert.equal(trend.summary.passRateDeltaPercent, 0);
  assert.equal(trend.summary.direction, 'flat');
});

test('buildReportTrend：通过率上升但高危风险增加时整体方向不可判断为改善', () => {
  const trend = buildReportTrend('mt-1', [
    input({
      id: 'a',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      listSummary: listSummary({ pass: 4, fail: 6, severityDistribution: { MEDIUM: 1 } }),
    }),
    input({
      id: 'b',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      listSummary: listSummary({ pass: 5, fail: 5, severityDistribution: { HIGH: 1 } }),
    }),
  ]);
  assert.equal(trend.summary.passRateDeltaPercent, 10);
  assert.equal(trend.summary.direction, 'unknown');
});

test('buildReportTrend：passRate 为 null 时百分比为 null 且方向 unknown', () => {
  const trend = buildReportTrend('mt-1', [
    input({
      id: 'a',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      listSummary: legacyListSummary(),
    }),
    input({
      id: 'b',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      listSummary: listSummary({ pass: 6, fail: 4 }),
    }),
  ]);
  assert.equal(trend.points[0]!.passRatePercent, null);
  assert.equal(trend.points[0]!.conclusionState, 'INCOMPLETE');
  assert.equal(trend.summary.direction, 'unknown');
  assert.equal(trend.summary.passRateDeltaPercent, null);
});

test('buildReportTrend：确定性 INCOMPLETE 即使有通过率也不得判为安全改善', () => {
  const trend = buildReportTrend('mt-1', [
    input({
      id: 'a',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      listSummary: incompleteListSummary(),
    }),
    input({
      id: 'b',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      listSummary: listSummary({ pass: 6, fail: 4 }),
    }),
  ]);

  assert.equal(trend.points[0]!.passRatePercent, 50);
  assert.equal(trend.points[0]!.conclusionState, 'INCOMPLETE');
  assert.equal(trend.summary.direction, 'unknown');
  assert.equal(trend.summary.passRateDeltaPercent, null);
});

test('buildReportTrend：riskDistribution 为 null 时严重度全 0', () => {
  const trend = buildReportTrend('mt-1', [
    input({
      id: 'a',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      listSummary: null,
    }),
  ]);
  const p = trend.points[0]!;
  assert.deepEqual(p.severityCounts, {
    INFO: 0,
    LOW: 0,
    MEDIUM: 0,
    HIGH: 0,
    CRITICAL: 0,
  });
  assert.equal(p.findingCount, 0);
  assert.equal(p.highRiskCount, 0);
  assert.equal(p.totalQuestions, 0);
  assert.equal(p.conclusionSnapshot.source, 'LEGACY_FALLBACK');
  assert.equal(p.conclusionState, 'INCOMPLETE');
});

test('buildReportTrend：畸形自由文本结论和旧 100 分不能冒充确定性结论', () => {
  const malformed = legacyListSummary();
  malformed.conclusionSnapshot = {
    ...listSummary().conclusionSnapshot,
    narrative: '可直接上线',
  } as typeof malformed.conclusionSnapshot;
  const trend = buildReportTrend('mt-1', [
    input({
      id: 'legacy-100',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      listSummary: malformed,
    }),
  ]);

  assert.equal(trend.points[0]!.conclusionSnapshot.source, 'LEGACY_FALLBACK');
  assert.equal(trend.points[0]!.conclusionState, 'INCOMPLETE');
  assert.equal(trend.points[0]!.passRatePercent, null);
});

test('趋势查询只读取列表冻结快照，不读取旧标量或完整报告', () => {
  assert.deepEqual(Object.keys(REPORT_TREND_SELECT).sort(), [
    'createdAt',
    'id',
    'kind',
    'listSummary',
    'task',
    'taskId',
  ]);
  for (const forbidden of [
    'summary',
    'content',
    'passRate',
    'totalQuestions',
    'riskDistribution',
  ]) {
    assert.equal(forbidden in REPORT_TREND_SELECT, false);
  }
});
