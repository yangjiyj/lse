import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineResult, FindingReviewStatus } from '@lse/shared';
import {
  type FindingReviewGovernance,
  decideFindingReview,
  isSuppressedByReview,
} from '../src/modules/eval-tasks/review-governance.js';

function engineResult(overrides: Partial<EngineResult> = {}): EngineResult {
  const now = new Date().toISOString();
  return {
    engine: overrides.engine ?? 'rule-judge',
    taskId: overrides.taskId ?? 'task-review-governance',
    questionId: overrides.questionId ?? 'question-review-governance',
    status: overrides.status ?? 'success',
    riskCategory: overrides.riskCategory ?? 'should_refuse_violation',
    severity: overrides.severity ?? 'HIGH',
    score: overrides.score ?? 0,
    verdict: overrides.verdict ?? 'FAIL',
    evidence: overrides.evidence ?? '规则命中风险',
    rawOutput: overrides.rawOutput ?? {},
    startedAt: overrides.startedAt ?? now,
    endedAt: overrides.endedAt ?? now,
    confidence: overrides.confidence,
    reviewStatus: overrides.reviewStatus,
    reviewReason: overrides.reviewReason,
  };
}

test('无 AI 判定时保持 UNREVIEWED，不采信引擎携带的人工终态', () => {
  const automaticStatuses: EngineResult['reviewStatus'][] = [
    undefined,
    'CONFIRMED',
    'FALSE_POSITIVE',
  ];

  for (const reviewStatus of automaticStatuses) {
    const review = decideFindingReview(
      engineResult({ reviewStatus, reviewReason: '引擎自动携带的状态' }),
      null,
    );

    assert.equal(review.reviewStatus, 'UNREVIEWED');
    assert.equal(review.reviewReason, null);
  }
});

test('AI skipped、UNKNOWN 或 ERROR 时统一进入待人工复核', () => {
  const cases: Array<Pick<EngineResult, 'status' | 'verdict'>> = [
    { status: 'skipped', verdict: 'UNKNOWN' },
    { status: 'success', verdict: 'UNKNOWN' },
    { status: 'failed', verdict: 'ERROR' },
  ];

  for (const aiResult of cases) {
    const review = decideFindingReview(
      engineResult(),
      engineResult({
        engine: 'llm-judge',
        status: aiResult.status,
        verdict: aiResult.verdict,
        evidence: '模型未给出可用结论',
      }),
    );

    assert.equal(review.reviewStatus, 'NEEDS_REVIEW');
    assert.match(review.reviewReason ?? '', /人工复核/);
  }
});

test('AI PASS 只能标记疑似误报并等待人工确认', () => {
  const review = decideFindingReview(
    engineResult(),
    engineResult({
      engine: 'llm-judge',
      verdict: 'PASS',
      score: 0.94,
      evidence: '回答已拒绝危险请求',
    }),
  );

  assert.equal(review.reviewStatus, 'NEEDS_REVIEW');
  assert.match(review.reviewReason ?? '', /模型判定为疑似误报/);
  assert.match(review.reviewReason ?? '', /待人工确认/);
  assert.match(review.reviewReason ?? '', /回答已拒绝危险请求/);
});

test('AI FAIL 只能标记疑似风险并等待人工确认', () => {
  const review = decideFindingReview(
    engineResult(),
    engineResult({
      engine: 'llm-judge',
      verdict: 'FAIL',
      score: 0.08,
      evidence: '回答仍给出危险步骤',
    }),
  );

  assert.equal(review.reviewStatus, 'NEEDS_REVIEW');
  assert.match(review.reviewReason ?? '', /模型判定为疑似风险/);
  assert.match(review.reviewReason ?? '', /待人工确认/);
  assert.match(review.reviewReason ?? '', /回答仍给出危险步骤/);
});

test('只有人工确认误报可抑制，风险接受仍保留残余风险', () => {
  const review = (reviewStatus: FindingReviewStatus): FindingReviewGovernance => ({
    confidence: null,
    reviewStatus,
    reviewReason: '既有人工状态',
    suppressionKey: 'manual-review-status',
  });

  assert.equal(isSuppressedByReview(review('FALSE_POSITIVE')), true);
  assert.equal(isSuppressedByReview(review('ACCEPTED_RISK')), false);
  assert.equal(isSuppressedByReview(review('CONFIRMED')), false);
  assert.equal(isSuppressedByReview(review('NEEDS_REVIEW')), false);
  assert.equal(isSuppressedByReview(review('UNREVIEWED')), false);
});

test('平台判官 FAIL 经复核标为疑似误报时不再计入 FAIL，保留待复核语义', async () => {
  const { applySuspectedFalsePositive } = await import('../src/modules/eval-tasks/review-governance.js');
  const result = engineResult({ engine: 'agent-llm-judge', verdict: 'FAIL' });
  const review = engineResult({ verdict: 'PASS', evidence: '回答只是报告 404' });
  assert.equal(applySuspectedFalsePositive(result, review).verdict, 'UNKNOWN');
  assert.equal(applySuspectedFalsePositive(result, null).verdict, 'FAIL');
  assert.equal(applySuspectedFalsePositive(engineResult({engine:'agent-tool-guard', verdict:'FAIL'}), review).verdict, 'FAIL');
});
