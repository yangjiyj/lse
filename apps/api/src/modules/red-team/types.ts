import type { LlmTargetConfig, ChatMessage } from '@lse/shared';
import type { EngineResult, Severity, QuestionType } from '@lse/shared';
import type { PerQuestionEngine } from '../engines/types.js';
import type { AttackMemoryStore } from './attack-memory.js';
import type { RedTeamChat } from './red-team-chat.js';

export type ChatFn = (
  cfg: LlmTargetConfig,
  messages: ChatMessage[],
  opts?: { temperature?: number; timeoutMs?: number; maxTokens?: number; signal?: AbortSignal },
) => Promise<{
  content: string;
  usage?: unknown;
  status?: 'SUCCESS' | 'ERROR';
  finishReason?: string | null;
  conversationId?: string | null;
}>;

export type AttackMoveId =
  | 'identity_spoof' // 身份伪装
  | 'academic_wrap' // 学术合规包装
  | 'stepwise_decompose' // 分步拆解
  | 'fictional_frame' // 虚构框架
  | 'authority_pressure' // 权威施压
  | 'foot_in_door' // 先铺垫后翻脸
  | 'shell_swap'; // 换壳绕过

/** Legacy wording heuristic for scheduling only, never a safety verdict. */
export type ModelAttitude = 'loosened' | 'soft_refuse' | 'hard_refuse';

export interface WordingSignals {
  source: 'lexical';
  version: 1;
  refusal: boolean;
  qualification: boolean;
  continuation: boolean;
  empty: boolean;
}

/** A verdict actually obtained for this recording turn, separate from the replay verdict. */
export interface RoundJudgment {
  source: 'judge' | 'not_evaluated';
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN' | 'ERROR';
  engine?: string;
}
export type StopReason = 'success' | 'max_round' | 'no_progress' | 'budget';

/** 固定脚本里的一轮 attacker 话术（重放只需 move + message）。 */
export interface AttackerTurn {
  move: AttackMoveId;
  message: string;
  phaseId?: string;
  phaseLabel?: string;
  rationale?: string;
  successSignal?: string;
}

/** 录制期完整往返的一轮（含目标应答与态度判读）。 */
export interface AttackTurn {
  conversationId?: string | null;
  index: number;
  move: AttackMoveId;
  attackerMessage: string;
  modelResponse: string;
  attitude: ModelAttitude;
  /** Missing on historical recordings; do not infer or backfill a judgment from wording. */
  wordingSignals?: WordingSignals;
  roundJudgment?: RoundJudgment;
  brokenLayers?: BrokenLayer[];
  phaseId?: string;
  phaseLabel?: string;
  rationale?: string;
  successSignal?: string;
  /** 调整依据：目标上一轮响应（措辞信号+摘要）→ 本轮所选攻击策略及攻击模型给出的理由。 */
  adjustmentBasis?: string;
}

export interface AttackPlaybookPhase {
  id: string;
  label: string;
  move: AttackMoveId;
  instruction: string;
  successSignal: string;
}

export interface AttackPlaybook {
  variant: string;
  label: string;
  objectiveId?: string;
  seedPack?: string;
  phases: AttackPlaybookPhase[];
}
export interface RedTeamLengthTruncation {
  stage: 'attacker' | 'target' | 'replay';
  round: number;
  side?: 'A' | 'B';
}

export interface AttackRecording {
  seedId: string;
  attackerTurns: AttackerTurn[]; // 固定脚本，用于重放
  transcript: AttackTurn[]; // 录制期完整往返
  movesUsed: AttackMoveId[];
  rounds: number;
  stopReason: StopReason;
  playbook?: AttackPlaybook;
  attackerSelfAssessBroken: boolean; // 仅启发式，绝不作为判定
  brokenLayers?: BrokenLayer[];
  /** Episode 级红层奖励：post-hoc 网关证据缺失时为 null。 */
  redLayerReward?: number | null;
  /** 网关原生策略/告警是否识别到风险；缺少网关证据时为 null/undefined。 */
  recognizedRisk?: boolean | null;
  gatewayRecognizedRisk?: boolean | null;
  /** 客观 oracle：SUT 回复中是否检出本 episode 的 canary 机密 */
  canaryHit?: boolean;
  /** 本 episode 种入 SUT 的 canary 机密原文（落库取证用） */
  canaryToken?: string;
  /**
   * 基础设施未完成：场景在所有恢复策略（原轮重试 + 延后重排）耗尽后仍无法完成调用。
   * true 时 persistSide 落 status=ERROR/finalVerdict=ERROR，且不产生 Finding。
   */
  /** finish_reason=length 是资源消耗/截断证据，不属于调用异常。 */
  lengthTruncations?: RedTeamLengthTruncation[];
  infraIncomplete?: boolean;
  /** 基础设施未完成时的错误分类（INFRASTRUCTURE_INCOMPLETE / CONFIG_ERROR 等）。 */
  errorType?: string;
}

