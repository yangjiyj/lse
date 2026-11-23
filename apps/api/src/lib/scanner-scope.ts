import { resolve4, resolve6 } from 'node:dns/promises';
import { isIP } from 'node:net';

export type ScannerScopeErrorCode =
  | 'SCANNER_SCOPE_POLICY_NOT_FOUND'
  | 'SCANNER_SCOPE_POLICY_INVALID'
  | 'SCANNER_SCOPE_URL_INVALID'
  | 'SCANNER_SCOPE_ORIGIN_DENIED'
  | 'SCANNER_SCOPE_DNS_FAILED'
  | 'SCANNER_SCOPE_DNS_REBINDING'
  | 'SCANNER_SCOPE_ADDRESS_DENIED'
  | 'SCANNER_SCOPE_CIDR_DENIED';

export class ScannerScopeError extends Error {
  readonly code: ScannerScopeErrorCode;

  constructor(code: ScannerScopeErrorCode, message: string) {
    super(message);
    this.name = 'ScannerScopeError';
    this.code = code;
  }
}

export interface ScannerScopePolicy {
  ref: string;
  origins: string[];
  cidrs: string[];
  allowPrivate: boolean;
  allowPublic: boolean;
}

export interface ScannerTargetPreview {
  origin: string;
  hostname: string;
  addresses: string[];
  suggestedCidrs: string[];
  allowPrivate: boolean;
  allowPublic: boolean;
}

export interface ScannerDnsRecord {
  address: string;
  ttl?: number;
}

export interface ScannerDnsResolution {
  records: ScannerDnsRecord[];
}

export type ScannerDnsResolver = (hostname: string) => Promise<ScannerDnsResolution>;

export interface ResolvedScannerTarget {
  url: URL;
  hostname: string;
  addresses: string[];
  pinnedAddress: string;
}

export interface ScannerScopeDependencies {
  resolve?: ScannerDnsResolver;
  blockedCidrs?: string[];
}

interface NumericAddress {
  family: 4 | 6;
  value: bigint;
  normalized: string;
}

interface ParsedCidr {
  family: 4 | 6;
  network: bigint;
  prefix: number;
}

const ABSOLUTE_DENY_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.azure.internal',
  'instance-data.ec2.internal',
]);

const SENSITIVE_TARGET_QUERY_KEY =
  /^(?:api[-_]?key|access[-_]?token|auth(?:orization)?|bearer|token|signature|sig|secret)$/i;

const POLICY_KEYS = new Set(['ref', 'origins', 'cidrs', 'allowPrivate', 'allowPublic']);

function trimBrackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function parseIpv4Part(input: string): number | null {
  if (!/^(?:0x[0-9a-f]+|0[0-7]*|[0-9]+)$/i.test(input)) return null;
  const radix = /^0x/i.test(input) ? 16 : input.length > 1 && input.startsWith('0') ? 8 : 10;
  const value = Number.parseInt(input, radix);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseIpv4Like(input: string): number | null {
  if (!input || input.includes(':')) return null;
  const parts = input.split('.');
  if (parts.length > 4) return null;
  const parsed = parts.map(parseIpv4Part);
  if (parsed.some((value) => value === null)) return null;
  const values = parsed as number[];
  let result: number;
  if (values.length === 1) {
    if (values[0]! > 0xffffffff) return null;
    result = values[0]!;
  } else if (values.length === 2) {
    if (values[0]! > 0xff || values[1]! > 0xffffff) return null;
    result = (values[0]! << 24) | values[1]!;
  } else if (values.length === 3) {
    if (values[0]! > 0xff || values[1]! > 0xff || values[2]! > 0xffff) return null;
    result = (values[0]! << 24) | (values[1]! << 16) | values[2]!;
  } else {
    if (values.some((value) => value > 0xff)) return null;
    result = (values[0]! << 24) | (values[1]! << 16) | (values[2]! << 8) | values[3]!;
  }
  return result >>> 0;
}

function ipv4Text(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    '.',
  );
}

