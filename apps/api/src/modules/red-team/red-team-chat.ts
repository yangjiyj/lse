/**
 * 红队统一调用包装：所有红队模型角色（攻击脑 THINK / 被测模型 OBSERVE / replay /
 * 裁判）共用一次调用契约，集中处理：
 *   - 错误分类（retryable / non-retryable）
 *   - retryable 原轮即时重试（退避 1s、3s，最多 3 次）
 *   - non-retryable（配置错误）立即抛 ConfigError，不重试、不靠降并发掩盖
 *   - retryable 耗尽抛 RetryExhausted，供上层做延后重排
 *   - 成败反馈给任务级 AdaptiveConcurrency 控制器
 *   - 并发变更/重试事件经 onEvent 回调写任务日志（打码由调用方负责）
 *   - 角色级 maxTokens 透传
 *
 * 本模块只调度调用，不改变模型目标、攻击话术、上下文或裁判口径。
 */
import type { ChatMessage, LlmTargetConfig } from '@lse/shared';
import type { ChatFn } from './types.js';
import { classifyChatError } from './chat-error.js';
import type { AdaptiveConcurrency } from './adaptive-concurrency.js';
import { AsyncSemaphore } from './async-semaphore.js';

/** 红队模型角色阶段，用于日志与配置错误归属。 */
export type RedTeamStage = 'attacker' | 'target' | 'judge' | 'replay';

/** 配置/协议类不可重试错误（401/403/400/404/缺 choices）。 */
export class ConfigError extends Error {
  readonly stage: RedTeamStage;
  readonly reasonCode: string;
  readonly httpStatus: number | null;
  constructor(stage: RedTeamStage, reasonCode: string, httpStatus: number | null, message: string) {
    super(message);
    this.name = 'ConfigError';
    this.stage = stage;
    this.reasonCode = reasonCode;
    this.httpStatus = httpStatus;
  }
}

/** retryable 错误在原轮即时重试耗尽后抛出，供上层把场景放回队尾延后重排。 */
export class RetryExhausted extends Error {
  readonly stage: RedTeamStage;
  readonly lastReasonCode: string;
  readonly attempts: number;
  constructor(stage: RedTeamStage, lastReasonCode: string, attempts: number, message: string) {
    super(message);
    this.name = 'RetryExhausted';
    this.stage = stage;
    this.lastReasonCode = lastReasonCode;
    this.attempts = attempts;
  }
}

export interface RedTeamChatCallOptions {
  stage: RedTeamStage;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RedTeamChatResult {
  conversationId?: string | null;
  status: 'SUCCESS' | 'ERROR';
  content: string;
  usage?: unknown;
  finishReason?: string | null;
}

/** 并发/重试事件，供任务日志记录（须由调用方打码后落库）。 */
export interface RedTeamChatEvent {
  kind: 'decrease' | 'increase' | 'steady-success' | 'retry' | 'config-error';
  stage: RedTeamStage;
  previousConcurrency: number;
  effectiveConcurrency: number;
  reasonCode: string;
  attempt: number;
  maxAttempts: number;
  reasonText: string;
  previousMaxTokens?: number;
  effectiveMaxTokens?: number;
  finishReason?: string | null;
}

export interface RedTeamChat {
  call(
    cfg: LlmTargetConfig,
    messages: ChatMessage[],
    opts: RedTeamChatCallOptions,
  ): Promise<RedTeamChatResult>;
}

export interface CreateRedTeamChatOptions {
  chat: ChatFn;
  controller: AdaptiveConcurrency;
  /** 注入 sleep 便于测试；生产用支持 AbortSignal 的真实定时器。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 并发/重试事件回调（写任务日志）。 */
  onEvent?: (event: RedTeamChatEvent) => void;
  /** 即时重试次数（含首次），默认 3。 */
  maxAttempts?: number;
  /** 退避序列（毫秒），默认 [1000, 3000]。 */
  backoffMs?: number[];
  /**
   * 动态容量信号量：每次真实模型调用前 acquire、finally release。
   * 由调用方在 onEvent 的 decrease/increase 时 setCapacity 同步 AIMD。
   * 缺省时不做并发约束（兼容旧单测）。
   */
  semaphore?: AsyncSemaphore;
}

const STAGE_LABEL: Record<RedTeamStage, string> = {
  attacker: '攻击模型',
  target: '评估对象',
  judge: '判定模型',
  replay: '重放',
};

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error('red team retry backoff aborted');
      err.name = 'AbortError';
      reject(err);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });

