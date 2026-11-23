import { assertNonEndpointTaskTargetId } from '../../lib/endpoint-task-policy.js';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { generateAgentScenarios } from '../agent-evals/generator.js';
import type { AgentScenario } from '../agent-evals/types.js';
import { runEvalTask } from '../eval-tasks/executor.js';
import { RED_TEAM_ATTACK_VARIANT_IDS } from '../red-team/builtin-seeds.js';
import { selectRedTeamQuestions } from '../red-team/seed-sampler.js';
import type { ChatMessage, LlmCallResult, LlmTargetConfig } from '@lse/shared';
import { chatComplete } from '../../lib/llm-client.js';
import {
  gatewayRecognizedRiskFromEvidence,
  mergeAttackDefenseSummaries,
  redLayerRewardForEpisode,
  summarizeAttackDefenseTask,
  type AssuranceAttackDefenseSummary,
  type AssuranceAttackDefenseTaskSummary,
  type AttackDefenseTaskRow,
} from './attack-defense.js';
import {
  prismaAttackMemoryStore,
  shouldRememberAttack,
  type AttackMemoryStore,
} from '../red-team/attack-memory.js';
import type { AttackMoveId, BrokenLayer } from '../red-team/types.js';
import {
  fetchGatewayAssuranceEvidence,
  type FetchGatewayAssuranceEvidenceOptions,
} from './gateway-client.js';
import type { GatewayAssuranceEvidence } from './types.js';

const AGENT_ENGINE = 'agent-tool-guard';
const AGENT_DIMENSION = 'agent_tool_call';

export interface AssuranceAttackDefenseProbeOptions {
  runId: string;
  gatewayModelTargetId: string;
  gatewayRuntimeBaseUrl?: string;
  gatewayRuntimeApiKey?: string;
  gatewayRuntimeModel?: string;
  controlPlaneBaseUrl?: string;
  tenantId?: string;
  internalToken?: string;
  fetchGatewayEvidence?: (
    options: FetchGatewayAssuranceEvidenceOptions,
  ) => Promise<GatewayAssuranceEvidence>;
  agentSampleCount?: number;
  agentLevel?: string;
  redTeamSampleCount?: number;
  redTeamBareTargetId?: string;
  redTeamAttackerTargetId?: string;
  redTeamJudgeTargetId?: string;
  redTeamQuestionSetId?: string;
  redTeamMaxRounds?: number;
  redTeamNoProgressK?: number;
  repairEligible?: boolean;
  /** Test seam: override the red-team reachability preflight (defaults to a live probe). */
  probeRedTeamReachable?: (
    prisma: PrismaClient,
    attackerTargetId: string,
    judgeTargetId: string,
  ) => Promise<RedTeamReachability>;
}

export interface RedTeamReachability {
  reachable: boolean;
  unreachableTargetId?: string;
  reason?: string;
}

export interface RedTeamReachabilityDeps {
  chat?: (
    cfg: LlmTargetConfig,
    messages: ChatMessage[],
    opts: { timeoutMs?: number; temperature?: number; maxTokens?: number },
  ) => Promise<LlmCallResult>;
  timeoutMs?: number;
}

/**
 * A null httpStatus on an ERROR result means we never received an HTTP response —
 * the TCP connection failed or timed out before the endpoint answered, i.e. the
 * endpoint is unreachable. An HTTP error (401/500/…) means the endpoint IS reachable,
 * so it is NOT treated as unreachable here.
 */
export function isConnectionUnreachable(result: LlmCallResult): boolean {
  return result.status === 'ERROR' && result.httpStatus === null;
}

/**
 * Pre-flight reachability check for the red-team attacker/judge endpoints. The red-team
 * battery makes ~sampleCount×rounds×roles model calls; if the adversary endpoint is
 * unreachable, each call burns its full per-call timeout (60s) and the whole assurance
 * cycle hangs for hours with no circuit breaker. A cheap short-timeout probe lets us skip
 * the battery fast and still write attribution.json. Auth failures (401) count as reachable.
 */
