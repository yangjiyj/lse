// AI 资产测绘：扫描范围解析与校验。
// 放行来源只有管理员配置的范围；默认空 = 不扫描任何范围。仅支持 IPv4 CIDR 与主机清单。
// 扫描目标另可写完整 URL（http/https）或「主机:端口」（按 http://主机:端口 处理），
// 主机和端口同样要落在已配置范围内。
// 目标写法不对抛 TargetFormatError（接口返回 400）；写法对但不在授权范围内抛普通 Error（403）。

import { isIP } from 'node:net';

export class TargetFormatError extends Error {}

export const HARD_MAX_HOSTS_PER_RUN = 256;
export const HARD_MAX_PORTS = 16;
export const MIN_CIDR_PREFIX = 16;

export interface ScopeEntry {
  kind: 'cidr' | 'host';
  text: string;
  /** IPv4 数值区间（闭区间），主机名条目为 null。 */
  start: number | null;
  end: number | null;
  hostCount: number;
}

export interface ScopeConfig {
  entries: string[];
  ports: number[];
  maxHostsPerRun: number;
}

export interface ScanEndpoint {
  scheme: 'http' | 'https';
  host: string;
  port: number;
  /** URL 的路径前缀，去掉末尾斜杠；非 URL 目标为空串。 */
  basePath: string;
}

export interface ScanPlan {
  hosts: string[];
  ports: number[];
  endpoints: ScanEndpoint[];
}

const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// 云元数据/链路本地、"本网络"、组播与保留段一律不允许进入扫描范围。
const BLOCKED_RANGES: Array<[number, number]> = [
  [ipToInt('0.0.0.0'), ipToInt('0.255.255.255')],
  [ipToInt('169.254.0.0'), ipToInt('169.254.255.255')],
  [ipToInt('224.0.0.0'), ipToInt('255.255.255.255')],
];

