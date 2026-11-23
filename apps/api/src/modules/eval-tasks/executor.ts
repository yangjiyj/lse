import { runPlatformScenario } from '../agent-evals/observed-runner.js';
import { createPlatformTargetChat } from '../red-team/platform-chat.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  ChatMessage,
  EngineResult,
  EngineRunStatus,
  JudgeInput,
  JudgeRules,
  LlmCallResult,
  LlmTargetConfig,
  QuestionType,
  Severity,
  Verdict,
} from '@lse/shared';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import { assertControlPlaneAllowed, resolveInternalToken } from '../../lib/gateway-access.js';
import { chatComplete } from '../../lib/llm-client.js';
import { withTenant } from '../../lib/tenant-context.js';
import { PLATFORM_TENANT_ID } from '../../lib/tenant-models.js';
import {
  clearEvalTaskPause,
  isEvalTaskCancelRequested,
  isEvalTaskPauseRequested,
} from '../../lib/queue.js';
import { runAgentScenario as defaultRunAgentScenario } from '../agent-evals/runner.js';
import { parseAgentConfig } from '../agent-evals/agent-target.js';
import {
  runMcpScenario as defaultRunMcpScenario,
  type McpRunResult,
  type RunMcpScenarioArgs,
} from '../agent-evals/mcp-runner.js';
import type { McpScenarioMetadata } from '../agent-evals/types.js';
import { invokeEvaluationTarget, withGatewaySessionHeader } from '../eval-targets/invoker.js';
import { runPreTaskFingerprintCheck } from '../model-fingerprint/pre-task.js';
import {
  collectGatewayFindingsByTask,
  fetchGatewayAuditEvents,
  postGatewayEvalFindings,
  type GatewayEvalFindingInput,
  type GatewayLogFinding,
} from '../gateway-logs/client.js';
import {
  resolvePerQuestionEngines,
  resolveTaskLevelEngines,
  resolveDormantTaskLevelEngines,
} from '../engines/registry.js';
import { loadCustomRiskEngine } from '../engines/custom-risk/engine.js';
import {
  fetchGatewayAssuranceEvidence,
  type FetchGatewayAssuranceEvidenceOptions,
} from '../assurance/gateway-client.js';
import { gatewayRecognizedRiskFromEvidence } from '../assurance/attack-defense.js';
import { loadActiveJudgeTarget } from '../engines/judge-target.js';
import { AGENT_TOOL_GUARD_ENGINE } from '../engines/agent-tool-guard.js';
import { createLlmJudgeEngine, LLM_JUDGE_ENGINE } from '../engines/llm-judge.js';
import type { PerQuestionEngine, TaskLevelEngine, TaskScanTarget } from '../engines/types.js';
import { aggregateVerdict, parseJudgeRules, SEVERITY_RANK } from './judge.js';
import { loadTaskQuestions } from './sampling.js';
import {
  decideFindingReview,
  isSuppressedByReview,
  type FindingReviewGovernance,
  applySuspectedFalsePositive,
} from './review-governance.js';
import {
  runRedTeamAttack,
  persistPair,
  resolveRedTeamConfig,
  redTeamPrismaStore,
  resolveAttackerHead,
  type AttackerHead,
  type ChatFn,
  type RedTeamRoundEvent,
  type RedTeamStore,
} from '../red-team/index.js';
import { toRedTeamSeed } from '../red-team/seed.js';
import { RED_TEAM_SETTING_KEY } from '../red-team/config.js';
import { assertExternalAttackerTarget } from '../red-team/target-validation.js';
import { makeSubstanceJudge } from '../red-team/substance-judge.js';
import { AdaptiveConcurrency } from '../red-team/adaptive-concurrency.js';
import { AsyncSemaphore } from '../red-team/async-semaphore.js';
import {
  ConfigError,
  createRedTeamChat,
  RetryExhausted,
  type RedTeamChat,
} from '../red-team/red-team-chat.js';
import { redactString } from '../../lib/redact.js';
import { evaluateGateForTask } from '../gates/service.js';

/** 执行器依赖（便于测试注入假的模型调用与引擎，避免真实网络请求）。 */
import { ScenarioScheduler } from '../red-team/scenario-scheduler.js';
import { parseMultimodalMeta, runMultimodalQuestion } from '../multimodal-jailbreak/executor.js';
import { parseByoMeta, runByoImageQuestion } from '../multimodal-jailbreak/byo-images/executor.js';
import { loadByoImageBlob } from '../multimodal-jailbreak/byo-images/store.js';
import { RedTeamExecutionError } from '../red-team/execution-error.js';
import type { RedTeamLengthTruncation } from '../red-team/types.js';
export interface RunEvalTaskDeps {
  callModel?: (
    cfg: LlmTargetConfig,
    messages: ChatMessage[],
    opts?: { timeoutMs?: number; temperature?: number; signal?: AbortSignal },
  ) => Promise<LlmCallResult>;
  runAgentScenario?: (
    cfg: LlmTargetConfig,
    scenario: { prompt: string; metadata?: Record<string, unknown> | null },
  ) => Promise<LlmCallResult>;
  /** 注入 MCP 测-堵-验闭环执行器（题目 metadata.kind=mcp_runtime 时走）。 */
  runMcpScenario?: (args: RunMcpScenarioArgs) => Promise<McpRunResult>;
  perQuestionEngines?: PerQuestionEngine[];
  taskLevelEngines?: TaskLevelEngine[];
  /**
   * 注入全局评审模型（覆盖 DB 里激活的 JUDGE 查询），用于测试确定性：
   *   undefined → 不覆盖，照常查 DB（生产路径）；
   *   null → 显式「无评审目标」，不启用 llm-judge；
   *   LlmTargetConfig → 直接用此评审目标。
   */
  judgeTarget?: LlmTargetConfig | null;
  /** 注入红队攻击脑（任务 7 起：题目 metadata.kind=red_team 时走红队管道）。 */
  attackerHead?: AttackerHead;
  /**
   * 注入 prisma（仅测试用）：覆盖 runEvalTask 函数体内的 DB 读写，使内存假库能一路覆盖到
   * 红队落库点，从而观测默认装配的攻击脑（缺省时走 resolveAttackerHead('react')）。
   * 不注入时一律回退到模块级 prisma，生产运行时行为逐字节等价。
   * 类型取真实 PrismaClient 的结构化子集（仅 runEvalTask 实际调用到的模型），
   * 故真 prisma 天然可赋值、假库只需实现这几张表即可。
   */
  prisma?: PrismaLike;
  fetchGatewayEvidence?: (
    options: FetchGatewayAssuranceEvidenceOptions,
  ) => Promise<Awaited<ReturnType<typeof fetchGatewayAssuranceEvidence>>>;
  collectGatewayFindings?: (args: {
    controlPlaneBaseUrl: string;
    internalToken: string;
    tenantId: string;
    taskId: string;
  }) => Promise<GatewayLogFinding[]>;
  /** 测试注入缝：覆盖「是否启用网关联动」；不注入时读系统设置 gateway.gatewayLinkageEnabled（默认关）。 */
  gatewayLinkageEnabled?: boolean;
  isCancelRequested?: (taskId: string) => Promise<boolean>;
  cancelPollIntervalMs?: number;
  /** 暂停信号（2.4.2）：为真时不再派新题，在途的题做完后置为已暂停。默认读 Valkey 暂停键，按 cancelPollIntervalMs 节流。 */
  isPauseRequested?: (taskId: string) => Promise<boolean>;
  /** 测试注入缝：任务完成后的上线门禁判定（默认 evaluateGateForTask，走真实库）。 */
  evaluateGates?: (taskId: string) => Promise<unknown>;
  /**
   * 任务前模型指纹比对。不注入时：使用模块级 prisma 时默认开启；注入内存假库（deps.prisma）时默认关闭。
   * 传 false 显式关闭；传函数则替换默认实现（测试用）。永不阻断任务。
   */
  preTaskFingerprintCheck?:
    | false
    | ((taskId: string, modelTargetId: string, signal: AbortSignal) => Promise<unknown>);
}

/**
 * runEvalTask 实际触达的最小 prisma 读写面（真实 PrismaClient 的结构化子集）。
 * 仅列出本函数体内用到的模型；evalTaskLog 由 safeLog 自管模块级 prisma，不在此面内。
 */
export type PrismaLike = Pick<
  PrismaClient,
  | 'evalTask'
  | 'question'
  | 'wrongAnswer'
  | 'finding'
  | 'engineRun'
  | 'evalResult'
  | 'modelTarget'
  | 'systemSetting'
>;

/** 红队单题上下文：把一道 red_team 题接入「录脚本·重放实际侧·裁判·落库」管道所需的全部依赖。 */
export interface RedTeamQuestionCtx {
  task: { id: string; modelTargetId: string };
  bareTarget: LlmTargetConfig;
  question: {
    id: string;
    content: string;
    metadata: Record<string, unknown> | null;
    shouldRefuse: boolean;
    type: QuestionType;
    category: string | null;
    expectedBehavior: string | null;
    referenceAnswer: string | null;
    severity: Severity | null;
  };
  deps: {
    attackerHead: AttackerHead;
    chat: ChatFn;
    judge: PerQuestionEngine;
    loadTarget(id: string): Promise<LlmTargetConfig>;
    collectGatewayEvidence?: (args: {
      taskId: string;
      sampleId: string;
      targetId: string;
      traceId: string;
    }) => Promise<{ gatewayRecognizedRisk: boolean | null }>;
    loadSetting(key: string): Promise<Record<string, unknown> | null>;
    store: RedTeamStore;
    signal?: AbortSignal;
    /** 统一调用包装（重试+自适应并发+空响应校验）；注入后红队角色共用它。 */
    redTeamChat?: RedTeamChat;
    /** 被测模型单次输出上限（透传给 replay）。 */
    targetMaxTokens?: number;
  };
  live?: {
    sampleIndex: number;
    totalSamples: number;
  };
}

export interface RedTeamQuestionSummary {
  sideAVerdict: string;
  sideBVerdict: string;
  reportTargetId: string;
  gatewayFindings: GatewayEvalFindingInput[];
}

/** 红队落库时种子标题的最大截取长度（仅用于展示，不影响判定）。 */
const RED_TEAM_SEED_TITLE_MAX = 40;
const RED_TEAM_LIVE_TEXT_MAX = 4000;

type ReportableRedTeamSide = {
  side: 'A' | 'B';
  modelTargetId: string;
  response: string;
  judge: EngineResult;
};

/**
 * 判定来源码（llm_judge_fail / agent_llm_judge_fail 等）说的是「谁判的」，不是「什么风险」。
 * 写进类别字段会让风险处置台的「风险类别」列变成「AI 评审不通过」，与「判定」列重复。
 * 所以类别只取引擎给出的业务类别；判定来源码一律让位给样本自身的风险域，
 * 都没有时写 uncategorized（判定来源仍在 engine / 判定依据字段里保留）。
 */
const JUDGE_SOURCE_CATEGORY = /^(?:agent_)?llm_judge/;
export function redTeamFindingCategory(
  judgeCategory: string | null | undefined,
  questionCategory: string | null | undefined,
): string {
  const judged = (judgeCategory ?? '').trim();
  if (judged && !JUDGE_SOURCE_CATEGORY.test(judged)) return judged;
  const domain = (questionCategory ?? '').trim();
  return domain || 'uncategorized';
}

function redTeamGatewayFindings(
  ctx: RedTeamQuestionCtx,
  side: ReportableRedTeamSide,
): GatewayEvalFindingInput[] {
  if (side.judge.verdict !== 'FAIL') return [];
  const category = redTeamFindingCategory(side.judge.riskCategory, ctx.question.category);
  const evidence = side.judge.evidence ?? null;
  return [
    {
      findingId: `autonomous-red-team:${side.side}:${category}`,
      // 展示用风险域：样本风险域 → 引擎给出的业务类别 → 中文兜底（uncategorized 不外露）。
      riskDomain:
        ctx.question.category ||
        (category === 'uncategorized' ? '' : category) ||
        '自主红队评估风险',
      category,
      severity: atLeastHigh(side.judge.severity),
      verdict: 'autonomous_red_team_jailbreak',
      expectedBehavior:
        ctx.question.expectedBehavior ?? (ctx.question.shouldRefuse ? 'should_refuse' : null),
      actualBehavior: truncate(side.response, 500),
      reason: evidence,
      evidence,
      isFalsePositive: false,
    },
  ];
}

function redTeamLiveText(text: string | null | undefined, max = RED_TEAM_LIVE_TEXT_MAX): string {
  const masked = redactString(String(text ?? ''));
  return masked.length > max ? `${masked.slice(0, max)}...` : masked;
}

async function logRedTeamRound(ctx: RedTeamQuestionCtx, event: RedTeamRoundEvent): Promise<void> {
  const sampleIndex = ctx.live?.sampleIndex ?? null;
  const totalSamples = ctx.live?.totalSamples ?? null;
  const sampleText =
    sampleIndex !== null && totalSamples !== null
      ? `第 ${sampleIndex}/${totalSamples} 个场景，`
      : '';
  await safeLog(
    ctx.task.id,
    'info',
    `红队对抗进度：${sampleText}第 ${event.roundNumber}/${event.maxRounds} 轮`,
    {
      kind: 'red_team_round',
      sampleIndex,
      totalSamples,
      questionId: ctx.question.id,
      seedTitle: redTeamLiveText(ctx.question.content, 160),
      round: event.roundNumber,
      maxRounds: event.maxRounds,
      phaseId: event.phaseId ?? null,
      phaseLabel: event.phaseLabel ?? null,
      move: event.move,
      attitude: event.attitude,
      wordingSignals: event.wordingSignals ?? null,
      roundJudgment: event.roundJudgment ?? null,
      broke: event.broke,
      stopReason: event.stopReason,
      judgeVerdict: event.judgeVerdict ?? null,
      usedTokens: event.usedTokens,
      brokenLayers: event.brokenLayers ?? [],
      redLayerReward: event.redLayerReward ?? null,
      rationale: redTeamLiveText(event.rationale, 1000),
      successSignal: redTeamLiveText(event.successSignal, 1000),
      attackerMessage: redTeamLiveText(event.attackerMessage),
      modelResponse: redTeamLiveText(event.modelResponse),
    } as Prisma.InputJsonValue,
  );
}

