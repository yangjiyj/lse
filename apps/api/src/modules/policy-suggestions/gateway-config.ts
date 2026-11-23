// 策略下发所需的网关连接解析：地址取系统设置「网关控制台地址」，缺省回退 NEWAPI_CONTROL_PLANE_BASE_URL；
// 令牌只认 NEWAPI_EVAL_INTEGRATION_TOKEN；地址必须通过 assertControlPlaneAllowed（不放宽）。
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { assertControlPlaneAllowed, resolveInternalToken } from '../../lib/gateway-access.js';
import type { GatewayConn } from './gateway-client.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type GatewayConnResult =
  | { ok: true; conn: GatewayConn }
  | { ok: false; reason: 'NOT_CONFIGURED' | 'NOT_ALLOWED' | 'TOKEN_MISSING'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 与系统设置「网关连通自检」一致：补 scheme 与默认端口 8080，拼 /admin/v1。 */
export function controlPlaneFromGatewayBase(base: string): string | null {
  let input = base.trim();
  if (!input) return null;
  if (!/^https?:\/\//i.test(input)) input = `http://${input}`;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  if (!url.port) url.host = `${url.hostname}:8080`;
  return `${url.protocol}//${url.host}/admin/v1`;
}

export async function resolveGatewayConn(
  db: Pick<PrismaClient, 'systemSetting'>,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn?: FetchLike,
): Promise<GatewayConnResult> {
  const row = await db.systemSetting.findUnique({ where: { key: 'gateway' } });
  const base =
    isRecord(row?.value) && typeof row.value.gatewayBaseUrl === 'string'
      ? row.value.gatewayBaseUrl
      : '';
  const controlPlaneBaseUrl =
    controlPlaneFromGatewayBase(base) || env.NEWAPI_CONTROL_PLANE_BASE_URL?.trim() || '';
  if (!controlPlaneBaseUrl) {
    return { ok: false, reason: 'NOT_CONFIGURED', message: '未配置网关地址' };
  }
  try {
    assertControlPlaneAllowed(controlPlaneBaseUrl, env);
  } catch (err) {
    return {
      ok: false,
      reason: 'NOT_ALLOWED',
      message: err instanceof AppError ? err.message : '网关地址未获授权',
    };
  }
  let internalToken: string;
  try {
    internalToken = resolveInternalToken(env);
  } catch {
    return { ok: false, reason: 'TOKEN_MISSING', message: '未配置网关集成密钥' };
  }
  const tenantId = env.NEWAPI_TENANT_ID?.trim() || 'tenant_default';
  return { ok: true, conn: { controlPlaneBaseUrl, internalToken, tenantId, fetchFn } };
}
