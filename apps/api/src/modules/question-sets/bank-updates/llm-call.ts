import type { ChatMessage, LlmTargetConfig } from '@lse/shared';
import type { JudgeChat } from '../../standard-evaluations/gbt45654/classifier.js';
import { BANK_UPDATE_CALL_TIMEOUT_MS } from './constants.js';

/** 连续失败熔断触发时抛出，外层捕获后把状态记为失败。 */
export class StopUpdate extends Error {}

/** 出题与裁判分开计连续失败：一方持续故障不会被另一方的成功冲掉。 */
export type CallRole = 'generator' | 'judge';
const ROLE_LABEL: Record<CallRole, string> = { generator: '出题模型', judge: '裁判模型' };

/** 上下文超限类错误缩小输出上限后重试的取值。 */
export const REDUCED_MAX_TOKENS = 4096;

/** 模型目标 defaultParams 里有更小的 max_tokens 就用它。 */
export function effectiveMaxTokens(cfg: LlmTargetConfig, wanted: number): number {
  const v = cfg.defaultParams?.max_tokens;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(wanted, Math.floor(v)) : wanted;
}

/** 400 且信息像是上下文或输出长度超限。 */
export function isContextLimitError(res: { httpStatus?: number | null; error?: string | null }): boolean {
  if (res.httpStatus !== 400) return false;
  return /context|max_tokens|max_completion_tokens|maximum|too long|length|token/i.test(res.error ?? '');
}

/**
 * 带连续失败计数的模型调用器：成功（有内容且解析得出）清零，失败（调用出错、内容为空、解析不出）加一，
 * 出题与裁判各自计数，任一方达到上限抛 StopUpdate。onActivity 在每次调用结束后触发（写心跳）。
 */
export function createCaller(chat: JudgeChat, maxFailures: number, onActivity?: () => Promise<void> | void) {
  const failures: Record<CallRole, number> = { generator: 0, judge: 0 };
  const total: Record<CallRole, number> = { generator: 0, judge: 0 };
  let stopMessage: string | null = null;
  let lastError: string | null = null;
  const fail = (role: CallRole, detail?: string | null): void => {
    failures[role] += 1;
    total[role] += 1;
    if (detail) lastError = `${ROLE_LABEL[role]}：${detail.slice(0, 200)}`;
    if (failures[role] >= maxFailures) {
      stopMessage = `${ROLE_LABEL[role]}连续 ${maxFailures} 次调用失败${detail ? `（${detail.slice(0, 200)}）` : ''}，已停止`;
      throw new StopUpdate(stopMessage);
    }
  };
  const run = async (cfg: LlmTargetConfig, messages: ChatMessage[], maxTokens: number, temperature: number) =>
    chat(cfg, messages, { maxTokens, temperature, timeoutMs: BANK_UPDATE_CALL_TIMEOUT_MS }).catch((e: unknown) => ({
      status: 'ERROR' as const,
      content: '',
      error: (e as Error).message,
      httpStatus: null as number | null,
    }));
  return {
    /**
     * 调用模型；给了 parse 时返回解析结果。调用出错、内容为空、解析不出都计一次失败并返回 null。
     * 只有解析成功才清零：模型持续回格式不对的内容时也能熔断。
     */
    async call<T = string>(
      role: CallRole,
      cfg: LlmTargetConfig,
      messages: ChatMessage[],
      maxTokens: number,
      temperature: number,
      parse?: (text: string) => T | null,
    ): Promise<T | null> {
      const tokens = effectiveMaxTokens(cfg, maxTokens);
      let res = await run(cfg, messages, tokens, temperature);
      if (res.status !== 'SUCCESS' && tokens > REDUCED_MAX_TOKENS && isContextLimitError(res)) {
        res = await run(cfg, messages, REDUCED_MAX_TOKENS, temperature);
      }
      await onActivity?.();
      if (res.status !== 'SUCCESS' || !res.content.trim()) {
        fail(role, res.error ? String(res.error) : '返回内容为空');
        return null;
      }
      const out = parse ? parse(res.content) : (res.content as unknown as T);
      if (out === null || out === undefined) {
        fail(role, '返回格式无法解析');
        return null;
      }
      failures[role] = 0;
      return out;
    },
    /** 该方累计失败次数（含已被后来成功清零的）。 */
    totalFailures: (role: CallRole) => total[role],
    get stopMessage() {
      return stopMessage;
    },
    /** 最后一次失败的原因（带模型角色）。 */
    get lastError() {
      return lastError;
    },
  };
}
