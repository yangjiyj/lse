import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTaskReport, type ReportInputData } from '../src/modules/reports/report-builder.js';
import {
  buildFallbackReportListSummary,
  buildReportListSummary,
  parseReportListSummary,
  REPORT_LIST_SELECT,
} from '../src/modules/reports/report-list-summary.js';
import {
  buildReportConclusionSnapshot,
  legacyReportConclusionSnapshot,
} from '../src/modules/reports/report-conclusion.js';

const now = new Date('2026-07-11T13:00:00.000Z');
const EVIDENCE_MARKER = 'REPORT-LIST-MUST-NOT-LOAD-THIS-EVIDENCE';

function fullSummary() {
  const input: ReportInputData = {
    task: {
      id: 'task-list-summary',
      name: '列表快照任务',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: ['rule-judge'],
      totalQuestions: 1,
      processedQuestions: 1,
      passedCount: 0,
      failedCount: 1,
      errorCount: 0,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      modelTarget: { name: '模型', provider: 'openai-compatible', model: 'model' },
      questionSets: [{ name: '题集', type: 'GENERAL', language: 'zh' }],
    },
    verdictCounts: { FAIL: 1 },
    findings: [
      {
        engine: 'rule-judge',
        riskCategory: 'forbidden_content',
        severity: 'HIGH',
        verdict: 'FAIL',
        title: '高风险',
        evidence: EVIDENCE_MARKER,
      },
    ],
    engineRuns: [
      {
        engine: 'rule-judge',
        status: 'SUCCESS',
        normalizedCount: 1,
        skippedCount: 0,
        durationMs: 8,
        errorMessage: null,
      },
    ],
    wrongAnswers: [
      {
        questionContent: EVIDENCE_MARKER,
        modelResponse: EVIDENCE_MARKER,
        riskCategory: 'forbidden_content',
        severity: 'HIGH',
        engine: 'rule-judge',
        reason: EVIDENCE_MARKER,
      },
    ],
    generatedAt: now,
    explanationRun: {
      mode: 'local',
      label: '规则依据分析',
      attemptedCount: 1,
      llmCount: 0,
      fallbackCount: 1,
      skippedReasons: [],
    },
  };
  return {
    ...buildTaskReport(input).summary,
    kind: 'comprehensive',
    headline: '列表只展示这一句摘要',
    metrics: { includedReportCount: 3 },
  };
}

test('buildReportListSummary 只保留列表指标并排除冻结证据重字段', () => {
  const summary = buildReportListSummary(fullSummary());
  const serialized = JSON.stringify(summary);

  assert.deepEqual(Object.keys(summary).sort(), [
    'conclusionSnapshot',
    'errorCount',
    'evidenceFindingCount',
    'explanationRun',
    'failedCount',
    'findingCount',
    'headline',
    'kind',
    'metrics',
    'passedCount',
    'processedQuestions',
    'securityScore',
    'severityDistribution',
    'totalQuestions',
    'verdictDistribution',
    'wrongAnswerCount',
  ]);
  assert.equal(summary.kind, 'comprehensive');
  assert.equal(summary.findingCount, 1);
  assert.equal(summary.conclusionSnapshot.source, 'DETERMINISTIC_RULE');
  assert.equal(summary.conclusionSnapshot.state, 'RISK_DETECTED');
  assert.equal(summary.securityScore?.policyVersion, 'risk-score-v1');
  assert.equal(summary.explanationRun?.label, '规则依据分析');
  assert.doesNotMatch(serialized, new RegExp(EVIDENCE_MARKER));
  for (const forbidden of [
    'riskEvidencePortfolio',
    'riskItemsBySeverity',
    'wrongAnswerSamples',
    'findingSamples',
    'remediationItems',
    'agentTraceSamples',
    'redTeamSummary',
  ]) {
    assert.equal(forbidden in summary, false, `列表快照不得包含 ${forbidden}`);
  }
});

test('buildReportListSummary 写入路径拒绝缺失或畸形的结论快照', () => {
  const valid = fullSummary();
  const missing = { ...valid, conclusionSnapshot: undefined };
  const malformed = {
    ...valid,
    conclusionSnapshot: {
      ...valid.conclusionSnapshot,
      narrative: '可直接上线',
    },
  };
  const wrongScope = {
    ...valid,
    conclusionSnapshot: buildReportConclusionSnapshot({
      scopeKind: 'RESULT_SET',
      activeRiskCount: 0,
      results: [{ finalVerdict: 'PASS', status: 'SUCCESS', side: null }],
      engineRuns: [],
    }),
  };

  assert.throws(() => buildReportListSummary(missing), /conclusion snapshot/i);
  assert.throws(() => buildReportListSummary(malformed as typeof valid), /conclusion snapshot/i);
  assert.throws(() => buildReportListSummary(wrongScope), /scopeKind/i);
});