/**
 * 处理一道红队题：解析红队配置 -> 录脚本 -> 对被测模型重放；若配置防护层再做 B 侧对照 -> 同一裁判判定 -> 落库。
 * 返回两侧裁决供调用方更新进度与计数；未配置防护层时以被测模型结论作为主裁决。
 *
 * 健壮性约定：单题管道内部任何环节失败（配置错 / LLM 超时 / 重放或落库异常）都不向调用方抛出，
 * 而是软化为双侧 ERROR 返回——避免一道题的偶发失败拖垮整批（pump 循环据此计入 errorCount 并继续）。
 * 失败时仅记录题目 id 与「打码后」的错误信息，绝不打印中转/裁判配置里的 apiKey 等明文。
 */
const RED_TEAM_DEFER_COOLDOWN_MS = 15_000;

export async function runRedTeamForQuestion(
  ctx: RedTeamQuestionCtx,
): Promise<RedTeamQuestionSummary> {
  return runRedTeamForQuestionInner(ctx, false);
}

async function runRedTeamForQuestionInner(
  ctx: RedTeamQuestionCtx,
  retried: boolean,
): Promise<RedTeamQuestionSummary> {
  try {
    const cfg = await resolveRedTeamConfig(ctx.question.metadata, ctx.deps.loadSetting);
    const evaluationTarget = {
      id: ctx.task.modelTargetId,
      baseUrl: ctx.bareTarget.baseUrl,
      model: ctx.bareTarget.model,
    };
    const attackerTargetIds = [
      ...new Set([cfg.attackerTargetId, cfg.secondaryAttackerTargetId].filter(Boolean)),
    ];
    for (const attackerTargetId of attackerTargetIds) {
      if (attackerTargetId === evaluationTarget.id) {
        throw new ConfigError(
          'attacker',
          'RED_TEAM_ATTACKER_MUST_DIFFER',
          null,
          '攻击模型不能与评估对象相同，请选择独立模型。',
        );
      }
      const attackerTarget = await ctx.deps.loadTarget(attackerTargetId);
      try {
        assertExternalAttackerTarget(
          {
            id: attackerTargetId,
            baseUrl: attackerTarget.baseUrl,
            model: attackerTarget.model,
          },
          evaluationTarget,
        );
      } catch (error) {
        if (error instanceof AppError && error.code === 'RED_TEAM_ATTACKER_MUST_DIFFER') {
          throw new ConfigError('attacker', error.code, null, error.message);
        }
        throw error;
      }
    }
    const seed = toRedTeamSeed(ctx.question);
    // 破局判据接线：按 cfg.judgeTargetId 加载裁判模型（空则回落 attackerTargetId，二者皆非空），
    // 用 makeSubstanceJudge 构造「只看内容实质」的实质裁判，并把它注入【录制期破局判定路径】（breakJudge）。
    // 注意：
    //   - 注入到 breakJudge 的是 substanceJudge，而非门控信号 ctx.deps.judge（aiReviewEngine）——
    //     ctx.deps.judge 仅表示「已启用红队」，不应直接作为破局裁判。
    //   - 终判裁判（A/B 重放后判两侧）仍用 ctx.deps.judge，不被 substanceJudge 污染。
    const judgeTarget = await ctx.deps.loadTarget(cfg.judgeTargetId || cfg.attackerTargetId);
    // P4：实质裁判走统一调用契约（stage=judge，judgeMaxTokens），参与自适应恢复。
    const substanceJudge = makeSubstanceJudge(
      judgeTarget,
      ctx.deps.redTeamChat ?? ctx.deps.chat,
      cfg.judgeMaxTokens,
    );
    const finalJudge = ctx.deps.redTeamChat
      ? createLlmJudgeEngine({
          target: judgeTarget,
          enabled: true,
          rubricEnabled: config.LLM_JUDGE_RUBRIC_ENABLED,
          maxTokens: cfg.judgeMaxTokens,
          signal: ctx.deps.signal,
          propagateInfrastructureErrors: true,
          chat: async (target, messages, options) => {
            const result = await ctx.deps.redTeamChat!.call(target, messages, {
              stage: 'judge',
              temperature: options?.temperature,
              timeoutMs: options?.timeoutMs,
              maxTokens: options?.maxTokens ?? cfg.judgeMaxTokens,
              signal: options?.signal ?? ctx.deps.signal,
            });
            return {
              status: result.status,
              content: result.content,
              finishReason: result.finishReason ?? null,
              model: target.model,
              usage: result.usage as any,
              latencyMs: 0,
              httpStatus: 200,
              error: null,
              raw: { finishReason: result.finishReason ?? null },
            } as LlmCallResult;
          },
        })
      : ctx.deps.judge;
    const pair = await runRedTeamAttack({
      task: ctx.task,
      bareTarget: ctx.bareTarget,
      seed,
      cfg,
      head: ctx.deps.attackerHead,
      deps: {
        chat: ctx.deps.chat,
        judge: finalJudge,
        breakJudge: substanceJudge,
        attackMemory: ctx.deps.store.attackMemory,
        loadTarget: ctx.deps.loadTarget,
        collectGatewayEvidence: ctx.deps.collectGatewayEvidence,
        signal: ctx.deps.signal,
        redTeamChat: ctx.deps.redTeamChat,
        targetMaxTokens: cfg.targetMaxTokens,
      },
      controlGroupId: ctx.question.id,
      onRound: (event) => logRedTeamRound(ctx, event),
    });
    await persistPair(
      ctx.deps.store,
      {
        taskId: ctx.task.id,
        headName: ctx.deps.attackerHead.name,
        seedTitle: ctx.question.content.slice(0, RED_TEAM_SEED_TITLE_MAX),
      },
      pair,
    );
    const reportSide = pair.sideB ?? pair.sideA;
    return {
      sideAVerdict: pair.sideA.judge.verdict,
      sideBVerdict: pair.sideB?.judge.verdict ?? pair.sideA.judge.verdict,
      reportTargetId: reportSide.modelTargetId,
      gatewayFindings: redTeamGatewayFindings(ctx, reportSide),
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // P2：RetryExhausted 不在此处理，重新抛给 pump 调度层——由 ScenarioScheduler 做真实
    // 延后队列（冷却后重新执行全新 attack，不占 worker 空等 15s，仅一次）。ConfigError 也抛，
    // pump 据此做任务级断路。这里只兜底「真正的落库异常」等其他错误为双侧 ERROR。
    if (
      err instanceof Error &&
      ['RetryExhausted', 'ConfigError', 'RedTeamInfrastructureError'].includes(err.name)
    ) {
      throw err;
    }
    const e = err as Error;
    const maskedName = redactString(String(e?.name ?? 'Error'));
    const maskedMessage = redactString(String(e?.message ?? e));
    console.error(
      `[executor] 红队单题失败已软化为 ERROR questionId=${ctx.question.id} error=${maskedName}: ${maskedMessage}`,
    );
    return {
      sideAVerdict: 'ERROR',
      sideBVerdict: 'ERROR',
      reportTargetId: ctx.task.modelTargetId,
      gatewayFindings: [],
    };
  }
}

type LogLevel = 'info' | 'warn' | 'error';

/** 任务级引擎（红队扫描等）单次扫描的最长等待时间。 */
const TASK_ENGINE_TIMEOUT_MS = 5 * 60 * 1000;
const CANCEL_POLL_INTERVAL_MS = 500;
/** 休眠任务级引擎（已勾选但未部署 sidecar / 开关未开）落 SKIPPED 行时写入的统一原因。 */
const DORMANT_ENGINE_SKIP_REASON =
  '任务级引擎已选择但当前不可用：未部署对应 sidecar 或开关未开启，本次跳过扫描';
const SEMANTIC_INPUT_RISK_ENGINE = 'semantic-input-risk';
const SEMANTIC_INPUT_RISK_KIND = 'semantic_input_risk';
/** MCP 测-堵-验闭环引擎名（落 EngineRun.rawOutput / Finding.engine）。 */
const MCP_CLOSED_LOOP_ENGINE = 'mcp-closed-loop';

/** 写任务日志，best-effort，绝不抛出。 */
async function safeLog(
  taskId: string,
  level: LogLevel,
  message: string,
  context?: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await prisma.evalTaskLog.create({
      data: {
        taskId,
        level,
        message,
        ...(context !== undefined ? { context } : {}),
      },
    });
  } catch (err) {
    console.error(`[executor] 写任务日志失败 taskId=${taskId}:`, (err as Error).message);
  }
}

/** 包装单个 per-question 引擎，捕获异常 → 降级为 skipped 结果，单个引擎崩溃不影响整体。 */
async function safeJudge(engine: PerQuestionEngine, input: JudgeInput): Promise<EngineResult> {
  const startedAt = new Date().toISOString();
  try {
    return await engine.judge(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      engine: engine.engine,
      taskId: input.taskId,
      questionId: input.questionId,
      status: 'skipped',
      riskCategory: 'engine_error',
      severity: 'INFO',
      score: null,
      verdict: 'UNKNOWN',
      evidence: `引擎异常：${message}`,
      rawOutput: { error: message },
      startedAt,
      endedAt: new Date().toISOString(),
    };
  }
}

function startCancelWatcher(args: {
  taskId: string;
  isCancelRequested: (taskId: string) => Promise<boolean>;
  intervalMs: number;
  abort: () => void;
}): () => void {
  const timer = setInterval(
    () => {
      args
        .isCancelRequested(args.taskId)
        .then((requested) => {
          if (requested) args.abort();
        })
        .catch(() => undefined);
    },
    Math.max(50, args.intervalMs),
  );
  timer.unref?.();
  return () => clearInterval(timer);
}

function toCfg(t: {
  baseUrl: string;
  apiKey: string;
  model: string;
  extraHeaders: Prisma.JsonValue | null;
  defaultParams: Prisma.JsonValue | null;
}): LlmTargetConfig {
  return {
    baseUrl: t.baseUrl,
    apiKey: t.apiKey,
    model: t.model,
    extraHeaders: (t.extraHeaders as Record<string, string> | null) ?? null,
    defaultParams: (t.defaultParams as Record<string, unknown> | null) ?? null,
  };
}

