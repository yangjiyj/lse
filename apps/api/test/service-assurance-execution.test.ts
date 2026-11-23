import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExecutionSummary,
  encodeExecutionCheck,
  EXECUTION_EVIDENCE_TYPE,
  REQUEST_TOTAL_EVIDENCE_TYPE,
  encodeRequestTotal,
} from '../src/modules/service-assurance/execution-evidence.js';

const row = (
  id: string,
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'UNKNOWN',
  count: number | null,
) => ({
  evidenceType: EXECUTION_EVIDENCE_TYPE,
  ruleId: id,
  extractedValue: encodeExecutionCheck({
    id,
    label: id,
    status,
    requestCount: count,
    detail: '实际执行记录。',
  }),
});

test('没有执行记录的历史运行保留未知状态，不能把配置数当完成数或请求数', () => {
  const result = buildExecutionSummary('SAFE', 'ENDPOINT', []);
  assert.equal(result.telemetryAvailable, false);
  assert.equal(result.requestCount, null);
  assert.equal(result.checks.length, 2);
  assert.ok(result.checks.every((item) => item.status === 'UNKNOWN' && item.requestCount === null));
});

test('零风险也可以有可核对的真实执行明细', () => {
  const result = buildExecutionSummary('SAFE', 'ENDPOINT', [
    row('lse-http-security-headers', 'COMPLETED', 1),
    row('lse-triton-product-fingerprint', 'COMPLETED', 1),
  ]);
  assert.equal(result.telemetryAvailable, true);
  assert.equal(result.requestCount, 2);
  assert.ok(result.checks.every((item) => item.status === 'COMPLETED'));
});

test('丢失或损坏执行记录不会被补成成功', () => {
  const result = buildExecutionSummary('SAFE', 'ENDPOINT', [
    row('lse-http-security-headers', 'COMPLETED', 1),
    {
      evidenceType: EXECUTION_EVIDENCE_TYPE,
      ruleId: 'lse-triton-product-fingerprint',
      extractedValue: '{broken',
    },
  ]);
  assert.equal(result.requestCount, null);
  assert.equal(result.checks[1]?.status, 'UNKNOWN');
});

test('只有合法有限请求计数可持久化，遥测文本始终脱敏', () => {
  assert.throws(() =>
    encodeExecutionCheck({
      id: 'a',
      label: 'a',
      status: 'COMPLETED',
      requestCount: -1,
      detail: 'x',
    }),
  );
  const encoded = encodeExecutionCheck({
    id: 'a',
    label: 'a',
    status: 'FAILED',
    requestCount: 0,
    detail: 'Authorization: Bearer sk-sentinel-execution-123456',
  });
  assert.doesNotMatch(encoded, /sk-sentinel/);
});

test('接口检查保留实际总数，不将总请求虚构为逐阶段覆盖', () => {
  const rows = [
    row('lse-http-security-headers', 'COMPLETED', 1),
    row('lse-triton-product-fingerprint', 'COMPLETED', 1),
    row('zap-api-passive', 'UNKNOWN', null),
  ];
  const total = {
    evidenceType: REQUEST_TOTAL_EVIDENCE_TYPE,
    ruleId: null,
    extractedValue: encodeRequestTotal(17),
  };
  const result = buildExecutionSummary('SAFE', 'OPENAPI', [...rows, total]);
  assert.equal(result.requestCount, 17);
  assert.equal(result.checks.find((item) => item.id === 'zap-api-passive')?.requestCount, null);
  assert.equal(result.checks.find((item) => item.id === 'zap-api-passive')?.status, 'UNKNOWN');
  assert.equal(
    buildExecutionSummary('SAFE', 'OPENAPI', [...rows, { ...total, extractedValue: '{broken' }])
      .requestCount,
    null,
  );
  assert.equal(
    buildExecutionSummary('SAFE', 'OPENAPI', [...rows, total, total]).requestCount,
    null,
  );
});
