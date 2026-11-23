import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { attributeAssuranceFailure } from './attribution.js';
import type { AssuranceAttackDefenseSummary } from './attack-defense.js';
import { writeAssuranceArtifactManifest } from './artifacts.js';
import { buildAssuranceSamplePlan } from './samples.js';
import { shouldStopAssuranceRun } from './stop-token.js';
import type {
  AssuranceAttribution,
  AssuranceEvidenceSummary,
  AssuranceSamplePlanItem,
  GatewayAssuranceContract,
  GatewayAssuranceEvidence,
} from './types.js';

export interface AssuranceDryRunOptions {
  runId: string;
  taskId: string;
  targetId: string;
  artifactRoot: string;
  gatewayRef: string;
  lseRef: string;
  stopFile?: string;
  evidencePollAttempts?: number;
  evidencePollIntervalMs?: number;
  fetchContract: () => Promise<GatewayAssuranceContract>;
  invokeSample?: (sample: AssuranceSamplePlanItem) => Promise<AssuranceSampleInvocationResult>;
  fetchEvidence: (sample: AssuranceSamplePlanItem) => Promise<GatewayAssuranceEvidence>;
  collectAttackDefense?: () => Promise<AssuranceAttackDefenseSummary>;
}

export interface AssuranceSampleInvocationResult {
  status: string;
  httpStatus: number | null;
  error: string | null;
  latencyMs: number;
  turnCount?: number;
  turns?: Array<{
    turnIndex: number;
    status: string;
    httpStatus: number | null;
    error: string | null;
    latencyMs: number;
  }>;
}

export interface AssuranceDryRunResult {
  status: 'COMPLETED' | 'PAUSED';
  stopReason: string | null;
  samples: AssuranceSamplePlanItem[];
  attributions: AssuranceAttribution[];
  evidenceSummaries: AssuranceEvidenceSummary[];
  attackDefense?: AssuranceAttackDefenseSummary;
  artifactManifestPath: string;
}

type AssuranceRunStateStatus = 'RUNNING' | 'COMPLETED' | 'PAUSED';

type AssuranceRunStatePhase =
  | 'sample_plan'
  | 'sample_invocation'
  | 'evidence_poll'
  | 'sample_completed'
  | 'attack_defense'
  | 'completed'
  | 'paused';

interface WriteRunStateInput {
  status: AssuranceRunStateStatus;
  phase: AssuranceRunStatePhase;
  policyCount: number;
  variantCount: number;
  samplesCompleted: number;
  currentSampleId: string | null;
  failureCount?: number | null;
  policyHitCount?: number | null;
  policyHitSampleCount?: number | null;
  attackDefense?: AssuranceAttackDefenseSummary;
  artifactManifestPath?: string | null;
  notes?: string[];
}

