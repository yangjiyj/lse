import type {
  AssuranceAttribution,
  AssuranceFailureCode,
  AssuranceOwner,
  AssuranceSamplePlanItem,
  GatewayAssuranceEvidence,
} from './types.js';

const EVIDENCE_SCHEMA = 'gateway-assurance-evidence/v1';

function pushIf(
  codes: AssuranceFailureCode[],
  condition: boolean,
  code: AssuranceFailureCode,
): void {
  if (condition) codes.push(code);
}

export function ownerForAssuranceCodes(codes: AssuranceFailureCode[]): AssuranceOwner {
  if (codes.length === 0) return 'none';
  if (codes.some((code) => code.startsWith('BOTH_'))) return 'both';
  const hasLse = codes.some((code) => code.startsWith('LSE_'));
  const hasGateway = codes.some((code) => code.startsWith('GW_'));
  if (hasLse && !hasGateway) return 'lse';
  if (hasGateway && !hasLse) return 'gateway';
  return hasGateway ? 'gateway' : 'lse';
}

export function attributeAssuranceFailure(
  sample: AssuranceSamplePlanItem,
  evidence: GatewayAssuranceEvidence,
): AssuranceAttribution {
  if (evidence.schemaVersion !== EVIDENCE_SCHEMA) {
    return { owner: 'both', failureCodes: ['BOTH_EVIDENCE_SCHEMA_DRIFT'] };
  }

  const codes: AssuranceFailureCode[] = [];
  if (!sample.traceId.trim()) {
    codes.push('LSE_TRACE_HEADER_MISSING');
    return { owner: 'lse', failureCodes: codes };
  }

  pushIf(codes, sample.expected.requestLog && !evidence.checks.requestLog, 'GW_NO_REQUEST_LOG');
  pushIf(codes, sample.expected.contentLog && !evidence.checks.contentLog, 'GW_NO_CONTENT_LOG');
  pushIf(
    codes,
    sample.expected.securityEvent && !evidence.checks.securityEvent,
    'GW_NO_SECURITY_EVENT',
  );
  pushIf(codes, sample.expected.alert && !evidence.checks.alert, 'GW_NO_ALERT');
  pushIf(
    codes,
    sample.expected.securityEvent &&
      evidence.checks.securityEvent &&
      policyHitCount(evidence) === 0,
    'GW_NO_POLICY_HIT',
  );
  pushIf(
    codes,
    sample.expected.block && !eventShowsBlock(evidence),
    'GW_EXPECTED_BLOCK_BUT_ALLOWED',
  );
  pushIf(codes, sample.expected.uiVisible && !evidence.checks.uiVisible, 'GW_UI_NOT_VISIBLE');
  pushIf(codes, sample.expected.outbox && !evidence.checks.outbox, 'GW_ASYNC_AUDIT_STUCK');
  pushIf(codes, sample.expected.writeback && !evidence.checks.writeback, 'LSE_NO_WRITEBACK');

  return {
    owner: ownerForAssuranceCodes(codes),
    failureCodes: codes,
    source: 'assurance_sample',
    sampleId: sample.sampleId,
  };
}

function policyHitCount(evidence: GatewayAssuranceEvidence): number {
  return evidence.events.filter(isRecord).reduce((sum, event) => {
    const hits = event.policy_hits ?? event.policyHits;
    return sum + (Array.isArray(hits) ? hits.length : 0);
  }, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function eventShowsBlock(evidence: GatewayAssuranceEvidence): boolean {
  return evidence.events.some((event) => {
    if (!event || typeof event !== 'object') return false;
    const record = event as Record<string, unknown>;
    return record.action === 'block' || record.verdict === 'blocked';
  });
}
