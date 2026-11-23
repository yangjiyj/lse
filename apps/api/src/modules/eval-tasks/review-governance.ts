import { createHash } from 'node:crypto';
import type { EngineResult, FindingReviewStatus } from '@lse/shared';

export interface FindingReviewGovernance {
  confidence: number | null;
  reviewStatus: FindingReviewStatus;
  reviewReason: string | null;
  suppressionKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Math.round(value * 1000) / 1000;
}

function rawConfidence(result: EngineResult): number | null {
  const direct = clampConfidence(result.confidence);
  if (direct !== null) return direct;
  if (isRecord(result.rawOutput)) {
    const fromRaw = clampConfidence(result.rawOutput.confidence);
    if (fromRaw !== null) return fromRaw;
  }
  if (result.score === null) return null;
  if (result.verdict === 'FAIL') return clampConfidence(1 - result.score);
  if (result.verdict === 'PASS') return clampConfidence(result.score);
  return null;
}

function reviewConfidence(review: EngineResult | null): number | null {
  if (!review || review.status === 'skipped') return null;
  const direct = rawConfidence(review);
  if (direct !== null) return direct;
  if (review.score === null) return null;
  return review.verdict === 'FAIL'
    ? clampConfidence(1 - review.score)
    : clampConfidence(review.score);
}

function reason(prefix: string, review: EngineResult | null): string {
  const evidence = review?.evidence?.trim();
  return evidence ? `${prefix}：${evidence}` : prefix;
}

export function suppressionKeyFor(result: EngineResult): string {
  const payload = [
    result.engine,
    result.riskCategory,
    result.severity,
    result.verdict,
    result.questionId ?? '',
    result.evidence ?? '',
  ].join('\n');
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

export function decideFindingReview(
  result: EngineResult,
  aiReview: EngineResult | null,
): FindingReviewGovernance {
  const suppressionKey = suppressionKeyFor(result);
  if (!aiReview) {
    return {
      confidence: rawConfidence(result),
      reviewStatus: 'UNREVIEWED',
      reviewReason: null,
      suppressionKey,
    };
  }

  if (
    aiReview.status === 'skipped' ||
    aiReview.verdict === 'UNKNOWN' ||
    aiReview.verdict === 'ERROR'
  ) {
    return {
      confidence: reviewConfidence(aiReview) ?? rawConfidence(result),
      reviewStatus: 'NEEDS_REVIEW',
      reviewReason: reason('AI 复核未能明确判定，建议人工复核', aiReview),
      suppressionKey,
    };
  }

  if (aiReview.verdict === 'PASS') {
    return {
      confidence: reviewConfidence(aiReview) ?? rawConfidence(result),
      reviewStatus: 'NEEDS_REVIEW',
      reviewReason: reason('模型判定为疑似误报，待人工确认', aiReview),
      suppressionKey,
    };
  }

  return {
    confidence: reviewConfidence(aiReview) ?? rawConfidence(result),
    reviewStatus: 'NEEDS_REVIEW',
    reviewReason: reason('模型判定为疑似风险，待人工确认', aiReview),
    suppressionKey,
  };
}

export function isSuppressedByReview(review: FindingReviewGovernance): boolean {
  return review.reviewStatus === 'FALSE_POSITIVE';
}

/** 模型复核分歧保留为待确认，不能当作已确认的语义风险。客观工具风险不受影响。 */
export function applySuspectedFalsePositive(result: EngineResult, aiReview: EngineResult | null): EngineResult {
  if (result.engine !== 'agent-llm-judge' || result.verdict !== 'FAIL' ||
      aiReview?.status !== 'success' || aiReview.verdict !== 'PASS') return result;
  return { ...result, verdict: 'UNKNOWN', score: null,
    evidence: reason('模型判定为疑似误报，待人工确认', aiReview),
    rawOutput: { ...(isRecord(result.rawOutput) ? result.rawOutput : {}), suspectedFalsePositive: true, proposedVerdict: 'FAIL' } };
}
