import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';

export const DEFAULT_MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

export type TargetEgressErrorCode =
  | 'TARGET_EGRESS_POLICY_REQUIRED'
  | 'TARGET_EGRESS_POLICY_INVALID'
  | 'TARGET_EGRESS_CONTEXT_REQUIRED'
  | 'TARGET_EGRESS_URL_INVALID'
  | 'TARGET_EGRESS_TARGET_NOT_ALLOWED'
  | 'TARGET_EGRESS_DNS_FAILED'
  | 'TARGET_EGRESS_PRIVATE_ADDRESS'
  | 'TARGET_EGRESS_REDIRECT_BLOCKED'
  | 'TARGET_RESPONSE_TOO_LARGE';

export class TargetEgressError extends Error {
  readonly code: TargetEgressErrorCode;

  constructor(code: TargetEgressErrorCode, message: string) {
    super(message);
    this.name = 'TargetEgressError';
    this.code = code;
  }
}

export interface TargetEgressContext {
  tenantId?: string;
  projectId?: string;
}

export interface TargetEgressPolicy {
  allowlist: string[];
  allowPrivateNetworks: boolean;
}

type PolicyEntry = string[] | { allowlist?: unknown; allowPrivateNetworks?: unknown };

export interface TargetEgressOptions {
  context?: TargetEgressContext;
  env?: NodeJS.ProcessEnv;
  policy?: TargetEgressPolicy;
  timeoutMs?: number;
  lookup?: (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;
}

function clean(value: string): string {
  return value.trim().replace(/\.$/, '').toLowerCase();
}

function parseAllowlist(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
  const origins: string[] = [];
  for (const item of values) {
    if (typeof item !== 'string' || !item.trim()) continue;
    try {
      const parsed = new URL(item.trim());
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) {
        continue;
      }
      origins.push(clean(parsed.origin));
    } catch {
      // Malformed policy entries are ignored and can never broaden access.
    }
  }
  return [...new Set(origins)];
}

function parsePolicyEntry(value: unknown): TargetEgressPolicy {
  if (Array.isArray(value)) {
    return { allowlist: parseAllowlist(value), allowPrivateNetworks: false };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entry = value as PolicyEntry & Record<string, unknown>;
    return {
      allowlist: parseAllowlist(entry.allowlist),
      allowPrivateNetworks: entry.allowPrivateNetworks === true,
    };
  }
  return { allowlist: [], allowPrivateNetworks: false };
}

function parseJsonPolicy(raw: string, context: TargetEgressContext): TargetEgressPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { allowlist: [], allowPrivateNetworks: false };
  }
  if (Array.isArray(parsed)) return parsePolicyEntry(parsed);
  if (!parsed || typeof parsed !== 'object') return { allowlist: [], allowPrivateNetworks: false };
  const map = parsed as Record<string, unknown>;
  const tenant = context.tenantId?.trim();
  const project = context.projectId?.trim();
  if (!tenant || !project) return { allowlist: [], allowPrivateNetworks: false };
  const key = `${tenant}/${project}`;
  for (const candidate of [key, `${tenant}/*`, `*/${project}`, '*/*']) {
    if (Object.prototype.hasOwnProperty.call(map, candidate))
      return parsePolicyEntry(map[candidate]);
  }
  return { allowlist: [], allowPrivateNetworks: false };
}

/**
 * Resolve the server-owned egress policy. LSE_TARGET_EGRESS_POLICIES is the
 * preferred tenant/project map; the flat allowlist is retained for a single-
 * tenant deployment and tests. Missing/invalid policies resolve to deny.
 */
export function resolveTargetEgressPolicy(
  context: TargetEgressContext = {},
  env: NodeJS.ProcessEnv = process.env,
): TargetEgressPolicy {
  const mapped = env.LSE_TARGET_EGRESS_POLICIES?.trim();
  if (mapped) return parseJsonPolicy(mapped, context);
  const allowlist = parseAllowlist(env.LSE_TARGET_EGRESS_ALLOWLIST ?? '');
  return {
    allowlist,
    allowPrivateNetworks: env.LSE_TARGET_EGRESS_ALLOW_PRIVATE === 'true',
  };
}

function hasConfiguredTargetEgressPolicy(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.LSE_TARGET_EGRESS_POLICIES?.trim() || env.LSE_TARGET_EGRESS_ALLOWLIST?.trim());
}

/** 出站策略的布尔摘要（供前端提示）；刻意不包含允许清单内容。 */
export function summarizeTargetEgressPolicy(
  context: TargetEgressContext = resolveServerTargetEgressContext(),
  env: NodeJS.ProcessEnv = process.env,
): { allowlistConfigured: boolean; allowPrivateNetworks: boolean } {
  if (!hasConfiguredTargetEgressPolicy(env)) return { allowlistConfigured: false, allowPrivateNetworks: false };
  return { allowlistConfigured: true, allowPrivateNetworks: resolveTargetEgressPolicy(context, env).allowPrivateNetworks };
}

/** Resolve the process-owned scope; request payloads must never override it. */
export function resolveServerTargetEgressContext(env: NodeJS.ProcessEnv = process.env): {
  tenantId: string;
  projectId: string;
} {
  return {
    tenantId: env.LSE_TENANT_ID?.trim() || 'tenant_default',
    projectId: env.LSE_PROJECT_ID?.trim() || 'project_default',
  };
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return null;
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return (((a * 256 + b) * 256 + c) * 256 + d) >>> 0;
}