export function ipToInt(ip: string): number {
  const m = IPV4_RE.exec(ip);
  if (!m) return Number.NaN;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return Number.NaN;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function isIpv4(value: string): boolean {
  return !Number.isNaN(ipToInt(value));
}

export function isBlockedIpv4(ip: string): boolean {
  const n = ipToInt(ip);
  if (Number.isNaN(n)) return true;
  return BLOCKED_RANGES.some(([s, e]) => n >= s && n <= e);
}

function overlapsBlocked(start: number, end: number): boolean {
  return BLOCKED_RANGES.some(([s, e]) => start <= e && end >= s);
}

export function parseScopeEntry(raw: string): ScopeEntry {
  const bad = (msg: string) => new TargetFormatError(msg);
  const text = raw.trim().toLowerCase();
  if (!text) throw bad('范围条目不能为空');
  const slash = text.indexOf('/');
  if (slash >= 0) {
    const ip = text.slice(0, slash);
    const prefixText = text.slice(slash + 1);
    const base = ipToInt(ip);
    if (Number.isNaN(base) || !/^\d{1,2}$/.test(prefixText)) {
      throw bad(`范围条目格式不合法：${raw}`);
    }
    const prefix = Number(prefixText);
    if (prefix > 32) throw bad(`范围条目格式不合法：${raw}`);
    if (prefix < MIN_CIDR_PREFIX) throw bad(`CIDR 前缀不能小于 /${MIN_CIDR_PREFIX}：${raw}`);
    const size = 2 ** (32 - prefix);
    if (base % size !== 0) throw bad(`CIDR 必须使用网络地址：${raw}`);
    const end = base + size - 1;
    if (overlapsBlocked(base, end)) throw bad(`不允许扫描保留/链路本地/组播地址段：${raw}`);
    return { kind: 'cidr', text: `${ip}/${prefix}`, start: base, end, hostCount: size };
  }
  if (isIpv4(text)) {
    if (isBlockedIpv4(text)) throw bad(`不允许扫描保留/链路本地/组播地址：${raw}`);
    const n = ipToInt(text);
    return { kind: 'cidr', text: `${text}/32`, start: n, end: n, hostCount: 1 };
  }
  if (!HOSTNAME_RE.test(text) || /^\d+$/.test(text.replace(/\./g, ''))) {
    throw bad(`范围条目格式不合法：${raw}`);
  }
  return { kind: 'host', text, start: null, end: null, hostCount: 1 };
}

const URL_PREFIX_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** 「主机:端口」：主机里不含 /、: 和空白，端口为数字。 */
const HOST_PORT_RE = /^[^\s/:]+:\d{1,5}$/;
const MAX_BASE_PATH = 256;

/** 按 URL 处理的目标：完整 URL，或「主机:端口」。 */
export function isUrlTarget(raw: string): boolean {
  const text = raw.trim();
  return URL_PREFIX_RE.test(text) || HOST_PORT_RE.test(text);
}

/** URL 原文里的主机部分（小写）：去掉协议、账号、端口和路径。 */
function rawHostOf(text: string): string {
  const authority = text.replace(URL_PREFIX_RE, '').split(/[/\\?#]/, 1)[0] ?? '';
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  return hostPort.replace(/:\d*$/, '').toLowerCase();
}

/**
 * 解析 URL 目标；只收 http/https，不收账号口令、查询参数、锚点和 IPv6。
 * 「主机:端口」按 http://主机:端口 处理。
 * 主机原文必须与解析结果一致：010.0.0.5（八进制）、0x0a.0.0.5、2130706433 这类写法
 * 会被 URL 解析成别的地址，一律拒绝，请写成标准 IP。
 */
export function parseUrlTarget(raw: string): ScanEndpoint {
  const bad = (msg: string) => new TargetFormatError(msg);
  const trimmed = raw.trim();
  const text = URL_PREFIX_RE.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw bad(`URL 格式不合法：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw bad(`URL 只支持 http 和 https：${raw}`);
  }
  if (url.username || url.password) throw bad(`URL 不能带账号口令：${raw}`);
  if (url.search || url.hash || /[?#]/.test(text)) {
    throw bad(`URL 不能带查询参数或锚点：${raw}`);
  }
  const host = url.hostname.toLowerCase();
  if (!host || host.startsWith('[')) throw bad(`URL 主机不合法：${raw}`);
  if (rawHostOf(text) !== host) {
    throw bad(
      isIpv4(host)
        ? `URL 主机请写成标准 IP（点分十进制、不带前导 0，如 10.0.0.5）：${raw}`
        : `URL 主机不合法：${raw}`,
    );
  }
  let entry: ScopeEntry;
  try {
    entry = parseScopeEntry(host);
  } catch (err) {
    const msg = (err as Error).message;
    throw bad(msg.includes('不允许') ? msg : `URL 主机不合法：${raw}`);
  }
  if (entry.kind === 'cidr' && entry.hostCount !== 1) throw bad(`URL 主机不合法：${raw}`);
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  const port = url.port ? Number(url.port) : scheme === 'https' ? 443 : 80;
  if (port < 1 || port > 65535) throw bad(`URL 端口不合法：${raw}`);
  const basePath = url.pathname.replace(/\/+$/, '');
  if (basePath.length > MAX_BASE_PATH) throw bad(`URL 路径过长：${raw}`);
  return { scheme, host, port, basePath };
}

/** 端点写成文本，协议、主机、端口、路径前缀都写全（审计用）。 */
export function endpointText(e: ScanEndpoint): string {
  return `${e.scheme}://${e.host}:${e.port}${e.basePath}`;
}

export interface ParsedTargets {
  plain: ScopeEntry[];
  urls: Array<{ target: string; endpoint: ScanEndpoint }>;
}

/** 只校验写法，不看授权范围；写法不对抛 TargetFormatError。 */
export function parseScanTargets(targets: string[]): ParsedTargets {
  if (!targets.length) throw new TargetFormatError('请填写扫描目标');
  const out: ParsedTargets = { plain: [], urls: [] };
  for (const t of targets) {
    if (isUrlTarget(t)) out.urls.push({ target: t, endpoint: parseUrlTarget(t) });
    else out.plain.push(parseScopeEntry(t));
  }
  return out;
}

function tryParse(raw: unknown): ScopeEntry | null {
  if (typeof raw !== 'string') return null;
  try {
    return parseScopeEntry(raw);
  } catch {
    return null;
  }
}

export function normalizeScopeConfig(value: unknown): ScopeConfig {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const entries = Array.isArray(v.entries)
    ? [
        ...new Set(
          v.entries
            .map(tryParse)
            .filter((e): e is ScopeEntry => !!e)
            .map((e) => e.text),
        ),
      ]
    : [];
  const ports = Array.isArray(v.ports)
    ? [
        ...new Set(v.ports.filter((p): p is number => Number.isInteger(p) && p >= 1 && p <= 65535)),
      ].slice(0, HARD_MAX_PORTS)
    : [];
  const rawMax = typeof v.maxHostsPerRun === 'number' ? Math.floor(v.maxHostsPerRun) : 64;
  const maxHostsPerRun = Math.min(Math.max(rawMax, 1), HARD_MAX_HOSTS_PER_RUN);
  return { entries, ports, maxHostsPerRun };
}

/**
 * 远程部署（2.4.8）：目标主机是否在已配置的扫描范围里，只比网段不比端口。
 * 标准写法的 IPv4 按网段判断，其余按同名的主机名条目判断（调用方先把主机名解析成 IP 再判一次）。
 */
export function hostInScope(host: string, config: ScopeConfig): boolean {
  const scope = config.entries.map(tryParse).filter((e): e is ScopeEntry => !!e);
  const text = host.trim().toLowerCase();
  // 只认标准点分十进制：10.41.010.5 这类写法 ipToInt 会按十进制算，系统解析却按八进制，不能当 IPv4 判。
  if (isIP(text) === 4) {
    const n = ipToInt(text);
    return scope.some((s) => s.kind === 'cidr' && s.start! <= n && n <= s.end!);
  }
  return scope.some((s) => s.kind === 'host' && s.text === text);
}

function covered(target: ScopeEntry, scope: ScopeEntry[]): boolean {
  if (target.kind === 'host') return scope.some((s) => s.kind === 'host' && s.text === target.text);
  return scope.some((s) => s.kind === 'cidr' && s.start! <= target.start! && s.end! >= target.end!);
}

/** 把请求的目标展开为端点清单；任一目标不在已配置范围内即整体拒绝。 */
export function expandScanTargets(
  targets: string[],
  ports: number[],
  config: ScopeConfig,
): ScanPlan {
  const { plain: parsed, urls: urlTargets } = parseScanTargets(targets);
  if (parsed.length && !ports.length) throw new TargetFormatError('请选择扫描端口');
  if (!config.entries.length || !config.ports.length) {
    throw new Error('管理员尚未配置扫描范围或端口，默认不扫描任何范围');
  }
  const scope = config.entries.map((e) => parseScopeEntry(e));
  const urls = urlTargets.map((u) => u.endpoint);
  for (const t of parsed) {
    if (!covered(t, scope)) throw new Error(`扫描目标不在已配置范围内：${t.text}`);
  }
  for (const u of urls) {
    const entry = parseScopeEntry(u.host);
    if (!covered(entry, scope)) throw new Error(`扫描目标不在已配置范围内：${u.host}`);
    if (!config.ports.includes(u.port)) throw new Error(`端口 ${u.port} 不在已配置端口列表内`);
  }
  const plainPorts = parsed.length ? [...new Set(ports)] : [];
  for (const p of plainPorts) {
    if (!config.ports.includes(p)) throw new Error(`端口 ${p} 不在已配置端口列表内`);
  }
  const total = parsed.reduce((sum, t) => sum + t.hostCount, 0) + urls.length;
  if (total > config.maxHostsPerRun) {
    throw new Error(`单次扫描主机数 ${total} 超过上限 ${config.maxHostsPerRun}`);
  }
  const endpoints: ScanEndpoint[] = [];
  const seen = new Set<string>();
  const push = (e: ScanEndpoint) => {
    const key = `${e.scheme}://${e.host}:${e.port}${e.basePath}`;
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push(e);
  };
  for (const t of parsed) {
    const hosts: string[] = [];
    if (t.kind === 'host') hosts.push(t.text);
    else for (let n = t.start!; n <= t.end!; n += 1) hosts.push(intToIp(n));
    for (const host of hosts) {
      for (const port of plainPorts) push({ scheme: 'http', host, port, basePath: '' });
    }
  }
  for (const u of urls) push(u);
  return {
    hosts: [...new Set(endpoints.map((e) => e.host))],
    ports: [...new Set(endpoints.map((e) => e.port))],
    endpoints,
  };
}
