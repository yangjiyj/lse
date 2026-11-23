import type {
  ChatMessage,
  LlmCallResult,
  LlmTargetConfig,
  LlmToolCall,
  LlmToolChoice,
  LlmToolDefinition,
} from '@lse/shared';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  TargetEgressError,
  fetchTarget,
  readResponseBodyLimited,
} from './target-egress-policy.js';
import { withLseCorrelationSignature } from './lse-correlation-signature.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export interface ChatCompleteOptions {
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  toolChoice?: LlmToolChoice;
  /** 外部取消信号（如任务取消时传入），与内部超时信号叠加。 */
  signal?: AbortSignal;
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errResult(
  latencyMs: number,
  httpStatus: number | null,
  error: string,
  raw: unknown,
): LlmCallResult {
  return {
    status: 'ERROR',
    content: '',
    finishReason: null,
    model: null,
    usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    latencyMs,
    httpStatus,
    error,
    raw,
  };
}

function parseJsonArguments(
  value: unknown,
): Pick<LlmToolCall, 'arguments' | 'rawArguments' | 'parseError'> {
  if (isRecord(value)) return { arguments: value };
  if (typeof value !== 'string') {
    return { arguments: {}, rawArguments: value, parseError: 'non_object_arguments' };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed)
      ? { arguments: parsed }
      : { arguments: {}, rawArguments: value, parseError: 'non_object_arguments' };
  } catch {
    return { arguments: {}, rawArguments: value, parseError: 'invalid_json_arguments' };
  }
}

function parseToolCall(value: unknown): LlmToolCall | null {
  if (!isRecord(value)) return null;
  const fn = isRecord(value.function) ? value.function : null;
  const name =
    typeof fn?.name === 'string'
      ? fn.name
      : typeof value.name === 'string'
        ? value.name
        : typeof value.tool === 'string'
          ? value.tool
          : null;
  if (name === null) return null;

  const argsValue = fn !== null && 'arguments' in fn ? fn.arguments : value.arguments;
  const parsed = parseJsonArguments(argsValue);
  const call: LlmToolCall = {
    name,
    arguments: parsed.arguments,
    raw: value,
  };
  if (typeof value.id === 'string') call.id = value.id;
  if (typeof value.type === 'string') call.type = value.type;
  if (parsed.rawArguments !== undefined) call.rawArguments = parsed.rawArguments;
  if (parsed.parseError !== undefined) call.parseError = parsed.parseError;
  return call;
}

function parseToolCalls(message: unknown): LlmToolCall[] {
  if (!isRecord(message) || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.map(parseToolCall).filter((call): call is LlmToolCall => call !== null);
}

function serializeToolCalls(toolCalls: LlmToolCall[]): unknown[] {
  return toolCalls.map((call) => {
    // 解析失败的原始参数只留在证据里；发往上游的历史必须是合法 JSON，
    // 否则 OpenAI 兼容上游会以 500 拒绝整轮请求。
    const args =
      typeof call.rawArguments === 'string' && call.parseError === undefined
        ? call.rawArguments
        : JSON.stringify(call.arguments ?? {});
    return {
      ...(call.id !== undefined ? { id: call.id } : {}),
      type: call.type ?? 'function',
      function: { name: call.name, arguments: args },
    };
  });
}

function serializeMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    const out: Record<string, unknown> = {
      role: m.role,
      content: m.contentParts && m.contentParts.length > 0 ? m.contentParts : m.content,
    };
    if (m.toolCallId !== undefined) out.tool_call_id = m.toolCallId;
    if (m.role !== 'tool' && m.name !== undefined) out.name = m.name;
    if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
      out.tool_calls = serializeToolCalls(m.toolCalls);
    }
    return out;
  });
}

async function requestChatCompletion(
  cfg: LlmTargetConfig,
  messages: ChatMessage[],
  opts: ChatCompleteOptions,
  tools?: LlmToolDefinition[],
): Promise<LlmCallResult> {
  const url = joinUrl(cfg.baseUrl, '/chat/completions');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${cfg.apiKey}`,
    ...withLseCorrelationSignature(cfg.extraHeaders ?? {}),
  };

  const body: Record<string, unknown> = {
    ...(cfg.defaultParams ?? {}),
    model: cfg.model,
    messages: serializeMessages(messages),
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (tools !== undefined) {
    body.tools = tools;
    body.tool_choice = opts.toolChoice ?? 'auto';
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }

  const startedAt = Date.now();
  try {
    const res = await fetchTarget(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      },
      {
        context: cfg.egressContext,
        // 不传会用 fetchTarget 默认的 30 秒，调用方给的超时就不生效
        timeoutMs,
      },
    );
    const text = await readResponseBodyLimited(res, DEFAULT_MAX_RESPONSE_BYTES);
    const latencyMs = Date.now() - startedAt;

    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg = json?.error?.message ?? json?.message ?? `HTTP ${res.status}`;
      return errResult(latencyMs, res.status, `模型接口返回错误：${msg}`, json ?? text);
    }

    const choice = json?.choices?.[0];
    if (!choice) {
      return errResult(latencyMs, res.status, '模型响应缺少 choices 字段', json ?? text);
    }
    const message = choice?.message;
    const content = typeof message?.content === 'string' ? message.content : '';
    const toolCalls = parseToolCalls(message);
    const u = json?.usage ?? {};
    return {
      status: 'SUCCESS',
      content,
      finishReason: choice?.finish_reason ?? null,
      model: typeof json?.model === 'string' ? json.model : null,
      usage: {
        promptTokens: numOrNull(u.prompt_tokens),
        completionTokens: numOrNull(u.completion_tokens),
        totalTokens: numOrNull(u.total_tokens),
      },
      latencyMs,
      httpStatus: res.status,
      error: null,
      raw: json ?? text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  } catch (e) {
    const latencyMs = Date.now() - startedAt;
    if (e instanceof TargetEgressError) {
      return errResult(latencyMs, null, e.message, null);
    }
    const err = e as Error;
    const aborted = err?.name === 'AbortError';
    const reason = aborted
      ? `请求超时（>${timeoutMs}ms）`
      : `网络/连接错误：${err?.message ?? String(e)}`;
    return errResult(latencyMs, null, reason, null);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用 OpenAI 兼容的 /chat/completions 接口，返回归一化结果。
 *
 * 约定：cfg.baseUrl 需包含版本前缀（如 https://api.openai.com/v1、
 * https://api.deepseek.com/v1、http://localhost:11434/v1），本函数仅在其后
 * 拼接 /chat/completions（与 OpenAI 官方 SDK 的 baseURL 约定一致）。
 *
 * 该函数被连接测试与 M5 评估执行器共用，绝不抛出异常——任何失败都归一化为
 * status: 'ERROR' 的结果，便于统一落库与展示。
 */
export async function chatComplete(
  cfg: LlmTargetConfig,
  messages: ChatMessage[],
  opts: ChatCompleteOptions = {},
): Promise<LlmCallResult> {
  return requestChatCompletion(cfg, messages, opts);
}

export async function chatCompleteWithTools(
  cfg: LlmTargetConfig,
  messages: ChatMessage[],
  tools: LlmToolDefinition[],
  opts: ChatCompleteOptions = {},
): Promise<LlmCallResult> {
  return requestChatCompletion(cfg, messages, opts, tools);
}

// 仅供单测：校验发往上游的消息序列化。
export const llmClientForTest = { serializeMessages };
