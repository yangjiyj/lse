import type { McpJsonRpcCall } from '../agent-evals/types.js';
import { withLseCorrelationSignature } from '../../lib/lse-correlation-signature.js';

/**
 * MCP 测-堵-验闭环的低层 JSON-RPC 客户端。
 *
 * LSE 作为红队，经 AI 算力安全网关向目标 MCP server 发 `tools/call`：
 *   POST {gatewayBaseUrl}/mcp/{serverID}
 *   body = { jsonrpc:'2.0', id, method:'tools/call', params:{ name, arguments } }
 * 网关（gateway-core :8080）在 tools/call 上做内联红线复检并落审计三连，
 * 带 X-LSE-* 关联头即可被网关按同一 trace_id 归因（见 auth.go extractLSECorrelationHeaders）。
 *
 * 铁律：本模块只负责「测」（发起攻击）与「读即时响应」，绝不执行任何危险载荷、
 * 也不改变网关行为。破坏性命令/凭证/SSRF 载荷仅作为 tools/call 参数发给被测网关拦截。
 */

const DEFAULT_TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  if (typeof field !== 'string') return undefined;
  const trimmed = field.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** MCP 被测对象的接入配置（承载在 ModelTarget.accessConfig）。 */
export interface McpAccessConfig {
  /** 已在网关 mcp_servers 登记的 server id，用于拼 /mcp/{serverID}。 */
  serverID: string;
  /** 网关数据面前缀（已由 routes 归一化，如 http://host:8080）。 */
  gatewayBaseUrl: string;
  /** control-plane 前缀（.../admin/v1），拉契约/归因/触发 sync 用。 */
  controlPlaneBaseUrl: string;
  /** 租户标识（多租户隔离 + 归因回查 x-newapi-tenant-id）。 */
  tenantId: string;
  /** 拉契约/归因/管理端点用的内部共享密钥（可选，缺省回落全局 resolveInternalToken）。 */
  internalToken?: string;
  /** 可选：允许攻击的工具白名单（超出即跳过，避免打到无关工具）。 */
  toolAllowlist?: string[];
}

export interface ParseMcpAccessConfigResult {
  config: McpAccessConfig | null;
  /** 缺配置时给出机器可读原因（供归因判 LSE_MCP_* 用）。 */
  error: string | null;
}

/**
 * 解析并校验 MCP accessConfig。serverID / gatewayBaseUrl / controlPlaneBaseUrl 必填，
 * 否则无法发起攻击或回查归因（会导致 LSE_TRACE_HEADER_MISSING 一类空转）。
 */
export function parseMcpAccessConfig(accessConfig: unknown): ParseMcpAccessConfigResult {
  const serverID = stringField(accessConfig, 'serverID') ?? stringField(accessConfig, 'serverId');
  if (!serverID) {
    return { config: null, error: 'MCP accessConfig 缺少 serverID' };
  }
  const gatewayBaseUrl = stringField(accessConfig, 'gatewayBaseUrl');
  if (!gatewayBaseUrl) {
    return { config: null, error: 'MCP accessConfig 缺少 gatewayBaseUrl' };
  }
  const controlPlaneBaseUrl =
    stringField(accessConfig, 'controlPlaneBaseUrl') ??
    `${trimTrailingSlash(gatewayBaseUrl)}/admin/v1`;
  const rawAllowlist = isRecord(accessConfig) ? accessConfig.toolAllowlist : undefined;
  const toolAllowlist = Array.isArray(rawAllowlist)
    ? rawAllowlist.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      )
    : undefined;
  return {
    config: {
      serverID,
      gatewayBaseUrl: trimTrailingSlash(gatewayBaseUrl),
      controlPlaneBaseUrl: trimTrailingSlash(controlPlaneBaseUrl),
      tenantId: stringField(accessConfig, 'tenantId') ?? 'tenant_default',
      ...(stringField(accessConfig, 'internalToken')
        ? { internalToken: stringField(accessConfig, 'internalToken') }
        : {}),
      ...(toolAllowlist && toolAllowlist.length > 0 ? { toolAllowlist } : {}),
    },
    error: null,
  };
}

/** 网关拦截信号：JSON-RPC 层与错误文案的按名镜像（权威源是 gateway-core mcp_proxy）。 */
const MCP_BLOCK_SIGNAL_RE =
  /hard_floor_block|security_blocked|mcp_redline|blocked by (security|policy)|requires AgentGuard confirmation|policy_block|tool call blocked/i;
