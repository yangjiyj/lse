/** fetchMcpToolSnapshot：initialize → notifications/initialized → tools/list（分页）→ 可选 prompts/resources。 */
import { withDefaultContext } from './egress.js';
import { sanitizeEndpoint, sha256Hex, stableStringify, toolBaselineHash } from './hash.js';
import type { McpTransport, TransportContext } from './rpc.js';
import { Deadline } from './stream.js';
import { StreamableHttpTransport } from './transport.js';
import { LegacySseTransport } from './transport-sse.js';
import {
  MCP_FETCH_DEFAULTS,
  MCP_LEGACY_SSE_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  McpFetchError,
  type McpFetchOptions,
  type McpPromptEntry,
  type McpResourceEntry,
  type McpToolEntry,
  type McpToolSnapshot,
} from './types.js';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 64 * 1024) => (typeof v === 'string' ? v.slice(0, max) : '');

async function listPaged(
  transport: McpTransport,
  method: string,
  key: string,
  maxPages: number,
  maxItems: number,
): Promise<{ items: unknown[]; pages: number; truncated: boolean }> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const seenCursors = new Set<string>();
  for (;;) {
    const result = await transport.request(method, cursor ? { cursor } : {});
    pages += 1;
    if (!isRecord(result) || !Array.isArray(result[key])) {
      throw new McpFetchError('MCP_PROTOCOL_ERROR', `${method} 结果缺少 ${key} 数组`);
    }
    items.push(...(result[key] as unknown[]));
    if (items.length >= maxItems) return { items: items.slice(0, maxItems), pages, truncated: true };
    const next = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
    if (!next) return { items, pages, truncated: false };
    if (seenCursors.has(next) || pages >= maxPages) return { items, pages, truncated: true };
    seenCursors.add(next);
    cursor = next;
  }
}

function toTool(raw: unknown): McpToolEntry | null {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !raw.name) return null;
  const description = text(raw.description);
  const inputSchema = raw.inputSchema ?? {};
  return {
    name: raw.name.slice(0, 256),
    description,
    inputSchema,
    annotations: isRecord(raw.annotations) ? raw.annotations : null,
    descriptionSha256: sha256Hex(description),
    schemaSha256: sha256Hex(stableStringify(inputSchema)),
    baselineHash: toolBaselineHash(description, inputSchema),
  };
}

async function initialize(transport: McpTransport, protocolVersion: string) {
  const result = await transport.request('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'lse-ai-component-scan', version: '1.0.0' },
  });
  if (!isRecord(result) || typeof result.protocolVersion !== 'string') {
    throw new McpFetchError('MCP_NOT_MCP_RESPONSE', 'initialize 结果缺少 protocolVersion');
  }
  const negotiated = result.protocolVersion;
  if (!(MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(negotiated)) {
    throw new McpFetchError('MCP_PROTOCOL_ERROR', `不支持的协议版本 ${negotiated.slice(0, 32)}`);
  }
  transport.setProtocolVersion(negotiated);
  await transport.notify('notifications/initialized');
  const info = isRecord(result.serverInfo) ? result.serverInfo : null;
  return {
    protocolVersion: negotiated,
    capabilities: isRecord(result.capabilities) ? result.capabilities : {},
    serverInfo: info
      ? {
          name: text(info.name, 256),
          version: text(info.version, 128),
          ...(typeof info.title === 'string' ? { title: text(info.title, 256) } : {}),
        }
      : null,
  };
}

async function open(url: string, ctx: TransportContext, mode: McpFetchOptions['transport']) {
  if (mode !== 'sse') {
    const transport = new StreamableHttpTransport(url, ctx);
    try {
      return { transport, init: await initialize(transport, MCP_PROTOCOL_VERSION) };
    } catch (error) {
      // 规范建议：POST 返回 4xx（404/405 等）时回退旧版 HTTP+SSE
      const status = error instanceof McpFetchError ? error.httpStatus : null;
      const fallback = mode === 'auto' && (status === 404 || status === 405 || status === 400);
      if (!fallback) throw error;
    }
  }
  const legacy = new LegacySseTransport(url, ctx);
  await legacy.connect();
  return { transport: legacy as McpTransport, init: await initialize(legacy, MCP_LEGACY_SSE_PROTOCOL_VERSION) };
}

export async function fetchMcpToolSnapshot(
  url: string,
  headers: Record<string, string>,
  opts: McpFetchOptions = {},
): Promise<McpToolSnapshot> {
  const deadline = new Deadline(opts.timeoutMs ?? MCP_FETCH_DEFAULTS.timeoutMs);
  const maxTools = opts.maxTools ?? MCP_FETCH_DEFAULTS.maxTools;
  const maxPages = opts.maxPages ?? MCP_FETCH_DEFAULTS.maxPages;
  const ctx: TransportContext = {
    headers,
    egress: withDefaultContext(opts.egress),
    deadline,
    maxResponseBytes: opts.maxResponseBytes ?? MCP_FETCH_DEFAULTS.maxResponseBytes,
  };
  let transport: McpTransport | null = null;
  try {
    const opened = await open(url, ctx, opts.transport ?? 'auto');
    transport = opened.transport;
    const warnings: string[] = [];
    const tools = await listPaged(transport, 'tools/list', 'tools', maxPages, maxTools);
    const parsedTools = tools.items.map(toTool).filter((t): t is McpToolEntry => t !== null);
    if (parsedTools.length < tools.items.length) warnings.push(`忽略 ${tools.items.length - parsedTools.length} 个缺少名称的工具`);
    if (tools.truncated) warnings.push(`工具列表已截断（上限 ${maxTools} 个 / ${maxPages} 页）`);
    const optional = async <T>(enabled: boolean | undefined, cap: string, method: string, key: string, map: (v: unknown) => T | null) => {
      if (enabled === false || !(cap in opened.init.capabilities)) return null;
      try {
        const got = await listPaged(transport!, method, key, maxPages, maxTools);
        return got.items.map(map).filter((v): v is T => v !== null);
      } catch (error) {
        if (error instanceof McpFetchError && error.code === 'MCP_TIMEOUT') throw error;
        warnings.push(`${method} 调用失败，已忽略`);
        return null;
      }
    };
    const prompts = await optional<McpPromptEntry>(opts.includePrompts, 'prompts', 'prompts/list', 'prompts', (p) =>
      isRecord(p) && typeof p.name === 'string' ? { name: p.name, description: text(p.description), arguments: p.arguments ?? [] } : null,
    );
    const resources = await optional<McpResourceEntry>(opts.includeResources, 'resources', 'resources/list', 'resources', (r) =>
      isRecord(r) && typeof r.uri === 'string'
        ? { uri: sanitizeEndpoint(r.uri) === '[非法 URL]' ? r.uri.slice(0, 1024) : sanitizeEndpoint(r.uri), name: text(r.name, 256), description: text(r.description), mimeType: typeof r.mimeType === 'string' ? r.mimeType : null }
        : null,
    );
    return {
      endpoint: sanitizeEndpoint(url),
      transport: transport.kind,
      protocolVersion: opened.init.protocolVersion,
      serverInfo: opened.init.serverInfo,
      tools: parsedTools,
      toolsTruncated: tools.truncated,
      prompts,
      resources,
      pages: tools.pages,
      fetchedAt: (opts.now?.() ?? new Date()).toISOString(),
      warnings,
    };
  } finally {
    await transport?.close().catch(() => undefined);
    deadline.dispose();
  }
}