test('报告列表 Prisma select 从查询层排除 content 和完整 summary', () => {
  assert.equal(REPORT_LIST_SELECT.listSummary, true);
  assert.equal('summary' in REPORT_LIST_SELECT, false);
  assert.equal('content' in REPORT_LIST_SELECT, false);
  assert.equal('passRate' in REPORT_LIST_SELECT, false);
  assert.deepEqual(Object.keys(REPORT_LIST_SELECT).sort(), [
    'createdAt',
    'format',
    'generatedById',
    'id',
    'kind',
    'listSummary',
    'riskDistribution',
    'taskId',
    // 全部租户视角：列表每行要带 tenantId，供前端显示租户列与进入租户。
    'tenantId',
    'title',
    'totalQuestions',
  ]);
});

test('历史 listSummary 为空时仅由标量和风险分布构造最小安全回退', () => {
  const fallback = buildFallbackReportListSummary({
    kind: 'comprehensive',
    totalQuestions: 12,
    riskDistribution: {
      bySeverity: { HIGH: 2, LOW: 1 },
      byRiskCategory: { prompt_injection: 3 },
      byRiskDomain: { prompt_injection: 3 },
    },
  });

  assert.equal(fallback.totalQuestions, 12);
  assert.equal(fallback.findingCount, 3);
  assert.deepEqual(fallback.severityDistribution, { HIGH: 2, LOW: 1 });
  assert.equal(fallback.conclusionSnapshot.source, 'LEGACY_FALLBACK');
  assert.equal(fallback.conclusionSnapshot.state, 'INCOMPLETE');
  assert.deepEqual(fallback.conclusionSnapshot.reasonCodes, ['LEGACY_SNAPSHOT_MISSING']);
  assert.equal('riskEvidencePortfolio' in fallback, false);
  assert.equal('charts' in fallback, false);
});

test('历史 listSummary 缺字段或畸形时逐字段合并安全回退，不向 Web 返回 undefined', () => {
  const summary = parseReportListSummary(
    {
      kind: 'comprehensive',
      headline: '保留有效摘要',
      totalQuestions: 'not-a-number',
      processedQuestions: undefined,
      findingCount: '3',
      severityDistribution: { HIGH: '2', LOW: 1 },
      verdictDistribution: { FAIL: 2, PASS: -1 },
      metrics: { includedReportCount: 2, invalid: { evidence: EVIDENCE_MARKER } },
      explanationRun: 'invalid',
    },
    {
      kind: 'safety_overview',
      totalQuestions: 12,
      riskDistribution: {
        bySeverity: { HIGH: 2, LOW: 1 },
        byRiskCategory: {},
        byRiskDomain: {},
      },
    },
  );

  assert.equal(summary.kind, 'safety_overview');
  assert.equal(summary.headline, '保留有效摘要');
  assert.equal(summary.totalQuestions, 12);
  assert.equal(summary.processedQuestions, 0);
  assert.equal(summary.passedCount, 0);
  assert.equal(summary.failedCount, 0);
  assert.equal(summary.errorCount, 0);
  assert.equal(summary.findingCount, 3);
  assert.deepEqual(summary.severityDistribution, { LOW: 1 });
  assert.deepEqual(summary.verdictDistribution, { FAIL: 2 });
  assert.deepEqual(summary.metrics, { includedReportCount: 2 });
  assert.equal(summary.explanationRun, undefined);
  assert.equal(summary.conclusionSnapshot.source, 'LEGACY_FALLBACK');
  assert.equal(summary.conclusionSnapshot.state, 'INCOMPLETE');
  for (const field of [
    'totalQuestions',
    'processedQuestions',
    'passedCount',
    'failedCount',
    'errorCount',
    'wrongAnswerCount',
    'evidenceFindingCount',
    'findingCount',
    'verdictDistribution',
    'severityDistribution',
  ] as const) {
    assert.notEqual(summary[field], undefined, `${field} 不得为 undefined`);
  }
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(EVIDENCE_MARKER));
});