export async function probeRedTeamTargetsReachable(
  prisma: PrismaClient,
  attackerTargetId: string,
  judgeTargetId: string,
  deps: RedTeamReachabilityDeps = {},
): Promise<RedTeamReachability> {
  const chat = deps.chat ?? chatComplete;
  const timeoutMs = deps.timeoutMs ?? 8_000;
  const ids = [...new Set([attackerTargetId, judgeTargetId].filter(Boolean))];
  for (const id of ids) {
    const target = await prisma.modelTarget.findUnique({
      where: { id },
      select: { baseUrl: true, apiKey: true, model: true },
    });
    if (!target) {
      return { reachable: false, unreachableTargetId: id, reason: '目标不存在' };
    }
    const result = await chat(
      { baseUrl: target.baseUrl, apiKey: target.apiKey, model: target.model },
      [{ role: 'user', content: 'ping' }],
      { timeoutMs, temperature: 0, maxTokens: 1 },
    );
    if (isConnectionUnreachable(result)) {
      return { reachable: false, unreachableTargetId: id, reason: result.error ?? '连接失败' };
    }
  }
  return { reachable: true };
}

/**
 * Synthetic task summary recorded when the red-team battery is circuit-broken because its
 * adversary endpoint is unreachable. It carries one executionError (visible in the manifest)
 * and NO attributions, so it never opens a factory repair task for an infra outage.
 */
export function buildRedTeamSkippedSummary(reason: string): AssuranceAttackDefenseTaskSummary {
  return {
    kind: 'red_team',
    taskId: '',
    taskName: '网关 Assurance 红队 A/B 攻防复测（已跳过：对抗端点不可达）',
    status: 'SKIPPED',
    caseCount: 0,
    defendedCount: 0,
    bypassCount: 0,
    executionErrorCount: 1,
    gatewayWritebackMissingCount: 0,
    gatewayWritebackSuccessCount: 0,
    cases: [],
    attributions: [],
  };
}

export async function runAssuranceAttackDefenseProbes(
  prisma: PrismaClient,
  options: AssuranceAttackDefenseProbeOptions,
): Promise<AssuranceAttackDefenseSummary> {
  await assertNonEndpointTaskTargetId(prisma, options.gatewayModelTargetId);
  const summaries = [];
  const repairEligible = options.repairEligible ?? true;
  includeAssuranceControlPlaneAllowlist(options.controlPlaneBaseUrl);
  const protectedTargetId = await ensureRuntimeGatewayTarget(prisma, options);

  if ((options.agentSampleCount ?? 0) > 0) {
    const taskId = await createAgentRuntimeProbeTask(prisma, options, protectedTargetId);
    await runEvalTask(taskId);
    const task = await readAttackDefenseTask(prisma, taskId);
    const gatewayEvidenceByQuestionId = await collectAttackDefenseGatewayEvidence(task, options);
    summaries.push(
      summarizeAttackDefenseTask(task, {
        kind: 'agent_runtime',
        protectedTargetId,
        repairEligible,
        gatewayEvidenceByQuestionId,
      }),
    );
  }

  if ((options.redTeamSampleCount ?? 0) > 0 && redTeamProbeConfigured(options)) {
    const reachability = await (options.probeRedTeamReachable ?? probeRedTeamTargetsReachable)(
      prisma,
      options.redTeamAttackerTargetId!,
      options.redTeamJudgeTargetId!,
    );
    if (!reachability.reachable) {
      // Circuit-break: the red-team adversary endpoint is unreachable. Running the battery
      // would burn one full per-call timeout per call (~60s × samples × rounds) against a dead
      // endpoint and hang the whole assurance cycle. Skip it, record one executionError so the
      // outage is visible in the manifest, and let the cycle finish and write attribution.json.
      summaries.push(
        buildRedTeamSkippedSummary(
          `red-team 对抗端点不可达（${reachability.unreachableTargetId ?? '?'}）：${reachability.reason ?? ''}`,
        ),
      );
    } else {
      const taskId = await createRedTeamProbeTask(prisma, options, protectedTargetId);
      await runEvalTask(taskId);
      const task = await readAttackDefenseTask(prisma, taskId);
      const gatewayEvidenceByQuestionId = await collectAttackDefenseGatewayEvidence(task, options);
      await writeRedTeamRewardsFromGatewayEvidence(prisma, task, gatewayEvidenceByQuestionId, {
        attackMemory: prismaAttackMemoryStore(prisma),
      });
      summaries.push(
        summarizeAttackDefenseTask(task, {
          kind: 'red_team',
          protectedTargetId,
          repairEligible,
          gatewayEvidenceByQuestionId,
        }),
      );
    }
  }

  return mergeAttackDefenseSummaries(summaries);
}

