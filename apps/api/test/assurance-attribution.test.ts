import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeAssuranceFailure } from '../src/modules/assurance/attribution.js';
import type {
  AssuranceSamplePlanItem,
  GatewayAssuranceEvidence,
} from '../src/modules/assurance/types.js';

const sample: AssuranceSamplePlanItem = {
  sampleId: 'sample-1',
  policyId: 'secret.api_key.leak',
  category: 'secret',
  prompt: 'synthetic secret canary',
  traceId: 'trace-1',
  evalRunId: 'run-1',
  taskId: 'task-1',
  targetId: 'target-1',
  expectedDecision: 'block',
  expected: {
    requestLog: true,
    contentLog: true,
    securityEvent: true,
    alert: true,
    block: true,
    uiVisible: true,
    writeback: true,
    outbox: true,
  },
};

function evidence(checks: Partial<GatewayAssuranceEvidence['checks']>): GatewayAssuranceEvidence {
  return {
    schemaVersion: 'gateway-assurance-evidence/v1',
    tenantId: 'tenant-a',
    query: { traceId: 'trace-1' },
    checks: {
      requestLog: false,
      contentLog: false,
      securityEngine: false,
      policyDecision: false,
      securityEvent: false,
      alert: false,
      uiVisible: false,
      deepLink: false,
      writeback: false,
      outbox: false,
      ...checks,
    },
    sources: {},
    events: [],
  };
}

test('attributeAssuranceFailure reports gateway missing request logs', () => {
  const result = attributeAssuranceFailure(sample, evidence({ requestLog: false }));

  assert.deepEqual(result.failureCodes, [
    'GW_NO_REQUEST_LOG',
    'GW_NO_CONTENT_LOG',
    'GW_NO_SECURITY_EVENT',
    'GW_NO_ALERT',
    'GW_EXPECTED_BLOCK_BUT_ALLOWED',
    'GW_UI_NOT_VISIBLE',
    'GW_ASYNC_AUDIT_STUCK',
    'LSE_NO_WRITEBACK',
  ]);
  assert.equal(result.owner, 'gateway');
});

test('attributeAssuranceFailure reports LSE trace header issue before blaming gateway', () => {
  const result = attributeAssuranceFailure(
    { ...sample, traceId: '' },
    evidence({ requestLog: false }),
  );

  assert.equal(result.failureCodes[0], 'LSE_TRACE_HEADER_MISSING');
  assert.equal(result.owner, 'lse');
});

test('attributeAssuranceFailure reports schema drift as both-side issue', () => {
  const result = attributeAssuranceFailure(sample, {
    ...evidence({ requestLog: true }),
    schemaVersion: 'gateway-assurance-evidence/v0',
  });

  assert.deepEqual(result.failureCodes, ['BOTH_EVIDENCE_SCHEMA_DRIFT']);
  assert.equal(result.owner, 'both');
});

test('attributeAssuranceFailure reports gateway evidence without policy hits', () => {
  const result = attributeAssuranceFailure(
    {
      ...sample,
      expectedDecision: 'alert',
      expected: { ...sample.expected, block: false, outbox: false, writeback: false },
    },
    {
      ...evidence({
        requestLog: true,
        contentLog: true,
        securityEngine: true,
        policyDecision: true,
        securityEvent: true,
        alert: true,
        uiVisible: true,
      }),
      events: [{ action: 'alert', verdict: 'flagged', policy_hits: [] }],
    },
  );

  assert.deepEqual(result.failureCodes, ['GW_NO_POLICY_HIT']);
  assert.equal(result.owner, 'gateway');
});