test('listSummary 结论快照严格解析：畸形/自由文本/旧100分均保守降级 INCOMPLETE', () => {
  const valid = buildReportListSummary(fullSummary());
  const maliciousCases = [
    { ...valid, conclusionSnapshot: { ...valid.conclusionSnapshot, narrative: '可直接上线' } },
    { ...valid, conclusionSnapshot: { ...valid.conclusionSnapshot, state: 'NO_RISK_OBSERVED' } },
    {
      ...valid,
      conclusionSnapshot: {
        ...valid.conclusionSnapshot,
        counts: { ...valid.conclusionSnapshot.counts, pass: Number.POSITIVE_INFINITY },
      },
    },
    {
      ...valid,
      conclusionSnapshot: buildReportConclusionSnapshot({
        scopeKind: 'RESULT_SET',
        activeRiskCount: 0,
        results: [{ finalVerdict: 'PASS', status: 'SUCCESS', side: null }],
        engineRuns: [],
      }),
    },
    {
      ...valid,
      conclusionSnapshot: undefined,
      securityScore: { ...valid.securityScore!, score: 100, grade: 'A' },
    },
  ];

  for (const value of maliciousCases) {
    const parsed = parseReportListSummary(value, {
      kind: 'comprehensive',
      totalQuestions: 1,
      riskDistribution: { bySeverity: {}, byRiskCategory: {}, byRiskDomain: {} },
    });
    assert.equal(parsed.conclusionSnapshot.source, 'LEGACY_FALLBACK');
    assert.equal(parsed.conclusionSnapshot.state, 'INCOMPLETE');
    assert.equal(parsed.conclusionSnapshot.activeRiskCount, null);
    assert.equal(parsed.conclusionSnapshot.passRate, null);
  }
});

test('listSummary build/parse 遮蔽伪 keyCount 并保持普通字段和 null 类型', () => {
  const summary = {
    ...fullSummary(),
    metrics: {
      keyCount: 3,
      suppressionKey: null,
      businessLabel: 'PASS',
    },
  };
  summary.securityScore.coverageIncomplete = true;
  const builtOnce = buildReportListSummary(summary);
  const builtTwice = buildReportListSummary(summary);
  assert.deepEqual(builtTwice, builtOnce);
  assert.match(String(builtOnce.metrics?.keyCount), /^hash:[0-9a-f]{12}$/);
  assert.equal(builtOnce.metrics?.suppressionKey, null);
  assert.equal(builtOnce.metrics?.businessLabel, 'PASS');

  const parsedOnce = parseReportListSummary(builtOnce, {
    kind: 'comprehensive',
    totalQuestions: 1,
    riskDistribution: { bySeverity: { HIGH: 1 } },
  });
  const parsedTwice = parseReportListSummary(parsedOnce, {
    kind: 'comprehensive',
    totalQuestions: 1,
    riskDistribution: { bySeverity: { HIGH: 1 } },
  });
  assert.deepEqual(parsedTwice, parsedOnce);
  assert.match(String(parsedOnce.metrics?.keyCount), /^hash:[0-9a-f]{12}$/);
  assert.equal(parsedOnce.metrics?.suppressionKey, null);
  assert.equal(parsedOnce.metrics?.businessLabel, 'PASS');
  assert.equal(typeof parsedOnce.securityScore?.score, 'number');
  assert.equal(parsedOnce.securityScore?.coverageIncomplete, true);
});

test('normalizeStoredReportSummary 仅把 full summary 当内容，结论锚定 strict listSummary 且 kind 取 DB', async () => {
  const module = await import('../src/modules/reports/report-list-summary.js');
  const normalize = (module as Record<string, unknown>).normalizeStoredReportSummary;
  assert.equal(typeof normalize, 'function');

  const canonicalList = parseReportListSummary(null, {
    kind: 'prompt_injection_resilience',
    totalQuestions: 1,
    riskDistribution: { bySeverity: {}, byRiskCategory: {}, byRiskDomain: {} },
  });
  const full = {
    ...fullSummary(),
    kind: 'forged-json-kind',
  };
  const normalized = (
    normalize as (
      value: unknown,
      reportKind: string,
      canonicalList: typeof canonicalList,
    ) => ReturnType<typeof fullSummary>
  )(full, 'prompt_injection_resilience', canonicalList);

  assert.equal(normalized.kind, 'prompt_injection_resilience');
  assert.equal(normalized.headline, full.headline);
  assert.equal(normalized.conclusionSnapshot.source, 'LEGACY_FALLBACK');
  assert.equal(normalized.conclusionSnapshot.scopeKind, 'RESULT_SET');
});

