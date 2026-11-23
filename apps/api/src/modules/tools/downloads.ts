import type { FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { BUILTIN_PROBE_TOOL_CODE, type ToolDownloadKind } from '@lse/shared';
import { prisma, prismaUnscoped } from '../../db.js';
import { lastDayKeys } from '../dashboard/posture-range.js';

// 工具下载记录（下载溯源，2.3.9）：登录用户每次下载都记一条；匿名下载探针包同一 IP 同一文件
// 30 分钟内只记一条（防止刷记录）。记录失败不影响下载本身。

export interface DownloadActor {
  id: string;
  username: string;
  tenantId: string | null;
}

export const TREND_DAYS = 30;
const MAX_USER_ROWS = 200;
const RECENT_ROWS = 50;

function userAgentOf(request: FastifyRequest): string | null {
  const ua = request.headers['user-agent'];
  return typeof ua === 'string' && ua ? ua.slice(0, 500) : null;
}

export function actorOf(request: FastifyRequest): DownloadActor | null {
  const user = request.currentUser;
  return user ? { id: user.id, username: user.username, tenantId: user.homeTenantId } : null;
}

export async function recordToolDownload(
  request: FastifyRequest,
  input: {
    toolId: string;
    kind: ToolDownloadKind;
    versionId?: string | null;
    manualId?: string | null;
    filename?: string | null;
    actor: DownloadActor | null;
  },
): Promise<void> {
  try {
    await prismaUnscoped.toolDownload.create({
      data: {
        toolId: input.toolId,
        kind: input.kind,
        versionId: input.versionId ?? null,
        manualId: input.manualId ?? null,
        userId: input.actor?.id ?? null,
        username: input.actor?.username ?? null,
        tenantId: input.actor?.tenantId ?? null,
        ip: request.ip,
        userAgent: userAgentOf(request),
        filename: input.filename ?? null,
      },
    });
  } catch (err) {
    request.log.error({ err: { message: (err as Error).message } }, '记录工具下载失败');
  }
}

/**
 * 探针包下载接口是匿名的：带了有效登录令牌就记下载人，令牌无效或没带就当匿名，不影响下载。
 */
async function optionalActor(request: FastifyRequest): Promise<DownloadActor | null> {
  if (!request.headers.authorization?.startsWith('Bearer ')) return null;
  try {
    await request.jwtVerify();
    const user = await prismaUnscoped.user.findUnique({
      where: { id: request.user.sub },
      select: { id: true, username: true, tenantId: true, isActive: true },
    });
    return user?.isActive
      ? { id: user.id, username: user.username, tenantId: user.tenantId }
      : null;
  } catch {
    return null;
  }
}

/** 后台还没写完的探针下载记录。 */
const pendingProbeRecords = new Set<Promise<void>>();

/** 等后台的探针下载记录都写完（测试用）。 */
export async function settleDownloadRecords(): Promise<void> {
  await Promise.allSettled([...pendingProbeRecords]);
}

/**
 * 内置终端探针的安装包下载（/api/fleet/kits、Windows 安装包）也记进工具中心的下载记录。
 * 在后台写，不等数据库，下载时延不受影响。
 * - actor 不传：按请求里的登录令牌认人（kits 接口是匿名的）；
 * - 匿名下载：firstFromIp 为 false（同一 IP 同一文件 30 分钟内不是第一次，与登录页下载量同一个去重键）时不记；
 * - 带有效登录令牌的照常每次都记。
 */
export function recordProbeDownload(
  request: FastifyRequest,
  input: { filename: string; actor?: DownloadActor | null; firstFromIp?: boolean },
): void {
  const task = (async () => {
    try {
      const actor = input.actor === undefined ? await optionalActor(request) : input.actor;
      if (!actor && input.firstFromIp === false) return;
      const probe = await prismaUnscoped.tool.findUnique({
        where: { code: BUILTIN_PROBE_TOOL_CODE },
        select: { id: true },
      });
      if (!probe) return;
      await recordToolDownload(request, {
        toolId: probe.id,
        kind: 'package',
        filename: input.filename,
        actor,
      });
    } catch (err) {
      request.log.error({ err: { message: (err as Error).message } }, '记录探针包下载失败');
    }
  })();
  pendingProbeRecords.add(task);
  void task.finally(() => pendingProbeRecords.delete(task));
}

interface TrendRow {
  d: string;
  count: number;
}

/**
 * 下载溯源：按用户汇总（匿名单独一行，安装包、手册分两列）+ 近 30 天每日下载量（北京时间自然日）
 * + 最近 50 条下载明细。总数和趋势只算安装包，和列表里的下载量同一口径。
 */
export async function downloadSummary(toolId: string, now = new Date()) {
  const [total, groups, recentRows] = await Promise.all([
    prisma.toolDownload.count({ where: { toolId, kind: 'package' } }),
    prisma.toolDownload.groupBy({
      by: ['userId', 'username', 'tenantId', 'kind'],
      where: { toolId },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.toolDownload.findMany({
      where: { toolId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RECENT_ROWS,
      select: {
        createdAt: true,
        username: true,
        tenantId: true,
        kind: true,
        filename: true,
        ip: true,
        version: { select: { filename: true } },
        manual: { select: { filename: true } },
      },
    }),
  ]);
  type Row = {
    userId: string | null;
    username: string | null;
    tenantId: string | null;
    packages: number;
    manuals: number;
    total: number;
    lastDownloadedAt: Date | null;
  };
  const rows = new Map<string, Row>();
  for (const g of groups) {
    // 用户被删后 userId 置空，但用户名快照还在，按用户名单独成行；完全匿名的合成一行。
    const key = g.userId ? `id:${g.userId}` : g.username ? `name:${g.username}` : 'anonymous';
    const row = rows.get(key) ?? {
      userId: g.userId,
      username: g.username,
      tenantId: g.tenantId,
      packages: 0,
      manuals: 0,
      total: 0,
      lastDownloadedAt: null,
    };
    if (g.kind === 'manual') row.manuals += g._count._all;
    else row.packages += g._count._all;
    row.total += g._count._all;
    const at = g._max.createdAt;
    if (at && (!row.lastDownloadedAt || at > row.lastDownloadedAt)) {
      row.lastDownloadedAt = at;
      row.username = g.username;
      row.tenantId = g.tenantId;
    }
    rows.set(key, row);
  }
  const byUser = [...rows.values()]
    .sort(
      (a, b) =>
        b.total - a.total ||
        (b.lastDownloadedAt?.getTime() ?? 0) - (a.lastDownloadedAt?.getTime() ?? 0),
    )
    .slice(0, MAX_USER_ROWS);
  const tenantIds = [
    ...new Set([...byUser, ...recentRows].map((r) => r.tenantId).filter((t): t is string => !!t)),
  ];
  const tenants = tenantIds.length
    ? await prismaUnscoped.tenant.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, name: true },
      })
    : [];
  const tenantName = new Map(tenants.map((t) => [t.id, t.name]));

  const { keys, since } = lastDayKeys(TREND_DAYS, now);
  const trendRows = await prisma.$queryRaw<TrendRow[]>(Prisma.sql`
    SELECT to_char(("createdAt" + interval '8 hours')::date, 'YYYY-MM-DD') AS d,
           count(*)::int AS count
    FROM tool_downloads
    WHERE "toolId" = ${toolId} AND kind = 'package'
      AND "createdAt" >= ${since} AND "createdAt" <= ${now}
    GROUP BY 1`);
  const byDay = new Map(trendRows.map((r) => [r.d, r.count]));

  return {
    total,
    byUser: byUser.map((r) => ({
      userId: r.userId,
      username: r.username,
      tenantName: r.tenantId ? (tenantName.get(r.tenantId) ?? null) : null,
      packages: r.packages,
      manuals: r.manuals,
      total: r.total,
      lastDownloadedAt: r.lastDownloadedAt?.toISOString() ?? null,
    })),
    trend: keys.map((date) => ({ date, count: byDay.get(date) ?? 0 })),
    recent: recentRows.map((r) => ({
      createdAt: r.createdAt.toISOString(),
      username: r.username,
      tenantName: r.tenantId ? (tenantName.get(r.tenantId) ?? null) : null,
      kind: r.kind,
      filename: r.filename ?? r.version?.filename ?? r.manual?.filename ?? null,
      ip: r.ip,
    })),
  };
}
