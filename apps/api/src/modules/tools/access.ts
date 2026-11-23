import type { FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { BUILTIN_PROBE_TOOL_CODE } from '@lse/shared';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { builtinProbeVersions } from './builtin.js';
import { versionView } from './service.js';

// 工具中心各路由共用的取数、可见性判断和审计。

export const idParams = z.object({ id: z.string().uuid() });

export const creator = { select: { id: true, username: true } } as const;

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** 上传写库时所属工具（或记录）已被删掉：外键失败 P2003、记录不存在 P2025。 */
export function isMissingRecord(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === 'P2003' || err.code === 'P2025')
  );
}

export function audit(
  request: FastifyRequest,
  action: string,
  targetType: string,
  targetId: string,
  detail: unknown,
) {
  const ua = request.headers['user-agent'];
  return writeAudit({
    actorId: request.currentUser!.id,
    actorName: request.currentUser!.username,
    action,
    targetType,
    targetId,
    ip: request.ip,
    userAgent: typeof ua === 'string' ? ua : null,
    detail,
  });
}

export function declaredLength(request: FastifyRequest): number {
  const n = Number(request.headers['content-length'] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function canManage(request: FastifyRequest): boolean {
  return request.currentUser!.permissions.has('tool:manage');
}

export function isBuiltinProbe(tool: { code: string; builtin: boolean }): boolean {
  return tool.builtin && tool.code === BUILTIN_PROBE_TOOL_CODE;
}

/** 按安装包统计下载量（手册下载不算）。 */
export async function packageDownloadCounts(toolIds: string[]): Promise<Map<string, number>> {
  if (toolIds.length === 0) return new Map();
  const rows = await prisma.toolDownload.groupBy({
    by: ['toolId'],
    where: { toolId: { in: toolIds }, kind: 'package' },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.toolId, r._count._all]));
}

/** 隐藏的工具对没有 tool:manage 的用户一律当作不存在。 */
export async function loadVisibleTool(request: FastifyRequest, id: string) {
  const tool = await prisma.tool.findUnique({
    where: { id },
    include: {
      createdBy: creator,
      versions: { include: { createdBy: creator } },
      manuals: { include: { createdBy: creator }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!tool || (tool.hidden && !canManage(request))) throw notFound('工具不存在');
  return tool;
}

export type LoadedTool = Awaited<ReturnType<typeof loadVisibleTool>>;

export async function versionsOf(tool: LoadedTool) {
  return isBuiltinProbe(tool)
    ? builtinProbeVersions()
    : tool.versions.map((v) => versionView(tool.id, v));
}

/** 管理接口用：不看隐藏状态，不存在 404。 */
export async function loadTool(id: string) {
  const tool = await prisma.tool.findUnique({ where: { id } });
  if (!tool) throw notFound('工具不存在');
  return tool;
}
