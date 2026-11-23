import { createHash } from 'node:crypto';
import type { Severity, Verdict } from '@lse/shared';

export type PortfolioReviewStatus =
  | 'UNREVIEWED'
  | 'NEEDS_REVIEW'
  | 'CONFIRMED'
  | 'FALSE_POSITIVE'
  | 'ACCEPTED_RISK';

export interface RiskPortfolioFinding {
  stableId?: string | null;
  resultId?: string | null;
  engine: string;
  riskCategory: string;
  severity: Severity | null;
  verdict: Verdict;
  confidence?: number | null;
  evidenceStrength?: string | null;
  executionOutcome?: string | null;
  reviewStatus?: string | null;
  suppressionKey?: string | null;
  evidence: string | null;
  title: string | null;
  detail?: unknown;
}

export interface RiskPortfolioWrongAnswer {
  resultId?: string;
  questionContent: string;
  modelResponse?: string | null;
  reason?: string | null;
}

export interface RiskPortfolioEvalResult {
  id?: string;
  prompt?: string | null;
  response?: string | null;
  question: { content: string };
}

export interface RiskPortfolioContext<
  W extends RiskPortfolioWrongAnswer,
  R extends RiskPortfolioEvalResult,
> {
  resultId?: string;
  questionContent: string;
  modelResponse: string | null;
  reason: string | null;
  wrongAnswer?: W;
  result?: R;
}

export interface PortfolioRisk<
  F extends RiskPortfolioFinding,
  W extends RiskPortfolioWrongAnswer,
  R extends RiskPortfolioEvalResult,
> {
  /** 仅供报告构建过程关联使用的稳定键，不进入客户报告 JSON。 */
  key: string;
  resultId?: string;
  representative: F;
  /** 同一题级风险的全部 Finding，包括被人工排除的引擎证据。 */
  findings: F[];
  /** 实际参与有效风险判断的 Finding；FALSE_POSITIVE 不在其中。 */
  activeFindings: F[];
  reviewStatus: PortfolioReviewStatus;
  acceptedResidualRisk: boolean;
  context: RiskPortfolioContext<W, R>;
}

export interface RiskPortfolio<
  F extends RiskPortfolioFinding,
  W extends RiskPortfolioWrongAnswer,
  R extends RiskPortfolioEvalResult,
> {
  allFindings: F[];
  activeFindings: F[];
  excludedFindings: F[];
  activeRisks: Array<PortfolioRisk<F, W, R>>;
  excludedRisks: Array<PortfolioRisk<F, W, R>>;
  representativeFindings: F[];
  scoreFindings: Array<F & { reviewStatus: PortfolioReviewStatus }>;
}

interface IndexedFinding<F> {
  finding: F;
  sourceIndex: number;
}

interface FindingGroup<F> {
  key: string;
  resultId?: string;
  entries: Array<IndexedFinding<F>>;
}

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

function severityRank(severity: Severity | null): number {
  return severity === null ? 5 : SEVERITY_RANK[severity];
}

export function normalizePortfolioReviewStatus(
  value: string | null | undefined,
): PortfolioReviewStatus {
  switch (value) {
    case 'NEEDS_REVIEW':
    case 'CONFIRMED':
    case 'FALSE_POSITIVE':
    case 'ACCEPTED_RISK':
    case 'UNREVIEWED':
      return value;
    default:
      return 'UNREVIEWED';
  }
}

function text(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function stableDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function findingSignature(finding: RiskPortfolioFinding): string {
  return [
    finding.engine,
    finding.riskCategory,
    finding.severity,
    finding.verdict,
    normalizePortfolioReviewStatus(finding.reviewStatus),
    text(finding.suppressionKey),
    text(finding.title),
    text(finding.evidence),
  ].join('\u001f');
}

function canonicalValue(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN';
    if (!Number.isFinite(value)) return `number:${String(value)}`;
    return `number:${value}`;
  }
  if (typeof value === 'boolean') return `boolean:${value}`;
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;
  if (typeof value === 'symbol') return `symbol:${String(value.description ?? '')}`;
  if (typeof value === 'function') return `function:${value.name || 'anonymous'}`;
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item, seen)).join(',')}]`;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return 'circular';
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => compareText(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item, seen)}`);
    seen.delete(value);
    return `{${entries.join(',')}}`;
  }
  return String(value);
}