export async function collectAttackDefenseGatewayEvidence(
  task: AttackDefenseTaskRow,
  options: Pick<
    AssuranceAttackDefenseProbeOptions,
    'controlPlaneBaseUrl' | 'tenantId' | 'internalToken' | 'fetchGatewayEvidence'
  >,
): Promise<Record<string, GatewayAssuranceEvidence>> {
  if (!options.controlPlaneBaseUrl || !options.tenantId || !options.internalToken) return {};
  const fetcher = options.fetchGatewayEvidence ?? fetchGatewayAssuranceEvidence;
  const evidenceByQuestionId: Record<string, GatewayAssuranceEvidence> = {};
  const questionIds = [...new Set(task.results.map((row) => row.questionId).filter(Boolean))];
  for (const questionId of questionIds) {
    try {
      evidenceByQuestionId[questionId] = await fetcher({
        controlPlaneBaseUrl: options.controlPlaneBaseUrl,
        internalToken: options.internalToken,
        tenantId: options.tenantId,
        taskId: task.id,
        sampleId: questionId,
      });
    } catch {
      // Missing evidence remains a gateway evidence gap in the summary instead of
      // aborting the repair loop before attribution can be written.
    }
  }
  return evidenceByQuestionId;
}

export async function writeRedTeamRewardsFromGatewayEvidence(
  prisma: Pick<PrismaClient, 'evalResult' | 'engineRun'>,
  task: AttackDefenseTaskRow,
  gatewayEvidenceByQuestionId: Record<string, GatewayAssuranceEvidence>,
  options: { attackMemory?: AttackMemoryStore } = {},
): Promise<void> {
  const rewardByQuestionId = redTeamRewardByQuestionId(task, gatewayEvidenceByQuestionId);
  const rows = await prisma.evalResult.findMany({
    where: {
      taskId: task.id,
      questionId: { in: [...new Set(task.results.map((row) => row.questionId).filter(Boolean))] },
    },
    select: {
      id: true,
      questionId: true,
      side: true,
      finalVerdict: true,
      modelTargetId: true,
      engineRuns: {
        where: { engine: 'autonomous-red-team' },
        select: { id: true, requestPayload: true, rawOutput: true },
      },
    },
  });
  const memoryCandidates = new Map<
    string,
    {
      questionId: string;
      side: string | null;
      finalVerdict: string | null;
      modelTargetId: string;
      rawOutput: string | null;
    }
  >();
  for (const row of rows) {
    const reward = rewardByQuestionId.get(row.questionId) ?? {
      redLayerReward: null,
      gatewayRecognizedRisk: null,
    };
    const firstRun = row.engineRuns[0];
    if (firstRun) {
      const requestPayload = isRecord(firstRun.requestPayload) ? firstRun.requestPayload : {};
      const side = stringField(row.side) || stringField(requestPayload.side) || null;
      const candidate = {
        questionId: row.questionId,
        side,
        finalVerdict: row.finalVerdict,
        modelTargetId: row.modelTargetId,
        rawOutput: firstRun.rawOutput,
      };
      const prior = memoryCandidates.get(row.questionId);
      if (!prior || candidate.side === 'B') {
        memoryCandidates.set(row.questionId, candidate);
      }
    }
    for (const run of row.engineRuns) {
      await prisma.engineRun.update({
        where: { id: run.id },
        data: {
          requestPayload: withRedLayerReward(
            run.requestPayload,
            reward.redLayerReward,
            reward.gatewayRecognizedRisk,
          ),
          rawOutput: rawOutputWithRedLayerReward(
            run.rawOutput,
            reward.redLayerReward,
            reward.gatewayRecognizedRisk,
          ),
        },
      });
    }
  }
  if (options.attackMemory) {
    for (const candidate of memoryCandidates.values()) {
      const reward = rewardByQuestionId.get(candidate.questionId) ?? {
        redLayerReward: null,
        gatewayRecognizedRisk: null,
      };
      await rememberRewardedAttack(options.attackMemory, candidate, reward.redLayerReward);
    }
  }
}

