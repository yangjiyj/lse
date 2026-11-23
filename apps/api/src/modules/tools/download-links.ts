import { createHash, randomBytes } from 'node:crypto';
import { putEphemeral, takeEphemeral } from '../../lib/public-rate-limit.js';

// 工具版本的一次性下载链接：页面先用登录令牌换一个 60 秒有效、只能用一次的下载令牌，
// 再用普通链接让浏览器原生下载（大文件不经 blob、不占内存）。
// 令牌只存哈希，放在 Redis 里；取的时候原子地取出并删除（GETDEL），重复使用拿不到。

export interface DownloadLinkGrant {
  toolId: string;
  versionId: string;
  /** 签发人：下载记录、审计都记他。 */
  userId: string;
  /** 签发时能不能看隐藏工具（有 tool:manage）。 */
  canManage: boolean;
  /** 签发时所在的租户范围（审计记到这个租户，和带登录令牌下载一致）；全部租户视角为 null。 */
  tenantId: string | null;
}

/** 有效期（毫秒）；测试里可以改短。 */
export const downloadLinkSettings = { ttlMs: 60_000 };

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function redisKey(token: string): string {
  return `tool-dl:${createHash('sha256').update(token).digest('hex')}`;
}

export function isDownloadToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/** 签发一个下载令牌。Redis 不可用时抛错。 */
export async function issueDownloadLink(
  grant: DownloadLinkGrant,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const ttlMs = downloadLinkSettings.ttlMs;
  await putEphemeral(redisKey(token), JSON.stringify(grant), ttlMs);
  return { token, expiresAt: new Date(Date.now() + ttlMs) };
}

/** 取出并作废一个下载令牌；过期、用过或不存在时返回 null。Redis 不可用时抛错。 */
export async function takeDownloadLink(token: string): Promise<DownloadLinkGrant | null> {
  const raw = await takeEphemeral(redisKey(token));
  return raw ? (JSON.parse(raw) as DownloadLinkGrant) : null;
}
