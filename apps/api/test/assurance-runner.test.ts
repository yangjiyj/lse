import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAssuranceDryRun } from '../src/modules/assurance/runner.js';
import type {
  GatewayAssuranceContract,
  GatewayAssuranceEvidence,
} from '../src/modules/assurance/types.js';

const contract: GatewayAssuranceContract = {
  schemaVersion: 'gateway-assurance-contract/v1',
  tenantId: 'tenant-a',
  generatedAt: '2026-06-20T00:00:00Z',
  policies: [
    {
      policyId: 'secret.api_key.leak',
      version: 'p0',
      category: 'secret',
      mode: 'strict',
      expectedDecision: 'block',
      severity: 'critical',
      detector: 'secret',
      evidenceRequired: true,
      sampleGenerationHint: 'fake token',
      negativeContext: [],
    },
  ],
  linkContracts: [{ linkId: 'request_log', required: true }],
};

function evidence(traceId: string): GatewayAssuranceEvidence {
  return {
    schemaVersion: 'gateway-assurance-evidence/v1',
    tenantId: 'tenant-a',
    query: { traceId },
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
    },
    sources: {},
    events: [],
  };
}

function evidenceWithPolicyHit(traceId: string): GatewayAssuranceEvidence {
  const item = evidence(traceId);
  item.checks = {
    ...item.checks,
    requestLog: true,
    contentLog: true,
    securityEngine: true,
    policyDecision: true,
    securityEvent: true,
    alert: true,
    uiVisible: true,
    deepLink: true,
  };
  item.events = [
    {
      request_id: 'req-1',
      action: 'alert',
      verdict: 'flagged',
      risk_level: 'high',
      policy_hits: [
        {
          rule_id: 'secret_generic_api_key',
          category: 'generic_api_key',
          severity: 'high',
          action: 'security_audit_only',
        },
      ],
    },
  ];
  return item;
}