/** confirm 类：网关建二次确认单并以 -32000 拒绝本次请求。 */
const MCP_CONFIRM_SIGNAL_RE =
  /requires? (agentguard )?confirmation|需要二次确认|confirm(ation)? required/i;

export type McpImmediateDecision = 'blocked' | 'confirm' | 'passthrough' | 'transport_error';

/** 单次 tools/call 的即时结果（「测」+「读响应」，权威「验」由网关审计归因确定）。 */
export interface McpCallOutcome {
  status: 'SUCCESS' | 'ERROR';
  httpStatus: number | null;
  latencyMs: number;
  /** JSON-RPC result 对象（网关放行且上游有响应时）。 */
  jsonRpcResult: unknown;
  /** JSON-RPC error 对象（网关拒绝或上游报错时）。 */
  jsonRpcError: { code: number; message: string; data?: unknown } | null;
  /** 从即时响应识别出的网关裁决（仅供参考，audit-only 下网关放行故不足以判「堵」）。 */
  immediateDecision: McpImmediateDecision;
  /** 命中拦截信号时的原因文案。 */
  blockReason: string | null;
  /** 原始响应文本/负载，进证据链。 */
  raw: unknown;
  /** 传输/连接错误信息（status=ERROR 时）。 */
  error: string | null;
}

function classifyImmediate(
  httpStatus: number,
  jsonRpcError: { code: number; message: string } | null,
): { decision: McpImmediateDecision; reason: string | null } {
  const message = jsonRpcError?.message ?? '';
  // JSON-RPC -32000 = 服务端约定的策略拒绝码（confirm / hard_floor）。
  const isPolicyCode = jsonRpcError?.code === -32000;
  if (MCP_CONFIRM_SIGNAL_RE.test(message)) {
    return { decision: 'confirm', reason: message };
  }
  if (isPolicyCode || MCP_BLOCK_SIGNAL_RE.test(message) || httpStatus === 403) {
    return { decision: 'blocked', reason: message || `HTTP ${httpStatus}` };
  }
  return { decision: 'passthrough', reason: null };
}

export interface PostMcpToolCallOptions {
  gatewayBaseUrl: string;
  serverID: string;
  apiKey: string;
  call: McpJsonRpcCall;
  /** X-LSE-* 五头（测-堵-验粘合剂），网关按其归因。 */
  correlationHeaders?: Record<string, string>;
  extraHeaders?: Record<string, string> | null;
  requestId?: number | string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchFn?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * 向网关 /mcp/{serverID} 发一条 tools/call，返回归一化的即时结果。
 * 绝不抛异常（传输错误归 status=ERROR），以便上层稳定归一化 verdict。
 */
export async function postMcpToolCall(options: PostMcpToolCallOptions): Promise<McpCallOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${trimTrailingSlash(options.gatewayBaseUrl)}/mcp/${encodeURIComponent(options.serverID)}`;
  const fetchFn = options.fetchFn ?? fetch;
  const body = {
    jsonrpc: '2.0',
    id: options.requestId ?? 1,
    method: options.call.method,
    params: options.call.params,
  };
  const headers: Record<string, string> = withLseCorrelationSignature({
    'content-type': 'application/json',
    accept: 'application/json',
    ...(options.extraHeaders ?? {}),
    ...(options.correlationHeaders ?? {}),
  });
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) ac.abort();
    else options.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  const startedAt = Date.now();
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    const latencyMs = Date.now() - startedAt;
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const jsonRpcError =
      isRecord(json) && isRecord(json.error)
        ? {
            code: typeof json.error.code === 'number' ? json.error.code : 0,
            message: typeof json.error.message === 'string' ? json.error.message : '',
            ...(json.error.data === undefined ? {} : { data: json.error.data }),
          }
        : null;
    const jsonRpcResult = isRecord(json) ? (json.result ?? null) : null;
    const { decision, reason } = classifyImmediate(res.status, jsonRpcError);
    return {
      status: 'SUCCESS',
      httpStatus: res.status,
      latencyMs,
      jsonRpcResult,
      jsonRpcError,
      immediateDecision: decision,
      blockReason: reason,
      raw: json ?? text,
      error: null,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const err = error as Error;
    const reason =
      err.name === 'AbortError'
        ? `MCP tools/call 超时（>${timeoutMs}ms）`
        : `MCP tools/call 网络/连接错误：${err.message ?? String(error)}`;
    return {
      status: 'ERROR',
      httpStatus: null,
      latencyMs,
      jsonRpcResult: null,
      jsonRpcError: null,
      immediateDecision: 'transport_error',
      blockReason: null,
      raw: null,
      error: reason,
    };
  } finally {
    clearTimeout(timer);
  }
}