export async function runAssuranceDryRun(
  options: AssuranceDryRunOptions,
): Promise<AssuranceDryRunResult> {
  const contract = await options.fetchContract();
  const plan = buildAssuranceSamplePlan(contract, {
    runId: options.runId,
    taskId: options.taskId,
    targetId: options.targetId,
  });
  const policyCount = new Set(plan.samples.map((sample) => sample.policyId)).size;
  const variantCount = plan.samples.length;
  await writeRunState(options, {
    status: 'RUNNING',
    phase: 'sample_plan',
    policyCount,
    variantCount,
    samplesCompleted: 0,
    currentSampleId: null,
  });

  const stop = await shouldStopAssuranceRun({ stopFile: options.stopFile });
  if (stop.stop) {
    const artifactManifestPath = await writeAssuranceArtifactManifest({
      rootDir: options.artifactRoot,
      runId: options.runId,
      status: 'PAUSED',
      gatewayRef: options.gatewayRef,
      lseRef: options.lseRef,
      sampleCount: plan.samples.length,
      failureCount: 0,
      policyCount,
      variantCount,
      policyHitCount: 0,
      policyHitSampleCount: 0,
      multiTurnSampleCount: multiTurnSampleCount(plan.samples),
      attackDefenseCaseCount: 0,
      attackDefenseBypassCount: 0,
      attackDefenseExecutionErrorCount: 0,
      attackDefenseWritebackMissingCount: 0,
      attackDefenseWritebackSuccessCount: 0,
      notes: [stop.reason ?? 'paused'],
    });
    await writeRunJson(options.artifactRoot, options.runId, 'samples.json', plan.samples);
    await writeRunState(options, {
      status: 'PAUSED',
      phase: 'paused',
      policyCount,
      variantCount,
      samplesCompleted: 0,
      currentSampleId: null,
      failureCount: 0,
      artifactManifestPath,
      notes: [stop.reason ?? 'paused'],
    });
    return {
      status: 'PAUSED',
      stopReason: stop.reason,
      samples: plan.samples,
      attributions: [],
      evidenceSummaries: [],
      attackDefense: undefined,
      artifactManifestPath,
    };
  }

  const attributions: AssuranceAttribution[] = [];
  const evidenceSummaries: AssuranceEvidenceSummary[] = [];
  const invocations: Array<
    AssuranceSampleInvocationResult & { sampleId: string; traceId: string }
  > = [];
  let completedSamples = 0;
  for (const sample of plan.samples) {
    const shouldPollEvidence = options.invokeSample !== undefined;
    if (options.invokeSample !== undefined) {
      await writeRunState(options, {
        status: 'RUNNING',
        phase: 'sample_invocation',
        policyCount,
        variantCount,
        samplesCompleted: completedSamples,
        currentSampleId: sample.sampleId,
      });
      const invocation = await options.invokeSample(sample);
      invocations.push({ sampleId: sample.sampleId, traceId: sample.traceId, ...invocation });
    }
    await writeRunState(options, {
      status: 'RUNNING',
      phase: 'evidence_poll',
      policyCount,
      variantCount,
      samplesCompleted: completedSamples,
      currentSampleId: sample.sampleId,
    });
    const evidence = await fetchEvidenceAfterAuditSettle(options, sample, shouldPollEvidence);
    evidenceSummaries.push(summarizeEvidence(sample, evidence));
    attributions.push(attributeAssuranceFailure(sample, evidence));
    completedSamples += 1;
    await writeRunState(options, {
      status: 'RUNNING',
      phase: 'sample_completed',
      policyCount,
      variantCount,
      samplesCompleted: completedSamples,
      currentSampleId: null,
    });
  }
  let attackDefense: AssuranceAttackDefenseSummary | undefined;
  if (options.collectAttackDefense) {
    await writeRunState(options, {
      status: 'RUNNING',
      phase: 'attack_defense',
      policyCount,
      variantCount,
      samplesCompleted: completedSamples,
      currentSampleId: null,
    });
    attackDefense = await options.collectAttackDefense();
  }
  const allAttributions = [...attributions, ...attackDefenseAttributions(attackDefense)];
  const failureCount = allAttributions.filter((item) => item.failureCodes.length > 0).length;
  const policyHitCount = evidenceSummaries.reduce((sum, item) => sum + item.policyHitCount, 0);
  const policyHitSampleCount = evidenceSummaries.filter((item) => item.policyHitCount > 0).length;
  const artifactManifestPath = await writeAssuranceArtifactManifest({
    rootDir: options.artifactRoot,
    runId: options.runId,
    status: 'COMPLETED',
    gatewayRef: options.gatewayRef,
    lseRef: options.lseRef,
    sampleCount: plan.samples.length,
    failureCount,
    policyCount,
    variantCount,
    policyHitCount,
    policyHitSampleCount,
    multiTurnSampleCount: multiTurnSampleCount(plan.samples),
    attackDefenseCaseCount: attackDefense?.caseCount ?? 0,
    attackDefenseBypassCount: attackDefense?.bypassCount ?? 0,
    attackDefenseExecutionErrorCount: attackDefense?.executionErrorCount ?? 0,
    attackDefenseWritebackMissingCount: attackDefense?.gatewayWritebackMissingCount ?? 0,
    attackDefenseWritebackSuccessCount: attackDefense?.gatewayWritebackSuccessCount ?? 0,
    notes: failureCount > 0 ? ['dry-run produced failures for repair queue'] : [],
  });
  await writeRunJson(options.artifactRoot, options.runId, 'samples.json', plan.samples);
  if (invocations.length > 0) {
    await writeRunJson(options.artifactRoot, options.runId, 'invocations.json', invocations);
  }
  await writeRunJson(
    options.artifactRoot,
    options.runId,
    'evidence-summary.json',
    evidenceSummaries,
  );
  if (attackDefense) {
    await writeRunJson(
      options.artifactRoot,
      options.runId,
      'attack-defense-summary.json',
      attackDefense,
    );
  }
  await writeRunJson(options.artifactRoot, options.runId, 'attribution.json', allAttributions);
  await writeRunState(options, {
    status: 'COMPLETED',
    phase: 'completed',
    policyCount,
    variantCount,
    samplesCompleted: completedSamples,
    currentSampleId: null,
    failureCount,
    policyHitCount,
    policyHitSampleCount,
    attackDefense,
    artifactManifestPath,
    notes: failureCount > 0 ? ['dry-run produced failures for repair queue'] : [],
  });
  return {
    status: 'COMPLETED',
    stopReason: null,
    samples: plan.samples,
    attributions: allAttributions,
    evidenceSummaries,
    attackDefense,
    artifactManifestPath,
  };
}

