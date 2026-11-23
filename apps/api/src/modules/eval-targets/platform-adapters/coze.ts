import type { PlatformAppConfig } from './config.js';
import type { FetchLike, PlatformAdapter } from './types.js';
import { defaultFetch, diagnoseUrls, emptyResult, events, excerpt, json, record, requestTurn, safeTurn, streamError } from './stream.js';

export function parseCozeSse(stream: string) {
  const result = emptyResult();
  let completed = false;
  try {
    for (const { event, data } of events(stream)) {
      if (typeof data.conversation_id === 'string') result.conversationId = data.conversation_id;
      if (event === 'conversation.message.delta' && data.type === 'answer') result.text += typeof data.content === 'string' ? data.content : '';
      if (event === 'conversation.message.completed' && data.type === 'function_call') {
        const call = record(json(data.content));
        if (typeof call.name !== 'string') throw new Error('函数调用缺少工具名');
        result.toolCalls.push({ name: call.name, kind: 'plugin', arguments: record(json(call.arguments ?? {})), raw: excerpt(data) });
      }
      if (event === 'conversation.message.completed' && data.type === 'tool_response') {
        const call = result.toolCalls.at(-1);
        if (call) { call.result = excerpt(data.content); call.status = 'success'; }
      }
      if (event === 'conversation.chat.completed') {
        completed = true;
        const usage = record(data.usage);
        result.usage = { promptTokens: usage.input_count, completionTokens: usage.output_count };
      }
      if (event === 'conversation.chat.failed' || event === 'error') {
        const error = record(data.last_error ?? data.error ?? data);
        result.error = { code: String(error.code ?? 'COZE_ERROR'), message: String(error.msg ?? error.message ?? '平台执行失败') };
      }
    }
    if (!completed && !result.error) return streamError(result, new Error('平台流缺少完成事件'));
    return safeTurn(result);
  } catch (error) { return streamError(result, error); }
}
export function createCozeAdapter(cfg: Extract<PlatformAppConfig, { platform: 'coze' }>, apiKey: string, fetch: FetchLike = defaultFetch): PlatformAdapter {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  return {
    sendTurn: ({ message, conversationId, signal }) => requestTurn(`${base}/v3/chat${conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : ''}`,
      { bot_id: cfg.botId, user_id: cfg.user || 'lse-eval', stream: true, additional_messages: [{ role: 'user', content: message, content_type: 'text' }] },
      apiKey, parseCozeSse, fetch, signal),
    diagnose: () => diagnoseUrls([`${base}/v1/bot/get_online_info?bot_id=${encodeURIComponent(cfg.botId)}`], apiKey, fetch),
  };
}