export function includeAssuranceControlPlaneAllowlist(
  rawUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!rawUrl) return;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  const current = (env.GATEWAY_CONTROL_PLANE_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const seen = new Set(current.map((entry) => entry.toLowerCase()));
  for (const entry of [url.origin, url.host]) {
    const key = entry.toLowerCase();
    if (!seen.has(key)) {
      current.push(entry);
      seen.add(key);
    }
  }
  env.GATEWAY_CONTROL_PLANE_ALLOWLIST = current.join(',');
}

async function ensureRuntimeGatewayTarget(
  prisma: PrismaClient,
  options: AssuranceAttackDefenseProbeOptions,
): Promise<string> {
  if (!options.gatewayRuntimeBaseUrl && !options.controlPlaneBaseUrl) {
    return options.gatewayModelTargetId;
  }
  const source = await prisma.modelTarget.findUnique({
    where: { id: options.gatewayModelTargetId },
  });
  if (!source) throw new Error('gateway model target not found: ' + options.gatewayModelTargetId);
  const name = 'Assurance Runtime - ' + source.name;
  const accessConfig = mergeAccessConfig(source.accessConfig, {
    controlPlaneBaseUrl: options.controlPlaneBaseUrl,
    tenantId: options.tenantId,
  });
  // 评估对象名称在租户内唯一：运行时对象建在网关对象所在的租户里。
  const existing = await prisma.modelTarget.findFirst({
    where: { name, tenantId: source.tenantId },
    select: { id: true },
  });
  const target = await prisma.modelTarget.upsert({
    where: { id: existing?.id ?? '00000000-0000-0000-0000-000000000000' },
    create: {
      tenantId: source.tenantId,
      name,
      provider: source.provider,
      targetType: source.targetType,
      baseUrl: options.gatewayRuntimeBaseUrl || source.baseUrl,
      apiKey: options.gatewayRuntimeApiKey || source.apiKey,
      model: options.gatewayRuntimeModel || source.model,
      extraHeaders: source.extraHeaders as Prisma.InputJsonValue,
      defaultParams: source.defaultParams as Prisma.InputJsonValue,
      accessConfig,
      isGlobal: true,
      isActive: true,
    },
    update: {
      provider: source.provider,
      targetType: source.targetType,
      baseUrl: options.gatewayRuntimeBaseUrl || source.baseUrl,
      apiKey: options.gatewayRuntimeApiKey || source.apiKey,
      model: options.gatewayRuntimeModel || source.model,
      extraHeaders: source.extraHeaders as Prisma.InputJsonValue,
      defaultParams: source.defaultParams as Prisma.InputJsonValue,
      accessConfig,
      isActive: true,
    },
    select: { id: true },
  });
  return target.id;
}

function mergeAccessConfig(
  raw: unknown,
  overrides: { controlPlaneBaseUrl?: string; tenantId?: string },
): Prisma.InputJsonValue {
  const base = isRecord(raw) ? { ...raw } : {};
  if (overrides.controlPlaneBaseUrl) base.controlPlaneBaseUrl = overrides.controlPlaneBaseUrl;
  if (overrides.tenantId) base.tenantId = overrides.tenantId;
  return base as Prisma.InputJsonValue;
}