function stableFindingKey(finding: RiskPortfolioFinding): string {
  const stableId = text(finding.stableId);
  if (stableId) return `id:${stableId}`;
  return `detail:${stableDigest(canonicalValue(finding.detail))}`;
}

/** 最高严重度优先；同级按置信度和可解释文本稳定排序，避免依赖数据库返回顺序。 */
export function comparePortfolioFindingPriority<F extends RiskPortfolioFinding>(
  a: F,
  b: F,
): number {
  const severity = severityRank(a.severity) - severityRank(b.severity);
  if (severity !== 0) return severity;
  const confidence = (b.confidence ?? -1) - (a.confidence ?? -1);
  if (confidence !== 0) return confidence;
  return (
    compareText(a.engine, b.engine) ||
    compareText(a.riskCategory, b.riskCategory) ||
    compareText(text(a.title), text(b.title)) ||
    compareText(text(a.evidence), text(b.evidence)) ||
    compareText(a.verdict, b.verdict) ||
    compareText(
      normalizePortfolioReviewStatus(a.reviewStatus),
      normalizePortfolioReviewStatus(b.reviewStatus),
    ) ||
    compareText(stableFindingKey(a), stableFindingKey(b))
  );
}

export function aggregatePortfolioReviewStatus<F extends RiskPortfolioFinding>(
  findings: F[],
): PortfolioReviewStatus {
  const statuses = new Set(
    findings.map((finding) => normalizePortfolioReviewStatus(finding.reviewStatus)),
  );
  if (statuses.size !== 1) return 'NEEDS_REVIEW';
  const status = [...statuses][0]!;
  return status === 'FALSE_POSITIVE' ? 'NEEDS_REVIEW' : status;
}