function ipv6Value(input: string): bigint | null {
  let value = trimBrackets(input.toLowerCase()).split('%')[0] ?? '';
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const ipv4 = parseIpv4Like(value.slice(lastColon + 1));
    if (lastColon < 0 || ipv4 === null) return null;
    value = `${value.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(
      ipv4 & 0xffff
    ).toString(16)}`;
  }
  if (isIP(value) !== 6) return null;
  const pieces = value.split('::');
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(':').filter(Boolean) : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = pieces.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6Text(value: bigint): string {
  const groups: string[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(((value >> shift) & 0xffffn).toString(16));
  }
  return groups.join(':');
}

function numericAddress(input: string): NumericAddress | null {
  const cleaned = trimBrackets(input.trim().toLowerCase());
  const ipv4 = parseIpv4Like(cleaned);
  if (ipv4 !== null) {
    return { family: 4, value: BigInt(ipv4), normalized: ipv4Text(ipv4) };
  }
  const ipv6 = ipv6Value(cleaned);
  if (ipv6 === null) return null;
  const mappedPrefix = ipv6 >> 32n;
  if (mappedPrefix === 0xffffn || mappedPrefix === 0n) {
    const low = Number(ipv6 & 0xffffffffn);
    return { family: 4, value: BigInt(low), normalized: ipv4Text(low) };
  }
  return { family: 6, value: ipv6, normalized: ipv6Text(ipv6) };
}

function parseCidr(value: string): ParsedCidr | null {
  const [rawAddress, rawPrefix, ...extra] = value.trim().split('/');
  if (!rawAddress || !rawPrefix || extra.length > 0 || !/^\d+$/.test(rawPrefix)) return null;
  const address = numericAddress(rawAddress);
  if (!address) return null;
  const prefix = Number(rawPrefix);
  const width = address.family === 4 ? 32 : 128;
  if (prefix < 0 || prefix > width) return null;
  const shift = BigInt(width - prefix);
  return {
    family: address.family,
    network: shift === 0n ? address.value : (address.value >> shift) << shift,
    prefix,
  };
}

function cidrContains(cidr: ParsedCidr, address: NumericAddress): boolean {
  if (cidr.family !== address.family) return false;
  const width = address.family === 4 ? 32 : 128;
  const shift = BigInt(width - cidr.prefix);
  return shift === 0n
    ? address.value === cidr.network
    : address.value >> shift === cidr.network >> shift;
}

function inCidr(address: NumericAddress, cidr: string): boolean {
  const parsed = parseCidr(cidr);
  return parsed ? cidrContains(parsed, address) : false;
}

