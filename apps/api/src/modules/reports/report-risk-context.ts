import type {
  ReportEngineRun,
  ReportEvalResult,
  ReportFinding,
  ReportInputData,
  ReportWrongAnswer,
} from './report-builder.js';
import { selectPrimaryReportResults } from './report-primary-results.js';
import {
  buildRiskPortfolio,
  aggregatePortfolioReviewStatus,
  comparePortfolioFindingPriority,
  type PortfolioRisk,
  type RiskPortfolio,
} from './risk-portfolio.js';

export type ReportPortfolio = RiskPortfolio<ReportFinding, ReportWrongAnswer, ReportEvalResult>;
export type ReportPortfolioRisk = PortfolioRisk<ReportFinding, ReportWrongAnswer, ReportEvalResult>;

export interface ReportFailDisposition {
  activeFailCount: number;
  excludedFailCount: number;
  unexplainedFailCount: number;
}

export interface ReportRiskContext {
  primaryResults: ReportEvalResult[];
  primaryEngineRuns: ReportEngineRun[];
  failDisposition: ReportFailDisposition;
  portfolio: ReportPortfolio;
  activeRisks: ReportPortfolio['activeRisks'];
  excludedRisks: ReportPortfolio['excludedRisks'];
  representativeFindings: ReportFinding[];
  activeFindings: ReportFinding[];
  scoreFindings: ReportPortfolio['scoreFindings'];
  evidenceByRepresentative: ReadonlyMap<ReportFinding, readonly ReportFinding[]>;
}

export interface ReportRiskViewRisk extends Omit<
  ReportPortfolioRisk,
  'representative' | 'findings' | 'activeFindings'
> {
  sourceRisk: ReportPortfolioRisk;
  representative: ReportFinding;
  findings: ReportFinding[];
  activeFindings: ReportFinding[];
}

export interface ReportRiskView {
  risks: ReportRiskViewRisk[];
  excludedRisks: ReportRiskViewRisk[];
  representativeFindings: ReportFinding[];
  activeFindings: ReportFinding[];
  evidenceByRepresentative: ReadonlyMap<ReportFinding, readonly ReportFinding[]>;
  findingCount: number;
  evidenceFindingCount: number;
}

export type ReportRiskPredicate = (
  finding: ReportFinding,
  risk: ReportPortfolioRisk,
  context: ReportRiskContext,
) => boolean;

export function classifyFailDisposition(
  results: readonly Pick<ReportEvalResult, 'id' | 'finalVerdict'>[],
  activeRisks: readonly (Pick<ReportPortfolioRisk, 'resultId'> & Partial<Pick<ReportPortfolioRisk, 'activeFindings'>>)[],
  excludedRisks: readonly Pick<ReportPortfolioRisk, 'resultId'>[],
): ReportFailDisposition {
  const activeResultIds = new Set(
    activeRisks.flatMap((risk) => (risk.resultId &&
      (!risk.activeFindings || risk.activeFindings.some(f => f.reviewStatus !== 'NEEDS_REVIEW'))
      ? [risk.resultId] : [])),
  );
  const excludedResultIds = new Set(
    excludedRisks.flatMap((risk) => (risk.resultId ? [risk.resultId] : [])),
  );
  let activeFailCount = 0;
  let excludedFailCount = 0;
  let unexplainedFailCount = 0;
  for (const result of results) {
    if (result.finalVerdict !== 'FAIL') continue;
    if (result.id && activeResultIds.has(result.id)) activeFailCount += 1;
    else if (result.id && excludedResultIds.has(result.id)) excludedFailCount += 1;
    else unexplainedFailCount += 1;
  }
  return { activeFailCount, excludedFailCount, unexplainedFailCount };
}

