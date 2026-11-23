import type {
  BuiltReportRiskDistribution,
  BuiltReportSummary,
  ReportExplanationRun,
} from './report-builder.js';
import { redactReportSnapshot } from './report-redaction.js';
import {
  legacyReportConclusionSnapshot,
  normalizeReportConclusionSnapshot,
  parseReportConclusionSnapshot,
  reportConclusionScopeKindForReportKind,
  type ReportConclusionSnapshot,
} from './report-conclusion.js';

type SummaryWithSpecializedFields = BuiltReportSummary & {
  kind?: string;
  headline?: string;
  metrics?: Record<string, number | string | null>;
};

export interface ReportListSummary {
  kind?: string;
  headline?: string;
  metrics?: Record<string, number | string | null>;
  totalQuestions: number;
  processedQuestions: number;
  passedCount: number;
  failedCount: number;
  errorCount: number;
  wrongAnswerCount: number;
  evidenceFindingCount: number;
  findingCount: number;
  securityScore?: BuiltReportSummary['securityScore'];
  conclusionSnapshot: ReportConclusionSnapshot;
  verdictDistribution: Record<string, number>;
  severityDistribution: Record<string, number>;
  explanationRun?: ReportExplanationRun;
}

export const REPORT_LIST_SELECT = {
  id: true,
  taskId: true,
  tenantId: true,
  title: true,
  format: true,
  kind: true,
  listSummary: true,
  totalQuestions: true,
  riskDistribution: true,
  generatedById: true,
  createdAt: true,
} as const;

/** 从完整冻结快照提取列表唯一允许持久化的轻量字段。 */
export function buildReportListSummary(summary: SummaryWithSpecializedFields): ReportListSummary {
  const conclusionSnapshot = parseReportConclusionSnapshot(summary.conclusionSnapshot);
  const facts = canonicalFacts(conclusionSnapshot);
  const expectedScopeKind = reportConclusionScopeKindForReportKind(summary.kind);
  if (conclusionSnapshot.scopeKind !== expectedScopeKind) {
    throw new TypeError('report conclusion snapshot scopeKind does not match report kind');
  }
  const compact: ReportListSummary = {
    ...(summary.kind ? { kind: summary.kind } : {}),
    ...(summary.headline ? { headline: summary.headline } : {}),
    ...(summary.metrics ? { metrics: summary.metrics } : {}),
    totalQuestions: facts?.totalQuestions ?? summary.totalQuestions,
    processedQuestions: facts?.processedQuestions ?? summary.processedQuestions,
    passedCount: facts?.passedCount ?? summary.passedCount,
    failedCount: facts?.failedCount ?? summary.failedCount,
    errorCount: facts?.errorCount ?? summary.errorCount,
    wrongAnswerCount: summary.wrongAnswerCount,
    evidenceFindingCount: summary.evidenceFindingCount,
    findingCount: facts?.findingCount ?? summary.findingCount,
    ...(summary.securityScore
      ? {
          securityScore: facts
            ? { ...summary.securityScore, activeFindingCount: facts.findingCount }
            : summary.securityScore,
        }
      : {}),
    conclusionSnapshot,
    verdictDistribution: facts?.verdictDistribution ?? summary.verdictDistribution,
    severityDistribution: summary.severityDistribution,
    ...(summary.explanationRun ? { explanationRun: summary.explanationRun } : {}),
  };
  return redactReportSnapshot(compact);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeDistribution(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, count]) =>
      typeof count === 'number' && Number.isFinite(count) && count >= 0 ? [[key, count]] : [],
    ),
  );
}

function safeSeverityDistribution(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const bySeverity = (value as { bySeverity?: unknown }).bySeverity;
  return safeDistribution(bySeverity);
}

function safeCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : fallback;
}

interface CanonicalReportFacts {
  totalQuestions: number;
  processedQuestions: number;
  passedCount: number;
  failedCount: number;
  errorCount: number;
  findingCount: number;
  verdictDistribution: Record<string, number>;
}