function addressClass(address: NumericAddress): 'private' | 'public' | 'denied' {
  if (address.family === 4) {
    const value = Number(address.value);
    const inRange = (start: number, end: number) => value >= start && value <= end;
    if (
      inRange(0x00000000, 0x00ffffff) ||
      inRange(0x64400000, 0x647fffff) ||
      inRange(0x7f000000, 0x7fffffff) ||
      inRange(0xa9fe0000, 0xa9feffff) ||
      inRange(0xc0000000, 0xc00000ff) ||
      inRange(0xc0000200, 0xc00002ff) ||
      inRange(0xc6120000, 0xc613ffff) ||
      inRange(0xc6336400, 0xc63364ff) ||
      inRange(0xcb007100, 0xcb0071ff) ||
      inRange(0xe0000000, 0xffffffff)
    ) {
      return 'denied';
    }
    if (
      inRange(0x0a000000, 0x0affffff) ||
      inRange(0xac100000, 0xac1fffff) ||
      inRange(0xc0a80000, 0xc0a8ffff)
    ) {
      return 'private';
    }
    return 'public';
  }

  const prefix = (bits: number) => address.value >> BigInt(128 - bits);
  if (
    address.value === 0n ||
    address.value === 1n ||
    prefix(10) === 0b1111111010n ||
    prefix(8) === 0xffn ||
    prefix(32) === 0x20010db8n
  ) {
    return 'denied';
  }
  if (prefix(7) === 0b1111110n) return 'private';
  return 'public';
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      return null;
    }
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function parseScannerScopePolicy(ref: string, value: unknown): ScannerScopePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScannerScopeError('SCANNER_SCOPE_POLICY_INVALID', '扫描范围策略格式无效');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !POLICY_KEYS.has(key))) {
    throw new ScannerScopeError('SCANNER_SCOPE_POLICY_INVALID', '扫描范围策略包含未允许字段');
  }
  if (input.ref !== ref || !Array.isArray(input.origins) || !Array.isArray(input.cidrs)) {
    throw new ScannerScopeError('SCANNER_SCOPE_POLICY_INVALID', '扫描范围策略缺少必要字段');
  }
  const origins = input.origins.map((origin) =>
    typeof origin === 'string' ? normalizeOrigin(origin) : null,
  );
  if (origins.length === 0 || origins.some((origin) => !origin)) {
    throw new ScannerScopeError('SCANNER_SCOPE_POLICY_INVALID', '扫描范围 origin 配置无效');
  }
  const cidrs = input.cidrs.filter((cidr): cidr is string => typeof cidr === 'string');
  const parsedCidrs = cidrs.map((cidr) => parseCidr(cidr));
  if (
    cidrs.length !== input.cidrs.length ||
    cidrs.length === 0 ||
    parsedCidrs.some((cidr) => !cidr || cidr.prefix === 0)
  ) {
    throw new ScannerScopeError('SCANNER_SCOPE_POLICY_INVALID', '扫描范围 CIDR 配置无效');
  }
  if (typeof input.allowPrivate !== 'boolean' || typeof input.allowPublic !== 'boolean') {
    throw new ScannerScopeError('SCANNER_SCOPE_POLICY_INVALID', '扫描范围网络类型配置无效');
  }
  if (!input.allowPrivate && !input.allowPublic) {
    throw new ScannerScopeError('SCANNER_SCOPE_POLICY_INVALID', '扫描范围未允许任何网络类型');
  }
  return {
    ref,
    origins: origins as string[],
    cidrs: [...new Set(cidrs)],
    allowPrivate: input.allowPrivate,
    allowPublic: input.allowPublic,
  };
}

