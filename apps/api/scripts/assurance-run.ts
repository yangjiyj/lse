import { randomUUID } from 'node:crypto';
import { runAssuranceDryRun } from '../src/modules/assurance/runner.js';
import {
  fetchGatewayAssuranceContract,
  fetchGatewayAssuranceEvidence,
} from '../src/modules/assurance/gateway-client.js';
import { invokeGatewayAssuranceSample } from '../src/modules/assurance/sample-invoker.js';
import { runAssuranceAttackDefenseProbes } from '../src/modules/assurance/attack-defense-probes.js';
import {
  writeAssuranceSamplesToQuestionBank,
  type AssuranceQuestionBankClient,
} from '../src/modules/assurance/question-bank.js';
import {
  writeAssuranceRunToEvalTask,
  type AssuranceEvalTaskClient,
} from '../src/modules/assurance/eval-task-writeback.js';
import { prisma } from '../src/db.js';
import type { GatewayAssuranceRuntimeTarget } from '../src/modules/assurance/sample-invoker.js';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function required(name: string): string {
  const value = arg(name)?.trim();
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function optional(name: string, envName: string): string {
  return arg(name)?.trim() || process.env[envName]?.trim() || '';
}

function optionalInt(name: string, envName: string, fallback: number): number {
  const raw = optional(name, envName);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

async function resolveRuntimeTarget(): Promise<GatewayAssuranceRuntimeTarget> {
  const targetId = optional('gateway-model-target-id', 'ASSURANCE_GATEWAY_MODEL_TARGET_ID');
  if (targetId) {
    const target = await prisma.modelTarget.findUnique({ where: { id: targetId } });
    if (!target) throw new Error(`gateway model target not found: ${targetId}`);
    if (!target.isActive) throw new Error(`gateway model target is inactive: ${targetId}`);
    return {
      baseUrl:
        optional('gateway-chat-base-url', 'ASSURANCE_GATEWAY_CHAT_BASE_URL') || target.baseUrl,
      apiKey: target.apiKey,
      model: target.model,
    };
  }
  return {
    baseUrl: required('gateway-chat-base-url'),
    apiKey:
      optional('gateway-chat-api-key', 'ASSURANCE_GATEWAY_API_KEY') ||
      required('gateway-chat-api-key'),
    model: required('gateway-chat-model'),
  };
}

async function main(): Promise<void> {
  const controlPlaneBaseUrl = required('gateway-control-plane');
  const tenantId = required('tenant');
  const internalToken = process.env.NEWAPI_EVAL_INTEGRATION_TOKEN?.trim();
  if (!internalToken) throw new Error('NEWAPI_EVAL_INTEGRATION_TOKEN is required');

  const runId =
    arg('run-id') ??
    `assurance-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const artifactRoot = arg('artifact-root') ?? './assurance-runs';
  const taskId = arg('task-id') ?? `${runId}:task`;
  const targetId = arg('target-id') ?? `${runId}:target`;
  const gatewayRef = arg('gateway-ref') ?? 'unknown-gateway-ref';
  const lseRef = arg('lse-ref') ?? 'unknown-lse-ref';
  const stopFile = arg('stop-file');
  const gatewayModelTargetId = optional(
    'gateway-model-target-id',
    'ASSURANCE_GATEWAY_MODEL_TARGET_ID',
  );
  const attackAgentSamples = optionalInt(
    'attack-agent-samples',
    'ASSURANCE_ATTACK_AGENT_SAMPLES',
    0,
  );
  const attackAgentLevel =
    optional('attack-agent-level', 'ASSURANCE_ATTACK_AGENT_LEVEL') || 'standard';
  const attackRedTeamSamples = optionalInt(
    'attack-red-team-samples',
    'ASSURANCE_ATTACK_RED_TEAM_SAMPLES',
    0,
  );
  const attackDefenseEnabled =
    Boolean(gatewayModelTargetId) && (attackAgentSamples > 0 || attackRedTeamSamples > 0);
  const runtimeTarget = await resolveRuntimeTarget();

  const result = await runAssuranceDryRun({
    runId,
    taskId,
    targetId,
    artifactRoot,
    gatewayRef,
    lseRef,
    stopFile,
    fetchContract: () =>
      fetchGatewayAssuranceContract({ controlPlaneBaseUrl, internalToken, tenantId }),
    invokeSample: (sample) => invokeGatewayAssuranceSample(runtimeTarget, sample),
    fetchEvidence: (sample) =>
      fetchGatewayAssuranceEvidence({
        controlPlaneBaseUrl,
        internalToken,
        tenantId,
        traceId: sample.traceId,
        sampleId: sample.sampleId,
        evalRunId: sample.evalRunId,
        taskId: sample.taskId,
      }),
    collectAttackDefense: attackDefenseEnabled
      ? () =>
          runAssuranceAttackDefenseProbes(prisma, {
            runId,
            gatewayModelTargetId,
            gatewayRuntimeBaseUrl: runtimeTarget.baseUrl,
            gatewayRuntimeApiKey: runtimeTarget.apiKey,
            gatewayRuntimeModel: runtimeTarget.model,
            controlPlaneBaseUrl,
            tenantId,
            internalToken,
            agentSampleCount: attackAgentSamples,
            agentLevel: attackAgentLevel,
            redTeamSampleCount: attackRedTeamSamples,
            redTeamBareTargetId: optional(
              'red-team-bare-target-id',
              'ASSURANCE_RED_TEAM_BARE_TARGET_ID',
            ),
            redTeamAttackerTargetId: optional(
              'red-team-attacker-target-id',
              'ASSURANCE_RED_TEAM_ATTACKER_TARGET_ID',
            ),
            redTeamJudgeTargetId: optional(
              'red-team-judge-target-id',
              'ASSURANCE_RED_TEAM_JUDGE_TARGET_ID',
            ),
            redTeamQuestionSetId: optional(
              'red-team-question-set-id',
              'ASSURANCE_RED_TEAM_QUESTION_SET_ID',
            ),
            redTeamMaxRounds: optionalInt(
              'red-team-max-rounds',
              'ASSURANCE_RED_TEAM_MAX_ROUNDS',
              2,
            ),
            redTeamNoProgressK: optionalInt(
              'red-team-no-progress-k',
              'ASSURANCE_RED_TEAM_NO_PROGRESS_K',
              1,
            ),
            repairEligible: true,
          })
      : undefined,
  });

  const sampleWriteback =
    result.status === 'COMPLETED'
      ? await writeAssuranceSamplesToQuestionBank(
          prisma as unknown as AssuranceQuestionBankClient,
          result.samples,
        )
      : null;
  const taskWriteback =
    result.status === 'COMPLETED' && sampleWriteback && gatewayModelTargetId
      ? await writeAssuranceRunToEvalTask(prisma as unknown as AssuranceEvalTaskClient, {
          runId,
          modelTargetId: gatewayModelTargetId,
          questionSetId: sampleWriteback.questionSetId,
          result,
          artifactManifestPath: result.artifactManifestPath,
          gatewayRef,
          lseRef,
        })
      : null;

  process.stdout.write(
    `${JSON.stringify(
      {
        status: result.status,
        stopReason: result.stopReason,
        sampleCount: result.samples.length,
        failureCount: result.attributions.filter((item) => item.failureCodes.length > 0).length,
        artifactManifestPath: result.artifactManifestPath,
        sampleQuestionSetId: sampleWriteback?.questionSetId ?? null,
        sampleWritebackCreated: sampleWriteback?.created ?? 0,
        sampleWritebackUpdated: sampleWriteback?.updated ?? 0,
        evalTaskId: taskWriteback?.evalTaskId ?? null,
        evalTaskCreated: taskWriteback?.created ?? false,
        attackDefenseTaskCount: result.attackDefense?.taskCount ?? 0,
        attackDefenseCaseCount: result.attackDefense?.caseCount ?? 0,
        attackDefenseBypassCount: result.attackDefense?.bypassCount ?? 0,
        attackDefenseExecutionErrorCount: result.attackDefense?.executionErrorCount ?? 0,
        attackDefenseWritebackMissingCount: result.attackDefense?.gatewayWritebackMissingCount ?? 0,
      },
      null,
      2,
    )}\n`,
  );
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
