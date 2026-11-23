// LSE → JJDGUARD 策略建议通道：能力探测 / 下发 / 状态查询。
// 鉴权沿用 eval-integration 共享密钥（Bearer）+ X-JJDGuard-Tenant-Id；地址受 GATEWAY_CONTROL_PLANE_ALLOWLIST 约束。
// 令牌只进请求头，不进错误信息、日志或返回体。
import { integrationEndpoint } from '../gateway-logs/client.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const POLICY_SUGGESTIONS_CAPABILITY = 'policy_suggestions.v1';
export const GATEWAY_TIMEOUT_MS = 10_000;
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface GatewayConn {
  controlPlaneBaseUrl: string;
  internalToken: string;
  tenantId: string;
  fetchFn?: FetchLike;
}

export interface GatewaySuggestionBody {
  external_id: string;
  source: 'lse';
  type: string;
  action: 'block' | 'alert' | 'mask';
  payload: Record<string, unknown>;
}

export interface GatewaySuggestionState {
  id: string;
  externalId: string;
  status: 'pending_approval' | 'published' | 'rejected' | string;
  ruleSetId: string | null;
  ruleSetVersion: string | null;
  reviewNote: string | null;
}

export class GatewayCallError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'GatewayCallError';
  }
}

function headers(conn: GatewayConn, json = false): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: `Bearer ${conn.internalToken}`,
    'x-jjdguard-tenant-id': conn.tenantId,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

async function call(conn: GatewayConn, path: string, init: RequestInit): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GATEWAY_TIMEOUT_MS);
  try {
    const res = await (conn.fetchFn ?? fetch)(integrationEndpoint(conn.controlPlaneBaseUrl, path), {
      ...init,
      signal: ac.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const code =
        body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
          ? ((body as { error: string }).error as string)
          : null;
      throw new GatewayCallError(`网关返回 HTTP ${res.status}`, res.status, code);
    }
    return body;
  } catch (err) {
    if (err instanceof GatewayCallError) throw err;
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new GatewayCallError(aborted ? '连接网关超时（>10s）' : '无法连接网关', null, null);
  } finally {
    clearTimeout(timer);
  }
}

export interface CapabilityResult {
  reachable: boolean;
  supported: boolean;
  capabilities: string[];
  error: string | null;
}

export async function probePolicyCapability(conn: GatewayConn): Promise<CapabilityResult> {
  try {
    const body = await call(conn, '/health', { method: 'GET', headers: headers(conn) });
    const raw =
      body && typeof body === 'object' ? (body as { capabilities?: unknown }).capabilities : null;
    const capabilities = Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === 'string')
      : [];
    return {
      reachable: true,
      supported: capabilities.includes(POLICY_SUGGESTIONS_CAPABILITY),
      capabilities,
      error: null,
    };
  } catch (err) {
    return {
      reachable: false,
      supported: false,
      capabilities: [],
      error: err instanceof Error ? err.message : '无法连接网关',
    };
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function normalizeState(body: unknown): GatewaySuggestionState {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const id = str(b.id);
  const status = str(b.status);
  if (!id || !status) throw new GatewayCallError('网关返回的建议缺少 id 或状态', 200, null);
  return {
    id,
    externalId: str(b.external_id) ?? '',
    status,
    ruleSetId: str(b.rule_set_id),
    ruleSetVersion: str(b.rule_set_version),
    reviewNote: str(b.review_note),
  };
}

export async function submitPolicySuggestion(
  conn: GatewayConn,
  body: GatewaySuggestionBody,
): Promise<GatewaySuggestionState> {
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new GatewayCallError('建议内容超过 64KiB 上限', null, 'payload_too_large');
  }
  const res = await call(conn, '/policy-suggestions', {
    method: 'POST',
    headers: headers(conn, true),
    body: json,
  });
  return normalizeState(res);
}

export async function fetchPolicySuggestionState(
  conn: GatewayConn,
  idOrExternalId: string,
): Promise<GatewaySuggestionState> {
  const res = await call(conn, `/policy-suggestions/${encodeURIComponent(idOrExternalId)}`, {
    method: 'GET',
    headers: headers(conn),
  });
  return normalizeState(res);
}
