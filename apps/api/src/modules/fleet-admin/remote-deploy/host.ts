import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError, badRequest } from '../../../lib/errors.js';
import { hostInScope } from '../../asset-discovery/ranges.js';
import { readScopeConfig } from '../../asset-discovery/service.js';

// 远程部署（2.4.8）的目标校验：主机、用户名只允许安全字符（不会被 ssh 当成选项），目标要在资产测绘的扫描范围里。
// 主机名只解析一次：范围判断和实际连接都用解析出的同一个 IP 字面量，挡住 DNS 重绑定。

const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/;
const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
/** 只由数字、十六进制段和点组成的写法（如 10.41.010.5、0177.0.0.1、0x0a.0.0.1、167772165）。 */
const NUMERIC_LIKE_RE = /^(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d*))*$/i;

/**
 * IPv4（只认标准点分十进制）、IPv6 或主机名（不能以 - 开头，不含 @ ; 空格等）。
 * 带前导 0、八进制、十六进制、整数写法的 IPv4 一律不收：系统解析（ssh、getaddrinfo）会按八进制等换成
 * 别的地址，与范围判断对不上。
 */
export function validDeployHost(host: string): boolean {
  if (isIP(host) !== 0) return true;
  if (NUMERIC_LIKE_RE.test(host)) return false;
  return HOSTNAME_RE.test(host);
}

export function validSshUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

export const outOfScope = () =>
  new AppError(
    403,
    '目标主机不在资产测绘的扫描范围内，请先由管理员把它所在网段加入扫描范围',
    'REMOTE_DEPLOY_OUT_OF_SCOPE',
  );

export type DeployLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

const systemLookup: DeployLookup = (host) => lookup(host, { all: true, verbatim: true });

/**
 * 校验目标在扫描范围内（只比网段不比端口），返回连接要用的 IP 字面量：
 * - IPv4：按网段判断；
 * - IPv6 字面量：扫描范围里只有 IPv4 网段和主机名，一律不在范围内；
 * - 主机名：解析出的全部地址（含 AAAA）都要在 IPv4 网段内；范围里直接写了这个主机名的，按名字放行。
 *   解析不到 400。连接用解析出的第一个 IPv4（没有才用 IPv6），不再按名字解析。
 */
export async function resolveDeployTarget(
  host: string,
  lookupFn: DeployLookup = systemLookup,
): Promise<{ host: string; address: string }> {
  const config = await readScopeConfig();
  const family = isIP(host);
  if (family === 4) {
    if (!hostInScope(host, config)) throw outOfScope();
    return { host, address: host };
  }
  if (family === 6) throw outOfScope();
  const byName = hostInScope(host, config);
  const addresses = await lookupFn(host).catch(() => []);
  if (addresses.length === 0) {
    throw badRequest(`域名解析失败：${host}`, 'REMOTE_DEPLOY_HOST_UNRESOLVED');
  }
  if (!byName && !addresses.every((a) => a.family === 4 && hostInScope(a.address, config))) {
    throw outOfScope();
  }
  const v4 = addresses.find((a) => a.family === 4);
  return { host, address: (v4 ?? addresses[0]!).address };
}
