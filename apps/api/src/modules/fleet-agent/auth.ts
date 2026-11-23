// 终端接入的公共凭据函数：接入码 / 终端令牌的生成、哈希、Bearer 解析、常量时间比较与查找。
// 管理接口车道（fleet-admin）引用 hashSecret / generateEnrollmentCode / generateEndpointToken。
// 约定：接入码与终端令牌只存 sha256 小写 hex，明文只在签发时返回一次。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FleetEndpoint, FleetEnrollmentCode } from '@prisma/client';
import { prisma } from '../../db.js';

/** sha256 小写 hex。 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** 接入码：`jdc_` + 32 字节随机数的 base64url（共 47 字符）。 */
export function generateEnrollmentCode(): string {
  return 'jdc_' + randomBytes(32).toString('base64url');
}

/** 终端令牌：32 字节随机数的小写 hex（64 字符）。 */
export function generateEndpointToken(): string {
  return randomBytes(32).toString('hex');
}

/** 对采集器暴露的终端 ID：`ep_` + 20 hex。 */
export function generateEndpointPublicId(): string {
  return 'ep_' + randomBytes(10).toString('hex');
}

/** 常量时间字符串比较：先各自哈希成等长摘要，避免长度差异造成的时序泄露。 */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

/**
 * 解析 `Authorization: Bearer <token>`。不合规返回 null。
 * 与采集器约束一致：非空、≤ 8192、只允许可见 ASCII（33–126）。
 */
export function parseBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  if (header.length < 7 || header.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  const token = header.slice(7).trim();
  if (!token || token.length > 8192) return null;
  for (let i = 0; i < token.length; i += 1) {
    const c = token.charCodeAt(i);
    if (c < 33 || c > 126) return null;
  }
  return token;
}

/** 接入码可用于登记（ACTIVE 且未过期）。数量配额在登记事务里用条件原子更新判断。 */
export function enrollmentCodeUsable(code: FleetEnrollmentCode, now = new Date()): boolean {
  return code.status === 'ACTIVE' && !code.revokedAt && code.expiresAt.getTime() > now.getTime();
}

/** 按接入码明文查找可用的接入码记录（只比哈希）；无效/撤销/过期返回 null。 */
export async function findUsableEnrollmentCode(
  plaintext: string,
  now = new Date(),
): Promise<FleetEnrollmentCode | null> {
  const row = await prisma.fleetEnrollmentCode.findUnique({
    where: { codeHash: hashSecret(plaintext) },
  });
  return row && enrollmentCodeUsable(row, now) ? row : null;
}

/** 按终端令牌明文查找 ACTIVE 终端（只比哈希）；不存在或已吊销返回 null。 */
export async function findEndpointByToken(plaintext: string): Promise<FleetEndpoint | null> {
  const row = await prisma.fleetEndpoint.findUnique({
    where: { tokenHash: hashSecret(plaintext) },
  });
  return row && row.status === 'ACTIVE' && !row.revokedAt ? row : null;
}
