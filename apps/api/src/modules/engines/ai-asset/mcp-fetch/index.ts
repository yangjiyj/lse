/**
 * MCP 工具快照抓取与基线比对（AI 组件扫描用）。
 * 出站请求一律经 lib/target-egress-policy（见 egress.ts）；鉴权头不进日志、错误信息或快照。
 */
export { fetchMcpToolSnapshot } from './fetch.js';
export { diffToolBaseline } from './diff.js';
export type {
  BaselineEntry,
  ToolBaselineDiff,
  ToolDescriptionChange,
  ToolSchemaChange,
  ToolShadowing,
} from './diff.js';
export {
  MCP_FETCH_DEFAULTS,
  MCP_FETCH_ERROR_LABELS,
  MCP_PROTOCOL_VERSION,
  McpFetchError,
} from './types.js';
export type {
  McpFetchErrorCode,
  McpFetchOptions,
  McpPromptEntry,
  McpResourceEntry,
  McpToolEntry,
  McpToolSnapshot,
} from './types.js';
export { sanitizeEndpoint, stableStringify, toolBaselineHash } from './hash.js';