export function buildReportRiskContext(data: ReportInputData): ReportRiskContext {
  const allResults = data.results ?? [];
  const suspected = (finding: ReportFinding) => finding.engine === 'agent-llm-judge' &&
    finding.reviewStatus === 'NEEDS_REVIEW' &&
    (finding.reviewReason?.includes('模型判定为疑似误报') === true ||
      (typeof finding.detail === 'object' && finding.detail !== null &&
        (finding.detail as Record<string, unknown>).suspectedFalsePositive === true));
  const unresolvedIds = new Set(data.findings.filter(suspected).flatMap(f => f.resultId ? [f.resultId] : []));
  for (const finding of data.findings) {
    if (!suspected(finding) && finding.verdict === 'FAIL' && finding.reviewStatus !== 'FALSE_POSITIVE' && finding.resultId)
      unresolvedIds.delete(finding.resultId);
  }
  const primaryResults = selectPrimaryReportResults(allResults).map(result =>
    result.id && unresolvedIds.has(result.id) && result.finalVerdict === 'FAIL'
      ? { ...result, finalVerdict: 'UNKNOWN' as const } : result);
  const allResultIds = new Set(allResults.flatMap((result) => (result.id ? [result.id] : [])));
  const primaryResultIds = new Set(
    primaryResults.flatMap((result) => (result.id ? [result.id] : [])),
  );
  const belongsToPrimaryResult = (resultId: string | null | undefined) =>
    !resultId || !allResultIds.has(resultId) || primaryResultIds.has(resultId);
  const primaryEngineRuns = data.engineRuns.filter((run) => belongsToPrimaryResult(run.resultId));
  const portfolio = buildRiskPortfolio({
    findings: data.findings.filter((finding) => !suspected(finding) &&
      (finding.engine !== 'endpoint-agent-eval' || finding.verdict === 'FAIL') &&
      belongsToPrimaryResult(finding.resultId)),
    wrongAnswers: data.wrongAnswers.filter((answer) => belongsToPrimaryResult(answer.resultId)),
    results: primaryResults,
  });
  const failDisposition = classifyFailDisposition(
    primaryResults,
    portfolio.activeRisks,
    portfolio.excludedRisks,
  );
  return {
    primaryResults,
    primaryEngineRuns,
    failDisposition,
    portfolio,
    activeRisks: portfolio.activeRisks,
    excludedRisks: portfolio.excludedRisks,
    representativeFindings: portfolio.representativeFindings,
    activeFindings: portfolio.activeFindings,
    scoreFindings: portfolio.scoreFindings,
    evidenceByRepresentative: new Map(
      portfolio.activeRisks.map((risk) => [risk.representative, risk.activeFindings] as const),
    ),
  };
}

function selectRisk(
  risk: ReportPortfolioRisk,
  context: ReportRiskContext,
  predicate: ReportRiskPredicate,
): ReportRiskViewRisk | null {
  const findings = risk.findings
    .filter((finding) => predicate(finding, risk, context))
    .sort(comparePortfolioFindingPriority);
  const activeFindings = risk.activeFindings
    .filter((finding) => predicate(finding, risk, context))
    .sort(comparePortfolioFindingPriority);
  const representative = activeFindings[0] ?? findings[0];
  if (!representative) return null;
  const reviewStatus =
    activeFindings.length > 0 ? aggregatePortfolioReviewStatus(activeFindings) : 'FALSE_POSITIVE';
  return {
    ...risk,
    sourceRisk: risk,
    reviewStatus,
    acceptedResidualRisk: reviewStatus === 'ACCEPTED_RISK',
    representative,
    findings,
    activeFindings,
  };
}

export function selectReportRiskView(
  context: ReportRiskContext,
  predicate: ReportRiskPredicate,
): ReportRiskView {
  const selectedRisks = [...context.activeRisks, ...context.excludedRisks].flatMap((risk) => {
    const selected = selectRisk(risk, context, predicate);
    return selected ? [selected] : [];
  });
  const risks = selectedRisks.filter((risk) => risk.activeFindings.length > 0);
  const excludedRisks = selectedRisks.filter((risk) => risk.activeFindings.length === 0);
  const representativeFindings = risks.map((risk) => risk.representative);
  const activeFindings = risks.flatMap((risk) => risk.activeFindings);
  return {
    risks,
    excludedRisks,
    representativeFindings,
    activeFindings,
    evidenceByRepresentative: new Map(
      risks.map((risk) => [risk.representative, risk.findings] as const),
    ),
    findingCount: risks.length,
    evidenceFindingCount: activeFindings.length,
  };
}

export function fullReportRiskView(context: ReportRiskContext): ReportRiskView {
  return selectReportRiskView(context, () => true);
}

export function classifyReportRiskViewFailDisposition(
  results: readonly Pick<ReportEvalResult, 'id' | 'finalVerdict'>[],
  riskView: Pick<ReportRiskView, 'risks' | 'excludedRisks'>,
): ReportFailDisposition {
  return classifyFailDisposition(results, riskView.risks, riskView.excludedRisks);
}