export function createRedTeamChat(opts: CreateRedTeamChatOptions): RedTeamChat {
  const { chat, controller, onEvent, semaphore } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffMs = opts.backoffMs ?? [1000, 3000];

  const emit = (e: RedTeamChatEvent) => {
    try {
      onEvent?.(e);
    } catch {
      // 日志回调 best-effort，绝不影响主流程。
    }
  };

  return {
    async call(cfg, messages, callOpts): Promise<RedTeamChatResult> {
      const stage = callOpts.stage;
      let lastReasonCode = 'UNKNOWN';
      let lastHttpStatus: number | null = null;

      const targetDefaultMaxTokens = Number(cfg.defaultParams?.max_tokens);
      const hasTargetDefaultMaxTokens =
        Number.isFinite(targetDefaultMaxTokens) && targetDefaultMaxTokens > 0;
      const initialMaxTokens =
        callOpts.maxTokens === undefined || !hasTargetDefaultMaxTokens
          ? callOpts.maxTokens
          : Math.min(callOpts.maxTokens, Math.floor(targetDefaultMaxTokens));
      let effectiveMaxTokens = initialMaxTokens;
      const maxTokenCeiling = initialMaxTokens === undefined ? undefined : initialMaxTokens * 4;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // 任务取消尊重
        if (callOpts.signal?.aborted) {
          const err = new Error('red team chat aborted');
          err.name = 'AbortError';
          throw err;
        }
        // 真实并发约束：每次真实模型调用前 acquire 信号量（abort 可取消），
        // 调用结束（成功/失败/抛错）后 finally release。这是 AIMD 落到真实并发的关键。
        if (semaphore) await semaphore.acquire(callOpts.signal);
        let releaseSem: (() => void) | null = () => semaphore?.release();
        try {
          const raw = await chat(cfg, messages, {
            temperature: callOpts.temperature,
            timeoutMs: callOpts.timeoutMs,
            maxTokens: effectiveMaxTokens,
            signal: callOpts.signal,
          });

          // 兼容 ChatFn 收窄返回与 chatComplete 超集返回。
          const status = (raw as { status?: unknown }).status === 'ERROR' ? 'ERROR' : 'SUCCESS';
          const finishReason = (raw as { finishReason?: unknown }).finishReason ?? null;
          const httpStatus = (raw as { httpStatus?: unknown }).httpStatus ?? null;

          const classification = classifyChatError({
            status,
            content: (raw as { content?: unknown }).content,
            finishReason,
            httpStatus,
            error: (raw as { error?: unknown }).error,
          });
          lastReasonCode = classification.reasonCode;
          lastHttpStatus = classification.httpStatus;

          // 成功：升并发 + 返回。
          if (classification.reasonCode === 'OK') {
            if (releaseSem) {
              releaseSem();
              releaseSem = null;
            }
            const change = controller.onSuccess();
            emit({
              kind: change.recovered ? 'increase' : 'steady-success',
              stage,
              previousConcurrency: change.previous,
              effectiveConcurrency: change.effective,
              reasonCode: 'OK',
              attempt,
              maxAttempts,
              reasonText: change.recovered
                ? `${STAGE_LABEL[stage]}自动恢复并发至 ${change.effective}`
                : `${STAGE_LABEL[stage]}调用成功`,
            });
            return {
              status: 'SUCCESS',
              conversationId: raw.conversationId,
              content: String((raw as { content?: unknown }).content ?? ''),
              usage: (raw as { usage?: unknown }).usage,
              finishReason: typeof finishReason === 'string' ? finishReason : null,
            };
          }

          // non-retryable：配置错误，立即抛，不降并发轰击。
          if (releaseSem) {
            releaseSem();
            releaseSem = null;
          }
          if (!classification.retryable) {
            emit({
              kind: 'config-error',
              stage,
              previousConcurrency: controller.current(),
              effectiveConcurrency: controller.current(),
              reasonCode: classification.reasonCode,
              attempt,
              maxAttempts,
              reasonText: `${STAGE_LABEL[stage]}配置错误（${classification.reasonCode}），暂停调用`,
            });
            throw new ConfigError(
              stage,
              classification.reasonCode,
              classification.httpStatus,
              `${STAGE_LABEL[stage]}配置错误：${classification.reasonCode}`,
            );
          }

          // 推理模型在产出正式正文前耗尽 token：提升预算，不把它误判成并发拥塞。
          if (
            classification.reasonCode === 'TOKEN_BUDGET_EXHAUSTED' &&
            effectiveMaxTokens !== undefined &&
            maxTokenCeiling !== undefined
          ) {
            const previousMaxTokens = effectiveMaxTokens;
            effectiveMaxTokens = Math.min(maxTokenCeiling, previousMaxTokens * 2);
            if (attempt < maxAttempts) {
              emit({
                kind: 'retry',
                stage,
                previousConcurrency: controller.current(),
                effectiveConcurrency: controller.current(),
                reasonCode: classification.reasonCode,
                attempt,
                maxAttempts,
                reasonText: `${STAGE_LABEL[stage]}输出预算耗尽，max_tokens ${previousMaxTokens}->${effectiveMaxTokens} 后重试`,
                previousMaxTokens,
                effectiveMaxTokens,
                finishReason: typeof finishReason === 'string' ? finishReason : null,
              });
              const wait = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 1000;
              await sleep(wait, callOpts.signal);
            }
            continue;
          }

          // retryable：降并发 + 记录，未达上限则退避后重试。
          const change = controller.onError();
          emit({
            kind: 'decrease',
            stage,
            previousConcurrency: change.previous,
            effectiveConcurrency: change.effective,
            reasonCode: classification.reasonCode,
            attempt,
            maxAttempts,
            reasonText: `${STAGE_LABEL[stage]}调用可重试失败（${classification.reasonCode}），降并发 ${change.previous}->${change.effective}`,
          });

          if (attempt < maxAttempts) {
            emit({
              kind: 'retry',
              stage,
              previousConcurrency: change.effective,
              effectiveConcurrency: change.effective,
              reasonCode: classification.reasonCode,
              attempt,
              maxAttempts,
              reasonText: `${STAGE_LABEL[stage]}第 ${attempt}/${maxAttempts - 1} 次重试中`,
            });
            const wait = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 1000;
            await sleep(wait, callOpts.signal);
          }
        } finally {
          // attempt 体结束：未在成功/配置错误出口释放的（retryable 重试/退避），在此释放。
          if (releaseSem) {
            releaseSem();
            releaseSem = null;
          }
        }
      }

      // retryable 耗尽：抛 RetryExhausted 供上层延后重排。
      throw new RetryExhausted(
        stage,
        lastReasonCode,
        maxAttempts,
        `${STAGE_LABEL[stage]}连续 ${maxAttempts} 次可重试失败（${lastReasonCode}）`,
      );
    },
  };
}