function multiTurnSampleCount(samples: AssuranceSamplePlanItem[]): number {
  return samples.filter((sample) => (sample.turns?.length ?? 0) > 1).length;
}

function summarizeEvidence(
  sample: AssuranceSamplePlanItem,
  evidence: GatewayAssuranceEvidence,
): AssuranceEvidenceSummary {
  const events = evidence.events.filter(isRecord);
  const hits = events.flatMap(policyHitsFromEvent);
  return {
    sampleId: sample.sampleId,
    policyId: sample.policyId,
    variantId: sample.variantId ?? 'direct',
    traceId: sample.traceId,
    eventCount: events.length,
    policyHitCount: hits.length,
    ruleIds: uniqueStrings(
      hits.map((hit) => stringField(hit, 'rule_id') || stringField(hit, 'event_type')),
    ),
    actions: uniqueStrings(events.flatMap((event) => [stringField(event, 'action')])),
    verdicts: uniqueStrings(events.flatMap((event) => [stringField(event, 'verdict')])),
  };
}

function policyHitsFromEvent(event: Record<string, unknown>): Record<string, unknown>[] {
  const raw = event.policy_hits ?? event.policyHits;
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function attackDefenseAttributions(
  attackDefense: AssuranceAttackDefenseSummary | undefined,
): AssuranceAttribution[] {
  return attackDefense?.summaries.flatMap((summary) => summary.attributions) ?? [];
}

async function fetchEvidenceAfterAuditSettle(
  options: AssuranceDryRunOptions,
  sample: AssuranceSamplePlanItem,
  shouldPoll: boolean,
): Promise<GatewayAssuranceEvidence> {
  const attempts = shouldPoll ? Math.max(1, options.evidencePollAttempts ?? 10) : 1;
  const intervalMs = Math.max(0, options.evidencePollIntervalMs ?? 250);
  let last = await options.fetchEvidence(sample);
  for (let attempt = 1; attempt < attempts && !last.checks.requestLog; attempt += 1) {
    if (intervalMs > 0) await sleep(intervalMs);
    last = await options.fetchEvidence(sample);
  }
  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeRunState(
  options: AssuranceDryRunOptions,
  input: WriteRunStateInput,
): Promise<void> {
  const runDir = join(options.artifactRoot, options.runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, 'run-state.json'),
    `${JSON.stringify(
      {
        schema_version: 'gateway-lse-assurance-run-state/v1',
        run_id: options.runId,
        status: input.status,
        phase: input.phase,
        gateway_ref: options.gatewayRef,
        lse_ref: options.lseRef,
        policy_count: input.policyCount,
        variant_count: input.variantCount,
        sample_count: input.variantCount,
        samples_completed: input.samplesCompleted,
        current_sample_id: input.currentSampleId,
        failure_count: input.failureCount ?? null,
        policy_hit_count: input.policyHitCount ?? null,
        policy_hit_sample_count: input.policyHitSampleCount ?? null,
        attack_defense_case_count: input.attackDefense?.caseCount ?? null,
        attack_defense_bypass_count: input.attackDefense?.bypassCount ?? null,
        attack_defense_execution_error_count: input.attackDefense?.executionErrorCount ?? null,
        attack_defense_writeback_missing_count:
          input.attackDefense?.gatewayWritebackMissingCount ?? null,
        attack_defense_writeback_success_count:
          input.attackDefense?.gatewayWritebackSuccessCount ?? null,
        artifact_manifest_path: input.artifactManifestPath ?? null,
        notes: input.notes ?? [],
        written_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function writeRunJson(
  rootDir: string,
  runId: string,
  filename: string,
  value: unknown,
): Promise<void> {
  const runDir = join(rootDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, filename), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