export function resolveScannerScopePolicy(
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): ScannerScopePolicy {
  const raw = env.SERVICE_ASSURANCE_SCOPE_POLICIES?.trim();
  if (!raw) {
    throw new ScannerScopeError('SCANNER_SCOPE_POLICY_NOT_FOUND', '未配置服务安全核验范围策略');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ScannerScopeError(
      'SCANNER_SCOPE_POLICY_INVALID',
      '服务安全核验范围策略不是有效 JSON',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ScannerScopeError('SCANNER_SCOPE_POLICY_INVALID', '服务安全核验范围策略映射无效');
  }
  const value = (parsed as Record<string, unknown>)[ref];
  if (value === undefined) {
    throw new ScannerScopeError('SCANNER_SCOPE_POLICY_NOT_FOUND', '指定的扫描范围策略不存在');
  }
  return parseScannerScopePolicy(ref, value);
}

export function listScannerScopePolicies(
  env: NodeJS.ProcessEnv = process.env,
): ScannerScopePolicy[] {
  const raw = env.SERVICE_ASSURANCE_SCOPE_POLICIES?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ScannerScopeError(
      'SCANNER_SCOPE_POLICY_INVALID',
      '服务安全核验范围策略不是有效 JSON',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ScannerScopeError('SCANNER_SCOPE_POLICY_INVALID', '服务安全核验范围策略映射无效');
  }
  return Object.entries(parsed as Record<string, unknown>).map(([ref, value]) =>
    parseScannerScopePolicy(ref, value),
  );
}

async function systemResolve(hostname: string): Promise<ScannerDnsResolution> {
  const [ipv4, ipv6] = await Promise.allSettled([
    resolve4(hostname, { ttl: true }),
    resolve6(hostname, { ttl: true }),
  ]);
  const records: ScannerDnsRecord[] = [];
  if (ipv4.status === 'fulfilled') records.push(...ipv4.value);
  if (ipv6.status === 'fulfilled') records.push(...ipv6.value);
  if (records.length === 0 && ipv4.status === 'rejected' && ipv6.status === 'rejected') {
    throw new ScannerScopeError('SCANNER_SCOPE_DNS_FAILED', '目标域名解析失败');
  }
  return { records };
}

export async function previewScannerTarget(
  rawUrl: string,
  dependencies: ScannerScopeDependencies = {},
): Promise<ScannerTargetPreview> {
  const url = parseTargetUrl(rawUrl);
  const hostname = trimBrackets(url.hostname).toLowerCase().replace(/\.$/, '');
  if (ABSOLUTE_DENY_HOSTS.has(hostname)) {
    throw new ScannerScopeError('SCANNER_SCOPE_ADDRESS_DENIED', '目标主机属于云元数据或控制地址');
  }
  const literal = numericAddress(hostname);
  const resolution = literal
    ? { records: [{ address: literal.normalized }] }
    : await (dependencies.resolve ?? systemResolve)(hostname).catch((error: unknown) => {
        if (error instanceof ScannerScopeError) throw error;
        throw new ScannerScopeError('SCANNER_SCOPE_DNS_FAILED', '目标域名解析失败');
      });
  if (resolution.records.length === 0) {
    throw new ScannerScopeError('SCANNER_SCOPE_DNS_FAILED', '目标域名没有可用解析地址');
  }
  if (resolution.records.some((record) => record.ttl !== undefined && record.ttl <= 0)) {
    throw new ScannerScopeError('SCANNER_SCOPE_DNS_REBINDING', '目标域名 TTL 无效，拒绝潜在重绑定');
  }
  const addresses: string[] = [];
  let allowPrivate = false;
  let allowPublic = false;
  for (const record of resolution.records) {
    const address = numericAddress(record.address);
    if (!address) {
      throw new ScannerScopeError('SCANNER_SCOPE_DNS_FAILED', '目标域名返回非法 IP 地址');
    }
    const classification = addressClass(address);
    if (
      classification === 'denied' ||
      (dependencies.blockedCidrs ?? []).some((cidr) => inCidr(address, cidr))
    ) {
      throw new ScannerScopeError('SCANNER_SCOPE_ADDRESS_DENIED', '目标地址属于禁止扫描的网络范围');
    }
    if (classification === 'private') allowPrivate = true;
    if (classification === 'public') allowPublic = true;
    if (!addresses.includes(address.normalized)) addresses.push(address.normalized);
  }
  return {
    origin: url.origin.toLowerCase(),
    hostname,
    addresses,
    suggestedCidrs: addresses.map((address) => `${address}/${address.includes(':') ? 128 : 32}`),
    allowPrivate,
    allowPublic,
  };
}

function parseTargetUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ScannerScopeError('SCANNER_SCOPE_URL_INVALID', '目标 URL 格式非法');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname ||
    [...url.searchParams.keys()].some((key) => SENSITIVE_TARGET_QUERY_KEY.test(key))
  ) {
    throw new ScannerScopeError('SCANNER_SCOPE_URL_INVALID', '目标 URL 仅允许无凭据的 HTTP/S 地址');
  }
  return url;
}