function canonicalFacts(snapshot: ReportConclusionSnapshot): CanonicalReportFacts | null {
  if (snapshot.source !== 'DETERMINISTIC_RULE') return null;
  const verdictDistribution = Object.fromEntries(
    [
      ['PASS', snapshot.counts.pass],
      ['FAIL', snapshot.counts.fail],
      ['ERROR', snapshot.counts.error],
      ['UNKNOWN', snapshot.counts.unknown],
    ].filter((entry) => (entry[1] as number) > 0),
  );
  return {
    totalQuestions: snapshot.counts.expected,
    processedQuestions: snapshot.counts.observed,
    passedCount: snapshot.counts.pass,
    failedCount: snapshot.counts.fail,
    errorCount: snapshot.counts.error,
    findingCount: snapshot.activeRiskCount,
    verdictDistribution,
  };
}

function safeMetrics(value: unknown): Record<string, number | string | null> | undefined {
  if (!isRecord(value)) return undefined;
  const metrics = Object.fromEntries(
    Object.entries(value).flatMap(([key, metric]) =>
      metric === null ||
      typeof metric === 'string' ||
      (typeof metric === 'number' && Number.isFinite(metric))
        ? [[key, metric]]
        : [],
    ),
  );
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function safeSecurityScore(value: unknown): BuiltReportSummary['securityScore'] | undefined {
  if (!isRecord(value) || !['A', 'B', 'C', 'D', 'F'].includes(String(value.grade))) {
    return undefined;
  }
  const numericFields = [
    'score',
    'activeFindingCount',
    'confirmedFindingCount',
    'unreviewedFindingCount',
    'needsReviewFindingCount',
    'falsePositiveFindingCount',
    'acceptedRiskFindingCount',
    'skippedEngineCount',
    'riskDeduction',
    'reviewDeduction',
    'coverageDeduction',
    'totalDeduction',
  ] as const;
  if (
    numericFields.some(
      (field) =>
        typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] < 0,
    ) ||
    (value.score as number) > 100
  ) {
    return undefined;
  }
  return Object.fromEntries([
    ...(value.policyVersion === 'risk-score-v1' ? [['policyVersion', 'risk-score-v1']] : []),
    ...(value.advisory === true ? [['advisory', true]] : []),
    ['grade', value.grade],
    ...(typeof value.coverageIncomplete === 'boolean'
      ? [['coverageIncomplete', value.coverageIncomplete]]
      : []),
    ...numericFields.map((field) => [field, value[field]]),
  ]) as unknown as BuiltReportSummary['securityScore'];
}

function safeExplanationRun(value: unknown): ReportExplanationRun | undefined {
  if (!isRecord(value)) return undefined;
  if (!['local', 'self', 'review_model'].includes(String(value.mode))) return undefined;
  if (typeof value.label !== 'string' || !value.label.trim()) return undefined;
  const attemptedCount = safeCount(value.attemptedCount, -1);
  const llmCount = safeCount(value.llmCount, -1);
  const fallbackCount = safeCount(value.fallbackCount, -1);
  if ([attemptedCount, llmCount, fallbackCount].some((count) => count < 0)) return undefined;
  if (
    !Array.isArray(value.skippedReasons) ||
    value.skippedReasons.some((item) => typeof item !== 'string')
  ) {
    return undefined;
  }
  return {
    mode: value.mode as ReportExplanationRun['mode'],
    label: value.label,
    ...(typeof value.modelTargetName === 'string' && value.modelTargetName.trim()
      ? { modelTargetName: value.modelTargetName }
      : {}),
    attemptedCount,
    llmCount,
    fallbackCount,
    skippedReasons: value.skippedReasons,
  };
}

export function buildFallbackReportListSummary(input: {
  kind: string;
  totalQuestions: number | null;
  riskDistribution: BuiltReportRiskDistribution | unknown;
}): ReportListSummary {
  const severityDistribution = safeSeverityDistribution(input.riskDistribution);
  const findingCount = Object.values(severityDistribution).reduce((sum, count) => sum + count, 0);
  return {
    kind: input.kind,
    totalQuestions: input.totalQuestions ?? 0,
    processedQuestions: 0,
    passedCount: 0,
    failedCount: 0,
    errorCount: 0,
    wrongAnswerCount: 0,
    evidenceFindingCount: findingCount,
    findingCount,
    conclusionSnapshot: normalizeReportConclusionSnapshot(
      undefined,
      reportConclusionScopeKindForReportKind(input.kind),
    ),
    verdictDistribution: {},
    severityDistribution,
  };
}

