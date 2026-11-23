import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInternationalFrameworkSection } from '../src/modules/reports/framework-report.js';

test('国际框架报告映射按风险域返回结构化行并标注参考映射', () => {
  const rows = buildInternationalFrameworkSection(['prompt_injection', 'agent_tool_abuse']);
  assert.ok(rows.some((row) => row.entryId === 'LLM01'));
  assert.ok(rows.some((row) => row.entryId === 'AML.T0051'));
  assert.ok(rows.some((row) => row.entryId === 'AML.TA0005'));
  assert.ok(rows.every((row) => row.evidenceStatus.includes('平台参考映射')));
  assert.ok(rows.every((row) => row.riskDomainLabel.length > 0));
  assert.ok(rows.every((row) => row.entryNameEn.length > 0 || row.framework === 'GB/T 45654 附录A'));
});