function stringFromDetail(detail: unknown, key: string): string | undefined {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  const value = (detail as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstNonBlank(...values: Array<string | null | undefined>): string | undefined {
  return values
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim();
}

function contextForRisk<
  F extends RiskPortfolioFinding,
  W extends RiskPortfolioWrongAnswer,
  R extends RiskPortfolioEvalResult,
>(args: {
  representative: F;
  resultId?: string;
  wrongAnswerByResultId: Map<string, W>;
  resultById: Map<string, R>;
}): RiskPortfolioContext<W, R> {
  const { representative, resultId } = args;
  const wrongAnswer = resultId ? args.wrongAnswerByResultId.get(resultId) : undefined;
  const result = resultId ? args.resultById.get(resultId) : undefined;
  const promptExcerpt = stringFromDetail(representative.detail, 'promptExcerpt');
  const responseExcerpt = stringFromDetail(representative.detail, 'responseExcerpt');
  const questionContent =
    firstNonBlank(
      wrongAnswer?.questionContent,
      result?.prompt,
      result?.question.content,
      promptExcerpt,
      representative.title,
      representative.riskCategory,
    ) ?? '未记录风险输入';
  const modelResponse =
    firstNonBlank(
      wrongAnswer?.modelResponse,
      result?.response,
      responseExcerpt,
      representative.evidence,
    ) ?? null;
  const reason = firstNonBlank(representative.evidence, representative.title) ?? null;

  return {
    ...(resultId ? { resultId } : {}),
    questionContent,
    modelResponse,
    reason,
    ...(wrongAnswer ? { wrongAnswer } : {}),
    ...(result ? { result } : {}),
  };
}

export function buildRiskPortfolio<
  F extends RiskPortfolioFinding,
  W extends RiskPortfolioWrongAnswer,
  R extends RiskPortfolioEvalResult,
>(input: {
  findings: readonly F[];
  wrongAnswers: readonly W[];
  results?: readonly R[];
}): RiskPortfolio<F, W, R> {
  const groups = new Map<string, FindingGroup<F>>();
  const taskOccurrenceBySignature = new Map<string, number>();
  const sourceOrderByRiskKey = new Map<string, number>();

  input.findings.forEach((finding, sourceIndex) => {
    const resultId = text(finding.resultId) || undefined;
    let groupId: string;
    let key: string;
    if (resultId) {
      groupId = `result:${resultId}`;
      key = `result:${stableDigest(resultId)}`;
    } else {
      const signature = findingSignature(finding);
      const occurrence = taskOccurrenceBySignature.get(signature) ?? 0;
      taskOccurrenceBySignature.set(signature, occurrence + 1);
      groupId = `task:${stableDigest(signature)}:${occurrence}`;
      key = groupId;
    }
    if (!sourceOrderByRiskKey.has(key)) {
      sourceOrderByRiskKey.set(key, sourceIndex);
    }
    const group = groups.get(groupId) ?? { key, ...(resultId ? { resultId } : {}), entries: [] };
    group.entries.push({ finding, sourceIndex });
    groups.set(groupId, group);
  });

  const wrongAnswerByResultId = new Map<string, W>();
  for (const wrongAnswer of input.wrongAnswers) {
    const resultId = text(wrongAnswer.resultId);
    if (resultId && !wrongAnswerByResultId.has(resultId)) {
      wrongAnswerByResultId.set(resultId, wrongAnswer);
    }
  }
  const resultById = new Map<string, R>();
  for (const result of input.results ?? []) {
    const resultId = text(result.id);
    if (resultId && !resultById.has(resultId)) resultById.set(resultId, result);
  }

  const activeRisks: Array<PortfolioRisk<F, W, R>> = [];
  const excludedRisks: Array<PortfolioRisk<F, W, R>> = [];
  for (const group of groups.values()) {
    const findings = group.entries
      .sort(
        (a, b) =>
          comparePortfolioFindingPriority(a.finding, b.finding) || a.sourceIndex - b.sourceIndex,
      )
      .map((entry) => entry.finding);
    const activeFindings = findings.filter(
      (finding) => normalizePortfolioReviewStatus(finding.reviewStatus) !== 'FALSE_POSITIVE',
    );
    const representative = (activeFindings[0] ?? findings[0])!;
    const reviewStatus =
      activeFindings.length > 0 ? aggregatePortfolioReviewStatus(activeFindings) : 'FALSE_POSITIVE';
    const risk: PortfolioRisk<F, W, R> = {
      key: group.key,
      ...(group.resultId ? { resultId: group.resultId } : {}),
      representative,
      findings,
      activeFindings,
      reviewStatus,
      acceptedResidualRisk: reviewStatus === 'ACCEPTED_RISK',
      context: contextForRisk({
        representative,
        resultId: group.resultId,
        wrongAnswerByResultId,
        resultById,
      }),
    };
    (activeFindings.length > 0 ? activeRisks : excludedRisks).push(risk);
  }

  const compareRisk = (a: PortfolioRisk<F, W, R>, b: PortfolioRisk<F, W, R>) => {
    const representativeOrder = comparePortfolioFindingPriority(a.representative, b.representative);
    const sourceOrder =
      (sourceOrderByRiskKey.get(a.key) ?? 0) - (sourceOrderByRiskKey.get(b.key) ?? 0);
    return representativeOrder || compareText(a.key, b.key) || sourceOrder;
  };
  activeRisks.sort(compareRisk);
  excludedRisks.sort(compareRisk);
  const activeFindings = activeRisks.flatMap((risk) => risk.activeFindings);
  const excludedFindings = input.findings
    .filter((finding) => normalizePortfolioReviewStatus(finding.reviewStatus) === 'FALSE_POSITIVE')
    .sort(comparePortfolioFindingPriority);
  const representativeFindings = activeRisks.map((risk) => risk.representative);
  const scoreFindings = [
    ...activeRisks.map((risk) => ({ ...risk.representative, reviewStatus: risk.reviewStatus })),
    ...excludedRisks.map((risk) => ({
      ...risk.representative,
      reviewStatus: 'FALSE_POSITIVE' as const,
    })),
  ];

  return {
    allFindings: [...input.findings].sort(comparePortfolioFindingPriority),
    activeFindings,
    excludedFindings,
    activeRisks,
    excludedRisks,
    representativeFindings,
    scoreFindings,
  };
}