export function parseReportListSummary(
  value: unknown,
  fallback: Parameters<typeof buildFallbackReportListSummary>[0],
): ReportListSummary {
  const base = buildFallbackReportListSummary(fallback);
  const raw = isRecord(value) ? value : null;
  const redacted = redactReportSnapshot(value);
  if (!raw || !isRecord(redacted)) return base;

  const metrics = safeMetrics(redacted.metrics);
  const securityScore = safeSecurityScore(redacted.securityScore);
  const explanationRun = safeExplanationRun(redacted.explanationRun);
  const expectedScopeKind = reportConclusionScopeKindForReportKind(fallback.kind);
  const normalizedConclusionSnapshot = normalizeReportConclusionSnapshot(
    raw.conclusionSnapshot,
    expectedScopeKind,
  );
  const conclusionSnapshot =
    normalizedConclusionSnapshot.scopeKind === expectedScopeKind
      ? normalizedConclusionSnapshot
      : legacyReportConclusionSnapshot(expectedScopeKind);
  const facts = canonicalFacts(conclusionSnapshot);
  const canonicalSecurityScore =
    securityScore && facts
      ? { ...securityScore, activeFindingCount: facts.findingCount }
      : securityScore;
  const severityDistribution = isRecord(redacted.severityDistribution)
    ? safeDistribution(redacted.severityDistribution)
    : base.severityDistribution;
  return {
    ...base,
    ...(typeof redacted.headline === 'string' && redacted.headline.trim()
      ? { headline: redacted.headline }
      : {}),
    ...(metrics ? { metrics } : {}),
    totalQuestions:
      facts?.totalQuestions ?? safeCount(redacted.totalQuestions, base.totalQuestions),
    processedQuestions:
      facts?.processedQuestions ?? safeCount(redacted.processedQuestions, base.processedQuestions),
    passedCount: facts?.passedCount ?? safeCount(redacted.passedCount, base.passedCount),
    failedCount: facts?.failedCount ?? safeCount(redacted.failedCount, base.failedCount),
    errorCount: facts?.errorCount ?? safeCount(redacted.errorCount, base.errorCount),
    wrongAnswerCount: safeCount(redacted.wrongAnswerCount, base.wrongAnswerCount),
    evidenceFindingCount: safeCount(redacted.evidenceFindingCount, base.evidenceFindingCount),
    findingCount: facts?.findingCount ?? safeCount(redacted.findingCount, base.findingCount),
    ...(canonicalSecurityScore ? { securityScore: canonicalSecurityScore } : {}),
    conclusionSnapshot,
    verdictDistribution:
      facts?.verdictDistribution ?? safeDistribution(redacted.verdictDistribution),
    severityDistribution,
    ...(explanationRun ? { explanationRun } : {}),
  };
}

/**
 * 完整 summary 只承载冻结内容；结论只接受调用者从 listSummary 严格解析出的 canonical 快照。
 * JSON 内的 kind 不可信，始终由数据库列覆盖。
 */
export function normalizeStoredReportSummary(
  value: unknown,
  reportKind: string,
  canonicalListSummary: ReportListSummary,
): BuiltReportSummary {
  const redactedSummary = redactReportSnapshot(value);
  const safeSummary = isRecord(redactedSummary) ? redactedSummary : {};
  const expectedScopeKind = reportConclusionScopeKindForReportKind(reportKind);
  const normalizedConclusionSnapshot = normalizeReportConclusionSnapshot(
    canonicalListSummary.conclusionSnapshot,
    expectedScopeKind,
  );
  const conclusionSnapshot =
    normalizedConclusionSnapshot.scopeKind === expectedScopeKind
      ? normalizedConclusionSnapshot
      : legacyReportConclusionSnapshot(expectedScopeKind);
  return {
    ...safeSummary,
    kind: reportKind,
    totalQuestions: canonicalListSummary.totalQuestions,
    processedQuestions: canonicalListSummary.processedQuestions,
    passedCount: canonicalListSummary.passedCount,
    failedCount: canonicalListSummary.failedCount,
    errorCount: canonicalListSummary.errorCount,
    findingCount: canonicalListSummary.findingCount,
    verdictDistribution: canonicalListSummary.verdictDistribution,
    ...(canonicalListSummary.securityScore
      ? { securityScore: canonicalListSummary.securityScore }
      : {}),
    conclusionSnapshot,
  } as unknown as BuiltReportSummary;
}