function inIpv4Range(value: number, start: number, end: number): boolean {
  return value >= start && value <= end;
}

function isPrivateIpv4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) return true;
  return (
    inIpv4Range(value, 0x00000000, 0x00ffffff) ||
    inIpv4Range(value, 0x0a000000, 0x0affffff) ||
    inIpv4Range(value, 0x64400000, 0x647fffff) ||
    inIpv4Range(value, 0x7f000000, 0x7fffffff) ||
    inIpv4Range(value, 0xa9fe0000, 0xa9feffff) ||
    inIpv4Range(value, 0xac100000, 0xac1fffff) ||
    inIpv4Range(value, 0xc0000000, 0xc00000ff) ||
    inIpv4Range(value, 0xc0a80000, 0xc0a8ffff) ||
    inIpv4Range(value, 0xc6120000, 0xc613ffff) ||
    inIpv4Range(value, 0xe0000000, 0xffffffff)
  );
}

function expandIpv6(address: string): bigint | null {
  const value = address.toLowerCase().split('%')[0] ?? '';
  const chunks = value.split('::');
  if (chunks.length > 2) return null;
  const left = chunks[0] ? chunks[0].split(':').filter(Boolean) : [];
  const right = chunks.length === 2 && chunks[1] ? chunks[1].split(':').filter(Boolean) : [];
  if (chunks.length === 1 && left.length !== 8) return null;
  if (
    left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) ||
    right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))
  )
    return null;
  const all =
    chunks.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      : left;
  if (all.length !== 8) return null;
  return all.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n);
}

function isPrivateAddress(rawAddress: string): boolean {
  const address =
    rawAddress
      .toLowerCase()
      .replace(/^\[(.*)\]$/, '$1')
      .split('%')[0] ?? '';
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1] ?? '');
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) !== 6) return true;
  const value = expandIpv6(address);
  if (value === null) return true;
  const prefix = (bits: number) => value >> BigInt(128 - bits);
  return (
    prefix(7) === 0n || prefix(10) === 0b1111111010n || prefix(8) === 0n || prefix(8) === 0xffn
  );
}

function isIpLiteral(hostname: string): boolean {
  return isIP(hostname.replace(/^\[(.*)\]$/, '$1')) !== 0;
}

/** Validate the URL and its current DNS answers before an outbound request. */
export async function assertTargetUrlAllowed(
  rawUrl: string,
  options: TargetEgressOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TargetEgressError('TARGET_EGRESS_URL_INVALID', '目标 URL 格式非法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TargetEgressError('TARGET_EGRESS_URL_INVALID', '目标 URL 仅支持 http 或 https');
  }
  if (url.username || url.password || url.hash || !url.hostname) {
    throw new TargetEgressError(
      'TARGET_EGRESS_URL_INVALID',
      '目标 URL 不得包含凭据、片段或非法端口',
    );
  }
  const env = options.env ?? process.env;
  const policyConfigured = options.policy !== undefined || hasConfiguredTargetEgressPolicy(env);
  const policy = options.policy ?? resolveTargetEgressPolicy(options.context, env);
  if (!policyConfigured) return url;
  if (policy.allowlist.length === 0) {
    throw new TargetEgressError(
      'TARGET_EGRESS_POLICY_REQUIRED',
      '未配置当前租户/项目的目标出站允许清单',
    );
  }
  const origin = clean(url.origin);
  if (!policy.allowlist.includes(origin)) {
    throw new TargetEgressError(
      'TARGET_EGRESS_TARGET_NOT_ALLOWED',
      `目标地址不在允许清单内：${url.origin}`,
    );
  }

  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const addresses: LookupAddress[] = isIpLiteral(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await (options.lookup ?? ((host, lookupOptions) => dnsLookup(host, lookupOptions)))(
        hostname,
        {
          all: true,
          verbatim: true,
        },
      ).catch((error: unknown) => {
        throw new TargetEgressError('TARGET_EGRESS_DNS_FAILED', `目标域名解析失败：${hostname}`);
      });
  if (addresses.length === 0)
    throw new TargetEgressError('TARGET_EGRESS_DNS_FAILED', `目标域名没有解析地址：${hostname}`);
  if (!policy.allowPrivateNetworks && addresses.some((item) => isPrivateAddress(item.address))) {
    throw new TargetEgressError(
      'TARGET_EGRESS_PRIVATE_ADDRESS',
      '目标域名解析到未授权的内网、回环或链路本地地址',
    );
  }
  return url;
}

/** Fetch a target without following redirects; callers must handle a redirect as an error. */
export async function fetchTarget(
  rawUrl: string,
  init: RequestInit,
  options: TargetEgressOptions = {},
): Promise<Response> {
  const url = await assertTargetUrlAllowed(rawUrl, options);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const upstreamSignal = init.signal;
  const onAbort = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort();
    else upstreamSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      throw new TargetEgressError(
        'TARGET_EGRESS_REDIRECT_BLOCKED',
        '目标接口返回重定向，出站请求已拒绝',
      );
    }
    return response;
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', onAbort);
  }
}

export async function readResponseBodyLimited(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new TargetEgressError('TARGET_RESPONSE_TOO_LARGE', `目标响应超过 ${maxBytes} 字节上限`);
  }
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TargetEgressError(
          'TARGET_RESPONSE_TOO_LARGE',
          `目标响应超过 ${maxBytes} 字节上限`,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
