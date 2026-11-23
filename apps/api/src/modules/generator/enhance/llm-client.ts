import type { ChatMessage, LlmCallResult } from '@lse/shared';
import { AppError } from '../../../lib/errors.js';
import { chatComplete } from '../../../lib/llm-client.js';

export interface EnhanceLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface EnhanceLlmClient {
  chat(messages: ChatMessage[]): Promise<LlmCallResult>;
}

export function buildEnhanceConfigFromEnv(env: NodeJS.ProcessEnv): EnhanceLlmConfig | null {
  if (env.ENHANCE_LLM_ENABLED !== 'true') return null;
  return {
    baseUrl: env.ENHANCE_LLM_BASE_URL ?? '',
    apiKey: env.ENHANCE_LLM_API_KEY ?? '',
    model: env.ENHANCE_LLM_MODEL ?? '',
    timeoutMs: Number(env.ENHANCE_LLM_TIMEOUT_MS ?? 60_000),
  };
}

export function isEnhanceConfigured(cfg: EnhanceLlmConfig | null): cfg is EnhanceLlmConfig {
  return Boolean(
    cfg?.baseUrl && cfg.apiKey && cfg.model && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0,
  );
}

export function assertNotModelTargetShape(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const modelTargetKeys = ['provider', 'isGlobal', 'lastTestStatus', 'createdById'];
  if (modelTargetKeys.some((key) => key in record)) {
    throw new AppError(
      400,
      '增强模型不能复用评估对象，请配置 ENHANCE_LLM_* 独立凭据',
      'ENHANCE_MODEL_TARGET_FORBIDDEN',
    );
  }
}

export function createEnhanceLlmClient(cfg: EnhanceLlmConfig): EnhanceLlmClient {
  assertNotModelTargetShape(cfg);
  return {
    chat(messages) {
      return chatComplete(
        { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
        messages,
        {
          timeoutMs: cfg.timeoutMs,
        },
      );
    },
  };
}
