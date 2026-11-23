import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AssuranceArtifactManifestInput {
  rootDir: string;
  runId: string;
  status: 'RUNNING' | 'PAUSED' | 'FAILED' | 'COMPLETED' | string;
  gatewayRef: string;
  lseRef: string;
  sampleCount: number;
  failureCount: number;
  policyCount?: number;
  variantCount?: number;
  policyHitCount?: number;
  policyHitSampleCount?: number;
  multiTurnSampleCount?: number;
  attackDefenseCaseCount?: number;
  attackDefenseBypassCount?: number;
  attackDefenseExecutionErrorCount?: number;
  attackDefenseWritebackMissingCount?: number;
  attackDefenseWritebackSuccessCount?: number;
  notes?: string[];
}

export async function writeAssuranceArtifactManifest(
  input: AssuranceArtifactManifestInput,
): Promise<string> {
  const runDir = join(input.rootDir, input.runId);
  await mkdir(runDir, { recursive: true });
  const manifest = {
    schema_version: 'gateway-lse-assurance-artifact/v1',
    run_id: input.runId,
    status: input.status,
    gateway_ref: input.gatewayRef,
    lse_ref: input.lseRef,
    sample_count: input.sampleCount,
    failure_count: input.failureCount,
    policy_count: input.policyCount,
    variant_count: input.variantCount,
    policy_hit_count: input.policyHitCount,
    policy_hit_sample_count: input.policyHitSampleCount,
    multi_turn_sample_count: input.multiTurnSampleCount,
    attack_defense_case_count: input.attackDefenseCaseCount,
    attack_defense_bypass_count: input.attackDefenseBypassCount,
    attack_defense_execution_error_count: input.attackDefenseExecutionErrorCount,
    attack_defense_writeback_missing_count: input.attackDefenseWritebackMissingCount,
    attack_defense_writeback_success_count: input.attackDefenseWritebackSuccessCount,
    notes: input.notes ?? [],
    written_at: new Date().toISOString(),
  };
  const path = join(runDir, 'manifest.json');
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return path;
}