/** 写入前确认 full/list 两份冻结快照逐字段一致，避免生成时形成双重事实源。 */
export function assertReportConclusionSnapshotsMatch(
  fullSummary: unknown,
  listSummary: unknown,
  reportKind: string,
  reportPassRate: number | null,
): void {
  if (!isRecord(fullSummary) || !isRecord(listSummary)) {
    throw new TypeError('report conclusion snapshots must match');
  }
  const fullSnapshot = parseReportConclusionSnapshot(fullSummary.conclusionSnapshot);
  const listSnapshot = parseReportConclusionSnapshot(listSummary.conclusionSnapshot);
  const expectedScopeKind = reportConclusionScopeKindForReportKind(reportKind);
  if (
    fullSnapshot.scopeKind !== expectedScopeKind ||
    listSnapshot.scopeKind !== expectedScopeKind ||
    JSON.stringify(fullSnapshot) !== JSON.stringify(listSnapshot)
  ) {
    throw new TypeError('report conclusion snapshots must match');
  }
  const facts = canonicalFacts(fullSnapshot);
  if (!facts) throw new TypeError('new report conclusion snapshot must be deterministic');
  for (const summary of [fullSummary, listSummary]) {
    if (
      summary.totalQuestions !== facts.totalQuestions ||
      summary.processedQuestions !== facts.processedQuestions ||
      summary.passedCount !== facts.passedCount ||
      summary.failedCount !== facts.failedCount ||
      summary.errorCount !== facts.errorCount ||
      summary.findingCount !== facts.findingCount ||
      JSON.stringify(summary.verdictDistribution) !== JSON.stringify(facts.verdictDistribution) ||
      !isRecord(summary.securityScore) ||
      summary.securityScore.activeFindingCount !== facts.findingCount
    ) {
      throw new TypeError('report parallel counts must match conclusion snapshot');
    }
  }
  const fullSecurityScore = fullSummary.securityScore;
  const listSecurityScore = listSummary.securityScore;
  if (
    !isRecord(fullSecurityScore) ||
    !isRecord(listSecurityScore) ||
    JSON.stringify(fullSecurityScore) !== JSON.stringify(listSecurityScore) ||
    fullSecurityScore.policyVersion !== 'risk-score-v1' ||
    fullSecurityScore.advisory !== true ||
    fullSecurityScore.coverageIncomplete !== !fullSnapshot.coverageComplete
  ) {
    throw new TypeError('report security score must match the conclusion snapshot');
  }
  const fullCharts = fullSummary.charts;
  const expectedPassRatePercent =
    fullSnapshot.passRate === null ? null : Math.round(fullSnapshot.passRate * 1000) / 10;
  if (
    !isRecord(fullCharts) ||
    fullCharts.passRatePercent !== expectedPassRatePercent ||
    !Array.isArray(fullCharts.verdict) ||
    JSON.stringify(
      Object.fromEntries(
        fullCharts.verdict.flatMap((item) =>
          isRecord(item) && typeof item.key === 'string' && typeof item.value === 'number'
            ? [[item.key, item.value]]
            : [],
        ),
      ),
    ) !== JSON.stringify(facts.verdictDistribution)
  ) {
    throw new TypeError('report charts must match the conclusion snapshot');
  }
  if (reportPassRate !== fullSnapshot.passRate) {
    throw new TypeError('report passRate must match conclusion snapshot');
  }
}