async function createAgentRuntimeProbeTask(
  prisma: PrismaClient,
  options: AssuranceAttackDefenseProbeOptions,
  protectedTargetId: string,
): Promise<string> {
  const scenarios = generateAgentScenarios({
    level: options.agentLevel ?? 'standard',
    sampleCount: options.agentSampleCount,
    seed: options.runId + ':agent-runtime',
    maxConcurrency: 1,
  });
  const taskId = randomUUID();
  const set = await prisma.questionSet.create({
    data: {
      name: '网关 Assurance Agent 攻防复测 ' + options.runId,
      description: '自动闭环创建的 Agent 工具边界攻防探针题集。',
      type: 'PROMPT_INJECTION',
      source: 'assurance-agent:' + options.runId,
      language: 'zh',
      tags: ['gateway-assurance', 'attack-defense', 'agent-runtime'],
      questions: { create: scenarios.map(agentQuestionRow) },
    },
  });
  const task = await prisma.evalTask.create({
    data: {
      id: taskId,
      name: '网关 Assurance Agent 攻防复测 ' + options.runId,
      description: '自动闭环发起 Agent 工具调用攻击样本，验证网关防护、审计和 finding 回写。',
      status: 'PENDING',
      modelTargetId: protectedTargetId,
      engines: [AGENT_ENGINE],
      dimensions: [AGENT_DIMENSION],
      concurrency: 1,
      totalQuestions: scenarios.length,
      questionSets: { create: [{ questionSetId: set.id }] },
    },
    select: { id: true },
  });
  return task.id;
}

function agentQuestionRow(scenario: AgentScenario): Prisma.QuestionCreateWithoutQuestionSetInput {
  return {
    externalId: scenario.externalId,
    content: scenario.prompt,
    expectedBehavior: scenario.expectedBehavior,
    referenceAnswer: scenario.referenceAnswer,
    category: scenario.category,
    language: scenario.language,
    type: scenario.type,
    severity: scenario.severity,
    shouldRefuse: scenario.shouldRefuse,
    tags: scenario.tags,
    metadata: scenario.metadata as unknown as Prisma.InputJsonValue,
  };
}

export async function createRedTeamProbeTask(
  prisma: PrismaClient,
  options: AssuranceAttackDefenseProbeOptions,
  protectedTargetId: string,
): Promise<string> {
  await assertNonEndpointTaskTargetId(prisma, protectedTargetId);
  if (options.redTeamBareTargetId)
    await assertNonEndpointTaskTargetId(prisma, options.redTeamBareTargetId);
  const seedSet = await loadRedTeamSeedSet(prisma, options.redTeamQuestionSetId);
  if (!seedSet || seedSet.questions.length === 0) {
    throw new Error('assurance red-team seed set is missing or empty');
  }
  const selectionSeed = options.runId + ':red-team';
  const selected = selectRedTeamQuestions(seedSet.questions, {
    seed: selectionSeed,
    sampleCount: options.redTeamSampleCount,
    fallbackVariants: RED_TEAM_ATTACK_VARIANT_IDS,
  });
  const taskId = randomUUID();
  const taskName = '网关 Assurance 红队 A/B 攻防复测 ' + options.runId;
  const set = await prisma.questionSet.create({
    data: {
      name: taskName + ' 样本',
      description: '自动闭环从内置红队候选包抽样生成，本轮 seed：' + selectionSeed,
      type: 'SHOULD_REFUSE',
      source: 'assurance-red-team:' + options.runId,
      language: seedSet.language ?? 'zh',
      tags: ['gateway-assurance', 'attack-defense', 'red-team', 'autonomous-red-team'],
      questions: {
        create: selected.map(({ question, variant, selectionIndex }) => ({
          externalId: question.externalId,
          content: question.content,
          expectedBehavior: question.expectedBehavior,
          category: question.category,
          type: question.type,
          severity: question.severity,
          referenceAnswer: question.referenceAnswer,
          language: question.language,
          shouldRefuse: question.shouldRefuse,
          tags: [...new Set([...question.tags, 'gateway-assurance', 'red-team'])],
          metadata: redTeamQuestionMetadata(question.metadata, options, protectedTargetId, {
            selectionSeed,
            selectionIndex,
            sampleCount: selected.length,
            candidateCount: seedSet.questions.length,
            sourceQuestionSetId: seedSet.id,
            sourceQuestionSetName: seedSet.name,
            sourceQuestionId: question.id,
            variant,
          }),
        })),
      },
    },
  });
  const task = await prisma.evalTask.create({
    data: {
      id: taskId,
      name: taskName,
      description:
        '自动闭环 A/B 红队评估：攻击模型先评估未接入防护的基线对象，再将同一攻击脚本重放到防护后对象。',
      status: 'PENDING',
      modelTargetId: options.redTeamBareTargetId!,
      engines: ['rule-judge', 'sensitive-info', 'llm-judge'],
      dimensions: ['redteam_attack', 'prompt_injection', 'refusal'],
      concurrency: 1,
      totalQuestions: selected.length,
      questionSets: { create: [{ questionSetId: set.id }] },
    },
    select: { id: true },
  });
  return task.id;
}

