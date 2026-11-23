/**
 * 出站请求封装：一律经 target-egress-policy 的 fetchTarget（含 assertTargetUrlAllowed、
 * 禁止重定向、超时），错误映射为 McpFetchError。
 *
 * 在此之上附加一条只收紧不放宽的规则：回环（127/8、::1）、链路本地（169.254/16、fe80::/10，
 * 含云元数据 169.254.169.254）与 0.0.0.0/8 始终拒绝，除非当前租户/项目的出站策略显式把该
 * origin 登记进 allowlist 且 allowPrivateNetworks=true。原因：现有策略在“未配置”时默认放行
 * 所有地址（为兼容内网模型目标），而 MCP 地址由用户填写，SSRF 到本机管理端口/元数据服务的
 * 风险更高。RFC1918 内网地址仍按现有策略处理（私有化部署的 MCP 常在内网）。
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  TargetEgressError,
  fetchTarget,
  resolveServerTargetEgressContext,
  resolveTargetEgressPolicy,
  type TargetEgressOptions,
} from '../../../../lib/target-egress-policy.js';
import { McpFetchError } from './types.js';
import type { Deadline } from './stream.js';

type EgressOptions = Omit<TargetEgressOptions, 'timeoutMs'>;

function isAlwaysBlocked(address: string): boolean {
  const addr =
    address
      .toLowerCase()
      .replace(/^\[(.*)\]$/, '$1')
      .split('%')[0] ?? '';
  // WHATWG URL canonicalizes ::ffff:127.0.0.1 to ::ffff:7f00:1.
  // Classify both mapped encodings before deciding whether this is a public IPv6 target.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  const mappedV4 = mappedHex
    ? [
        parseInt(mappedHex[1]!, 16) >> 8,
        parseInt(mappedHex[1]!, 16) & 255,
        parseInt(mappedHex[2]!, 16) >> 8,
        parseInt(mappedHex[2]!, 16) & 255,
      ].join('.')
    : null;
  const v4 = mapped?.[1] ?? mappedV4 ?? (isIP(addr) === 4 ? addr : null);
  if (v4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 127 || a === 0 || (a === 169 && b === 254);
  }
  if (isIP(addr) !== 6) return true;
  return addr === '::1' || addr === '::' || /^fe[89ab][0-9a-f]:/.test(addr);
}

export function withDefaultContext(egress: EgressOptions | undefined): EgressOptions {
  const env = egress?.env ?? process.env;
  return { ...egress, env, context: egress?.context ?? resolveServerTargetEgressContext(env) };
}

export async function assertNotLoopbackOrLinkLocal(
  rawUrl: string,
  egress: EgressOptions,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new McpFetchError('MCP_URL_NOT_ALLOWED', '目标 URL 格式非法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new McpFetchError('MCP_URL_NOT_ALLOWED', '仅支持 http 或 https 协议');
  }
  const policy = egress.policy ?? resolveTargetEgressPolicy(egress.context, egress.env);
  const explicit =
    policy.allowPrivateNetworks && policy.allowlist.includes(url.origin.toLowerCase());
  if (explicit) return;
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  let addresses: string[];
  // A bracketed URL hostname is already a validated IPv6 literal; never send it to DNS.
  if (url.hostname.startsWith('[') || isIP(host)) addresses = [host];
  else if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost'))
    addresses = ['127.0.0.1'];
  else {
    const lookup = egress.lookup ?? ((h, o) => dnsLookup(h, o));
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((item) => item.address);
    } catch {
      throw new McpFetchError('MCP_CONNECT_FAILED', `目标域名解析失败：${host}`);
    }
  }
  if (addresses.some(isAlwaysBlocked)) {
    throw new McpFetchError(
      'MCP_URL_NOT_ALLOWED',
      '目标解析到回环或链路本地地址；如确需访问，请在出站策略中显式登记该地址并开启内网访问',
    );
  }
}

function mapEgressError(error: TargetEgressError): McpFetchError {
  if (error.code === 'TARGET_EGRESS_DNS_FAILED')
    return new McpFetchError('MCP_CONNECT_FAILED', error.message);
  if (error.code === 'TARGET_RESPONSE_TOO_LARGE')
    return new McpFetchError('MCP_RESPONSE_TOO_LARGE', error.message);
  return new McpFetchError('MCP_URL_NOT_ALLOWED', error.message);
}

/** 发起一次出站请求；返回 2xx 以外的响应由调用方按协议解释。 */
export async function egressFetch(
  url: string,
  init: RequestInit,
  egress: EgressOptions,
  deadline: Deadline,
): Promise<Response> {
  deadline.assertOpen();
  await assertNotLoopbackOrLinkLocal(url, egress);
  try {
    return await fetchTarget(
      url,
      { ...init, signal: deadline.signal },
      { ...egress, timeoutMs: deadline.remaining() },
    );
  } catch (error) {
    if (error instanceof McpFetchError) throw error;
    if (error instanceof TargetEgressError) throw mapEgressError(error);
    if ((error as Error)?.name === 'AbortError' || deadline.remaining() <= 0) {
      throw new McpFetchError('MCP_TIMEOUT', '请求超时');
    }
    throw new McpFetchError('MCP_CONNECT_FAILED', '无法连接目标 MCP 服务');
  }
}
