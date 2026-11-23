/** JSON-RPC 共用部分：传输接口、请求头过滤、状态码与响应解析。 */
import { readAllText, sseEvents, type Deadline } from './stream.js';
import { McpFetchError } from './types.js';
import type { TargetEgressOptions } from '../../../../lib/target-egress-policy.js';

export type EgressOptions = Omit<TargetEgressOptions, 'timeoutMs'>;
type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown; method?: unknown };

const BLOCKED_USER_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding',
  'mcp-session-id', 'mcp-protocol-version', 'last-event-id',
]);

export interface TransportContext {
  headers: Record<string, string>;
  egress: EgressOptions;
  deadline: Deadline;
  maxResponseBytes: number;
}

export interface McpTransport {
  readonly kind: 'streamable-http' | 'sse';
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  setProtocolVersion(version: string): void;
  close(): Promise<void>;
}

/** 用户提供的鉴权头原样透传（不记录）；协议控制头由本模块自己设置，用户不能覆盖。 */
export function userHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value !== 'string' || BLOCKED_USER_HEADERS.has(key.toLowerCase())) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n\0]/.test(value)) continue;
    out[key] = value;
  }
  return out;
}

export function checkStatus(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    void response.body?.cancel().catch(() => undefined);
    throw new McpFetchError('MCP_AUTH_FAILED', `服务端返回 HTTP ${response.status}，请检查鉴权头`, response.status);
  }
  if (response.status < 200 || response.status >= 300) {
    void response.body?.cancel().catch(() => undefined);
    throw new McpFetchError('MCP_NOT_MCP_RESPONSE', `服务端返回 HTTP ${response.status}`, response.status);
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new McpFetchError('MCP_NOT_MCP_RESPONSE', '响应不是合法 JSON');
  }
}

/** 从一条或一批 JSON-RPC 消息中取出 id 对应的响应；非 JSON-RPC 结构判为非 MCP 响应。 */
export function pickResponse(payload: unknown, id: number): { found: boolean; result?: unknown } {
  const list = Array.isArray(payload) ? payload : [payload];
  for (const item of list) {
    if (!item || typeof item !== 'object') throw new McpFetchError('MCP_NOT_MCP_RESPONSE', '响应不是 JSON-RPC 消息');
    const msg = item as JsonRpcMessage;
    if (msg.jsonrpc !== '2.0') throw new McpFetchError('MCP_NOT_MCP_RESPONSE', '响应缺少 jsonrpc: "2.0"');
    if (msg.id !== id || typeof msg.method === 'string') continue;
    if (msg.error && typeof msg.error === 'object') {
      const err = msg.error as { code?: unknown; message?: unknown };
      const message = typeof err.message === 'string' ? err.message.slice(0, 200) : '未知错误';
      throw new McpFetchError('MCP_PROTOCOL_ERROR', `JSON-RPC 错误 ${String(err.code ?? '')} ${message}`.trim());
    }
    if (!('result' in msg)) throw new McpFetchError('MCP_PROTOCOL_ERROR', 'JSON-RPC 响应缺少 result');
    return { found: true, result: msg.result };
  }
  return { found: false };
}

/** 读取 Streamable HTTP 的 POST 响应：application/json 或 text/event-stream。 */
export async function readRpcResponse(response: Response, id: number, ctx: TransportContext): Promise<unknown> {
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('text/event-stream')) {
    for await (const event of sseEvents(response, ctx.maxResponseBytes, ctx.maxResponseBytes, ctx.deadline)) {
      if (event.event !== 'message' || !event.data.trim()) continue;
      const picked = pickResponse(parseJson(event.data), id);
      if (picked.found) return picked.result;
    }
    throw new McpFetchError('MCP_PROTOCOL_ERROR', 'SSE 流结束但未收到对应响应');
  }
  if (!type.includes('application/json')) {
    await response.body?.cancel().catch(() => undefined);
    throw new McpFetchError('MCP_NOT_MCP_RESPONSE', `不支持的响应类型 ${type.split(';')[0] || '（空）'}`);
  }
  const picked = pickResponse(parseJson(await readAllText(response, ctx.maxResponseBytes, ctx.deadline)), id);
  if (!picked.found) throw new McpFetchError('MCP_PROTOCOL_ERROR', '响应中没有对应请求 id 的结果');
  return picked.result;
}
