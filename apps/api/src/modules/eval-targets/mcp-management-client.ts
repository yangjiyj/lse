import type { McpRegistryOutcome } from '../assurance/mcp-attribution.js';

/**
 * 注册/同步期 MCP 攻击（tool_poisoning / shadow_tool / rug_pull）的控制面客户端。
 *
 * 这三类不发 tools/call、运行时不复检，而是走 control-plane 管理端点触发 observe-only 检测：
 *   - sync：        POST {controlPlaneBaseUrl}/mcp-servers/{id}/sync  → poisoned_tool_count / changed / previous_hash
 *   - shadow-check：GET  {controlPlaneBaseUrl}/mcp-tools/shadow-check → warnings[]
 * 铁律：observe-only，本模块只读检测结果，绝不改网关行为。
 */

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface ManagementBase {
  controlPlaneBaseUrl: string;
  tenantId: string;
  /** 内部共享密钥（Bearer）；管理端点也可能要求管理员会话，缺权限时归 ok=false。 */
  internalToken: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function headers(base: ManagementBase): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${base.internalToken.trim()}`,
    'x-newapi-tenant-id': base.tenantId.trim(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function numField(value: unknown, snake: string, camel: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[snake] ?? value[camel];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function strField(value: unknown, snake: string, camel: string): string | null {
  if (!isRecord(value)) return null;
  const raw = value[snake] ?? value[camel];
  return typeof raw === 'string' ? raw : null;
}

async function withTimeout<T>(
  timeoutMs: number,
  signalHolder: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await signalHolder(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

export interface TriggerMcpSyncOptions extends ManagementBase {
  serverID: string;
}

/**
 * 触发 server 同步：投毒（poisoned_tool_count）与 rug-pull（changed/previous_hash）都从这里读判据。
 * 绝不抛异常——失败归 ok=false，供归因判 LSE_MCP_INVOKE_FAILED。
 */
export async function triggerMcpSync(options: TriggerMcpSyncOptions): Promise<McpRegistryOutcome> {
  const fetchFn = options.fetchFn ?? fetch;
  const url = `${trimTrailingSlash(options.controlPlaneBaseUrl)}/mcp-servers/${encodeURIComponent(
    options.serverID,
  )}/sync`;
  try {
    return await withTimeout(options.timeoutMs ?? 30_000, async (signal) => {
      const res = await fetchFn(url, { method: 'POST', headers: headers(options), signal });
      const body = await readJson(res);
      if (!res.ok) {
        return { ok: false, error: `sync HTTP ${res.status}` };
      }
      return {
        ok: true,
        poisonedToolCount: numField(body, 'poisoned_tool_count', 'poisonedToolCount'),
        changed: isRecord(body) ? body.changed === true : undefined,
        previousHash: strField(body, 'previous_hash', 'previousHash'),
        manifestHash: strField(body, 'manifest_hash', 'manifestHash'),
      };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface FetchMcpShadowCheckOptions extends ManagementBase {
  serverID?: string;
}

/** 影子工具检测：读 warnings 条数作为判据（零 DB 写）。 */
export async function fetchMcpShadowCheck(
  options: FetchMcpShadowCheckOptions,
): Promise<McpRegistryOutcome> {
  const fetchFn = options.fetchFn ?? fetch;
  const base = `${trimTrailingSlash(options.controlPlaneBaseUrl)}/mcp-tools/shadow-check`;
  const url = new URL(base);
  if (options.serverID) url.searchParams.set('server_id', options.serverID);
  try {
    return await withTimeout(options.timeoutMs ?? 30_000, async (signal) => {
      const res = await fetchFn(url, { method: 'GET', headers: headers(options), signal });
      const body = await readJson(res);
      if (!res.ok) {
        return { ok: false, error: `shadow-check HTTP ${res.status}` };
      }
      const warnings = isRecord(body) ? (body.warnings ?? body.Warnings) : undefined;
      return {
        ok: true,
        shadowWarningCount: Array.isArray(warnings) ? warnings.length : 0,
      };
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
