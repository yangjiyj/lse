import assert from 'node:assert/strict';
import test from 'node:test';
import { assessmentBody, assessEvidence } from '../../src/modules/external-assets/assessment.js';

const base = {
  source_request_id: 'd084298f-ac31-4ea3-bfaf-758ee6914382', source_tenant_id: 'tenant-a', source_asset_id: 'asset-a', source_instance_id: 'instance-a',
  asset_type: 'skill', content_hash: 'a'.repeat(64), ruleset_version: 'agent-static-v1',
  status: 'findings', checks: [
    { rule_id: 'unsafe-tool', status: 'finding', severity: 'high',
      reason_zh: '工具权限过宽', evidence_code: 'capability_match',
      recommendation_zh: '收窄授权范围' },
  ],
};

test('external assessment reports supplied evidence risk without claiming execution', () => {
  const input = assessmentBody.parse(base);
  const result = assessEvidence(input);
  assert.deepEqual({ coverage: result.coverage, verdict: result.verdict, method: result.method, findings: result.findings }, {
    coverage: 'supplied_evidence_only', verdict: 'risk_found',
    method: 'supplied_static_evidence_review',
    findings: [{ rule_id: 'unsafe-tool', severity: 'high', reason_zh: '工具权限过宽',
      evidence_code: 'capability_match', evidence_hash: null,
      recommendation_zh: '收窄授权范围' }],
  });
});

test('unknown or missing evidence is inconclusive', () => {
  const input = assessmentBody.parse({ ...base, status: 'partial', checks: [] });
  assert.equal(assessEvidence(input).verdict, 'inconclusive');
});

test('rejects raw content and mismatched schema fields', () => {
  assert.throws(() => assessmentBody.parse({ ...base, raw_content: 'secret' }));
  assert.throws(() => assessmentBody.parse({ ...base, content_hash: 'bad' }));
});


test('accepts bounded terminal context without treating it as authentication', () => {
  const input = assessmentBody.parse({ ...base,
    source_endpoint_id: 'ep_123', source_endpoint_asset_id: 'aea_123', source_endpoint_name: 'lab-terminal',
  });
  assert.equal(input.source_endpoint_id, 'ep_123');
  assert.throws(() => assessmentBody.parse({ ...base, source_endpoint_name: 'x'.repeat(129) }));
  assert.throws(() => assessmentBody.parse({ ...base, authenticated_employee_id: 'person-1' }));
});
