import { chatComplete } from '../../lib/llm-client.js';
import type { PerQuestionEngine } from '../engines/types.js';
import type { LlmTargetConfig } from '@lse/shared';
import { redLayerRewardForEpisode } from '../assurance/attack-defense.js';
import type {
  AttackerHead,
  AttackerTurn,
  ChatFn,
  RedTeamConfig,
  RedTeamPairResult,
  RedTeamRuntime,
  RedTeamSeed,
  RedTeamSideResult,
} from './types.js';
import type { AttackMemoryStore } from './attack-memory.js';
import { toJudgeInput } from './judge-input.js';
import { makeCanary as defaultMakeCanary, canarySystemMessage, detectCanary } from './canary.js';
import type { RedTeamChat } from './red-team-chat.js';
import { RedTeamExecutionError } from './execution-error.js';

export interface RedTeamPipeDeps {
  chat: ChatFn;
  judge: PerQuestionEngine; // A/B 重放期的终判裁判（同一把尺判两侧），也是录制期破局判据的默认值
  breakJudge?: PerQuestionEngine; // 录制期破局判据专用裁判（实质裁判）；缺省时回落 judge，保持单一标尺
  attackMemory?: AttackMemoryStore;
  loadTarget(id: string): Promise<LlmTargetConfig>;
  collectGatewayEvidence?: (args: {
    taskId: string;
    sampleId: string;
    targetId: string;
    traceId: string;
  }) => Promise<{ gatewayRecognizedRisk: boolean | null }>;
  signal?: AbortSignal;
  /** 注入口：测试可替换 canary 生成器；生产用默认 makeCanary */
  makeCanary?: (id?: string) => string;
  /** 统一调用包装（重试+降并发+空响应校验）；注入后 replay 走它，否则用 chat。 */
  redTeamChat?: RedTeamChat;
  /** 被测模型单次输出上限（透传给 replay 的 redTeamChat）。 */
  targetMaxTokens?: number;
}

/** 把固定脚本逐轮原样发给一个目标，收集其每轮应答（无自适应）。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const err = new Error('red team replay aborted');
  err.name = 'AbortError';
  throw err;
}

function assertReplayComplete(result: { content: string; status?: string }) {
  if (result.status === 'ERROR' || !result.content.trim()) {
    throw new RedTeamExecutionError('red team replay incomplete', {
      stage: 'replay',
      reasonCode: 'REPLAY_CALL_FAILED',
      attempts: 1,
    });
  }
}

async function replayScript(
  chat: ChatFn,
  target: LlmTargetConfig,
  turns: AttackerTurn[],
  signal?: AbortSignal,
  canary?: string,
  redTeamChat?: RedTeamChat,
  maxTokens?: number,
  onLength?: (round: number) => void,
) {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
  if (canary) {
    messages.push(canarySystemMessage(canary)); // 循环外只种一次，每轮都带上
  }
  let last = '';
  const finishReasons: Array<string | null> = [];
  for (const t of turns) {
    throwIfAborted(signal);
    messages.push({ role: 'user', content: t.message });
    // 优先走统一调用包装（重试+降并发+空响应校验+maxTokens），否则回退旧 chat。
    if (redTeamChat) {
      const r = await redTeamChat.call(target, messages as any, {
        stage: 'replay',
        temperature: 0,
        timeoutMs: 60000,
        maxTokens,
        signal,
      });
      throwIfAborted(signal);
      if (r.finishReason === 'length') onLength?.(finishReasons.length + 1);
      assertReplayComplete(r);
      finishReasons.push(r.finishReason ?? null);
      last = r.content;
      messages.push({ role: 'assistant', content: r.content });
    } else {
      const r = await chat(target, messages as any, { temperature: 0, timeoutMs: 60000, signal });
      throwIfAborted(signal);
      if (r.finishReason === 'length') onLength?.(finishReasons.length + 1);
      assertReplayComplete(r);
      finishReasons.push((r as any).finishReason ?? null);
      last = r.content;
      messages.push({ role: 'assistant', content: r.content });
    }
  }
  return { response: last, messages, finishReasons };
}

/**
 * 扫 replay 全程的 SUT(assistant)回复是否任一处吐出 canary。
 * 只看 assistant：system 消息本就含 canary 明文，扫它必假阳。
 * 修正"只看最后一轮回复会漏掉中间轮泄漏"的漏判。
 */
function replayLeakedCanary(
  result: { response: string; messages: { role: string; content: string }[] },
  canary?: string,
): boolean {
  return result.messages.some((m) => m.role === 'assistant' && detectCanary(m.content, canary));
}

