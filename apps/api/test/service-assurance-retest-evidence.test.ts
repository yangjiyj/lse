import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessOriginalRiskRetest,
  type RetestRisk,
} from '../src/modules/service-assurance/retest-evidence.js';
import type { ServiceAssuranceCheckExecution } from '@lse/shared';
const original: RetestRisk = {
  assessmentKey: 'risk-a',
  advisoryId: null,
  impactStatus: 'AFFECTED',
  evidenceLevel: 'CONFIG_MATCH',
  component: null,
  evidence: [{ sourceTool: 'nuclei', ruleId: 'rule-a', matchedLocation: 'https://service.test/a' }],
};
const check: ServiceAssuranceCheckExecution = {
  id: 'rule-a',
  label: '检查 A',
  status: 'COMPLETED',
  requestCount: 1,
  detail: '实际请求完成',
};

test('A 已有效复测且未再出现，B 未修复不阻止关闭 A', () => {
  const b = {
    ...original,
    assessmentKey: 'risk-b',
    evidence: [
      { sourceTool: 'nuclei', ruleId: 'rule-b', matchedLocation: 'https://service.test/b' },
    ],
  };
  assert.deepEqual(assessOriginalRiskRetest(original, [b], [check]), {
    originalRiskCheckCompleted: true,
    remainingAffectedCount: 0,
  });
});
test('未执行、零请求、缺少逐项记录不能把零命中当修复', () => {
  for (const checks of [
    [],
    [{ ...check, requestCount: 0 }],
    [{ ...check, status: 'UNKNOWN' as const }],
  ]) {
    assert.equal(assessOriginalRiskRetest(original, [], checks).originalRiskCheckCompleted, false);
  }
});
test('相同问题仍存在或降成待确认都阻止关闭', () => {
  for (const status of ['AFFECTED', 'UNDER_INVESTIGATION']) {
    assert.equal(
      assessOriginalRiskRetest(original, [{ ...original, impactStatus: status }], [check])
        .remainingAffectedCount,
      1,
    );
  }
});
test('组件升级须有同一包同一公告的明确负向证据，其他组件不阻塞', () => {
  const a = {
    ...original,
    advisoryId: 'CVE-TEST-A',
    evidenceLevel: 'VERSION_MATCH',
    component: { purl: 'pkg:pypi/example@1.0.0' },
  };
  const fixed = {
    ...a,
    assessmentKey: 'new-version-a',
    impactStatus: 'NOT_AFFECTED',
    component: { purl: 'pkg:pypi/example@2.0.0' },
  };
  const b = { ...a, advisoryId: 'CVE-TEST-B', component: { purl: 'pkg:pypi/other@1.0.0' } };
  assert.deepEqual(assessOriginalRiskRetest(a, [fixed, b], []), {
    originalRiskCheckCompleted: true,
    remainingAffectedCount: 0,
  });
  assert.equal(assessOriginalRiskRetest(a, [b], []).originalRiskCheckCompleted, false);
  assert.equal(
    assessOriginalRiskRetest(a, [{ ...fixed, evidence: [] }], []).originalRiskCheckCompleted,
    false,
  );
  assert.equal(assessOriginalRiskRetest(a, [fixed, a], []).remainingAffectedCount, 1);
});

test('不同 npm scope 不会被版本移除逻辑合并为同一包', () => {
  const a = {
    ...original,
    advisoryId: 'CVE-TEST-A',
    evidenceLevel: 'VERSION_MATCH',
    component: { purl: 'pkg:npm/@scope/vulnerable@1.0.0' },
  };
  const other = {
    ...a,
    impactStatus: 'NOT_AFFECTED',
    component: { purl: 'pkg:npm/@other/different@2.0.0' },
  };
  assert.equal(assessOriginalRiskRetest(a, [other], []).originalRiskCheckCompleted, false);
  const fixed = { ...other, component: { purl: 'pkg:npm/%40scope/vulnerable@2.0.0' } };
  assert.equal(assessOriginalRiskRetest(a, [fixed], []).originalRiskCheckCompleted, true);
});
test('人工改写复测结论不能作为原风险的修复证据', () => {
  const reviewed = { ...original, impactStatus: 'NOT_AFFECTED', reviewedAt: new Date() };
  assert.equal(assessOriginalRiskRetest(original, [reviewed], [check]).remainingAffectedCount, 1);
  const a = {
    ...original,
    advisoryId: 'CVE-TEST-A',
    evidenceLevel: 'VERSION_MATCH',
    component: { purl: 'pkg:pypi/example@1.0.0' },
  };
  const fixed = { ...a, impactStatus: 'NOT_AFFECTED', reviewedAt: new Date() };
  assert.deepEqual(assessOriginalRiskRetest(a, [fixed], []), {
    originalRiskCheckCompleted: false,
    remainingAffectedCount: 1,
  });
});
test('同包仍有版本或公告未知项时不能证明原公告已修复', () => {
  const a = {
    ...original,
    advisoryId: 'CVE-TEST-A',
    evidenceLevel: 'VERSION_MATCH',
    component: { purl: 'pkg:pypi/example@1.0.0' },
  };
  const fixed = {
    ...a,
    impactStatus: 'NOT_AFFECTED',
    component: { purl: 'pkg:pypi/example@2.0.0' },
  };
  const unknown = {
    ...a,
    advisoryId: null,
    impactStatus: 'UNDER_INVESTIGATION',
    component: { purl: 'pkg:pypi/example' },
  };
  assert.equal(assessOriginalRiskRetest(a, [fixed, unknown], []).remainingAffectedCount, 1);
});
