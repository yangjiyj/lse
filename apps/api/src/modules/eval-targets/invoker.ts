import { createPlatformAdapter, parsePlatformAppConfig, platformAppEnabled, platformTurnToLlmResult } from './platform-adapters/index.js';
import type { ChatMessage, LlmCallResult, LlmTargetConfig } from '@lse/shared';
import { readJsonPath } from '@lse/shared';
import { chatComplete } from '../../lib/llm-client.js';
import type { McpJsonRpcCall } from '../agent-evals/types.js';
import { parseMcpAccessConfig, postMcpToolCall } from './mcp-client.js';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  TargetEgressError,
  fetchTarget,
  readResponseBodyLimited,
  resolveServerTargetEgressContext,
} from '../../lib/target-egress-policy.js';
import { withLseCorrelationSignature } from '../../lib/lse-correlation-signature.js';
import { aggregateStream, detectStreamFormat } from '../../lib/stream-aggregate.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const RESPONSE_PATHS = ['answer', 'content', 'message', 'output', 'data.answer'] as const;
const UNSAFE_OBJECT_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

type TargetTypeValue = 'MODEL' | 'AGENT_API' | 'PUBLIC_AGENT' | 'MCP_OPENAPI' | 'GATEWAY_LOG' | 'PLATFORM_APP';

export interface EvaluationTargetConfig {
  targetType?: TargetTypeValue | string | null;
  baseUrl: string;
  apiKey: string;
  model: string;
  extraHeaders?: unknown;
  defaultParams?: unknown;
  accessConfig?: unknown;
}

export interface InvokeEvaluationTargetOptions {
  callModel?: (
    cfg: LlmTargetConfig,
    messages: ChatMessage[],
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<LlmCallResult>;
  timeoutMs?: number;
  sessionId?: string;
  correlationHeaders?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * MCP 攻击载荷（tools/call）。MCP_OPENAPI 目标必须由 mcp-runner 通过此项注入 payload；
   * 不注入时说明是 MCP 目标被当普通对话调用（无攻击语义），返回明确错误而非静默放行。
   */
  mcpCall?: McpJsonRpcCall;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}

function asUnknownRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function lastUserMessage(messages: ChatMessage[]): string {
  return messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
}

function gatewaySessionHeaders(
  target: Pick<EvaluationTargetConfig, 'targetType' | 'accessConfig'>,
  sessionId?: string,
): Record<string, string> | null {
  if (target.targetType !== 'GATEWAY_LOG') return null;
  const value = sessionId?.trim();
  if (!value) return null;
  const accessConfig = asUnknownRecord(target.accessConfig) ?? {};
  const configuredHeader =
    typeof accessConfig.sessionHeaderName === 'string' ? accessConfig.sessionHeaderName.trim() : '';
  return { [configuredHeader || 'X-NewAPI-Session-Id']: value };
}

export function withGatewaySessionHeader(
  target: Pick<EvaluationTargetConfig, 'targetType' | 'accessConfig'>,
  cfg: LlmTargetConfig,
  sessionId?: string,
): LlmTargetConfig {
  const sessionHeaders = gatewaySessionHeaders(target, sessionId);
  if (sessionHeaders === null) return cfg;
  return {
    ...cfg,
    extraHeaders: {
      ...(cfg.extraHeaders ?? {}),
      ...sessionHeaders,
    },
  };
}

function mergeExtraHeaders(
  headers: Record<string, string> | null,
  correlationHeaders?: Record<string, string>,
): Record<string, string> | null {
  if (correlationHeaders === undefined || Object.keys(correlationHeaders).length === 0) {
    return headers;
  }
  return { ...(headers ?? {}), ...correlationHeaders };
}

function toCfg(
  target: EvaluationTargetConfig,
  sessionId?: string,
  correlationHeaders?: Record<string, string>,
): LlmTargetConfig {
  return withGatewaySessionHeader(
    target,
    {
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      model: target.model,
      extraHeaders: mergeExtraHeaders(asStringRecord(target.extraHeaders), correlationHeaders),
      defaultParams: asUnknownRecord(target.defaultParams),
    },
    sessionId,
  );
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

function renderTemplate(value: unknown, prompt: string, sessionId = ''): unknown {
  if (typeof value === 'string') {
    return value.replaceAll('{{prompt}}', prompt).replaceAll('{{session_id}}', sessionId);
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, prompt, sessionId));
  if (isRecord(value)) {
    const rendered: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_OBJECT_PATH_SEGMENTS.has(key)) continue;
      rendered[key] = renderTemplate(item, prompt, sessionId);
    }
    return rendered;
  }
  return value;
}

