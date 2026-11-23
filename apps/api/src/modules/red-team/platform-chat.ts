import type { LlmTargetConfig } from '@lse/shared';
import type { EvaluationTargetConfig } from '../eval-targets/invoker.js';
import { createPlatformAdapter, parsePlatformAppConfig, platformAppEnabled, platformTurnToLlmResult } from '../eval-targets/platform-adapters/index.js';
import type { ChatFn } from './types.js';

/** 每个攻击历史有独立平台会话，攻击模型和判官仍经原调用器。 */
export function createPlatformTargetChat(target: EvaluationTargetConfig, targetCfg: LlmTargetConfig, fallback: ChatFn, taskId: string): ChatFn {
  const sessions = new WeakMap<object, { conversationId: string | null }>();
  const cfg = parsePlatformAppConfig(target.accessConfig);
  if (!cfg.user) cfg.user = `lse-eval-${taskId}`;
  const adapter = createPlatformAdapter(cfg, target.apiKey);
  return async (callCfg, messages, opts) => {
    if (callCfg.baseUrl !== targetCfg.baseUrl || callCfg.apiKey !== targetCfg.apiKey || callCfg.model !== targetCfg.model)
      return fallback(callCfg, messages, opts);
    if (!platformAppEnabled()) return { content: '', status: 'ERROR' };
    let session = sessions.get(messages);
    if (!session) { session = { conversationId: null }; sessions.set(messages, session); }
    const result = await adapter.sendTurn({ message: messages.filter(m => m.role === 'user').at(-1)?.content ?? '',
      conversationId: cfg.platform === 'dify' && cfg.appMode === 'workflow' ? null : session.conversationId, signal: opts?.signal });
    session.conversationId = result.conversationId ?? session.conversationId;
    return { ...platformTurnToLlmResult(result), conversationId: session.conversationId };
  };
}
