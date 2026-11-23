import { decryptCredential, isEncryptedCredential } from '../../../lib/credential-crypto.js';
import { parsePlatformAppConfig, type PlatformAppConfig } from './config.js';
import { createDifyAdapter } from './dify.js';
import { createCozeAdapter } from './coze.js';
import type { FetchLike, PlatformAdapter } from './types.js';
export { platformAppConfigSchema, parsePlatformAppConfig, platformAppEnabled } from './config.js';
export type { PlatformAppConfig } from './config.js';
export type { PlatformAdapter, PlatformTurnResult, ObservedToolCall, FetchLike } from './types.js';

export function createPlatformAdapter(cfg: PlatformAppConfig, apiKey: string, deps?: { fetch?: FetchLike }): PlatformAdapter {
  cfg = parsePlatformAppConfig(cfg);
  if (isEncryptedCredential(apiKey)) {
    const decrypted = decryptCredential(apiKey);
    if (!decrypted) throw new Error('应用密钥无法解密，请重新填写');
    apiKey = decrypted;
  }
  return cfg.platform === 'dify' ? createDifyAdapter(cfg, apiKey, deps?.fetch) : createCozeAdapter(cfg, apiKey, deps?.fetch);
}

export function platformTurnToLlmResult(result: import('./types.js').PlatformTurnResult): import('@lse/shared').LlmCallResult {
  const promptTokens = result.usage?.promptTokens ?? null;
  const completionTokens = result.usage?.completionTokens ?? null;
  return { status: result.error ? 'ERROR' : 'SUCCESS', content: result.text, finishReason: null, model: null,
    usage: { promptTokens, completionTokens, totalTokens: promptTokens === null && completionTokens === null ? null : (promptTokens ?? 0) + (completionTokens ?? 0) },
    latencyMs: result.latencyMs, httpStatus: null, error: result.error?.message ?? null,
    raw: { toolCalls: result.toolCalls, conversationId: result.conversationId, platformError: result.error ?? null } };
}
