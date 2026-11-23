import test from 'node:test';
import assert from 'node:assert/strict';
import type { Severity } from '@lse/shared';
import {
  buildSecurityScore,
  gradeLabelZh,
  scoreDisplayZh,
  scoreVerdictZh,
} from '../src/modules/reports/scoring.js';

function scoreFor(severities: Array<Severity | null>) {
  return buildSecurityScore({
    findings: severities.map((severity) => ({ severity, reviewStatus: 'CONFIRMED' })),
    engineRuns: [],
    coverageIncomplete: false,
  });
}

test('未知严重度风险保持计数但不按信息或中危扣分', () => {
  const score = scoreFor([null]);

  assert.equal(score.activeFindingCount, 1);
  assert.equal(score.riskDeduction, 0);
  assert.equal(score.score, 100);
});

test('新评分快照固定 risk-score-v1 且明确仅作辅助指标', () => {
  const score = scoreFor([]);
  assert.equal(score.policyVersion, 'risk-score-v1');
  assert.equal(score.advisory, true);
});

test('评分等级唯一使用 90/80/70/60 边界', () => {
  const cases: Array<[Severity[], number, string]> = [
    [['CRITICAL', 'HIGH', 'MEDIUM', 'INFO'], 39, 'F'],
    [['HIGH', 'HIGH', 'INFO'], 59, 'F'],
    [['HIGH', 'HIGH'], 60, 'D'],
    [['CRITICAL', 'INFO'], 69, 'D'],
    [['CRITICAL'], 70, 'C'],
    [['HIGH', 'INFO'], 79, 'C'],
    [['HIGH'], 80, 'B'],
    [['MEDIUM', 'INFO'], 89, 'B'],
    [['MEDIUM'], 90, 'A'],
  ];
  for (const [severities, expectedScore, expectedGrade] of cases) {
    const score = scoreFor(severities);
    assert.equal(score.score, expectedScore, `${expectedScore} score`);
    assert.equal(score.grade, expectedGrade, `${expectedScore} grade`);
  }
});

test('分数中文只描述中性观察档位，不作上线、合规或认证判断', () => {
  const text = [
    gradeLabelZh('A'),
    gradeLabelZh('B'),
    gradeLabelZh('C'),
    gradeLabelZh('D'),
    gradeLabelZh('F'),
    ...[59, 60, 69, 70, 79, 80, 89, 90, 100].flatMap((score) => [
      scoreVerdictZh(score),
      scoreDisplayZh(score),
    ]),
  ].join('\n');

  for (const forbidden of [
    '可以正常上线',
    '建议整改后再上线',
    '先处理再上线',
    '复测后再上线',
    '请勿直接上线',
    '基本安全',
    '合规',
    '认证',
  ]) {
    assert.doesNotMatch(text, new RegExp(forbidden));
  }
  assert.match(scoreVerdictZh(90), /风险扣分较少/);
  assert.match(scoreVerdictZh(59), /风险扣分较多/);
});


test("统一评分支持可配置维度权重与四级分级", async () => {
  const { buildUnifiedRiskScore, DEFAULT_RISK_SCORE_WEIGHTS } = await import("../src/modules/reports/scoring.js");
  assert.deepEqual(DEFAULT_RISK_SCORE_WEIGHTS, { correctness: 40, safety: 30, robustness: 20, coverage: 10 });
  assert.deepEqual(buildUnifiedRiskScore({ correctness: 100, safety: 80, robustness: 60, coverage: 40 }), {
    score: 80, level: "二级", weights: DEFAULT_RISK_SCORE_WEIGHTS,
  });
  assert.equal(buildUnifiedRiskScore({ correctness: 0, safety: 0, robustness: 0, coverage: 0 }).level, "四级");
});