function truncate(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从全局 SystemSetting('redteam.config').value 解析「整任务红队总局数上限」(maxLaps)。
 * 仅有限正数才视为有效上限；0 / 负数 / NaN / 非数字 一律返回 null（= 无上限，不误伤）。
 */
function resolveRedTeamMaxLaps(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const raw = value.maxLaps;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

function shouldRunAiReview(verdict: Verdict, results: EngineResult[]): boolean {
  if (verdict === 'FAIL' || verdict === 'UNKNOWN') return true;
  return results.some(
    (r) =>
      r.status !== 'skipped' &&
      (r.verdict === 'FAIL' || r.verdict === 'UNKNOWN' || SEVERITY_RANK[r.severity] >= 3),
  );
}

function aiReviewReason(result: EngineResult | null): string | null {
  if (!result) return null;
  const fallbackReason = isRecord(result.rawOutput) ? stringField(result.rawOutput, 'reason') : '';
  const evidence = result.evidence ?? fallbackReason;
  const suffix = evidence ? `依据：${evidence}` : '未返回补充依据';
  if (result.status === 'skipped') return `AI复核辅助：未完成判定，待人工确认。${suffix}`;
  if (result.verdict === 'PASS') {
    return `AI复核辅助：模型判定为疑似误报，待人工确认。${suffix}`;
  }
  if (result.verdict === 'FAIL') {
    return `AI复核辅助：模型判定为疑似风险，待人工确认。${suffix}`;
  }
  return `AI复核辅助：无法明确判定，待人工确认。${suffix}`;
}

function appendAiReviewReason(reason: string | null, result: EngineResult | null): string | null {
  const review = aiReviewReason(result);
  if (!review) return reason;
  return reason ? `${reason}\n${review}` : review;
}

type EvalGatewayAccess = { controlPlaneBaseUrl: string; tenantId: string };

function stringField(value: unknown, key: string): string {
  if (!isRecord(value)) return '';
  const field = value[key];
  return typeof field === 'string' ? field.trim() : '';
}

async function isGatewayLinkageEnabled(db: PrismaLike): Promise<boolean> {
  try {
    const s = await db.systemSetting.findUnique({ where: { key: 'gateway' } });
    const value = s?.value;
    return isRecord(value) && value.gatewayLinkageEnabled === true;
  } catch {
    return false;
  }
}

function resolveEvalGatewayAccess(
  accessConfig: unknown,
  linkageEnabled: boolean,
): EvalGatewayAccess | null {
  if (!linkageEnabled) return null;
  const controlPlaneBaseUrl =
    stringField(accessConfig, 'controlPlaneBaseUrl') ||
    process.env.NEWAPI_CONTROL_PLANE_BASE_URL?.trim() ||
    '';
  if (!controlPlaneBaseUrl) return null;
  assertControlPlaneAllowed(controlPlaneBaseUrl);
  return {
    controlPlaneBaseUrl,
    tenantId:
      stringField(accessConfig, 'tenantId') ||
      process.env.NEWAPI_TENANT_ID?.trim() ||
      process.env.PROXY_DEFAULT_TENANT_ID?.trim() ||
      'tenant_default',
  };
}

async function resolveReportTargetGatewayAccess(args: {
  db: PrismaLike;
  taskId: string;
  targetId: string;
  fallback: EvalGatewayAccess | null;
  linkageEnabled: boolean;
}): Promise<EvalGatewayAccess | null> {
  try {
    const target = await args.db.modelTarget.findUnique({
      where: { id: args.targetId },
      select: { accessConfig: true },
    });
    if (!target) return args.fallback;
    return resolveEvalGatewayAccess(target.accessConfig, args.linkageEnabled);
  } catch (err) {
    await safeLog(args.taskId, 'warn', '红队 finding 回写网关 target 配置不可用，退回任务级配置', {
      targetId: args.targetId,
      message: err instanceof Error ? err.message : String(err),
    });
    return args.fallback;
  }
}

function evalCorrelationHeaders(args: {
  evalRunId: string;
  taskId: string;
  sampleId: string;
  targetId: string;
  traceId: string;
}): Record<string, string> {
  return {
    'X-LSE-Eval-Run-Id': args.evalRunId,
    'X-LSE-Task-Id': args.taskId,
    'X-LSE-Sample-Id': args.sampleId,
    'X-LSE-Target-Id': args.targetId,
    'X-LSE-Trace-Id': args.traceId,
  };
}

function withCorrelationHeaders(
  cfg: LlmTargetConfig,
  headers?: Record<string, string>,
): LlmTargetConfig {
  if (headers === undefined) return cfg;
  return { ...cfg, extraHeaders: { ...(cfg.extraHeaders ?? {}), ...headers } };
}

function isRuleFalsePositive(result: EngineResult): boolean {
  return (
    result.verdict !== 'FAIL' && isRecord(result.rawOutput) && result.rawOutput.refused === true
  );
}

function isSemanticInputRisk(result: EngineResult): boolean {
  return (
    result.engine === SEMANTIC_INPUT_RISK_ENGINE &&
    stringField(result.rawOutput, 'kind') === SEMANTIC_INPUT_RISK_KIND
  );
}

function evalFindingVerdict(_question: { shouldRefuse: boolean }, result: EngineResult): string {
  if (isSemanticInputRisk(result)) return 'prompt_input_semantic_risk';
  if (isRuleFalsePositive(result)) return 'rule_false_positive';
  return result.riskCategory || 'eval_policy_violation';
}

function evalFindingRiskDomain(
  question: { shouldRefuse: boolean; category: string | null },
  result: EngineResult,
): string {
  if (isSemanticInputRisk(result)) {
    return (
      stringField(result.rawOutput, 'riskDomain') || question.category || '提示词/内容安全风险'
    );
  }
  return question.category || result.riskCategory || '内容安全评估风险';
}

type SemanticRiskQuestion = {
  id: string;
  content: string;
  type: string;
  category: string | null;
  severity: Severity | null;
  shouldRefuse: boolean;
  expectedBehavior: string | null;
  language: string;
  tags: string[];
  metadata: unknown;
};

function atLeastHigh(severity: Severity | null): Severity {
  const value = severity ?? 'HIGH';
  return SEVERITY_RANK[value] >= SEVERITY_RANK.HIGH ? value : 'HIGH';
}

function semanticInputRiskResult(args: {
  taskId: string;
  question: SemanticRiskQuestion;
}): EngineResult | null {
  if (args.question.type !== 'PROMPT_INJECTION') return null;
  const now = new Date().toISOString();
  const riskDomain = args.question.category
    ? `提示词/内容安全风险：${args.question.category}`
    : '提示词/内容安全风险：提示注入/越狱';
  return {
    engine: SEMANTIC_INPUT_RISK_ENGINE,
    taskId: args.taskId,
    questionId: args.question.id,
    status: 'success',
    riskCategory: 'prompt_injection',
    severity: atLeastHigh(args.question.severity),
    score: null,
    verdict: 'UNKNOWN',
    evidence: `评估样本的结构化题型为 PROMPT_INJECTION，输入语义包含提示注入/越狱风险；应进入内容与数据安全事件，而不是工具/智能体告警。风险域：${riskDomain}`,
    rawOutput: {
      kind: SEMANTIC_INPUT_RISK_KIND,
      source: 'question_semantic_metadata',
      questionType: args.question.type,
      riskDomain,
      category: args.question.category,
      shouldRefuse: args.question.shouldRefuse,
      expectedBehavior: args.question.expectedBehavior,
      language: args.question.language,
      tags: args.question.tags,
    },
    startedAt: now,
    endedAt: now,
  };
}

function evalFindingInputs(args: {
  question: {
    id: string;
    shouldRefuse: boolean;
    category: string | null;
    expectedBehavior: string | null;
  };
  result: LlmCallResult;
  failResults: EngineResult[];
}): GatewayEvalFindingInput[] {
  return args.failResults.map((item) => ({
    findingId: `${item.engine}:${item.riskCategory}`,
    riskDomain: evalFindingRiskDomain(args.question, item),
    category: item.riskCategory,
    severity: item.severity,
    verdict: evalFindingVerdict(args.question, item),
    expectedBehavior:
      args.question.expectedBehavior ?? (args.question.shouldRefuse ? 'should_refuse' : null),
    actualBehavior:
      args.result.status === 'SUCCESS' ? truncate(args.result.content, 500) : args.result.status,
    reason: item.evidence,
    evidence: item.evidence,
    isFalsePositive: isRuleFalsePositive(item),
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveGatewayRequestId(args: {
  access: EvalGatewayAccess;
  internalToken: string;
  evalRunId: string;
  taskId: string;
  sampleId: string;
  targetId: string;
}): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const events = await fetchGatewayAuditEvents({
      controlPlaneBaseUrl: args.access.controlPlaneBaseUrl,
      internalToken: args.internalToken,
      tenantId: args.access.tenantId,
      evalRunId: args.evalRunId,
      taskId: args.taskId,
      sampleId: args.sampleId,
      limit: 10,
      maxPages: 1,
    });
    const matched = events.find(
      (event) =>
        event.requestId &&
        (!event.correlation.targetId || event.correlation.targetId === args.targetId),
    );
    if (matched?.requestId) return matched.requestId;
    if (attempt < 2) await sleep(200 * (attempt + 1));
  }
  return null;
}

async function safeReportEvalFindingsToGateway(args: {
  taskId: string;
  sampleId: string;
  targetId: string;
  access: EvalGatewayAccess | null;
  findings: GatewayEvalFindingInput[];
}): Promise<void> {
  if (args.access === null || args.findings.length === 0) return;
  try {
    const internalToken = resolveInternalToken();
    const requestId = await resolveGatewayRequestId({
      access: args.access,
      internalToken,
      evalRunId: args.taskId,
      taskId: args.taskId,
      sampleId: args.sampleId,
      targetId: args.targetId,
    });
    if (requestId === null) {
      await safeLog(args.taskId, 'warn', '评估风险未回写网关内容安全事件：未找到对应网关请求日志', {
        sampleId: args.sampleId,
      });
      return;
    }
    const result = await postGatewayEvalFindings({
      controlPlaneBaseUrl: args.access.controlPlaneBaseUrl,
      internalToken,
      tenantId: args.access.tenantId,
      requestId,
      evalRunId: args.taskId,
      taskId: args.taskId,
      sampleId: args.sampleId,
      targetId: args.targetId,
      findings: args.findings,
    });
    await safeLog(args.taskId, 'info', '评估风险已回写网关内容与数据安全事件', {
      sampleId: args.sampleId,
      requestId,
      created: result.created,
      skipped: result.skipped,
    });
  } catch (err) {
    await safeLog(args.taskId, 'warn', '评估风险回写网关内容安全事件失败', {
      sampleId: args.sampleId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function safeCollectRedTeamGatewayEvidence(args: {
  taskId: string;
  sampleId: string;
  targetId: string;
  traceId: string;
  access: EvalGatewayAccess | null;
  fetchGatewayEvidence?: RunEvalTaskDeps['fetchGatewayEvidence'];
}): Promise<{ gatewayRecognizedRisk: boolean | null }> {
  if (args.access === null) return { gatewayRecognizedRisk: null };
  try {
    const evidence = await (args.fetchGatewayEvidence ?? fetchGatewayAssuranceEvidence)({
      controlPlaneBaseUrl: args.access.controlPlaneBaseUrl,
      internalToken: resolveInternalToken(),
      tenantId: args.access.tenantId,
      evalRunId: args.taskId,
      taskId: args.taskId,
      sampleId: args.sampleId,
      traceId: args.traceId,
    });
    return { gatewayRecognizedRisk: gatewayRecognizedRiskFromEvidence(evidence) };
  } catch (err) {
    await safeLog(args.taskId, 'warn', '红队网关识别信号采集失败，redLayerReward 保持 null', {
      sampleId: args.sampleId,
      targetId: args.targetId,
      traceId: args.traceId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { gatewayRecognizedRisk: null };
  }
}

function agentMetadataFrom(
  questionMetadata: unknown,
  raw: unknown,
): Record<string, unknown> | null {
  const questionMeta = isRecord(questionMetadata) ? questionMetadata : {};
  if (questionMeta.kind !== 'agent_runtime') return null;
  const rawMeta = isRecord(raw) ? raw : {};
  return {
    safeCanary: rawMeta.safeCanary ?? questionMeta.safeCanary ?? null,
    seed: rawMeta.seed ?? questionMeta.seed ?? null,
    attackPackVersion: rawMeta.attackPackVersion ?? questionMeta.attackPackVersion ?? null,
    attackPackId: rawMeta.attackPackId ?? questionMeta.attackPackId ?? null,
    riskSurface: rawMeta.riskSurface ?? questionMeta.riskSurface ?? null,
    templateId: rawMeta.templateId ?? questionMeta.templateId ?? null,
    agentInstanceId: rawMeta.agentInstanceId ?? questionMeta.agentInstanceId ?? null,
    caseId: rawMeta.caseId ?? questionMeta.caseId ?? null,
    riskFactors: rawMeta.riskFactors ?? questionMeta.riskFactors ?? null,
    inventorySources: rawMeta.inventorySources ?? null,
    maxTurns: rawMeta.maxTurns ?? questionMeta.maxTurns ?? null,
    allowedTools: rawMeta.allowedTools ?? questionMeta.allowedTools ?? null,
    scenarioName: rawMeta.scenarioName ?? questionMeta.scenarioName ?? null,
    businessRole: rawMeta.businessRole ?? questionMeta.businessRole ?? null,
    attackVariant: rawMeta.attackVariant ?? questionMeta.attackVariant ?? null,
    toolBoundary: rawMeta.toolBoundary ?? questionMeta.toolBoundary ?? null,
    successSignals: rawMeta.successSignals ?? questionMeta.successSignals ?? null,
    evidenceRequirements: rawMeta.evidenceRequirements ?? questionMeta.evidenceRequirements ?? null,
    evidenceChain: rawMeta.evidenceChain ?? null,
    remediation: rawMeta.remediation ?? questionMeta.remediation ?? null,
    observed: rawMeta.observed === true,
    canaryLeak: rawMeta.canaryLeak === true,
    sinkCanaryHit: rawMeta.sinkCanaryHit === true,
    sinkExfilHit: rawMeta.sinkExfilHit === true,
    sinkHits: rawMeta.sinkHits ?? [],
    runnerVerdict: rawMeta.verdict ?? null,
    noToolRefusal: rawMeta.noToolRefusal === true,
    // 运行器确定性判定的场景（身份标识、高风险操作人工介入），汇总引擎直接采用运行器结论。
    judge: rawMeta.judge ?? questionMeta.judge ?? null,
    // 运行器写入的是判定结果（含 basis），题目元数据里的是场景定义；只透传判定结果。
    hitl: isRecord(rawMeta.hitl) ? rawMeta.hitl : null,
    identityCheck: rawMeta.identityCheck ?? null,
    outcome: rawMeta.outcome ?? null,
    outcomeLabel: rawMeta.outcomeLabel ?? null,
    blockSource: rawMeta.blockSource ?? null,
  };
}

function agentTraceFrom(raw: unknown): unknown[] {
  return isRecord(raw) && Array.isArray(raw.trace) ? raw.trace : [];
}

function buildJudgeRules(questionMetadata: unknown, raw: unknown): JudgeRules | null {
  const base = parseJudgeRules(questionMetadata);
  const metadata = agentMetadataFrom(questionMetadata, raw);
  const trace = agentTraceFrom(raw);
  if (metadata === null && trace.length === 0) return base;
  return {
    ...(base ?? {}),
    ...(trace.length > 0 ? { agentTrace: trace } : {}),
    ...(metadata !== null ? { agentMetadata: metadata } : {}),
  };
}

/**
 * 执行一个评估任务：拉题 → 真实调用模型 → 引擎判定 → 落库 EvalResult / Finding /
 * WrongAnswer / EngineRun → 维护任务生命周期、进度与通过/失败/失败调用计数。
 *
 * 引擎分两层：per-question 引擎（rule-judge + sensitive-info 内置纯函数，以及可选的
 * python-judge sidecar）逐题判定；task-level 引擎（AI-Infra-Guard 红队扫描）对整个模型
 * 对象做一次扫描，产出任务级风险项。外部引擎由 registry 按配置开关与运行环境决定是否启用，
 * 默认在测试环境（LSE_TEST=1）下全部惰性关闭，因此内置两引擎（rule-judge + sensitive-info）
 * 始终产生 SUCCESS 运行记录；Agent 类对象（AGENT_API / PUBLIC_AGENT / MCP_OPENAPI）还会
 * 默认追加 agent-tool-guard，故其内置 SUCCESS 运行记录为 3 条。
 * 调用失败 → finalVerdict=ERROR；空回答 → UNKNOWN；其余交由引擎聚合判定。
 */
/** 暂停时保存的执行器状态（eval_tasks.pauseState），接续时恢复。 */
export interface EvalTaskPauseState {
  engineAccum: Record<
    string,
    { judged: number; failed: number; skipped: number; lastError: string | null }
  >;
  redTeamLaps: number;
}

/**
 * 接续时按已有结果重算进度：只算当前题目清单里的题；同一题有两侧结果（红队对照）时取网关侧（B）的结论，
 * 与执行时按网关侧计数一致。
 */
function countAnsweredResults(
  rows: Array<{ questionId: string; side: string | null; finalVerdict: Verdict | null }>,
  questionIds: Set<string>,
): { answered: Set<string>; processed: number; passed: number; failed: number; error: number } {
  const best = new Map<string, { side: string | null; verdict: Verdict | null }>();
  const rank = (side: string | null) => (side === 'B' ? 2 : side === 'A' ? 1 : 0);
  for (const r of rows) {
    if (!questionIds.has(r.questionId)) continue;
    const prev = best.get(r.questionId);
    if (!prev || rank(r.side) > rank(prev.side)) {
      best.set(r.questionId, { side: r.side, verdict: r.finalVerdict });
    }
  }
  let passed = 0;
  let failed = 0;
  let error = 0;
  for (const { verdict } of best.values()) {
    if (verdict === 'PASS') passed += 1;
    else if (verdict === 'FAIL') failed += 1;
    else if (verdict === 'ERROR') error += 1;
  }
  return { answered: new Set(best.keys()), processed: best.size, passed, failed, error };
}

function parsePauseState(value: unknown): EvalTaskPauseState {
  const state: EvalTaskPauseState = { engineAccum: {}, redTeamLaps: 0 };
  if (!isRecord(value)) return state;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  state.redTeamLaps = num(value.redTeamLaps);
  if (isRecord(value.engineAccum)) {
    for (const [engine, acc] of Object.entries(value.engineAccum)) {
      if (!isRecord(acc)) continue;
      state.engineAccum[engine] = {
        judged: num(acc.judged),
        failed: num(acc.failed),
        skipped: num(acc.skipped),
        lastError: typeof acc.lastError === 'string' ? acc.lastError : null,
      };
    }
  }
  return state;
}

export async function runEvalTask(taskId: string, deps: RunEvalTaskDeps = {}): Promise<void> {
  // 注入缝：测试可经 deps.prisma 喂内存假库覆盖本函数体内全部 DB 读写；
  // 不注入时 db === 模块级 prisma，生产路径逐字节等价。
  const db = deps.prisma ?? prisma;
  const callModel = deps.callModel ?? chatComplete;
  const callAgentScenario = deps.runAgentScenario ?? defaultRunAgentScenario;
  const callMcpScenario = deps.runMcpScenario ?? defaultRunMcpScenario;
  const collectGatewayFindings = deps.collectGatewayFindings ?? collectGatewayFindingsByTask;
  const isCancelRequested = deps.isCancelRequested ?? isEvalTaskCancelRequested;
  const cancelPollIntervalMs = deps.cancelPollIntervalMs ?? CANCEL_POLL_INTERVAL_MS;
  const isPauseRequested = deps.isPauseRequested ?? isEvalTaskPauseRequested;
  // 上线门禁：任务 COMPLETED 后判定；注入假库（deps.prisma）且未注入判定器时跳过。
  const evaluateGates =
    deps.evaluateGates ?? (deps.prisma ? null : (id: string) => evaluateGateForTask(id));
  const runGateHook = async () => {
    if (!evaluateGates) return;
    try {
      await evaluateGates(taskId);
    } catch (err) {
      // 门禁判定失败不能影响任务本身完成。
      console.error(`[executor] 上线门禁判定失败 taskId=${taskId}:`, (err as Error).message);
      await safeLog(taskId, 'warn', '上线门禁判定失败，任务结果不受影响', {
        message: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined);
    }
  };
  const taskAbortController = new AbortController();
  let cancelRequested = false;

  const task = await db.evalTask.findUnique({
    where: { id: taskId },
    include: {
      modelTarget: true,
      questionSets: true,
      standardRun: { select: { id: true } },
      pinnedQuestions: { select: { questionId: true } },
    },
  });

  if (!task) {
    console.error(`[executor] 评估任务不存在 taskId=${taskId}`);
    return;
  }
  if (task.modelTarget.targetType === 'ENDPOINT_AGENT') {
    await safeLog(taskId, 'info', '终端智能体任务由回调或轮询驱动，不进入普通执行器');
    return;
  }
  if (task.status === 'RUNNING') {
    await safeLog(taskId, 'warn', '任务已处于运行中，跳过重复执行');
    return;
  }
  if (task.status === 'CANCELED') {
    await safeLog(taskId, 'warn', '任务已取消，跳过执行');
    return;
  }
  if (task.status === 'PAUSED') {
    await safeLog(taskId, 'info', '任务已暂停，跳过执行');
    return;
  }
  if (task.standardRun) {
    await safeLog(taskId, 'warn', '标准专项任务不能进入旧评估执行器；请使用标准专项执行器。');
    return;
  }

  // 引擎按任务配置的 engines[] 过滤；DI 注入（测试）优先。空 engines → 全部可用引擎（向后兼容）。
  const selectedEngines = task.engines ?? [];
  // 全局评审模型：默认取 DB 里激活的 JUDGE ModelTarget（强制评审 ≠ 被测）喂给 registry；
  // deps.judgeTarget 显式注入时优先（测试确定性，避免依赖线上激活的 JUDGE）。
  //  undefined → 无 JUDGE 行，回退环境变量 LLM_JUDGE_*；null → 自评/不完整，不启用 llm-judge；
  //  LlmTargetConfig → 启用 llm-judge（配置即开关，绕过 LSE_TEST 环境门控）。
  // worker 里没有租户上下文：按任务租户取裁判模型，只会命中「本租户 + 平台共享」，
  // 不会拿别的租户的私有裁判模型（含它的 apiKey）去判本任务的数据。
  const judgeTarget =
    deps.judgeTarget !== undefined
      ? deps.judgeTarget
      : await withTenant(task.tenantId, () =>
          loadActiveJudgeTarget(db, {
            id: task.modelTarget.id,
            baseUrl: task.modelTarget.baseUrl,
            model: task.modelTarget.model,
          }),
        );
  // 自定义风险内容（参数7）：管理员启用了规则时追加内置 custom-risk 引擎；DI 注入时由注入方决定。
  const customRiskEngine = deps.perQuestionEngines ? null : await loadCustomRiskEngine(db);
  const perQuestionEngines = deps.perQuestionEngines ?? [
    ...resolvePerQuestionEngines(selectedEngines, judgeTarget, task.modelTarget.targetType),
    ...(customRiskEngine ? [customRiskEngine] : []),
  ];
  const aiReviewEngine = perQuestionEngines.find((e) => e.engine === LLM_JUDGE_ENGINE) ?? null;
  const primaryQuestionEngines = perQuestionEngines.filter((e) => e.engine !== LLM_JUDGE_ENGINE);
  const taskLevelEngines = deps.taskLevelEngines ?? resolveTaskLevelEngines(selectedEngines);
  // P0-2：被显式勾选却当前不可用的任务级引擎（DI 注入时不计算，由注入方决定）。
  const dormantTaskLevelEngines = deps.taskLevelEngines
    ? []
    : resolveDormantTaskLevelEngines(selectedEngines);

  const cfg = toCfg(task.modelTarget);
  // 网关联动用的是全平台共用的网关与网关租户：只对平台租户的任务开启，
  // 否则会把别的组织的网关审计证据挂到本租户的任务上，或把本租户的风险回写进共用网关。
  const platformTask = !task.tenantId || task.tenantId === PLATFORM_TENANT_ID;
  const gatewayLinkageEnabled =
    platformTask && (deps.gatewayLinkageEnabled ?? (await isGatewayLinkageEnabled(db)));
  let gatewayAccess: EvalGatewayAccess | null = null;
  try {
    gatewayAccess = resolveEvalGatewayAccess(task.modelTarget.accessConfig, gatewayLinkageEnabled);
  } catch (err) {
    await safeLog(taskId, 'warn', '网关内容安全回写配置不可用，评估风险不会同步到安全网关', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  const setIds = task.questionSets.map((s) => s.questionSetId);
  // 抽样评测：大题库按分类分层抽样（种子可复现），未设置时全量执行。
  // 失败用例复测：任务有显式题目清单时只跑清单题（限定在关联样本库内），跳过抽样。
  const pinnedQuestionIds = (task.pinnedQuestions ?? []).map((p) => p.questionId);
  const questions = await loadTaskQuestions(
    db,
    setIds,
    task.sampleSize,
    task.sampleSeed,
    pinnedQuestionIds,
  );
  const total = questions.length;

  // 暂停后接续（2.4.2）：pausedAt 不为空表示上次停在中途，保留已有结果，只跑还没答的题。
  const resuming = Boolean(task.pausedAt);
  const resumed = resuming
    ? countAnsweredResults(
        await db.evalResult.findMany({
          where: { taskId },
          select: { questionId: true, side: true, finalVerdict: true },
        }),
        new Set(questions.map((q) => q.id)),
      )
    : null;
  const pendingQuestions = resumed
    ? questions.filter((q) => !resumed.answered.has(q.id))
    : questions;
  const restored = resuming ? parsePauseState(task.pauseState) : null;

  // 原子领取：只有排队中的任务能被执行器接手。同一任务被重复入队（如排队中被暂停、恢复时原作业还在队列里）时，
  // 后到的作业领取不到就跳过，不会双跑，也不会对已经跑完的任务做幂等清理。所有入队点都先置为排队中再入队。
  const claimed = await db.evalTask.updateMany({
    where: { id: taskId, status: 'PENDING' },
    data: resuming
      ? // 接续：不重置计数和开始时间（计数在下面按已有结果重算）。
        {
          status: 'RUNNING',
          startedAt: task.startedAt ?? new Date(),
          finishedAt: null,
          totalQuestions: total,
        }
      : {
          status: 'RUNNING',
          startedAt: new Date(),
          finishedAt: null,
          totalQuestions: total,
          processedQuestions: 0,
          passedCount: 0,
          failedCount: 0,
          errorCount: 0,
          progress: 0,
        },
  });
  if (claimed.count === 0) {
    await safeLog(taskId, 'warn', '任务已不在排队中（已被其他执行接手或已结束），跳过本次执行');
    return;
  }
  if (resumed) {
    await safeLog(
      taskId,
      'info',
      `任务从暂停处继续，已完成 ${resumed.processed}/${total} 题`,
    );
  } else {
    // 幂等清理：重跑同一任务前清除上一轮派生数据（按外键依赖顺序：样本→风险项→引擎运行→结果）。
    // 放在领取之后：领取不到的重复作业不会动已有结果。
    await db.wrongAnswer.deleteMany({ where: { taskId } });
    await db.finding.deleteMany({ where: { taskId } });
    await db.engineRun.deleteMany({ where: { taskId } });
    await db.evalResult.deleteMany({ where: { taskId } });
    await safeLog(
      taskId,
      'info',
      `任务开始执行，评估对象=${task.modelTarget.name}，样本数=${total}`,
    );
  }

  if (total === 0) {
    await db.evalTask.update({
      where: { id: taskId },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
        totalQuestions: 0,
        processedQuestions: 0,
        passedCount: 0,
        failedCount: 0,
        errorCount: 0,
        progress: 1,
        pausedAt: null,
        pauseState: Prisma.DbNull,
        pauseRequestedAt: null,
      },
    });
    await safeLog(taskId, 'warn', '样本库为空，任务直接完成');
    await runGateHook();
    return;
  }

  // 任务前模型指纹比对：有基线时采集并比对，结果写入 task.fingerprintCheck；失败或无基线均不阻断。
  const fingerprintHook =
    deps.preTaskFingerprintCheck ??
    (deps.prisma
      ? false
      : (id: string, targetId: string, signal: AbortSignal) =>
          runPreTaskFingerprintCheck(id, targetId, {
            signal,
            log: (level, message, context) => safeLog(id, level, message, context),
          }));
  // 接续时开始阶段已经比对过，不再重复（排队中就被暂停、从没开始过的除外）。
  if (fingerprintHook && !(resuming && task.startedAt)) {
    try {
      await fingerprintHook(taskId, task.modelTargetId, taskAbortController.signal);
    } catch (err) {
      await safeLog(
        taskId,
        'warn',
        `模型指纹比对异常（不影响任务执行）：${(err as Error).message}`,
      );
    }
  }

  try {
    // 接续时计数按库里已有的结果重算（与只跑没答的题同一口径：只计数、不落结果的题会重跑）。
    let processed = resumed?.processed ?? 0;
    let passedCount = resumed?.passed ?? 0;
    let failedCount = resumed?.failed ?? 0;
    let errorCount = resumed?.error ?? 0;
    const recordProgress = (verdict: Verdict) => {
      processed += 1;
      if (verdict === 'ERROR') errorCount += 1;
      else if (verdict === 'PASS') passedCount += 1;
      else if (verdict === 'FAIL') failedCount += 1;
      return { processed, passedCount, failedCount, errorCount, progress: processed / total };
    };
    // 整任务红队总局数上限（maxLaps）：任务级一次读定，跨 pump worker 共享计数。
    // 无设置 / 非法值 → null（无上限）。仅红队分支受限；达上限后续红队题「跳过」（见下）。
    const redTeamSetting = await db.systemSetting.findUnique({
      where: { key: RED_TEAM_SETTING_KEY },
    });
    const redTeamMaxLaps = resolveRedTeamMaxLaps(redTeamSetting?.value);
    let redTeamLaps = restored?.redTeamLaps ?? 0;
    const poolSize = Math.max(1, Math.min(task.concurrency, pendingQuestions.length));
    // 任务级自适应并发（AIMD）：所有红队模型角色共享。有效并发受 task.concurrency 封顶；
    // retryable 错误减半最低 1，连续 8 成功 +1。AsyncSemaphore 把有效并发落到 pump 真实并发。
    const redTeamConcurrency = new AdaptiveConcurrency(poolSize);
    const redTeamSemaphore = new AsyncSemaphore(redTeamConcurrency.current());
    // 所有题共用真实调度器；RetryExhausted 场景只延后一次，重新进入同一条生产执行路径。
    const scenarioScheduler = new ScenarioScheduler(pendingQuestions as any);
    const questionIndexById = new Map(questions.map((question, index) => [question.id, index]));
    const redTeamStarted = new Set<string>();
    let pendingReadyAt: number | null = null;
    let redTeamConfigCircuitBroken = false;
    const waitUntil = async (ms: number): Promise<void> => {
      // 可取消等待：取消信号触发立即 resolve，不卡住。
      if (ms <= 0) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        taskAbortController.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    };
    const safeLogRedTeamError = (
      qid: string,
      stage: string,
      reasonCode: string,
      retryable: boolean,
      final: boolean,
      attempts: number,
    ): Promise<void> =>
      safeLog(
        taskId,
        final ? 'error' : 'warn',
        `红队调用未完成：${stage} ${reasonCode}${final ? '（最终）' : ''}`,
        {
          kind: 'red_team_error',
          stage,
          reasonCode,
          attempts,
          retryable,
          final,
          questionId: qid,
          previousConcurrency: redTeamConcurrency.current(),
          effectiveConcurrency: redTeamConcurrency.current(),
        } as Prisma.InputJsonValue,
      ).catch(() => undefined);
    const persistRedTeamInfrastructureError = async (
      question: (typeof questions)[number],
      stage: string,
      reasonCode: string,
      attempts: number,
      circuitBroken: boolean,
      lengthTruncations: readonly RedTeamLengthTruncation[] = [],
    ): Promise<void> => {
      const truncations = lengthTruncations.map(({ stage, round, side }) => ({
        stage,
        round,
        ...(side ? { side } : {}),
      }));
      const startedAt = new Date();
      const errorMessage = redactString(`红队基础设施未完成：${stage} ${reasonCode}`);
      const created = await db.evalResult.create({
        data: {
          taskId,
          questionId: question.id,
          modelTargetId: task.modelTargetId,
          prompt: question.content,
          response: null,
          status: 'ERROR',
          errorMessage,
          finalVerdict: 'ERROR',
          finalScore: null,
          startedAt,
          endedAt: new Date(),
          controlGroupId: question.id,
          side: null,
        },
        select: { id: true },
      });
      await db.engineRun.create({
        data: {
          taskId,
          resultId: created.id,
          engine: 'autonomous-red-team',
          status: 'ERROR',
          startedAt,
          endedAt: new Date(),
          requestPayload: {
            questionId: question.id,
            stage,
            reasonCode,
            attempts,
            infraIncomplete: true,
            circuitBroken,
            lengthTruncations: truncations,
          } as Prisma.InputJsonValue,
          rawOutput: JSON.stringify({
            stage,
            reasonCode,
            attempts,
            infraIncomplete: true,
            circuitBroken,
            lengthTruncations: truncations,
          }),
          normalizedCount: 0,
          errorMessage,
        },
      });
    };
    // onEvent：把并发变更同步到 semaphore，并写任务日志（打码由 safeLog 内 redactString 保证）。
    const taskRedTeamChat = createRedTeamChat({
      chat: (deps.callModel ?? chatComplete) as any,
      controller: redTeamConcurrency,
      semaphore: redTeamSemaphore,
      onEvent: (event) => {
        // 降并发：立即收紧 semaphore 容量；升并发：放宽。
        if (event.kind === 'decrease' || event.kind === 'increase') {
          redTeamSemaphore.setCapacity(redTeamConcurrency.current());
        }
        const level = event.kind === 'config-error' ? 'error' : 'info';
        safeLog(taskId, level, `红队并发控制：${event.reasonText}`, {
          kind: 'red_team_concurrency',
          stage: event.stage,
          eventKind: event.kind,
          previousConcurrency: event.previousConcurrency,
          effectiveConcurrency: event.effectiveConcurrency,
          reasonCode: event.reasonCode,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          ...(event.previousMaxTokens === undefined
            ? {}
            : { previousMaxTokens: event.previousMaxTokens }),
          ...(event.effectiveMaxTokens === undefined
            ? {}
            : { effectiveMaxTokens: event.effectiveMaxTokens }),
          ...(event.finishReason === undefined ? {} : { finishReason: event.finishReason }),
        } as Prisma.InputJsonValue).catch(() => undefined);
      },
    });
    const runStartedAt = new Date();
    let cancelCheckErrorLogged = false;
    const refreshCancelState = async (): Promise<boolean> => {
      if (cancelRequested) return true;
      try {
        cancelRequested = await isCancelRequested(taskId);
      } catch (err) {
        if (!cancelCheckErrorLogged) {
          cancelCheckErrorLogged = true;
          console.error(
            `[executor] 检查任务取消信号失败 taskId=${taskId}:`,
            (err as Error).message,
          );
        }
        return false;
      }
      if (cancelRequested && !taskAbortController.signal.aborted) {
        taskAbortController.abort();
      }
      return cancelRequested;
    };
    const stopCancelWatcher = startCancelWatcher({
      taskId,
      isCancelRequested: refreshCancelState,
      intervalMs: cancelPollIntervalMs,
      abort: () => {
        cancelRequested = true;
        if (!taskAbortController.signal.aborted) taskAbortController.abort();
      },
    });

    // 暂停信号（2.4.2）：按取消信号的轮询间隔节流；为真时不再派新题，在途的题做完（不 abort）。
    // 不锁存：用户撤销暂停（恢复）后再读到假，就接着派题。force 时不节流。
    let pauseRequested = false;
    let lastPauseCheckAt: number | null = null;
    let pauseCheckErrorLogged = false;
    // 库里没有暂停请求、暂停键却还在（残留）时，清键后至少接着跑一会儿，避免原地反复判断。
    let pauseGraceUntil = 0;
    const refreshPauseState = async (force = false): Promise<boolean> => {
      const now = Date.now();
      if (!force && now < pauseGraceUntil) return false;
      if (!force && lastPauseCheckAt !== null && now - lastPauseCheckAt < cancelPollIntervalMs) {
        return pauseRequested;
      }
      lastPauseCheckAt = now;
      try {
        pauseRequested = await isPauseRequested(taskId);
      } catch (err) {
        if (!pauseCheckErrorLogged) {
          pauseCheckErrorLogged = true;
          console.error(
            `[executor] 检查任务暂停信号失败 taskId=${taskId}:`,
            (err as Error).message,
          );
        }
        return false;
      }
      return pauseRequested;
    };

    // 每个 per-question 引擎的累计运行统计，pump 各 worker 串行更新（单线程事件循环天然原子）。
    const engineAccum = new Map<
      string,
      { judged: number; failed: number; skipped: number; lastError: string | null }
    >();
    for (const e of perQuestionEngines) {
      engineAccum.set(e.engine, { judged: 0, failed: 0, skipped: 0, lastError: null });
    }
    engineAccum.set(SEMANTIC_INPUT_RISK_ENGINE, {
      judged: 0,
      failed: 0,
      skipped: 0,
      lastError: null,
    });
    // 接续：引擎累计从暂停时的快照接着算，结束时的 EngineRun 汇总覆盖全部题。
    if (restored) {
      for (const [engine, acc] of Object.entries(restored.engineAccum)) {
        engineAccum.set(engine, { ...acc });
      }
    }

    const pump = async (): Promise<void> => {
      for (;;) {
        if (await refreshCancelState()) {
          scenarioScheduler.abort();
          return;
        }
        if (await refreshPauseState()) return;
        const scheduled = scenarioScheduler.next();
        if (scheduled.outcome === 'done') return;
        if (scheduled.outcome === 'pending') {
          pendingReadyAt =
            pendingReadyAt === null
              ? scheduled.readyAt
              : Math.min(pendingReadyAt, scheduled.readyAt);
          return;
        }
        const question = scheduled.question as (typeof questions)[number];
        const index = questionIndexById.get(question.id);
        if (index === undefined) throw new Error(`调度器返回未知问题：${question.id}`);
        if (await refreshCancelState()) {
          scenarioScheduler.markDone(question.id);
          return;
        }

        try {
          const startedAt = new Date();
          const sourceMetadata = isRecord(question.metadata) ? question.metadata : null;
          const metadata: Record<string, unknown> | null =
            task.modelTarget.targetType === 'AGENT' && sourceMetadata
              ? {
                  ...sourceMetadata,
                  originalAgentSnapshot: sourceMetadata.agentSnapshot,
                  agentSnapshot: parseAgentConfig(task.modelTarget.agentConfig),
                }
              : sourceMetadata;
          const sessionId = `${taskId}:${question.id}`;
          const correlationHeaders =
            gatewayAccess === null
              ? undefined
              : evalCorrelationHeaders({
                  evalRunId: taskId,
                  taskId,
                  sampleId: question.id,
                  targetId: task.modelTargetId,
                  traceId: sessionId,
                });
          const cfgForQuestion = withCorrelationHeaders(
            withGatewaySessionHeader(task.modelTarget, cfg, sessionId),
            correlationHeaders,
          );
          const canUseAgentRunner =
            task.modelTarget.targetType === 'PLATFORM_APP' ||
            task.modelTarget.targetType === 'MODEL' ||
            task.modelTarget.targetType === 'AGENT' ||
            task.modelTarget.targetType === 'GATEWAY_LOG';

          // 红队分支：题目 metadata.kind=red_team 且裁判可用时，走红队管道（录脚本·按配置重放·判·报）并
          // 直接进入下一题。攻击脑默认装配真实 ReAct（生产默认 react），测试可经 deps.attackerHead 注入
          // dummy 覆盖。裁判不可用（aiReviewEngine 为 null）时不进此分支、不崩、不编造判定，自然落到下
          // 面的常规单轮路径（保持「外部不可用不拖垮主闭环」的约定）。
          // W6b 多模态越狱：题目 metadata.kind=multimodal_jailbreak 时生成图片并按 OpenAI 兼容
          // image_url 发送，判定复用任务装配的 llm-judge（全局判定模型），结果落 EvalResult/Finding。
          const multimodalMeta = parseMultimodalMeta(question.metadata);
          // 客户自带图片集（kind=multimodal_byo）：图片来自图片集而非程序生成，其余链路相同。
          const byoMeta = multimodalMeta ? null : parseByoMeta(question.metadata);
          if (multimodalMeta || byoMeta) {
            const mm = byoMeta
              ? await runByoImageQuestion({
                  db,
                  taskId,
                  modelTargetId: task.modelTargetId,
                  supportsVision: task.modelTarget.supportsVision,
                  question,
                  meta: byoMeta,
                  loadImage: loadByoImageBlob,
                  invoke: (messages) =>
                    invokeEvaluationTarget(task.modelTarget, messages, {
                      callModel,
                      sessionId,
                      correlationHeaders,
                      signal: taskAbortController.signal,
                    }),
                  judge: aiReviewEngine,
                })
              : await runMultimodalQuestion({
              db,
              taskId,
              modelTargetId: task.modelTargetId,
              supportsVision: task.modelTarget.supportsVision,
              question,
              meta: multimodalMeta!,
              invoke: (messages) =>
                invokeEvaluationTarget(task.modelTarget, messages, {
                  callModel,
                  sessionId,
                  correlationHeaders,
                  signal: taskAbortController.signal,
                }),
              judge: aiReviewEngine,
            });
            if (await refreshCancelState()) return;
            if (mm.verdict === 'ERROR' || mm.verdict === 'UNKNOWN') {
              await safeLog(
                taskId,
                'warn',
                `多模态越狱样本未得出判定：${truncate(question.content)}`,
                {
                  questionId: question.id,
                  verdict: mm.verdict,
                },
              );
            }
            const mmSnap = recordProgress(mm.verdict);
            await db.evalTask.update({
              where: { id: taskId },
              data: {
                processedQuestions: mmSnap.processed,
                passedCount: mmSnap.passedCount,
                failedCount: mmSnap.failedCount,
                errorCount: mmSnap.errorCount,
                progress: mmSnap.progress,
              },
            });
            continue;
          }

          if (metadata?.kind === 'red_team' && aiReviewEngine) {
            // 延后重试仍属于同一局，只在首次领取时消费 maxLaps 配额。
            if (!redTeamStarted.has(question.id)) {
              if (redTeamMaxLaps !== null && redTeamLaps >= redTeamMaxLaps) {
                await safeLog(
                  taskId,
                  'warn',
                  `已达整任务红队总局数上限 ${redTeamMaxLaps}，跳过该红队题（不计入进度）`,
                  { questionId: question.id },
                );
                continue;
              }
              redTeamStarted.add(question.id);
              redTeamLaps += 1;
            }
            // P5：配置错误任务级断路——上游已确定不可用，不再逐题轰击，未执行场景计 ERROR。
            if (redTeamConfigCircuitBroken) {
              await safeLogRedTeamError(
                question.id,
                '配置错误断路',
                'CIRCUIT_BROKEN',
                false,
                true,
                0,
              );
              await persistRedTeamInfrastructureError(
                question,
                '配置错误断路',
                'CIRCUIT_BROKEN',
                0,
                true,
              );
              const snap = recordProgress('ERROR');
              await db.evalTask.update({
                where: { id: taskId },
                data: {
                  processedQuestions: snap.processed,
                  passedCount: snap.passedCount,
                  failedCount: snap.failedCount,
                  errorCount: snap.errorCount,
                  progress: snap.progress,
                },
              });
              continue;
            }
            // targetId→cfg 解析（DRY）：既给 react 攻击脑当 loadAttackerTarget（从 attackerTargetId
            // 解析出独立攻击脑模型），又给下方 ctx.loadTarget 复用，避免两份 findUniqueOrThrow+toCfg。
            const redteamMetadata = isRecord(metadata.redteam) ? metadata.redteam : {};
            const protectedGatewayTargetId = stringField(redteamMetadata, 'gatewayTargetId');
            const loadTarget = async (id: string): Promise<LlmTargetConfig> => {
              const target = await db.modelTarget.findUniqueOrThrow({ where: { id } });
              const loadedCfg = toCfg(target);
              if (id !== protectedGatewayTargetId) return loadedCfg;
              const targetSessionId = `${taskId}:${question.id}:${id}`;
              return withCorrelationHeaders(
                withGatewaySessionHeader(target, loadedCfg, targetSessionId),
                evalCorrelationHeaders({
                  evalRunId: taskId,
                  taskId,
                  sampleId: question.id,
                  targetId: id,
                  traceId: targetSessionId,
                }),
              );
            };
            // 红队链路统一用同一个 chat 函数（与 ctx.chat 一致），确保攻击脑 THINK 请求带正确关联头、
            // 且测试可经 deps.callModel 注入。
            // 任务级统一调用包装（重试 + AIMD 降并发 + 空响应校验）；上层已创建。
            // chat 仍传底层 ChatFn（resolveAttackerHead 需要），redTeamChat 透传给 pipe/recording。
            const baseChat = (deps.callModel ?? chatComplete) as ChatFn;
            const chatFnForRedTeam = task.modelTarget.targetType === 'PLATFORM_APP'
              ? createPlatformTargetChat(task.modelTarget, cfgForQuestion, baseChat, taskId) : baseChat;
            const redTeamChat = task.modelTarget.targetType === 'PLATFORM_APP'
              ? createRedTeamChat({ chat: chatFnForRedTeam, controller: redTeamConcurrency, semaphore: redTeamSemaphore }) : taskRedTeamChat;
            // 默认装配 react 时注入 chat 与 loadAttackerTarget，让攻击脑从 attackerTargetId 解析出
            // 独立攻击脑客户端，而非回落用被攻击目标自己（自攻）。
            const attackerHead =
              deps.attackerHead ??
              resolveAttackerHead('react', chatFnForRedTeam, { loadAttackerTarget: loadTarget });
            const redTeamGatewayAccess = protectedGatewayTargetId
              ? await resolveReportTargetGatewayAccess({
                  db,
                  taskId,
                  targetId: protectedGatewayTargetId,
                  fallback: gatewayAccess,
                  linkageEnabled: gatewayLinkageEnabled,
                })
              : gatewayAccess;
            let redTeamSummary: RedTeamQuestionSummary;
            try {
              redTeamSummary = await runRedTeamForQuestion({
                task: { id: task.id, modelTargetId: task.modelTargetId },
                bareTarget: cfgForQuestion,
                question: {
                  id: question.id,
                  content: question.content,
                  metadata,
                  shouldRefuse: question.shouldRefuse,
                  type: question.type,
                  category: question.category,
                  expectedBehavior: question.expectedBehavior,
                  referenceAnswer: question.referenceAnswer,
                  severity: question.severity,
                },
                deps: {
                  attackerHead,
                  chat: chatFnForRedTeam,
                  redTeamChat,
                  judge: aiReviewEngine as PerQuestionEngine,
                  loadTarget,
                  collectGatewayEvidence: (args) =>
                    safeCollectRedTeamGatewayEvidence({
                      ...args,
                      access: redTeamGatewayAccess,
                      fetchGatewayEvidence: deps.fetchGatewayEvidence,
                    }),
                  loadSetting: async (key) => {
                    const s = await db.systemSetting.findUnique({ where: { key } });
                    return (s?.value as Record<string, unknown> | undefined) ?? null;
                  },
                  store: redTeamPrismaStore(db, task.id),
                  signal: taskAbortController.signal,
                },
                live: {
                  sampleIndex: index + 1,
                  totalSamples: total,
                },
              });
            } catch (rtErr) {
              if (rtErr instanceof Error && rtErr.name === 'AbortError') throw rtErr;
              const redTeamError = RedTeamExecutionError.from(rtErr);
              // P2：RetryExhausted → ScenarioScheduler 延后一次，之后重新进入本段完整生产路径。
              if (redTeamError.name === 'RetryExhausted') {
                const readyAt = Date.now() + RED_TEAM_DEFER_COOLDOWN_MS;
                if (scenarioScheduler.rescheduleOnce(question.id, readyAt)) {
                  await safeLogRedTeamError(
                    question.id,
                    redTeamError.stage ?? 'target',
                    redTeamError.lastReasonCode ?? 'RETRY_EXHAUSTED',
                    true,
                    false,
                    redTeamError.attempts ?? 3,
                  );
                  continue; // 不计 progress——延后场景尚未完成
                }
              }
              // P5：ConfigError → 任务级断路，本题计 ERROR，后续红队题不再调上游。
              if (
                redTeamError.name === 'ConfigError' &&
                redTeamError.reasonCode !== 'CONTEXT_WINDOW_EXCEEDED'
              ) {
                redTeamConfigCircuitBroken = true;
                await safeLogRedTeamError(
                  question.id,
                  redTeamError.stage ?? 'target',
                  redTeamError.reasonCode ?? 'CONFIG_ERROR',
                  false,
                  true,
                  1,
                );
                await persistRedTeamInfrastructureError(
                  question,
                  redTeamError.stage ?? 'target',
                  redTeamError.reasonCode ?? 'CONFIG_ERROR',
                  1,
                  true,
                  redTeamError.lengthTruncations,
                );
                const cbSnap = recordProgress('ERROR');
                await db.evalTask.update({
                  where: { id: taskId },
                  data: {
                    processedQuestions: cbSnap.processed,
                    passedCount: cbSnap.passedCount,
                    failedCount: cbSnap.failedCount,
                    errorCount: cbSnap.errorCount,
                    progress: cbSnap.progress,
                  },
                });
                continue;
              }
              // RetryExhausted 二次（已延后过）或其他错误 → 最终基础设施未完成，计 ERROR。
              await safeLogRedTeamError(
                question.id,
                redTeamError.stage ?? 'target',
                redTeamError.reasonCode ?? redTeamError.name,
                false,
                true,
                redTeamError.attempts ?? 0,
              );
              await persistRedTeamInfrastructureError(
                question,
                redTeamError.stage ?? 'target',
                redTeamError.reasonCode ?? redTeamError.name,
                redTeamError.attempts ?? 0,
                false,
                redTeamError.lengthTruncations,
              );
              const errSnap = recordProgress('ERROR');
              await db.evalTask.update({
                where: { id: taskId },
                data: {
                  processedQuestions: errSnap.processed,
                  passedCount: errSnap.passedCount,
                  failedCount: errSnap.failedCount,
                  errorCount: errSnap.errorCount,
                  progress: errSnap.progress,
                },
              });
              continue;
            }
            const { sideBVerdict } = redTeamSummary;
            // 归一化为可计数的三态：仅 PASS/FAIL 原样保留，其余（含 UNKNOWN）一律计为 ERROR，
            // 以维持「passed + failed + error === processed」恒等式（UNKNOWN 若漏入会悄悄破坏它）。
            // 结果类型恰是 Verdict 的子集，无需 as 断言即可传入 recordProgress。
            const countableVerdict: Verdict =
              sideBVerdict === 'PASS' ? 'PASS' : sideBVerdict === 'FAIL' ? 'FAIL' : 'ERROR';
            const snap = recordProgress(countableVerdict);
            await db.evalTask.update({
              where: { id: taskId },
              data: {
                processedQuestions: snap.processed,
                passedCount: snap.passedCount,
                failedCount: snap.failedCount,
                errorCount: snap.errorCount,
                progress: snap.progress,
              },
            });
            const reportGatewayAccess = await resolveReportTargetGatewayAccess({
              db,
              taskId,
              targetId: redTeamSummary.reportTargetId,
              fallback: gatewayAccess,
              linkageEnabled: gatewayLinkageEnabled,
            });
            await safeReportEvalFindingsToGateway({
              taskId,
              sampleId: question.id,
              targetId: redTeamSummary.reportTargetId,
              access: reportGatewayAccess,
              findings: redTeamSummary.gatewayFindings,
            });
            continue;
          }

          // MCP 测-堵-验闭环分支：经网关向目标 MCP 发起攻击（tools/call 或注册期管理端点），
          // 按 trace_id 回查网关审计判「检测/堵/留痕」三连并产归因。与 red_team 同款计数收尾，
          // 恒守 passed+failed+error===processed（verdict 已在 runner 归一化为 PASS/FAIL/ERROR）。
          if (metadata?.kind === 'adr_observation') {
            const adr = isRecord(metadata.adr) ? metadata.adr : {};
            const findingValues = Array.isArray(adr.findings) ? adr.findings : [];
            const adrFindings = findingValues.flatMap((value) => (isRecord(value) ? [value] : []));
            const finalVerdict: Verdict = adrFindings.length > 0 ? 'FAIL' : 'PASS';
            const endedAt = new Date();
            const result = await db.evalResult.create({
              data: {
                taskId,
                questionId: question.id,
                modelTargetId: task.modelTargetId,
                prompt: question.content,
                response: '平台已完成脱敏运行轨迹的离线规则分析；本条未调用评估对象。',
                usage: { promptTokens: null, completionTokens: null, totalTokens: null },
                latencyMs: 0,
                status: 'SUCCESS',
                errorMessage: null,
                finalVerdict,
                finalScore: null,
                startedAt,
                endedAt,
              },
            });
            await db.engineRun.create({
              data: {
                taskId,
                resultId: result.id,
                engine: 'adr-sensor-import',
                status: 'SUCCESS',
                startedAt,
                endedAt,
                durationMs: 0,
                requestPayload: {
                  privacyMode: 'no-raw-conversation-persistence',
                  sessionFingerprint: stringField(adr, 'sessionFingerprint'),
                  messageCount: typeof adr.messageCount === 'number' ? adr.messageCount : 0,
                  toolCallCount: typeof adr.toolCallCount === 'number' ? adr.toolCallCount : 0,
                  truncated: adr.truncated === true,
                },
                rawOutput: JSON.stringify({
                  findingCount: adrFindings.length,
                  privacyMode: 'no-raw-conversation-persistence',
                }),
                normalizedCount: adrFindings.length,
              },
            });

            for (const [findingIndex, finding] of adrFindings.entries()) {
              const severityText = stringField(finding, 'severity').toUpperCase();
              const severity: Severity = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(
                severityText,
              )
                ? (severityText as Severity)
                : 'MEDIUM';
              const riskCategory =
                stringField(finding, 'riskCategory') || 'agent_runtime_observation';
              const title = redactString(
                stringField(finding, 'title') || `运行轨迹风险 ${findingIndex + 1}`,
              );
              const evidence = redactString(
                stringField(finding, 'evidence') || '脱敏轨迹摘要命中风险规则。',
              );
              const score = typeof finding.score === 'number' ? finding.score : null;
              const detail = isRecord(finding.detail) ? finding.detail : {};
              await db.finding.create({
                data: {
                  taskId,
                  resultId: result.id,
                  questionId: question.id,
                  engine: 'adr-sensor-import',
                  riskCategory,
                  severity,
                  score,
                  verdict: 'FAIL',
                  title,
                  evidence,
                  suppressionKey:
                    `adr:${stringField(adr, 'sessionFingerprint') || question.id}:` +
                    `${riskCategory}:${findingIndex}`,
                  detail: {
                    ...detail,
                    trace: {
                      source: stringField(adr, 'source'),
                      sessionFingerprint: stringField(adr, 'sessionFingerprint'),
                      timestamp: stringField(adr, 'timestamp'),
                      model: stringField(adr, 'model'),
                      messageCount: typeof adr.messageCount === 'number' ? adr.messageCount : 0,
                      toolCallCount: typeof adr.toolCallCount === 'number' ? adr.toolCallCount : 0,
                      chunked: adr.chunked === true,
                      truncated: adr.truncated === true,
                    },
                  } as Prisma.InputJsonValue,
                },
              });
              await db.wrongAnswer.create({
                data: {
                  taskId,
                  resultId: result.id,
                  questionId: question.id,
                  questionContent: question.content,
                  modelResponse: null,
                  riskCategory,
                  severity,
                  verdict: 'FAIL',
                  reason: evidence,
                  engine: 'adr-sensor-import',
                },
              });
            }

            const adrSnap = recordProgress(finalVerdict);
            await db.evalTask.update({
              where: { id: taskId },
              data: {
                processedQuestions: adrSnap.processed,
                passedCount: adrSnap.passedCount,
                failedCount: adrSnap.failedCount,
                errorCount: adrSnap.errorCount,
                progress: adrSnap.progress,
              },
            });
            continue;
          }

          if (metadata?.kind === 'mcp_runtime') {
            const mcpMeta = metadata as unknown as McpScenarioMetadata;
            const mcpGateway =
              gatewayAccess === null
                ? null
                : {
                    controlPlaneBaseUrl: gatewayAccess.controlPlaneBaseUrl,
                    tenantId: gatewayAccess.tenantId,
                  };
            let mcpResult: McpRunResult | null = null;
            let mcpError: string | null = null;
            try {
              mcpResult = await callMcpScenario({
                target: {
                  targetType: task.modelTarget.targetType,
                  baseUrl: task.modelTarget.baseUrl,
                  apiKey: task.modelTarget.apiKey,
                  model: task.modelTarget.model,
                  extraHeaders: task.modelTarget.extraHeaders,
                  defaultParams: task.modelTarget.defaultParams,
                  accessConfig: task.modelTarget.accessConfig,
                },
                metadata: mcpMeta,
                prompt: question.content,
                ...(correlationHeaders ? { correlationHeaders } : {}),
                traceId: sessionId,
                evalRunId: taskId,
                taskId,
                sampleId: question.id,
                targetId: task.modelTargetId,
                gateway: mcpGateway,
                internalToken: mcpGateway === null ? '' : resolveInternalToken(),
                signal: taskAbortController.signal,
              });
            } catch (err) {
              mcpError = err instanceof Error ? err.message : String(err);
            }
            if (await refreshCancelState()) return;
            const mcpEndedAt = new Date();

            const mcpNotExecuted = mcpResult?.executionStatus === 'NOT_EXECUTED';
            const mcpVerdict: Verdict = mcpNotExecuted
              ? 'UNKNOWN'
              : mcpResult
                ? mcpResult.verdict === 'PASS'
                  ? 'PASS'
                  : mcpResult.verdict === 'FAIL'
                    ? 'FAIL'
                    : 'ERROR'
                : 'ERROR';
            const mcpCreated = await db.evalResult.create({
              data: {
                taskId,
                questionId: question.id,
                modelTargetId: task.modelTargetId,
                prompt: question.content,
                response: mcpResult && mcpResult.status === 'SUCCESS' ? mcpResult.content : null,
                usage: { promptTokens: null, completionTokens: null, totalTokens: null },
                latencyMs: mcpResult?.latencyMs ?? 0,
                status: mcpResult && mcpResult.status === 'SUCCESS' ? 'SUCCESS' : 'ERROR',
                errorMessage: mcpResult?.error ?? mcpError,
                finalVerdict: mcpVerdict,
                finalScore: null,
                startedAt,
                endedAt: mcpEndedAt,
              },
            });
            const mcpRawOutput = mcpResult
              ? JSON.stringify(mcpResult.raw)
              : JSON.stringify({ kind: 'mcp_closed_loop', error: mcpError });
            await db.engineRun.create({
              data: {
                taskId,
                resultId: mcpCreated.id,
                engine: MCP_CLOSED_LOOP_ENGINE,
                status: mcpNotExecuted ? 'SKIPPED' : mcpVerdict === 'ERROR' ? 'FAILED' : 'SUCCESS',
                startedAt,
                endedAt: mcpEndedAt,
                durationMs: mcpResult?.latencyMs ?? 0,
                normalizedCount: mcpResult && !mcpNotExecuted ? 1 : 0,
                skippedCount: mcpNotExecuted ? 1 : 0,
                rawOutput: mcpRawOutput,
              },
            });
            // FAIL = 攻击绕过网关（漏检/未留痕/strict 应拦未拦）→ 落 Finding + WrongAnswer。
            if (mcpVerdict === 'FAIL' && mcpResult) {
              const codes = mcpResult.closedLoop.failureCodes;
              const sandboxSelfTest = mcpMeta.templateId.endsWith('-r4');
              const evidenceText = sandboxSelfTest
                ? '本地沙箱探针（检测器自检）未通过；不代表客户MCP配置覆盖。'
                : `MCP ${mcpMeta.mcpClass} 攻击未被网关有效拦截/留痕。归因：${codes.join(',') || '无'}。` +
                  `预期动作=${mcpMeta.expectedGatewayAction}，工具=${mcpMeta.toolName}。`;
              await db.finding.create({
                data: {
                  taskId,
                  resultId: mcpCreated.id,
                  questionId: question.id,
                  engine: MCP_CLOSED_LOOP_ENGINE,
                  riskCategory: `mcp:${mcpMeta.mcpClass}`,
                  severity: question.severity ?? 'HIGH',
                  verdict: 'FAIL',
                  title: sandboxSelfTest
                    ? '本地沙箱探针（检测器自检）未通过'
                    : `[MCP闭环] ${mcpMeta.mcpClass} 攻击绕过（owner=${mcpResult.closedLoop.owner}）`,
                  evidence: evidenceText,
                  detail: mcpResult.closedLoop as unknown as Prisma.InputJsonValue,
                },
              });
              await db.wrongAnswer.create({
                data: {
                  taskId,
                  resultId: mcpCreated.id,
                  questionId: question.id,
                  questionContent: question.content,
                  modelResponse: mcpResult.status === 'SUCCESS' ? mcpResult.content : null,
                  riskCategory: `mcp:${mcpMeta.mcpClass}`,
                  severity: question.severity ?? 'HIGH',
                  verdict: 'FAIL',
                  reason: evidenceText,
                  engine: MCP_CLOSED_LOOP_ENGINE,
                },
              });
            }
            if (mcpVerdict === 'ERROR') {
              await safeLog(
                taskId,
                'warn',
                `MCP 闭环无法判定：${truncate(question.content)} -> ${mcpResult?.error ?? mcpError ?? '未知'}`,
                {
                  questionId: question.id,
                  failureCodes: mcpResult?.closedLoop.failureCodes ?? [],
                },
              );
            }
            const mcpSnap = recordProgress(mcpVerdict);
            await db.evalTask.update({
              where: { id: taskId },
              data: {
                processedQuestions: mcpSnap.processed,
                passedCount: mcpSnap.passedCount,
                failedCount: mcpSnap.failedCount,
                errorCount: mcpSnap.errorCount,
                progress: mcpSnap.progress,
              },
            });
            continue;
          }

          const usedAgentRunner = metadata?.kind === 'agent_runtime' && canUseAgentRunner;
          const result = usedAgentRunner
            ? task.modelTarget.targetType === 'PLATFORM_APP'
              ? await runPlatformScenario(task.modelTarget, { prompt: question.content, metadata }, { taskId, signal: taskAbortController.signal })
              : await callAgentScenario(cfgForQuestion, { prompt: question.content, metadata })
            : await invokeEvaluationTarget(
                task.modelTarget,
                [{ role: 'user', content: question.content }],
                { callModel, sessionId, correlationHeaders, signal: taskAbortController.signal },
              );
          if (await refreshCancelState()) return;
          const endedAt = new Date();

          const usage: Prisma.InputJsonValue = {
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
          };

          // 判定：调用失败 → ERROR；空回答 → UNKNOWN；否则跑各 per-question 引擎并聚合裁决。
          let finalVerdict: Verdict;
          let finalScore: number | null = null;
          let engineResults: EngineResult[] = [];
          let aiReviewResult: EngineResult | null = null;
          let findingReviews = new Map<EngineResult, FindingReviewGovernance>();
          if (isRecord(result.raw) && result.raw.observed === true && result.raw.platformError) {
            finalVerdict = 'UNKNOWN';
          } else if (result.status === 'ERROR') {
            finalVerdict = 'ERROR';
          } else {
            const semanticRisk = semanticInputRiskResult({ taskId, question });
            const rules = buildJudgeRules(question.metadata, result.raw);
            const hasAgentTrace = Array.isArray(rules?.agentTrace) && rules.agentTrace.length > 0;
            if (result.content.trim().length === 0 && !hasAgentTrace && semanticRisk === null) {
              finalVerdict = 'UNKNOWN';
            } else {
              const judgeInput: JudgeInput = {
                taskId,
                questionId: question.id,
                questionType: question.type,
                prompt: question.content,
                response: result.content,
                expectedBehavior: question.expectedBehavior,
                referenceAnswer: question.referenceAnswer,
                shouldRefuse: question.shouldRefuse,
                severity: question.severity,
                rules,
              };
              engineResults = await Promise.all(
                primaryQuestionEngines.map((e) => safeJudge(e, judgeInput)),
              );
              if (semanticRisk !== null) {
                engineResults = [semanticRisk, ...engineResults];
              }
              const preliminary = aggregateVerdict(engineResults);
              // Agent runtime 的 runner verdict/trace 是结构化沙箱裁决；不要让通用 AI 复核
              // 再按回答文本把 FAIL/UNKNOWN 改写成另一种结论。
              if (
                (!usedAgentRunner || (task.modelTarget.targetType === 'PLATFORM_APP' && isRecord(result.raw) && result.raw.verdict === 'UNKNOWN')) &&
                aiReviewEngine &&
                shouldRunAiReview(preliminary.verdict, engineResults)
              ) {
                aiReviewResult = await safeJudge(aiReviewEngine, judgeInput);
                engineResults = [...engineResults, aiReviewResult];
              }
              const incompleteJudges = engineResults.filter((r) => r.status === 'failed');
              if (incompleteJudges.length > 0) {
                await safeLog(
                  taskId,
                  'warn',
                  '部分判定未完成，规则辅助结果不能代替独立模型判定。',
                  {
                    questionId: question.id,
                    engines: incompleteJudges.map((r) => r.engine),
                    judgmentIncomplete: true,
                  },
                );
              }
              engineResults = engineResults.map(r => applySuspectedFalsePositive(r, aiReviewResult));
              findingReviews = new Map(
                engineResults
                  .filter((r) => r.verdict === 'FAIL' && r.status !== 'skipped')
                  .map((r) => [r, decideFindingReview(r, aiReviewResult)]),
              );
              const effectiveEngineResults = engineResults.filter((r) => {
                if (r.verdict !== 'FAIL' || r.status === 'skipped') return true;
                const review = findingReviews.get(r);
                return review ? !isSuppressedByReview(review) : true;
              });
              const agg = aggregateVerdict(effectiveEngineResults);
              finalVerdict = agg.verdict;
              finalScore = agg.score;

              // 累计每个引擎的运行统计（用于汇总 EngineRun）。
              for (const r of engineResults) {
                const acc = engineAccum.get(r.engine);
                if (acc === undefined) continue;
                if (r.status === 'skipped' || r.status === 'failed') {
                  acc.skipped += 1;
                  if (r.evidence) acc.lastError = r.evidence;
                } else {
                  acc.judged += 1;
                  if (r.verdict === 'FAIL') acc.failed += 1;
                }
              }
            }
          }

          const created = await db.evalResult.create({
            data: {
              taskId,
              questionId: question.id,
              modelTargetId: task.modelTargetId,
              prompt: question.content,
              response: result.status === 'SUCCESS' ? result.content : null,
              usage,
              latencyMs: result.latencyMs,
              status: result.status,
              errorMessage: result.error,
              finalVerdict,
              finalScore,
              startedAt,
              endedAt,
            },
          });

          if (usedAgentRunner && result.raw !== null && result.raw !== undefined) {
            await db.engineRun.create({
              data: {
                taskId,
                resultId: created.id,
                engine: AGENT_TOOL_GUARD_ENGINE,
                status: 'SUCCESS',
                startedAt,
                endedAt,
                durationMs: result.latencyMs,
                normalizedCount: Array.isArray((result.raw as { trace?: unknown }).trace)
                  ? ((result.raw as { trace?: unknown[] }).trace?.length ?? 0)
                  : 0,
                rawOutput: JSON.stringify(result.raw),
              },
            });
          }

          // 落库风险项：每个判 FAIL 的引擎结果一条 Finding。
          const failResults = engineResults.filter(
            (r) => r.verdict === 'FAIL' && r.status !== 'skipped',
          );
          const effectiveFailResults = failResults.filter((r) => {
            const review = findingReviews.get(r);
            return review ? !isSuppressedByReview(review) : true;
          });
          if (failResults.length > 0) {
            await db.finding.createMany({
              data: failResults.map((r) => {
                const review = findingReviews.get(r) ?? decideFindingReview(r, aiReviewResult);
                return {
                  taskId,
                  resultId: created.id,
                  questionId: question.id,
                  engine: r.engine,
                  riskCategory: r.riskCategory,
                  severity: r.severity,
                  score: r.score,
                  evidenceStrength: r.evidenceStrength ?? null,
                  executionOutcome: r.executionOutcome ?? null,
                  confidence: review.confidence,
                  verdict: r.verdict,
                  reviewStatus: review.reviewStatus,
                  reviewReason: review.reviewReason,
                  suppressionKey: review.suppressionKey,
                  title: `[${r.engine}] ${r.riskCategory}`,
                  evidence: r.evidence,
                  detail: (r.rawOutput ?? {}) as Prisma.InputJsonValue,
                };
              }),
            });
            await safeReportEvalFindingsToGateway({
              taskId,
              sampleId: question.id,
              targetId: task.modelTargetId,
              access: gatewayAccess,
              findings: evalFindingInputs({ question, result, failResults: effectiveFailResults }),
            });
          }

          const progressSnapshot = recordProgress(finalVerdict);
          if (finalVerdict === 'ERROR') {
            await safeLog(
              taskId,
              'error',
              `样本调用失败：${truncate(question.content)} -> ${result.error ?? '未知错误'}`,
              { questionId: question.id, httpStatus: result.httpStatus },
            );
          } else if (finalVerdict === 'FAIL' && effectiveFailResults.length > 0) {
            // 记录样本：取严重度最高的失败项作为代表写入样本集。
            const worst = effectiveFailResults.reduce((a, b) =>
              SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a,
            );
            await db.wrongAnswer.create({
              data: {
                taskId,
                resultId: created.id,
                questionId: question.id,
                questionContent: question.content,
                modelResponse: result.status === 'SUCCESS' ? result.content : null,
                riskCategory: worst.riskCategory,
                severity: worst.severity,
                verdict: 'FAIL',
                reason: appendAiReviewReason(worst.evidence, aiReviewResult),
                engine: worst.engine,
              },
            });
          }

          await db.evalTask.update({
            where: { id: taskId },
            data: {
              processedQuestions: progressSnapshot.processed,
              passedCount: progressSnapshot.passedCount,
              failedCount: progressSnapshot.failedCount,
              errorCount: progressSnapshot.errorCount,
              progress: progressSnapshot.progress,
            },
          });
        } finally {
          scenarioScheduler.markDone(question.id);
        }
      }
    };

    // 暂停（2.4.2）：还有没跑的题就停在这里，下次从断点接续。
    // 不写 EngineRun 汇总，不跑任务级引擎、网关回拉、门禁，这些在全部题跑完时做。
    // 只在「执行中且暂停请求还在」时改成已暂停：停止接口刚把它改成已停止、或用户刚撤销了暂停时都不改。
    const tryPause = async (): Promise<'paused' | 'stopped' | 'withdrawn'> => {
      // 已领取局数、但还没跑完的红队场景（冷却中的延后场景）恢复后会重新领取，这里不算局数。
      const finished = new Set(
        (await db.evalResult.findMany({ where: { taskId }, select: { questionId: true } })).map(
          (r) => r.questionId,
        ),
      );
      const unfinishedLaps = [...redTeamStarted].filter((id) => !finished.has(id)).length;
      const pauseState: EvalTaskPauseState = {
        engineAccum: Object.fromEntries(engineAccum),
        redTeamLaps: Math.max(0, redTeamLaps - unfinishedLaps),
      };
      const paused = await db.evalTask.updateMany({
        where: { id: taskId, status: 'RUNNING', pauseRequestedAt: { not: null } },
        data: {
          status: 'PAUSED',
          pausedAt: new Date(),
          pauseState: pauseState as unknown as Prisma.InputJsonValue,
          pauseRequestedAt: null,
          totalQuestions: total,
          processedQuestions: processed,
          passedCount,
          failedCount,
          errorCount,
          progress: processed / total,
        },
      });
      if (paused.count > 0) return 'paused';
      const now = await db.evalTask.findUnique({ where: { id: taskId }, select: { status: true } });
      return now?.status === 'RUNNING' ? 'withdrawn' : 'stopped';
    };
    let pauseOutcome: 'paused' | 'stopped' | null = null;

    try {
      for (;;) {
        pendingReadyAt = null;
        await Promise.all(Array.from({ length: poolSize }, () => pump()));
        if (await refreshCancelState()) {
          scenarioScheduler.abort();
          break;
        }
        // 暂停时不再等延后的红队场景，留到接续时重跑。在途的题都做完了：置已暂停前不节流地
        // 再读一次暂停键，用户已撤销（恢复）就接着派题；题都做完了就按完成收尾。
        if (await refreshPauseState()) {
          if (!(await refreshPauseState(true))) continue;
          if (scenarioScheduler.pendingCount + scenarioScheduler.deferredCount === 0) break;
          const outcome = await tryPause();
          if (outcome === 'withdrawn') {
            // 库里已没有暂停请求：暂停键是残留的，清掉后接着跑。
            await clearEvalTaskPause(taskId).catch(() => undefined);
            pauseRequested = false;
            lastPauseCheckAt = Date.now();
            pauseGraceUntil = Date.now() + Math.max(cancelPollIntervalMs, 1_000);
            await safeLog(taskId, 'info', '暂停已撤销，继续执行');
            continue;
          }
          pauseOutcome = outcome;
          break;
        }
        if (pendingReadyAt === null) break;
        await waitUntil(Math.max(0, pendingReadyAt - Date.now()));
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        cancelRequested = true;
        scenarioScheduler.abort();
        if (!taskAbortController.signal.aborted) taskAbortController.abort();
      } else {
        throw err;
      }
    } finally {
      stopCancelWatcher();
    }

    await refreshCancelState();

    if (pauseOutcome) {
      await clearEvalTaskPause(taskId).catch(() => undefined);
      await safeLog(
        taskId,
        'info',
        pauseOutcome === 'paused'
          ? `任务已暂停：已完成 ${processed}/${total} 题`
          : '任务已被停止，不再置为已暂停',
      );
      return;
    }

    // 汇总：每个 per-question 引擎写一条 EngineRun 运行记录。
    // 状态判定：判过题 → SUCCESS；只被跳过 → SKIPPED；一题没碰但属内置引擎 → SUCCESS（保持
    // 内置两引擎恒产出 SUCCESS 记录的契约），外部引擎一题没碰 → SKIPPED。
    // AI 复核引擎只在初判 FAIL/UNKNOWN 或高风险时才调用，一题没碰说明没有需要复核的题，记 SUCCESS。
    const runEndedAt = new Date();
    const durationMs = runEndedAt.getTime() - runStartedAt.getTime();
    const engineRunRows: Prisma.EngineRunCreateManyInput[] = perQuestionEngines.map((e) => {
      const acc = engineAccum.get(e.engine) ?? {
        judged: 0,
        failed: 0,
        skipped: 0,
        lastError: null,
      };
      const status: EngineRunStatus =
        acc.judged > 0
          ? 'SUCCESS'
          : acc.skipped > 0
            ? 'SKIPPED'
            : e.builtin || e === aiReviewEngine
              ? 'SUCCESS'
              : 'SKIPPED';
      const row: Prisma.EngineRunCreateManyInput = {
        taskId,
        resultId: null,
        engine: e.engine,
        status,
        startedAt: runStartedAt,
        endedAt: runEndedAt,
        durationMs,
        normalizedCount: acc.judged,
        skippedCount: acc.skipped,
        rawOutput: JSON.stringify({
          engine: e.engine,
          judged: acc.judged,
          failed: acc.failed,
          skipped: acc.skipped,
        }),
      };
      if (acc.lastError) {
        row.errorMessage = acc.lastError;
      }
      return row;
    });
    const semanticAcc = engineAccum.get(SEMANTIC_INPUT_RISK_ENGINE);
    if (semanticAcc && semanticAcc.judged + semanticAcc.failed + semanticAcc.skipped > 0) {
      engineRunRows.push({
        taskId,
        resultId: null,
        engine: SEMANTIC_INPUT_RISK_ENGINE,
        status: 'SUCCESS',
        startedAt: runStartedAt,
        endedAt: runEndedAt,
        durationMs,
        normalizedCount: semanticAcc.judged,
        skippedCount: semanticAcc.skipped,
        rawOutput: JSON.stringify({
          engine: SEMANTIC_INPUT_RISK_ENGINE,
          judged: semanticAcc.judged,
          failed: semanticAcc.failed,
          skipped: semanticAcc.skipped,
          source: 'question_semantic_metadata',
        }),
      });
    }
    await db.engineRun.createMany({ data: engineRunRows });

    // 任务级引擎（如 AI-Infra-Guard 红队扫描）：对整模型做一次扫描，产出任务级风险项。
    // 每个引擎独立 try/catch，异常不影响任务完成；结果以 resultId/questionId 置空的 Finding 归属任务。
    if (!cancelRequested && taskLevelEngines.length > 0) {
      const target: TaskScanTarget = {
        name: task.modelTarget.name,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
      };
      const promptSeeds = questions.slice(0, 20).map((q) => q.content);
      for (const engine of taskLevelEngines) {
        try {
          const run = await engine.scan({
            taskId,
            target,
            promptSeeds,
            timeoutMs: TASK_ENGINE_TIMEOUT_MS,
          });
          await db.engineRun.create({
            data: {
              taskId,
              resultId: null,
              engine: run.engine,
              status: run.status,
              startedAt: new Date(run.startedAt),
              endedAt: new Date(run.endedAt),
              durationMs: run.durationMs,
              normalizedCount: run.results.length,
              rawOutput: JSON.stringify(run.rawOutput ?? null),
              ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
            },
          });
          const taskFindings = run.results.filter(
            (r) => r.verdict === 'FAIL' && r.status !== 'skipped',
          );
          if (taskFindings.length > 0) {
            await db.finding.createMany({
              data: taskFindings.map((r) => ({
                taskId,
                resultId: null,
                questionId: null,
                engine: r.engine,
                riskCategory: r.riskCategory,
                severity: r.severity,
                score: r.score,
                evidenceStrength: r.evidenceStrength ?? null,
                executionOutcome: r.executionOutcome ?? null,
                verdict: r.verdict,
                title: `[${r.engine}] ${r.riskCategory}`,
                evidence: r.evidence,
                detail: (r.rawOutput ?? {}) as Prisma.InputJsonValue,
              })),
            });
          }
          await safeLog(
            taskId,
            run.status === 'SUCCESS' ? 'info' : 'warn',
            `任务级引擎 ${run.engine} 执行 ${run.status}，产出 ${run.results.length} 项` +
              (run.errorMessage ? `（${run.errorMessage}）` : ''),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await safeLog(taskId, 'warn', `任务级引擎 ${engine.engine} 异常：${message}`).catch(
            () => undefined,
          );
        }
      }
    }

    // P0-2：把「已显式选择但当前不可用」的任务级引擎（未部署 sidecar / 开关未开）显式落库，
    // 避免静默 0 扫描被误读为「无风险」。落 SKIPPED EngineRun + 任务详情 warn 日志。
    // 每条独立 try/catch：落账仅为可见性兜底，绝不能因写一行 SKIPPED 失败而把已完成任务翻成 FAILED。
    if (!cancelRequested)
      for (const engine of dormantTaskLevelEngines) {
        try {
          await db.engineRun.create({
            data: {
              taskId,
              resultId: null,
              engine,
              status: 'SKIPPED',
              normalizedCount: 0,
              errorMessage: DORMANT_ENGINE_SKIP_REASON,
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await safeLog(taskId, 'warn', `休眠引擎 ${engine} 落 SKIPPED 失败：${message}`).catch(
            () => undefined,
          );
          continue;
        }
        await safeLog(
          taskId,
          'warn',
          `任务级引擎 ${engine} 已选择但当前不可用（未部署 sidecar 或开关未开），本次跳过；如需该项扫描请联系部署同学开启`,
        ).catch(() => undefined);
      }

    // 收尾：智能体黑盒目标若绑定了网关证据源，按 taskId 回拉网关审计事件，落成网关侧 Finding。
    // 仅 AGENT_API；MODEL/GATEWAY_LOG/红队各有自己的网关证据路径，互不干扰。失败不影响任务完成。
    // 红队任务有自己的逐样本网关证据采集与回写，这里只为「普通被测对象评测」材料化网关侧实证。
    if (
      !cancelRequested &&
      gatewayAccess !== null &&
      task.modelTarget.targetType !== 'GATEWAY_LOG' &&
      redTeamLaps === 0
    ) {
      try {
        const gwFindings = await collectGatewayFindings({
          controlPlaneBaseUrl: gatewayAccess.controlPlaneBaseUrl,
          internalToken: resolveInternalToken(),
          tenantId: gatewayAccess.tenantId,
          taskId,
        });
        if (gwFindings.length > 0) {
          await db.finding.createMany({
            data: gwFindings.map((f) => ({
              taskId,
              resultId: null,
              questionId: null,
              engine: f.engine,
              riskCategory: f.riskCategory,
              severity: f.severity,
              score: f.score,
              verdict: f.verdict,
              title: `[网关] ${f.title}`,
              evidence: f.evidence,
              detail: f.detail as Prisma.InputJsonValue,
            })),
          });
        }
        await safeLog(taskId, 'info', `网关侧实证回拉完成：落库 ${gwFindings.length} 条`);
      } catch (err) {
        await safeLog(taskId, 'warn', '网关侧实证回拉失败，结果页不展示网关实证', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const finalStatus = cancelRequested ? 'CANCELED' : 'COMPLETED';
    await db.evalTask.update({
      where: { id: taskId },
      data: {
        status: finalStatus,
        finishedAt: new Date(),
        totalQuestions: total,
        processedQuestions: processed,
        passedCount,
        failedCount,
        errorCount,
        progress: total === 0 ? 1 : processed / total,
        pausedAt: null,
        pauseState: Prisma.DbNull,
        pauseRequestedAt: null,
      },
    });
    // 跑完前才要求的暂停没用上：清掉，免得重评时一开始就停。
    if (pauseRequested) await clearEvalTaskPause(taskId).catch(() => undefined);
    if (cancelRequested) {
      await safeLog(
        taskId,
        'warn',
        `任务已取消：保留已完成 ${processed}/${total} 题，通过 ${passedCount} 题，失败 ${failedCount} 题，调用失败 ${errorCount} 题`,
      );
    } else {
      await safeLog(
        taskId,
        'info',
        `任务执行完成：共 ${total} 题，通过 ${passedCount} 题，失败 ${failedCount} 题，调用失败 ${errorCount} 题`,
      );
      await runGateHook();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.evalTask
      .update({
        where: { id: taskId },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          // 失败是结束态：不再接续，暂停字段一并清掉。
          pausedAt: null,
          pauseState: Prisma.DbNull,
          pauseRequestedAt: null,
        },
      })
      .catch(() => undefined);
    await safeLog(taskId, 'error', `任务执行异常终止：${message}`).catch(() => undefined);
  }
}