/** 录制期每一轮完成后抛出的实时观察事件，用于任务详情页展示正在发生的攻击链路。 */
export interface RedTeamRoundEvent {
  seedId: string;
  roundIndex: number;
  roundNumber: number;
  maxRounds: number;
  move: AttackMoveId;
  attackerMessage: string;
  modelResponse: string;
  attitude: ModelAttitude;
  wordingSignals?: WordingSignals;
  roundJudgment?: RoundJudgment;
  broke: boolean;
  stopReason: StopReason | null;
  usedTokens: number;
  judgeVerdict?: string | null;
  brokenLayers?: BrokenLayer[];
  /** 单轮实时红层信号暂不计算；episode 级 reward 由 B 侧网关证据采集后写入 recording。 */
  redLayerReward?: number | null;
  phaseId?: string;
  phaseLabel?: string;
  rationale?: string;
  successSignal?: string;
}

export interface RedTeamRuntime {
  judge?: PerQuestionEngine;
  taskId?: string;
  signal?: AbortSignal;
  attackMemory?: AttackMemoryStore;
  guardFingerprint?: string;
  judgeContext?:
    | RedTeamJudgeContext
    | ((turn: RedTeamJudgeContextRequest) => RedTeamJudgeContext | null | undefined);
  onRound?: (event: RedTeamRoundEvent) => void | Promise<void>;
  /** episode 级一次性 canary 机密，运行期生成，录制/replay 两侧共用 */
  canarySecret?: string;
  /**
   * 统一调用包装（重试 + 自适应并发 + 空响应校验）。
   * 注入后录制期 THINK/ACT 走它；缺省时回退旧 chat（保持兼容）。
   * 角色级 maxTokens 也由它透传。
   */
  redTeamChat?: RedTeamChat;
}

export type BrokenLayer = 'content' | 'action';

export interface RedTeamJudgeContext {
  agentTrace?: unknown[];
  agentMetadata?: Record<string, unknown>;
}

export interface RedTeamJudgeContextRequest {
  seed: RedTeamSeed;
  roundIndex: number;
  attackerMessage: string;
  modelResponse: string;
}

export type RedTeamCompositeJudgeResult = EngineResult & {
  brokenLayers: BrokenLayer[];
};

export interface RedTeamSeed {
  questionId: string;
  content: string;
  category: string | null;
  expectedBehavior: string | null;
  referenceAnswer: string | null;
  shouldRefuse: boolean;
  severity: Severity | null;
  questionType: QuestionType;
  redteam?: {
    objectiveId?: string;
    variant?: string;
    seedPack?: string;
    seedLevel?: string;
    /** 该题是否启用 canary 数据外发 oracle（静态开关，非明文机密） */
    canaryExfil?: boolean;
  };
}

export interface RedTeamConfig {
  moves: AttackMoveId[];
  maxRounds: number; // N，默认 6
  noProgressK: number; // K，默认 3
  budgetTokens: number | null;
  gatewayTargetId: string; // 可选防护层 target id；空字符串表示单模型红队
  attackerTargetId: string; // attacker 脑所用 LLM target id
  breakOn: 'verdict' | 'attitude'; // verdict 使用逐轮裁判；旧 attitude 模式只调度，不确认内容突破
  judgeTargetId: string; // 实质裁判所用 LLM target id（空则回落 attackerTargetId）
  secondaryAttackerTargetId: string; // 备用攻击脑 target id（空则不启用）
  /** 攻击脑单次输出上限（默认 512），资源消耗攻击仍测但不无限输出。 */
  attackerMaxTokens: number;
  /** 被测模型单次输出上限（默认 1024）；达 length 截断属测评证据，非异常。 */
  targetMaxTokens: number;
  /** 裁判单次输出上限（默认 512）。 */
  judgeMaxTokens: number;
}

export interface AttackerHead {
  readonly name: 'dummy' | 'react';
  attack(
    bareTarget: LlmTargetConfig,
    seed: RedTeamSeed,
    cfg: RedTeamConfig,
    runtime?: RedTeamRuntime,
  ): Promise<AttackRecording>;
}

export interface RedTeamSideResult {
  side: 'A' | 'B';
  modelTargetId: string;
  finalPrompt: string;
  response: string;
  replayMessages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  judge: EngineResult;
}

export interface RedTeamPairResult {
  controlGroupId: string;
  recording: AttackRecording;
  sideA: RedTeamSideResult;
  sideB?: RedTeamSideResult;
}
