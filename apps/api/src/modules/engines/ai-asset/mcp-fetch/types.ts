/** MCP 工具快照抓取：类型、默认值与中文错误码。 */
import type { TargetEgressOptions } from '../../../../lib/target-egress-policy.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_LEGACY_SSE_PROTOCOL_VERSION = '2024-11-05';

export interface McpFetchOptions {
  /** 整体超时（含所有请求与响应体读取），默认 20000ms。 */
  timeoutMs?: number;
  /** 单个响应体（或单条 SSE 事件）字节上限，默认 1 MiB。 */
  maxResponseBytes?: number;
  /** 工具数上限，超出截断并标记 toolsTruncated，默认 500。 */
  maxTools?: number;
  /** tools/list 等分页页数上限，默认 20。 */
  maxPages?: number;
  /** 是否尝试 prompts/list、resources/list（失败忽略），默认 true。 */
  includePrompts?: boolean;
  includeResources?: boolean;
  /** auto：先 Streamable HTTP，服务端 404/405 时回退旧版 HTTP+SSE。 */
  transport?: 'auto' | 'streamable-http' | 'sse';
  /** 透传给 target-egress-policy（context/env/policy/lookup）；不得用于放宽生产策略。 */
  egress?: Omit<TargetEgressOptions, 'timeoutMs'>;
  now?: () => Date;
}

export const MCP_FETCH_DEFAULTS = {
  timeoutMs: 20_000,
  maxResponseBytes: 1024 * 1024,
  maxTools: 500,
  maxPages: 20,
} as const;

export interface McpToolEntry {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: Record<string, unknown> | null;
  descriptionSha256: string;
  schemaSha256: string;
  /** 与 AiComponentToolBaseline.descriptionHash 同口径：sha256(描述 + "\n" + 键排序后的 inputSchema JSON)。 */
  baselineHash: string;
}

export interface McpPromptEntry {
  name: string;
  description: string;
  arguments: unknown;
}

export interface McpResourceEntry {
  uri: string;
  name: string;
  description: string;
  mimeType: string | null;
}

export interface McpToolSnapshot {
  /** 去掉 query 中凭据类参数后的端点。 */
  endpoint: string;
  transport: 'streamable-http' | 'sse';
  protocolVersion: string;
  serverInfo: { name: string; version: string; title?: string } | null;
  tools: McpToolEntry[];
  toolsTruncated: boolean;
  /** null = 服务端未声明该能力或调用失败（已忽略）。 */
  prompts: McpPromptEntry[] | null;
  resources: McpResourceEntry[] | null;
  pages: number;
  fetchedAt: string;
  warnings: string[];
}

export type McpFetchErrorCode =
  | 'MCP_URL_NOT_ALLOWED'
  | 'MCP_CONNECT_FAILED'
  | 'MCP_TIMEOUT'
  | 'MCP_NOT_MCP_RESPONSE'
  | 'MCP_AUTH_FAILED'
  | 'MCP_PROTOCOL_ERROR'
  | 'MCP_RESPONSE_TOO_LARGE';

export const MCP_FETCH_ERROR_LABELS: Record<McpFetchErrorCode, string> = {
  MCP_URL_NOT_ALLOWED: 'URL 不允许访问',
  MCP_CONNECT_FAILED: '连接失败',
  MCP_TIMEOUT: '请求超时',
  MCP_NOT_MCP_RESPONSE: '非 MCP 响应',
  MCP_AUTH_FAILED: '鉴权失败',
  MCP_PROTOCOL_ERROR: 'MCP 协议错误',
  MCP_RESPONSE_TOO_LARGE: '响应超过大小上限',
};

/** 错误信息只含状态码、错误码与服务端 JSON-RPC 错误摘要，绝不包含请求头或 URL 查询串。 */
export class McpFetchError extends Error {
  readonly code: McpFetchErrorCode;
  readonly httpStatus: number | null;

  constructor(code: McpFetchErrorCode, detail: string, httpStatus: number | null = null) {
    super(`${MCP_FETCH_ERROR_LABELS[code]}：${detail}`);
    this.name = 'McpFetchError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