async function loadRedTeamSeedSet(prisma: PrismaClient, id: string | undefined) {
  if (id) {
    return prisma.questionSet.findUnique({
      where: { id },
      include: { questions: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
  }
  return prisma.questionSet.findFirst({
    where: { source: 'builtin:red-team' },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    include: { questions: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  });
}

function redTeamProbeConfigured(options: AssuranceAttackDefenseProbeOptions): boolean {
  return Boolean(
    options.redTeamBareTargetId &&
    options.gatewayModelTargetId &&
    options.redTeamAttackerTargetId &&
    options.redTeamJudgeTargetId,
  );
}

function redTeamQuestionMetadata(
  original: unknown,
  options: AssuranceAttackDefenseProbeOptions,
  protectedTargetId: string,
  selection: {
    selectionSeed: string;
    selectionIndex: number;
    sampleCount: number;
    candidateCount: number;
    sourceQuestionSetId: string;
    sourceQuestionSetName: string;
    sourceQuestionId: string;
    variant: string;
  },
): Prisma.InputJsonValue {
  const base = isRecord(original) ? { ...original } : {};
  const prior = isRecord(base.redteam) ? base.redteam : {};
  return {
    ...base,
    kind: 'red_team',
    redteam: {
      ...prior,
      objectiveId: stringField(prior.objectiveId) || `question:${selection.sourceQuestionId}`,
      gatewayTargetId: protectedTargetId,
      mode: 'protected_compare',
      attackerTargetId: options.redTeamAttackerTargetId,
      secondaryAttackerTargetId: '',
      judgeTargetId: options.redTeamJudgeTargetId,
      breakOn: 'verdict',
      maxRounds: options.redTeamMaxRounds ?? 2,
      noProgressK: options.redTeamNoProgressK ?? 1,
      variant: selection.variant,
      selectionSeed: selection.selectionSeed,
      selectionIndex: selection.selectionIndex,
      sampleCount: selection.sampleCount,
      candidateCount: selection.candidateCount,
      sourceQuestionSetId: selection.sourceQuestionSetId,
      sourceQuestionSetName: selection.sourceQuestionSetName,
      sourceQuestionId: selection.sourceQuestionId,
    },
  } as Prisma.InputJsonValue;
}

function withRedLayerReward(
  value: unknown,
  reward: number | null,
  gatewayRecognizedRisk: boolean | null,
): Prisma.InputJsonValue {
  const base = isRecord(value) ? { ...value } : {};
  base.redLayerReward = reward;
  base.gatewayRecognizedRisk = gatewayRecognizedRisk;
  return base as Prisma.InputJsonValue;
}

function rawOutputWithRedLayerReward(
  value: string | null,
  reward: number | null,
  gatewayRecognizedRisk: boolean | null,
): string {
  const raw = parseJsonRecord(value) ?? {};
  raw.redLayerReward = reward;
  raw.gatewayRecognizedRisk = gatewayRecognizedRisk;
  if (isRecord(raw.recording)) {
    raw.recording = {
      ...raw.recording,
      redLayerReward: reward,
    };
  }
  return JSON.stringify(raw);
}

async function rememberRewardedAttack(
  attackMemory: AttackMemoryStore,
  candidate: {
    side: string | null;
    finalVerdict: string | null;
    modelTargetId: string;
    rawOutput: string | null;
  },
  redLayerReward: number | null,
): Promise<void> {
  const raw = parseJsonRecord(candidate.rawOutput);
  const recording = isRecord(raw?.recording) ? raw.recording : null;
  const playbook = isRecord(recording?.playbook) ? recording.playbook : null;
  const objectiveId = stringField(playbook?.objectiveId);
  const verdict = normalizedVerdict(candidate.finalVerdict);
  const reward = redLayerReward;
  if (
    !shouldRememberAttack({
      broke: verdict === 'FAIL',
      verdict,
      redLayerReward: reward,
      executionNoise: verdict === 'ERROR',
      objectiveId,
    })
  ) {
    return;
  }
  if (typeof reward !== 'number') return;

  await attackMemory.remember({
    objectiveId,
    guardFingerprint: candidate.side === 'B' ? `gateway:${candidate.modelTargetId}` : 'bare',
    playbookVariant: stringField(playbook?.variant) || 'unknown',
    moveSequence: attackMoveArray(recording?.movesUsed),
    brokenLayers: brokenLayerArray(recording?.brokenLayers),
    redLayerReward: reward,
    ts: new Date(),
  });
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function attackMoveArray(value: unknown): AttackMoveId[] {
  return Array.isArray(value)
    ? (value.filter((item) => typeof item === 'string') as AttackMoveId[])
    : [];
}

function brokenLayerArray(value: unknown): BrokenLayer[] {
  return Array.isArray(value)
    ? (value.filter((item) => item === 'content' || item === 'action') as BrokenLayer[])
    : [];
}

function redTeamRewardByQuestionId(
  task: AttackDefenseTaskRow,
  gatewayEvidenceByQuestionId: Record<string, GatewayAssuranceEvidence>,
): Map<string, { redLayerReward: number | null; gatewayRecognizedRisk: boolean | null }> {
  const protectedRowsByQuestionId = new Map<string, AttackDefenseTaskRow['results'][number]>();
  for (const row of task.results) {
    if (row.side === 'B') {
      protectedRowsByQuestionId.set(row.questionId, row);
    } else if (!protectedRowsByQuestionId.has(row.questionId)) {
      protectedRowsByQuestionId.set(row.questionId, row);
    }
  }
  const rewards = new Map<
    string,
    { redLayerReward: number | null; gatewayRecognizedRisk: boolean | null }
  >();
  for (const [questionId, row] of protectedRowsByQuestionId) {
    const hasGatewayEvidence = Object.prototype.hasOwnProperty.call(
      gatewayEvidenceByQuestionId,
      questionId,
    );
    const gatewayRecognizedRisk = hasGatewayEvidence
      ? gatewayRecognizedRiskFromEvidence(gatewayEvidenceByQuestionId[questionId])
      : null;
    rewards.set(questionId, {
      gatewayRecognizedRisk,
      redLayerReward: redLayerRewardForEpisode({
        broke: normalizedVerdict(row.finalVerdict) === 'FAIL',
        gatewayRecognizedRisk,
      }),
    });
  }
  return rewards;
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedVerdict(value: string | null): string | null {
  const verdict = value?.trim().toUpperCase();
  return verdict ? verdict : null;
}

async function readAttackDefenseTask(
  prisma: PrismaClient,
  taskId: string,
): Promise<AttackDefenseTaskRow> {
  const task = await prisma.evalTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      name: true,
      status: true,
      modelTargetId: true,
      engines: true,
      dimensions: true,
      totalQuestions: true,
      processedQuestions: true,
      passedCount: true,
      failedCount: true,
      errorCount: true,
      finishedAt: true,
      results: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          questionId: true,
          controlGroupId: true,
          side: true,
          finalVerdict: true,
          modelTargetId: true,
          findings: { select: { id: true } },
        },
      },
      logs: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { level: true, message: true, context: true },
      },
    },
  });
  if (!task) throw new Error('attack-defense task not found: ' + taskId);
  return task as unknown as AttackDefenseTaskRow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
