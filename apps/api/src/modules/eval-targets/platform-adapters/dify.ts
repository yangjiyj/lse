import type { PlatformAppConfig } from './config.js';
import type { FetchLike, ObservedToolCall, PlatformAdapter } from './types.js';
import { defaultFetch, diagnoseUrls, emptyResult, events, excerpt, json, record, requestTurn, safeTurn, streamError } from './stream.js';

export function parseDifySse(stream: string) {
  const result = emptyResult();
  let completed = false;
  const thoughts = new Map<string, { call: ObservedToolCall; position: number }>();
  try {
    for (const { event, data } of events(stream)) {
      if (typeof data.conversation_id === 'string') result.conversationId = data.conversation_id;
      if (event === 'message' || event === 'agent_message') result.text += typeof data.answer === 'string' ? data.answer : '';
      if (event === 'agent_thought') {
        const inputs = record(json(data.tool_input || '{}'));
        let observations: Record<string, any> = {};
        try { observations = record(json(data.observation)); } catch { /* 单工具也可能返回纯文本。 */ }
        const names = data.tool ? String(data.tool).split(';').map(n => n.trim()).filter(Boolean)
          : [...thoughts.entries()].filter(([key]) => typeof data.id === 'string' && key.startsWith(`${data.id}:`)).map(([, item]) => item.call.name);
        for (const name of names) {
          const key = `${data.id ?? `event-${thoughts.size}`}:${name}`;
          const previous = thoughts.get(key);
          const call: ObservedToolCall = { name, kind: /^dataset_[0-9a-f_]+$/i.test(name) ? 'knowledge' : 'tool',
            arguments: { ...previous?.call.arguments, ...record(inputs[name] ?? (names.length === 1 ? inputs : {})) },
            result: data.observation ? excerpt(observations[name] ?? data.observation) : previous?.call.result ?? '',
            status: 'success', raw: excerpt(data) };
          thoughts.set(key, { call, position: typeof data.position === 'number' ? data.position : previous?.position ?? thoughts.size });
        }
      }
      if (event === 'node_finished') {
        const node = record(data.data);
        const kinds: Record<string, ObservedToolCall['kind']> = { tool: 'tool', 'http-request': 'http', 'knowledge-retrieval': 'knowledge', code: 'code', agent: 'workflow_node' };
        const kind = kinds[node.node_type];
        if (kind) result.toolCalls.push({ name: String(node.title ?? node.node_id ?? node.node_type), kind,
          arguments: record(node.inputs), result: excerpt(node.outputs), status: node.status === 'failed' ? 'error' : 'success', raw: excerpt(node) });
      }
      if (event === 'message_end' || event === 'workflow_finished') {
        completed = true;
        const usage = record(record(data.metadata).usage ?? record(data.data).usage);
        result.usage = { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
        if (event === 'workflow_finished') {
          const run = record(data.data);
          const outputs = record(run.outputs);
          result.text = typeof outputs.answer === 'string' ? outputs.answer : typeof outputs.text === 'string' ? outputs.text : JSON.stringify(outputs);
          if (run.status === 'failed') result.error = { code: 'WORKFLOW_FAILED', message: String(run.error ?? '工作流执行失败') };
        }
      }
      if (event === 'error') result.error = { code: String(data.code ?? 'DIFY_ERROR'), message: String(data.message ?? '平台执行失败') };
    }
    result.toolCalls.unshift(...[...thoughts.values()].sort((a, b) => a.position - b.position).map(item => item.call));
    if (!completed && !result.error) return streamError(result, new Error('平台流缺少完成事件'));
    return safeTurn(result);
  } catch (error) { return streamError(result, error); }
}
export function createDifyAdapter(cfg: Extract<PlatformAppConfig, { platform: 'dify' }>, apiKey: string, fetch: FetchLike = defaultFetch): PlatformAdapter {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  return {
    sendTurn: ({ message, conversationId, signal }) => {
      const workflow = cfg.appMode === 'workflow';
      const body = workflow
        ? { inputs: { ...cfg.inputs, query: message }, response_mode: 'streaming', user: cfg.user || 'lse-eval' }
        : { query: message, inputs: cfg.inputs ?? {}, response_mode: 'streaming', conversation_id: conversationId ?? '', user: cfg.user || 'lse-eval' };
      return requestTurn(`${base}/${workflow ? 'workflows/run' : 'chat-messages'}`, body, apiKey, parseDifySse, fetch, signal);
    },
    diagnose: () => diagnoseUrls([`${base}/info`, `${base}/parameters`], apiKey, fetch),
  };
}