test('runAssuranceDryRun fetches contract, checks evidence, and writes artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lse-assurance-runner-'));
  try {
    const result = await runAssuranceDryRun({
      runId: 'run-1',
      taskId: 'task-1',
      targetId: 'target-1',
      artifactRoot: dir,
      gatewayRef: 'gw-sha',
      lseRef: 'lse-sha',
      evidencePollAttempts: 1,
      fetchContract: async () => contract,
      fetchEvidence: async (sample) => evidence(sample.traceId),
    });

    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.samples.length, 1);
    assert.equal(result.attributions[0]?.failureCodes[0], 'GW_NO_REQUEST_LOG');
    const raw = await readFile(join(dir, 'run-1', 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw);
    assert.equal(manifest.sample_count, 1);
    assert.equal(manifest.failure_count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runAssuranceDryRun invokes gateway sample before evidence lookup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lse-assurance-runner-invoke-'));
  try {
    const calls: string[] = [];
    const result = await runAssuranceDryRun({
      runId: 'run-invoke',
      taskId: 'task-1',
      targetId: 'target-1',
      artifactRoot: dir,
      gatewayRef: 'gw-sha',
      lseRef: 'lse-sha',
      evidencePollAttempts: 1,
      fetchContract: async () => contract,
      invokeSample: async (sample) => {
        calls.push(`invoke:${sample.sampleId}`);
        return { status: 'SUCCESS', httpStatus: 200, error: null, latencyMs: 12 };
      },
      fetchEvidence: async (sample) => {
        calls.push(`evidence:${sample.sampleId}`);
        return evidence(sample.traceId);
      },
    });

    assert.equal(result.status, 'COMPLETED');
    assert.deepEqual(calls, [
      'invoke:run-invoke-secret_api_key_leak-direct-0',
      'evidence:run-invoke-secret_api_key_leak-direct-0',
    ]);
    const raw = await readFile(join(dir, 'run-invoke', 'invocations.json'), 'utf8');
    const invocations = JSON.parse(raw);
    assert.equal(invocations[0].sampleId, 'run-invoke-secret_api_key_leak-direct-0');
    assert.equal(invocations[0].status, 'SUCCESS');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runAssuranceDryRun writes gateway policy-hit feedback for each sample', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lse-assurance-runner-feedback-'));
  try {
    const result = await runAssuranceDryRun({
      runId: 'run-feedback',
      taskId: 'task-1',
      targetId: 'target-1',
      artifactRoot: dir,
      gatewayRef: 'gw-sha',
      lseRef: 'lse-sha',
      evidencePollAttempts: 1,
      fetchContract: async () => contract,
      invokeSample: async () => ({
        status: 'SUCCESS',
        httpStatus: 200,
        error: null,
        latencyMs: 12,
      }),
      fetchEvidence: async (sample) => evidenceWithPolicyHit(sample.traceId),
    });

    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.evidenceSummaries?.[0]?.policyHitCount, 1);
    assert.deepEqual(result.evidenceSummaries?.[0]?.ruleIds, ['secret_generic_api_key']);
    const raw = await readFile(join(dir, 'run-feedback', 'evidence-summary.json'), 'utf8');
    const summaries = JSON.parse(raw);
    assert.equal(summaries[0].policyHitCount, 1);
    assert.deepEqual(summaries[0].ruleIds, ['secret_generic_api_key']);
    const manifestRaw = await readFile(join(dir, 'run-feedback', 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw);
    assert.equal(manifest.policy_hit_count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runAssuranceDryRun retries evidence after async audit write settles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lse-assurance-runner-retry-'));
  try {
    let evidenceCalls = 0;
    const result = await runAssuranceDryRun({
      runId: 'run-retry',
      taskId: 'task-1',
      targetId: 'target-1',
      artifactRoot: dir,
      gatewayRef: 'gw-sha',
      lseRef: 'lse-sha',
      evidencePollAttempts: 3,
      evidencePollIntervalMs: 1,
      fetchContract: async () => contract,
      invokeSample: async () => ({ status: 'SUCCESS', httpStatus: 200, error: null, latencyMs: 1 }),
      fetchEvidence: async (sample) => {
        evidenceCalls += 1;
        const item = evidence(sample.traceId);
        if (evidenceCalls > 1) item.checks.requestLog = true;
        return item;
      },
    });

    assert.equal(result.status, 'COMPLETED');
    assert.equal(evidenceCalls, 2);
    assert(!result.attributions[0]?.failureCodes.includes('GW_NO_REQUEST_LOG'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runAssuranceDryRun writes live run state while samples and attack-defense probes run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lse-assurance-runner-live-state-'));
  try {
    let sawSampleState = false;
    let sawAttackDefenseState = false;
    const result = await runAssuranceDryRun({
      runId: 'run-live-state',
      taskId: 'task-1',
      targetId: 'target-1',
      artifactRoot: dir,
      gatewayRef: 'gw-sha',
      lseRef: 'lse-sha',
      evidencePollAttempts: 1,
      fetchContract: async () => contract,
      invokeSample: async (sample) => {
        const liveRaw = await readFile(join(dir, 'run-live-state', 'run-state.json'), 'utf8');
        const live = JSON.parse(liveRaw);
        assert.equal(live.status, 'RUNNING');
        assert.equal(live.phase, 'sample_invocation');
        assert.equal(live.samples_completed, 0);
        assert.equal(live.current_sample_id, sample.sampleId);
        sawSampleState = true;
        return { status: 'SUCCESS', httpStatus: 200, error: null, latencyMs: 12 };
      },
      fetchEvidence: async (sample) => evidenceWithPolicyHit(sample.traceId),
      collectAttackDefense: async () => {
        const liveRaw = await readFile(join(dir, 'run-live-state', 'run-state.json'), 'utf8');
        const live = JSON.parse(liveRaw);
        assert.equal(live.status, 'RUNNING');
        assert.equal(live.phase, 'attack_defense');
        assert.equal(live.samples_completed, 1);
        assert.equal(live.current_sample_id, null);
        sawAttackDefenseState = true;
        return {
          taskCount: 1,
          caseCount: 0,
          bypassCount: 0,
          defendedCount: 0,
          executionErrorCount: 0,
          gatewayWritebackMissingCount: 0,
          gatewayWritebackSuccessCount: 0,
          summaries: [],
        };
      },
    });

    assert.equal(result.status, 'COMPLETED');
    assert.equal(sawSampleState, true);
    assert.equal(sawAttackDefenseState, true);
    const finalRaw = await readFile(join(dir, 'run-live-state', 'run-state.json'), 'utf8');
    const final = JSON.parse(finalRaw);
    assert.equal(final.status, 'COMPLETED');
    assert.equal(final.phase, 'completed');
    assert.equal(final.samples_completed, 1);
    assert.equal(final.failure_count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runAssuranceDryRun stops before evidence queries when STOP file exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lse-assurance-runner-stop-'));
  try {
    const stopFile = join(dir, 'STOP');
    await writeFile(stopFile, 'pause', 'utf8');
    let evidenceCalls = 0;
    const result = await runAssuranceDryRun({
      runId: 'run-stop',
      taskId: 'task-1',
      targetId: 'target-1',
      artifactRoot: dir,
      gatewayRef: 'gw-sha',
      lseRef: 'lse-sha',
      stopFile,
      fetchContract: async () => contract,
      fetchEvidence: async (sample) => {
        evidenceCalls += 1;
        return evidence(sample.traceId);
      },
    });

    assert.equal(result.status, 'PAUSED');
    assert.equal(evidenceCalls, 0);
    assert.match(result.stopReason ?? '', /STOP/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