function assertAddressAllowed(
  address: NumericAddress,
  policy: ScannerScopePolicy,
  blockedCidrs: string[],
): void {
  const classification = addressClass(address);
  if (classification === 'denied' || blockedCidrs.some((cidr) => inCidr(address, cidr))) {
    throw new ScannerScopeError('SCANNER_SCOPE_ADDRESS_DENIED', '目标地址属于禁止扫描的网络范围');
  }
  if (classification === 'private' && !policy.allowPrivate) {
    throw new ScannerScopeError('SCANNER_SCOPE_ADDRESS_DENIED', '扫描范围未授权内网地址');
  }
  if (classification === 'public' && !policy.allowPublic) {
    throw new ScannerScopeError('SCANNER_SCOPE_ADDRESS_DENIED', '扫描范围未授权公网地址');
  }
  if (!policy.cidrs.some((cidr) => inCidr(address, cidr))) {
    throw new ScannerScopeError('SCANNER_SCOPE_CIDR_DENIED', '目标地址不在扫描范围 CIDR 内');
  }
}

export async function resolveAndAuthorizeTarget(
  rawUrl: string,
  policy: ScannerScopePolicy,
  dependencies: ScannerScopeDependencies = {},
): Promise<ResolvedScannerTarget> {
  const url = parseTargetUrl(rawUrl);
  const hostname = trimBrackets(url.hostname).toLowerCase().replace(/\.$/, '');
  if (ABSOLUTE_DENY_HOSTS.has(hostname)) {
    throw new ScannerScopeError('SCANNER_SCOPE_ADDRESS_DENIED', '目标主机属于云元数据或控制地址');
  }

  const literal = numericAddress(hostname);
  const resolution = literal
    ? { records: [{ address: literal.normalized }] }
    : await (dependencies.resolve ?? systemResolve)(hostname).catch((error: unknown) => {
        if (error instanceof ScannerScopeError) throw error;
        throw new ScannerScopeError('SCANNER_SCOPE_DNS_FAILED', '目标域名解析失败');
      });
  if (resolution.records.length === 0) {
    throw new ScannerScopeError('SCANNER_SCOPE_DNS_FAILED', '目标域名没有可用解析地址');
  }
  if (resolution.records.some((record) => record.ttl !== undefined && record.ttl <= 0)) {
    throw new ScannerScopeError('SCANNER_SCOPE_DNS_REBINDING', '目标域名 TTL 无效，拒绝潜在重绑定');
  }

  const addresses: string[] = [];
  for (const record of resolution.records) {
    const address = numericAddress(record.address);
    if (!address) {
      throw new ScannerScopeError('SCANNER_SCOPE_DNS_FAILED', '目标域名返回非法 IP 地址');
    }
    assertAddressAllowed(address, policy, dependencies.blockedCidrs ?? []);
    if (!addresses.includes(address.normalized)) addresses.push(address.normalized);
  }

  if (!policy.origins.includes(url.origin.toLowerCase())) {
    throw new ScannerScopeError('SCANNER_SCOPE_ORIGIN_DENIED', '目标地址不在扫描范围 origin 内');
  }

  return {
    url,
    hostname,
    addresses,
    pinnedAddress: addresses[0]!,
  };
}

export async function authorizeRedirect(
  from: ResolvedScannerTarget,
  location: string,
  policy: ScannerScopePolicy,
  dependencies: ScannerScopeDependencies = {},
): Promise<ResolvedScannerTarget> {
  let target: URL;
  try {
    target = new URL(location, from.url);
  } catch {
    throw new ScannerScopeError('SCANNER_SCOPE_URL_INVALID', '目标重定向地址非法');
  }
  return resolveAndAuthorizeTarget(target.toString(), policy, dependencies);
}

export function assertPinnedConnection(
  target: ResolvedScannerTarget,
  observedAddress: string,
): void {
  const observed = numericAddress(observedAddress);
  if (!observed || observed.normalized !== target.pinnedAddress) {
    throw new ScannerScopeError('SCANNER_SCOPE_DNS_REBINDING', '实际连接地址与授权锁定地址不一致');
  }
}
