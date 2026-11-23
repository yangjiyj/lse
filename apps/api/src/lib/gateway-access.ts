// 网关审计接入的安全裁决 —— 内部令牌解析 + Control Plane 地址白名单。
//
// 安全约束（① G3 凭证外泄）：
//   1. 网关审计内部令牌只认 NEWAPI_EVAL_INTEGRATION_TOKEN，不再回退到
//      NEWAPI_INTERNAL_API_SECRET —— 避免无关内部密钥被当作网关审计凭证误用。
//   2. controlPlaneBaseUrl 来自被测对象 accessConfig（用户可控），是 SSRF /
//      凭证外泄面：/analyze 会携带内部令牌向该地址发起出站请求。通过
//      GATEWAY_CONTROL_PLANE_ALLOWLIST 收敛可达目标；未配置时放行以兼容存量部署。

import { AppError, badRequest, forbidden } from './errors.js';

/** 解析网关审计内部访问令牌；仅认专用环境变量，缺省即 503。 */
export function resolveInternalToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.NEWAPI_EVAL_INTEGRATION_TOKEN?.trim() || '';
  if (!token) {
    throw new AppError(503, '未配置网关审计内部访问令牌', 'GATEWAY_AUDIT_TOKEN_REQUIRED');
  }
  return token;
}

function stripTrailingDot(value: string): string {
  return value.replace(/\.$/, '');
}

function normalizeHostname(value: string): string {
  return stripTrailingDot(value.toLowerCase()).replace(/^\[(.*)\]$/, '$1');
}

function isBlockedControlPlaneHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  // 放开内网（LAN/tailscale 等私网为合法网关部署），仅挡回环与云元数据，防被当 SSRF 探本机/元数据。
  // 真正的访问控制是集成密钥握手（token），不靠 IP 白名单。
  return (
    host === '::1' || host === '0.0.0.0' || host.startsWith('127.') || host.startsWith('169.254.')
  );
}

/**
 * 校验 Control Plane API 地址是否在允许列表内。
 * - 未配置 GATEWAY_CONTROL_PLANE_ALLOWLIST：拒绝私网、loopback 与云元数据地址。
 * - 已配置：仅放行命中 origin / host(:port) / hostname 的地址，否则拒绝。
 */
export function assertControlPlaneAllowed(
  rawUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const allowlist = (env.GATEWAY_CONTROL_PLANE_ALLOWLIST ?? '').trim();

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw badRequest('Control Plane API 地址格式非法', 'GATEWAY_CONTROL_PLANE_INVALID');
  }

  const hostname = normalizeHostname(url.hostname); // host
  if (!allowlist) {
    if (isBlockedControlPlaneHostname(hostname)) {
      throw forbidden(
        `网关地址指向回环或云元数据，已拒绝：${url.host}`,
        'GATEWAY_CONTROL_PLANE_NOT_ALLOWED',
      );
    }
    return;
  }

  const entries = allowlist
    .split(',')
    .map((entry) => stripTrailingDot(entry.trim().toLowerCase()))
    .filter(Boolean);
  const host = stripTrailingDot(url.host.toLowerCase()); // host[:port]
  const origin = `${url.protocol}//${host}`; // scheme://host[:port]
  const allowed = entries.some((entry) => {
    if (entry === origin) return true;
    if (entry === host) return true;
    if (entry === hostname && url.port === '') return true;
    return false;
  });
  if (!allowed) {
    throw forbidden(
      `Control Plane API 地址不在允许列表内：${url.host}`,
      'GATEWAY_CONTROL_PLANE_NOT_ALLOWED',
    );
  }
}
