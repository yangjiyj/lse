import { describe, expect, it } from 'vitest';
import type { ReportConclusionSnapshot } from './api';
import { presentReportConclusion } from './report-conclusion';

const snapshot = (state: ReportConclusionSnapshot['state']): ReportConclusionSnapshot => ({
  schemaVersion: 1,
  policyVersion: 'report-conclusion-v1',
  scopeKind: 'TASK',
  taskCompleted: true,
  resultDetailsAvailable: true,
  taskCountersMatch: true,
  missingEngineRunCount: 0,
  source: 'DETERMINISTIC_RULE',
  basis: 'ACTIVE_RISK_AND_EXECUTION_COVERAGE',
  state,
  coverageComplete: state !== 'INCOMPLETE',
  reasonCodes: [],
  activeRiskCount: state === 'RISK_DETECTED' ? 1 : 0,
  counts: {
    expected: 10,
    observed: 10,
    valid: 10,
    pass: 9,
    fail: 1,
    activeFailCount: 1,
    excludedFailCount: 0,
    unexplainedFailCount: 0,
    error: 0,
    unknown: 0,
    missingVerdict: 0,
    modelCallError: 0,
    engineRunTotal: 1,
    engineRunFailed: 0,
    engineRunSkipped: 0,
    engineRunNonterminal: 0,
    engineRunPartialSkip: 0,
    skippedEvaluation: 0,
    unobservedResult: 0,
  },
  passRate: 0.9,
  validDecisionRate: 1,
});

describe('presentReportConclusion', () => {
  it('只按冻结结论快照展示风险，不用评分或通过率代替结论', () => {
    expect(presentReportConclusion(snapshot('RISK_DETECTED')).title).toBe('本次评估发现有效风险');
    expect(presentReportConclusion(snapshot('NO_RISK_OBSERVED')).title).toBe(
      '本次评估范围内未观察到有效风险',
    );
  });

  it('执行覆盖不完整时不能显示为安全或可放行', () => {
    const presentation = presentReportConclusion(snapshot('INCOMPLETE'));
    expect(presentation.title).toBe('评估结论不完整');
    expect(presentation.detail).toContain('不能形成风险结论');
  });

  it('历史报告明确不可验证且禁止下载', () => {
    const presentation = presentReportConclusion(undefined);
    expect(presentation.title).toBe('历史报告：结论不可验证');
    expect(presentation.downloadable).toBe(false);
  });
});