function pathValue(value: unknown, path: string): unknown {
  // 支持 a.b 与 choices[0].message.content 两种写法；拒绝原型链字段。
  return readJsonPath(value, path);
}

export function extractResponseText(json: unknown, configuredPath: unknown): string | null {
  const paths =
    typeof configuredPath === 'string' && configuredPath.trim()
      ? [configuredPath.trim(), ...RESPONSE_PATHS]
      : [...RESPONSE_PATHS];
  for (const path of paths) {
    const value = pathValue(json, path);
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function agentHeaders(
  target: EvaluationTargetConfig,
  accessConfig: Record<string, unknown>,
  correlationHeaders?: Record<string, string>,
  sessionId?: string,
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(asStringRecord(target.extraHeaders) ?? {}),
    ...(asStringRecord(accessConfig.headers) ?? {}),
    ...(correlationHeaders ?? {}),
  };
  const authType = typeof accessConfig.authType === 'string' ? accessConfig.authType : 'bearer';
  if (target.apiKey && authType === 'bearer') headers.authorization = `Bearer ${target.apiKey}`;
  if (target.apiKey && authType === 'api_key') {
    const name =
      typeof accessConfig.authHeaderName === 'string' ? accessConfig.authHeaderName : 'X-API-Key';
    headers[name] = target.apiKey;
  }
  // 固定会话：配置会话请求头后，同一评估样本的多轮请求携带同一会话标识。
  const sessionHeaderName =
    typeof accessConfig.sessionHeaderName === 'string' ? accessConfig.sessionHeaderName.trim() : '';
  if (sessionHeaderName && sessionId?.trim()) headers[sessionHeaderName] = sessionId.trim();
  return withLseCorrelationSignature(headers);
}

/** 构造智能体应用 API 的请求头与请求体；调用器与接入诊断共用，保证诊断所测即评估所用。 */
export function buildAgentApiRequest(
  target: EvaluationTargetConfig,
  prompt: string,
  correlationHeaders?: Record<string, string>,
  sessionId?: string,
): { headers: Record<string, string>; body: unknown; accessConfig: Record<string, unknown> } {
  const accessConfig = asUnknownRecord(target.accessConfig) ?? {};
  const template = accessConfig.requestTemplate ?? { input: '{{prompt}}' };
  return {
    headers: agentHeaders(target, accessConfig, correlationHeaders, sessionId),
    body: renderTemplate(template, prompt, sessionId?.trim() ?? ''),
    accessConfig,
  };
}

async function invokeAgentApi(
  target: EvaluationTargetConfig,
  messages: ChatMessage[],
  timeoutMs: number,
  correlationHeaders?: Record<string, string>,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<LlmCallResult> {
  const { headers, body, accessConfig } = buildAgentApiRequest(
    target,
    lastUserMessage(messages),
    correlationHeaders,
    sessionId,
  );
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  const startedAt = Date.now();
  try {
    const res = await fetchTarget(
      target.baseUrl,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      },
      {
        context: resolveServerTargetEgressContext(),
        timeoutMs,
      },
    );
    const text = await readResponseBodyLimited(res, DEFAULT_MAX_RESPONSE_BYTES);
    const latencyMs = Date.now() - startedAt;
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg =
        isRecord(json) && typeof json.message === 'string' ? json.message : `HTTP ${res.status}`;
      return errResult(latencyMs, res.status, `智能体应用 API 返回错误：${msg}`, json ?? text);
    }
    const streamFormat =
      json === null ? detectStreamFormat(res.headers.get('content-type'), text) : null;
    if (streamFormat !== null) {
      // SSE / NDJSON 流式响应：聚合增量文本为完整回答。
      const aggregated = aggregateStream(
        text,
        streamFormat,
        typeof accessConfig.responseTextPath === 'string' ? accessConfig.responseTextPath : null,
      );
      const label = streamFormat === 'sse' ? 'SSE' : 'NDJSON';
      if (aggregated.text === null) {
        return errResult(
          latencyMs,
          res.status,
          `智能体应用 API 流式响应（${label}）中未找到可识别的回答字段`,
          text.slice(0, 4000),
        );
      }
      return {
        status: 'SUCCESS',
        content: aggregated.text,
        finishReason: null,
        model: target.model,
        usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        latencyMs,
        httpStatus: res.status,
        error: null,
        raw: {
          stream: streamFormat,
          events: aggregated.events.length,
          last: aggregated.lastJsonEvent,
        },
      };
    }
    const content = extractResponseText(json, accessConfig.responseTextPath);
    if (content === null) {
      return errResult(
        latencyMs,
        res.status,
        '智能体应用 API 响应缺少可识别的回答字段',
        json ?? text,
      );
    }
    return {
      status: 'SUCCESS',
      content,
      finishReason: null,
      model: target.model,
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      latencyMs,
      httpStatus: res.status,
      error: null,
      raw: json ?? text,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error instanceof TargetEgressError) {
      return errResult(latencyMs, null, error.message, null);
    }
    const err = error as Error;
    const reason =
      err.name === 'AbortError'
        ? `请求超时（>${timeoutMs}ms）`
        : `网络/连接错误：${err.message ?? String(error)}`;
    return errResult(latencyMs, null, reason, null);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * MCP_OPENAPI 目标：经网关 /mcp/{serverID} 发一条 tools/call 攻击载荷。
 * 载荷由 mcp-runner 通过 options.mcpCall 注入；accessConfig 提供 serverID/gatewayBaseUrl。
 * 网关侧按 correlationHeaders 的 trace_id 归因，audit-only 铁律下网关只审计不真拦。
 */
async function invokeMcpTarget(
  target: EvaluationTargetConfig,
  options: InvokeEvaluationTargetOptions,
): Promise<LlmCallResult> {
  if (options.mcpCall === undefined) {
    return errResult(
      0,
      null,
      'MCP/OpenAPI 被测对象需要 MCP 攻击样本（metadata.kind=mcp_runtime）经 MCP 发起器执行，不能作为普通对话目标直连',
      null,
    );
  }
  const parsed = parseMcpAccessConfig(target.accessConfig);
  if (parsed.config === null) {
    return errResult(0, null, `MCP 被测对象配置无效：${parsed.error ?? '未知原因'}`, null);
  }
  const outcome = await postMcpToolCall({
    gatewayBaseUrl: parsed.config.gatewayBaseUrl,
    serverID: parsed.config.serverID,
    apiKey: target.apiKey,
    call: options.mcpCall,
    correlationHeaders: options.correlationHeaders,
    extraHeaders: asStringRecord(target.extraHeaders),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (outcome.status === 'ERROR') {
    return errResult(
      outcome.latencyMs,
      outcome.httpStatus,
      outcome.error ?? 'MCP 调用失败',
      outcome.raw,
    );
  }
  // 网关放行/拦截都算「成功发起攻击并拿到网关响应」；堵没堵住由归因段按审计判定。
  const content =
    outcome.immediateDecision === 'blocked' || outcome.immediateDecision === 'confirm'
      ? (outcome.blockReason ?? '网关拦截 MCP tools/call')
      : typeof outcome.jsonRpcResult === 'string'
        ? outcome.jsonRpcResult
        : JSON.stringify(outcome.jsonRpcResult ?? outcome.jsonRpcError ?? '');
  return {
    status: 'SUCCESS',
    content,
    finishReason: null,
    model: target.model,
    usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    latencyMs: outcome.latencyMs,
    httpStatus: outcome.httpStatus,
    error: null,
    raw: {
      kind: 'mcp_tool_call',
      immediateDecision: outcome.immediateDecision,
      blockReason: outcome.blockReason,
      jsonRpcResult: outcome.jsonRpcResult,
      jsonRpcError: outcome.jsonRpcError,
      response: outcome.raw,
    },
  };
}

export async function invokeEvaluationTarget(
  target: EvaluationTargetConfig,
  messages: ChatMessage[],
  options: InvokeEvaluationTargetOptions = {},
): Promise<LlmCallResult> {
  const targetType = target.targetType ?? 'MODEL';
  if (targetType === 'PLATFORM_APP') {
    if (!platformAppEnabled()) return errResult(0, 403, '平台智能体测评功能未启用', null);
    try {
      const cfg = parsePlatformAppConfig(target.accessConfig);
      if (!cfg.user) cfg.user = `lse-eval-${options.sessionId?.split(':')[0] || 'content'}`;
      return platformTurnToLlmResult(await createPlatformAdapter(cfg, target.apiKey).sendTurn({
        message: lastUserMessage(messages), conversationId: null, signal: options.signal,
      }));
    } catch { return errResult(0, null, '平台智能体配置无效', null); }
  }
  if (targetType === 'AGENT_API' || targetType === 'PUBLIC_AGENT') {
    return invokeAgentApi(
      target,
      messages,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.correlationHeaders,
      options.signal,
      options.sessionId,
    );
  }
  if (targetType === 'MCP_OPENAPI') {
    return invokeMcpTarget(target, options);
  }
  return (options.callModel ?? chatComplete)(
    toCfg(target, options.sessionId, options.correlationHeaders),
    messages,
    { timeoutMs: options.timeoutMs, signal: options.signal },
  );
}