test('deterministic list/full 的并行计数和风险数强制由 canonical snapshot 派生', async () => {
  const module = await import('../src/modules/reports/report-list-summary.js');
  const normalize = (module as Record<string, unknown>).normalizeStoredReportSummary;
  assert.equal(typeof normalize, 'function');

  const full = fullSummary();
  const compact = buildReportListSummary(full);
  const forgedCompact = {
    ...compact,
    totalQuestions: 999,
    processedQuestions: 998,
    passedCount: 997,
    failedCount: 996,
    errorCount: 995,
    findingCount: 994,
    verdictDistribution: { PASS: 997, FAIL: 996, ERROR: 995, UNKNOWN: 993 },
    securityScore: { ...compact.securityScore!, activeFindingCount: 994 },
  };
  const canonicalList = parseReportListSummary(forgedCompact, {
    kind: 'comprehensive',
    totalQuestions: 999,
    riskDistribution: { bySeverity: { HIGH: 994 } },
  });

  assert.deepEqual(
    {
      total: canonicalList.totalQuestions,
      processed: canonicalList.processedQuestions,
      pass: canonicalList.passedCount,
      fail: canonicalList.failedCount,
      error: canonicalList.errorCount,
      finding: canonicalList.findingCount,
      scoreFinding: canonicalList.securityScore?.activeFindingCount,
      verdicts: canonicalList.verdictDistribution,
    },
    {
      total: full.conclusionSnapshot.counts.expected,
      processed: full.conclusionSnapshot.counts.observed,
      pass: full.conclusionSnapshot.counts.pass,
      fail: full.conclusionSnapshot.counts.fail,
      error: full.conclusionSnapshot.counts.error,
      finding: full.conclusionSnapshot.activeRiskCount,
      scoreFinding: full.conclusionSnapshot.activeRiskCount,
      verdicts: {},
    },
  );

  const normalized = (
    normalize as (
      value: unknown,
      reportKind: string,
      canonicalList: typeof canonicalList,
    ) => ReturnType<typeof fullSummary>
  )(
    { ...full, totalQuestions: 999, passedCount: 999, findingCount: 999 },
    'comprehensive',
    canonicalList,
  );
  assert.equal(normalized.totalQuestions, canonicalList.totalQuestions);
  assert.equal(normalized.passedCount, canonicalList.passedCount);
  assert.equal(normalized.findingCount, canonicalList.findingCount);
  assert.deepEqual(normalized.verdictDistribution, canonicalList.verdictDistribution);
  assert.deepEqual(normalized.conclusionSnapshot, canonicalList.conclusionSnapshot);
});

test('写入校验拒绝 full summary 与 listSummary 的 conclusionSnapshot 不一致', async () => {
  const module = await import('../src/modules/reports/report-list-summary.js');
  const assertMatch = (module as Record<string, unknown>).assertReportConclusionSnapshotsMatch;
  assert.equal(typeof assertMatch, 'function');

  const full = fullSummary();
  const compact = buildReportListSummary(full);
  assert.doesNotThrow(() =>
    (assertMatch as (full: unknown, compact: unknown, kind: string, passRate: unknown) => void)(
      full,
      compact,
      'comprehensive',
      full.conclusionSnapshot.passRate,
    ),
  );
  assert.throws(
    () =>
      (assertMatch as (full: unknown, compact: unknown, kind: string, passRate: unknown) => void)(
        full,
        compact,
        'comprehensive',
        1,
      ),
    /passRate.*match|一致/i,
  );
  assert.throws(
    () =>
      (assertMatch as (full: unknown, compact: unknown, kind: string, passRate: unknown) => void)(
        { ...full, totalQuestions: 999 },
        compact,
        'comprehensive',
        full.conclusionSnapshot.passRate,
      ),
    /counts|match|一致/i,
  );
  assert.throws(
    () =>
      (assertMatch as (full: unknown, compact: unknown, kind: string) => void)(
        full,
        { ...compact, conclusionSnapshot: legacyReportConclusionSnapshot('TASK') },
        'comprehensive',
      ),
    /snapshot.*match|一致/i,
  );
});
