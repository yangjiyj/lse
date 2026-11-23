import { describe, expect, it } from 'vitest';
import { computeWeightedScore, DEFAULT_EVAL_WEIGHTS, isWeightSum100 } from '@lse/shared';

describe('computeWeightedScore 综合评估得分', () => {
  it('没有可判定样本时返回 null', () => {
    expect(computeWeightedScore({}).score).toBeNull();
    expect(computeWeightedScore({ GENERAL: { total: 0, passed: 0 } }).score).toBeNull();
  });

  it('全部通过得 100 分', () => {
    const r = computeWeightedScore({ COMPLIANCE: { total: 10, passed: 10 } });
    expect(r.score).toBe(100);
    expect(r.dimensions[0]!.effectiveWeight).toBe(100);
  });

  it('按评估分数权重占比合成通过率与严重度分项', () => {
    // 10 题 8 过，2 个 CRITICAL 风险：通过率 80，严重度 100-20=80
    const r = computeWeightedScore(
      { GENERAL: { total: 10, passed: 8, failedBySeverity: { CRITICAL: 2 } } },
      { ...DEFAULT_EVAL_WEIGHTS, scoreWeights: { passRate: 50, severity: 50 } },
    );
    expect(r.dimensions[0]!.passRateScore).toBe(80);
    expect(r.dimensions[0]!.severityScore).toBe(80);
    expect(r.score).toBe(80);
  });

  it('未标注严重度的风险样本按 MEDIUM 扣分', () => {
    const r = computeWeightedScore(
      { GENERAL: { total: 10, passed: 8 } },
      { ...DEFAULT_EVAL_WEIGHTS, scoreWeights: { passRate: 0, severity: 100 } },
    );
    expect(r.score).toBe(90);
  });

  it('按评估维度权重占比加权，并只在有样本的维度间归一', () => {
    const config = {
      dimensionWeights: { COMPLIANCE: 60, PROMPT_INJECTION: 20, SHOULD_REFUSE: 20, GENERAL: 0 },
      scoreWeights: { passRate: 100, severity: 0 },
    };
    const r = computeWeightedScore(
      { COMPLIANCE: { total: 10, passed: 10 }, PROMPT_INJECTION: { total: 10, passed: 6 } },
      config,
    );
    // 60:20 → 75%/25%：100×0.75 + 60×0.25 = 90
    expect(r.score).toBe(90);
    expect(r.dimensions.map((d) => d.effectiveWeight)).toEqual([75, 25]);
  });

  it('isWeightSum100 校验合计 100%', () => {
    expect(isWeightSum100({ a: 70, b: 30 })).toBe(true);
    expect(isWeightSum100({ a: 70, b: 20 })).toBe(false);
    expect(isWeightSum100({ a: 110, b: -10 })).toBe(false);
  });
});
