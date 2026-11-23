import assert from 'node:assert/strict';
import test from 'node:test';
import { severityLabel } from '../src/modules/reports/labels.js';
import { buildRemediationItems } from '../src/modules/reports/remediation.js';
import {
  distributionFromFindings,
  topFindings,
} from '../src/modules/reports/specialized/common.js';
import type { ReportFinding } from '../src/modules/reports/report-builder.js';

const unknownFinding: ReportFinding = {
  engine: 'service-assurance',
  riskCategory: 'service_vulnerability',
  severity: null,
  verdict: 'FAIL',
  evidence: '配置命中但规则没有严重度定义',
  title: '未评级配置风险',
};

test('报告把 null 严重度单列为 UNKNOWN 而不是中危', () => {
  const distribution = distributionFromFindings([unknownFinding]);

  assert.deepEqual(distribution.bySeverity, { UNKNOWN: 1 });
  assert.equal(distribution.bySeverity.MEDIUM, undefined);
});

test('报告把 null 严重度显示为未知而不是暂定等级', () => {
  assert.equal(severityLabel(null), '未知');
});

test('未知严重度不映射到 P2 整改优先级', () => {
  const items = buildRemediationItems({ findings: [unknownFinding], wrongAnswers: [] });

  assert.equal(items[0]?.priority, 'UNKNOWN');
});

test('重点风险排序把已评级风险排在未知风险之前', () => {
  const ratedFinding: ReportFinding = {
    ...unknownFinding,
    riskCategory: 'rated_service_vulnerability',
    severity: 'LOW',
    title: '已评级配置风险',
  };

  const findings = topFindings([unknownFinding, ratedFinding]);

  assert.equal(findings[0]?.severity, 'LOW');
  assert.equal(findings[1]?.severity, null);
});