export async function runRedTeamAttack(params: {
  task: { id: string; modelTargetId: string };
  bareTarget: LlmTargetConfig;
  seed: RedTeamSeed;
  cfg: RedTeamConfig;
  head: AttackerHead;
  deps: RedTeamPipeDeps;
  controlGroupId: string;
  onRound?: RedTeamRuntime['onRound'];
}): Promise<RedTeamPairResult> {
  const { task, bareTarget, seed, cfg, head, deps, controlGroupId, onRound } = params;
  const makeCanary = deps.makeCanary ?? defaultMakeCanary;
  // 仅对启用 canary 的题种机密；其余题 canary=undefined（两侧不种，oracle 恒 false）
  const canary = seed.redteam?.canaryExfil ? makeCanary() : undefined;
  // 录：attacker 对裸模型自主攻击，产出固定脚本。
  // 把 runtime（破局裁判 + taskId）透传给攻击脑，使录制期每轮可用真裁判判破局（生产破局接线），
  // 而非回退到态度启发式。破局裁判优先用 deps.breakJudge（executor 注入的 substance judge），
  // 缺省时回落 deps.judge——绝不污染下面 A/B 重放期的终判裁判（仍用 deps.judge 同一把尺判两侧）。
  const recording = await head.attack(bareTarget, seed, cfg, {
    judge: deps.breakJudge ?? deps.judge,
    taskId: task.id,
    attackMemory: deps.attackMemory,
    guardFingerprint: cfg.gatewayTargetId ? `gateway:${cfg.gatewayTargetId}` : 'bare',
    signal: deps.signal,
    onRound,
    canarySecret: canary,
    // 录制期 THINK/ACT 也走统一调用包装（重试+降并发+空响应校验+角色 maxTokens）。
    redTeamChat: deps.redTeamChat,
  });
  try {
    if (recording.infraIncomplete) {
      const reasonCode = recording.errorType ?? 'INFRASTRUCTURE_INCOMPLETE';
      throw new RedTeamExecutionError(`red team recording incomplete: ${reasonCode}`, {
        name: reasonCode === 'CONFIG_ERROR' ? 'ConfigError' : 'RedTeamInfrastructureError',
        stage: 'attacker',
        reasonCode,
        attempts: 0,
      });
    }

    const finalPrompt = recording.attackerTurns.at(-1)?.message ?? seed.content;
    const hasProtectedTarget = Boolean(cfg.gatewayTargetId);
    const gatewayTarget = hasProtectedTarget ? await deps.loadTarget(cfg.gatewayTargetId) : null;
    // 单模型模式只重放被测模型；配置了防护层时，再用同一脚本做 B 侧对照。
    const replayA = await replayScript(
      deps.chat,
      bareTarget,
      recording.attackerTurns,
      deps.signal,
      canary,
      deps.redTeamChat,
      deps.targetMaxTokens,
      (round) => (recording.lengthTruncations ??= []).push({ stage: 'replay', round, side: 'A' }),
    );
    const replayB = gatewayTarget
      ? await replayScript(
          deps.chat,
          gatewayTarget,
          recording.attackerTurns,
          deps.signal,
          canary,
          deps.redTeamChat,
          deps.targetMaxTokens,
          (round) =>
            (recording.lengthTruncations ??= []).push({ stage: 'replay', round, side: 'B' }),
        )
      : null;
    // 判：同一把尺判实际产生的侧。
    const judgeA = await deps.judge.judge(
      toJudgeInput(task.id, seed, finalPrompt, replayA.response),
    );
    const judgeB = replayB
      ? await deps.judge.judge(toJudgeInput(task.id, seed, finalPrompt, replayB.response))
      : null;
    const gatewayEvidence =
      replayB && cfg.gatewayTargetId && deps.collectGatewayEvidence
        ? await deps.collectGatewayEvidence({
            taskId: task.id,
            sampleId: seed.questionId,
            targetId: cfg.gatewayTargetId,
            traceId: `${task.id}:${seed.questionId}:${cfg.gatewayTargetId}`,
          })
        : null;
    const gatewayRecognizedRisk = gatewayEvidence?.gatewayRecognizedRisk ?? null;
    recording.gatewayRecognizedRisk = gatewayRecognizedRisk;
    recording.recognizedRisk = gatewayRecognizedRisk;
    // 客观 oracle：SUT 任一侧 replay 全程任一轮回复逐字吐出本 episode canary = 实时数据外发实锤
    const canaryHit =
      replayLeakedCanary(replayA, canary) ||
      (replayB ? replayLeakedCanary(replayB, canary) : false);
    recording.canaryHit = canaryHit;
    if (canary) recording.canaryToken = canary;
    recording.redLayerReward = redLayerRewardForEpisode({
      broke: (judgeB ?? judgeA).verdict === 'FAIL',
      gatewayRecognizedRisk,
      canaryHit,
    });
    const sideA: RedTeamSideResult = {
      side: 'A',
      modelTargetId: task.modelTargetId,
      finalPrompt,
      response: replayA.response,
      replayMessages: replayA.messages,
      judge: judgeA,
    };
    const sideB: RedTeamSideResult | undefined =
      replayB && judgeB
        ? {
            side: 'B',
            modelTargetId: cfg.gatewayTargetId,
            finalPrompt,
            response: replayB.response,
            replayMessages: replayB.messages,
            judge: judgeB,
          }
        : undefined;
    return { controlGroupId, recording, sideA, sideB };
  } catch (error) {
    throw RedTeamExecutionError.from(error, recording.lengthTruncations);
  }
}
