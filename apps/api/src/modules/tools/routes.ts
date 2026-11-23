import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Tool, ToolVersion } from '@prisma/client';
import { z } from 'zod';
import {
  DETECT_CATEGORIES,
  TOOL_ARCH_VALUES,
  TOOL_CODE_PATTERN,
  TOOL_MANUAL_MAX_BYTES,
  TOOL_OS_VALUES,
  isToolTaskEntryKey,
} from '@lse/shared';
import { prisma, prismaUnscoped } from '../../db.js';
import { attachmentDisposition } from '../../lib/attachment.js';
import { auditDownload } from '../../lib/data-security.js';
import { recordDownload } from '../../lib/platform-stats.js';
import { enforcePublicRateLimit } from '../../lib/public-rate-limit.js';
import { setCurrentTenantScope } from '../../lib/tenant-context.js';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../../lib/errors.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import {
  audit,
  canManage,
  creator,
  declaredLength,
  idParams,
  isBuiltinProbe,
  isMissingRecord,
  isUniqueViolation,
  loadTool,
  loadVisibleTool,
  packageDownloadCounts,
  versionsOf,
  type LoadedTool,
} from './access.js';
import { builtinProbeVersions } from './builtin.js';
import { toolManualRoutes } from './manual-routes.js';
import { actorOf, downloadSummary, recordToolDownload, type DownloadActor } from './downloads.js';
import { isDownloadToken, issueDownloadLink, takeDownloadLink } from './download-links.js';
import {
  displayFilename,
  openStored,
  removeStored,
  storeUpload,
  sweepStaleParts,
  toolUploadMaxBytes,
} from './storage.js';
import {
  detailView,
  listItemView,
  matchesPlatform,
  versionView,
  type ToolVersionView,
} from './service.js';

// 工具中心（2.3.x）：工具是平台级内容，所有租户共用。
// tool:read 看可见的工具、下载、看说明和手册；tool:manage 管理全部，并能看到隐藏的工具。

const listQuery = z.object({
  category: z.enum(DETECT_CATEGORIES).optional(),
  os: z.enum(TOOL_OS_VALUES).optional(),
  arch: z.enum(TOOL_ARCH_VALUES).optional(),
  keyword: z.string().trim().max(100).optional(),
});

const versionParams = idParams.extend({ versionId: z.string().uuid() });

const configParam = z
  .object({
    name: z.string().trim().min(1, '参数名不能为空').max(64),
    label: z.string().trim().min(1, '参数显示名不能为空').max(64),
    description: z.string().trim().max(500).default(''),
    defaultValue: z.string().max(500).default(''),
    required: z.boolean().default(false),
  })
  .strict();
const configParams = z
  .array(configParam)
  .max(50, '配置参数最多 50 个')
  .refine((list) => new Set(list.map((p) => p.name)).size === list.length, '参数名不能重复');
const toolFields = {
  name: z.string().trim().min(1, '名称不能为空').max(100),
  category: z.enum(DETECT_CATEGORIES),
  description: z.string().trim().max(2000),
  instructions: z.string().max(20000),
  configParams,
  /** 快速建任务入口：只能取 TOOL_TASK_ENTRIES 的 key，null 表示没有。 */
  taskEntry: z.string().refine(isToolTaskEntryKey, '任务入口不在可选范围内').nullable(),
};
const createBody = z
  .object({
    code: z
      .string()
      .trim()
      .regex(TOOL_CODE_PATTERN, '编码只能用小写字母、数字和连字符，首尾不能是连字符'),
    ...toolFields,
    description: toolFields.description.default(''),
    instructions: toolFields.instructions.default(''),
    configParams: configParams.default([]),
    taskEntry: toolFields.taskEntry.default(null),
  })
  .strict();

/**
 * 编辑工具：编码不能改。内置工具不能改类别和任务入口、不能禁用，可以隐藏。
 * 禁用：仍在列表里，不能下载、不能建任务；隐藏：没有 tool:manage 的用户完全看不到。
 */
const patchBody = z
  .object({ ...toolFields, enabled: z.boolean(), hidden: z.boolean() })
  .partial()
  .strict();

const versionQuery = z.object({
  version: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, '版本号只能用字母、数字和 . _ + -，最长 64 位'),
  os: z.enum(TOOL_OS_VALUES),
  arch: z.enum(TOOL_ARCH_VALUES),
  filename: z.string().min(1).max(1000),
  releaseNotes: z.string().trim().max(500, '版本说明最多 500 字').default(''),
});

/** 详情带版本上传上限（字节），页面上传前先比对。 */
async function detailOf(tool: LoadedTool, downloadCount: number) {
  return {
    ...detailView(tool, await versionsOf(tool), downloadCount),
    maxUploadBytes: toolUploadMaxBytes(),
  };
}

const downloadUnavailable = () =>
  new AppError(503, '下载服务暂不可用，请稍后再试', 'TOOL_DOWNLOAD_UNAVAILABLE');

/** 发送一个版本的文件：写下载记录、计入登录页下载量（同 IP 同文件 30 分钟一次）、写下载审计。 */
async function sendVersionFile(
  request: FastifyRequest,
  reply: FastifyReply,
  tool: Pick<Tool, 'id' | 'code'>,
  version: ToolVersion,
  actor: DownloadActor,
) {
  const file = await openStored(version.storageKey);
  await recordToolDownload(request, {
    toolId: tool.id,
    kind: 'package',
    versionId: version.id,
    filename: version.filename,
    actor,
  });
  await recordDownload(`${request.ip}:tool-version:${version.id}`);
  await auditDownload(
    actor,
    {
      kind: 'tool_package',
      targetType: 'tool_version',
      targetId: version.id,
      detail: {
        toolId: tool.id,
        code: tool.code,
        version: version.version,
        os: version.os,
        arch: version.arch,
        filename: version.filename,
      },
    },
    request,
  );
  return reply
    .type('application/octet-stream')
    .header('content-length', String(file.size))
    .header('content-disposition', attachmentDisposition(version.filename))
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff')
    .send(file.stream);
}

export async function toolRoutes(app: FastifyInstance): Promise<void> {
  // 原始字节上传：请求流原样交给路由，由 storeUpload 流式写盘（仅本插件作用域）。
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
  );
  // 鉴权放在每个路由上（不用插件级钩子）：凭一次性令牌下载的 GET /download 不带登录令牌。
  const read = { preHandler: [authenticate, requirePermission('tool:read')] };
  const manage = { preHandler: [authenticate, requirePermission('tool:manage')] };
  const uploadLimit = Math.max(toolUploadMaxBytes(), TOOL_MANUAL_MAX_BYTES);
  toolManualRoutes(app, { read, manage, uploadLimit });

  // 启动时清一次进程被杀等情况留下的半截文件；失败只记日志，不影响启动。
  app.addHook('onReady', async () => {
    try {
      const removed = await sweepStaleParts();
      if (removed) app.log.info({ removed }, '已清理工具中心存储目录里的过期半截文件');
    } catch (err) {
      app.log.warn({ err: { message: (err as Error).message } }, '清理工具中心半截文件失败');
    }
  });

  app.get('/', read, async (request) => {
    const q = listQuery.parse(request.query);
    const tools = await prisma.tool.findMany({
      where: {
        ...(canManage(request) ? {} : { hidden: false }),
        ...(q.category ? { category: q.category } : {}),
        ...(q.keyword
          ? {
              OR: [
                { name: { contains: q.keyword, mode: 'insensitive' as const } },
                { code: { contains: q.keyword, mode: 'insensitive' as const } },
                { description: { contains: q.keyword, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      include: { versions: true },
      orderBy: [{ builtin: 'desc' }, { createdAt: 'desc' }],
    });
    const probeVersions = tools.some(isBuiltinProbe) ? await builtinProbeVersions() : [];
    const counts = await packageDownloadCounts(tools.map((t) => t.id));
    const items = tools
      .map((tool) => {
        const versions: ToolVersionView[] = isBuiltinProbe(tool)
          ? probeVersions
          : tool.versions.map((v) => versionView(tool.id, { ...v, createdBy: null }));
        return { tool, versions };
      })
      .filter(({ versions }) => matchesPlatform(versions, q.os, q.arch))
      .map(({ tool, versions }) => listItemView(tool, versions, counts.get(tool.id) ?? 0));
    return { items };
  });

  app.get('/:id', read, async (request) => {
    const { id } = idParams.parse(request.params);
    const tool = await loadVisibleTool(request, id);
    const counts = await packageDownloadCounts([tool.id]);
    return detailOf(tool, counts.get(tool.id) ?? 0);
  });

  app.post('/', manage, async (request, reply) => {
    const body = createBody.parse(request.body ?? {});
    const user = request.currentUser!;
    let id: string;
    try {
      ({ id } = await prisma.tool.create({
        data: { ...body, createdById: user.id },
        select: { id: true },
      }));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('工具编码已存在', 'TOOL_CODE_EXISTS');
      throw err;
    }
    await audit(request, 'tool.create', 'tool', id, { code: body.code, name: body.name });
    const tool = await loadVisibleTool(request, id);
    reply.code(201);
    return detailOf(tool, 0);
  });

  app.patch('/:id', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = patchBody.parse(request.body ?? {});
    const tool = await loadTool(id);
    if (tool.builtin && body.category !== undefined && body.category !== tool.category)
      throw badRequest('内置工具不能改类别', 'TOOL_BUILTIN');
    if (tool.builtin && body.taskEntry !== undefined && body.taskEntry !== tool.taskEntry)
      throw badRequest('内置工具不能改任务入口', 'TOOL_BUILTIN');
    if (tool.builtin && body.enabled === false)
      throw badRequest('内置工具不能禁用，可以隐藏', 'TOOL_BUILTIN');
    await prisma.tool.update({ where: { id }, data: body });
    await audit(request, 'tool.update', 'tool', id, {
      code: tool.code,
      fields: Object.keys(body),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.hidden !== undefined ? { hidden: body.hidden } : {}),
    });
    const updated = await loadVisibleTool(request, id);
    const counts = await packageDownloadCounts([id]);
    return detailOf(updated, counts.get(id) ?? 0);
  });

  app.delete('/:id', manage, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const tool = await prisma.tool.findUnique({
      where: { id },
      include: {
        versions: { select: { storageKey: true } },
        manuals: { select: { storageKey: true } },
      },
    });
    if (!tool) throw notFound('工具不存在');
    if (tool.builtin) throw conflict('内置工具不能删除，可以隐藏', 'TOOL_BUILTIN');
    // 版本、手册、下载记录随工具级联删除；库里删掉后再删文件，删文件失败不影响结果。
    await prisma.tool.delete({ where: { id } });
    for (const f of [...tool.versions, ...tool.manuals]) {
      await removeStored(f.storageKey).catch((err: Error) =>
        request.log.error({ err: { message: err.message } }, '工具文件删除失败'),
      );
    }
    await audit(request, 'tool.delete', 'tool', id, {
      code: tool.code,
      name: tool.name,
      versions: tool.versions.length,
      manuals: tool.manuals.length,
    });
    return reply.code(204).send();
  });

  /** 上传一个版本：请求体是文件原始字节，版本号、系统、架构、文件名、版本说明走 query。 */
  app.post('/:id/versions', { ...manage, bodyLimit: uploadLimit }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const q = versionQuery.parse(request.query);
    const filename = displayFilename(q.filename);
    if (!filename) throw badRequest('文件名不能为空', 'TOOL_FILENAME');
    const tool = await loadTool(id);
    if (tool.builtin)
      throw conflict('内置工具的版本来自终端探针安装包目录，不能在这里上传', 'TOOL_BUILTIN');
    const key = { toolId: id, version: q.version, os: q.os, arch: q.arch };
    const duplicate = () =>
      conflict('该版本在这个系统和架构下已有文件，请先删除旧文件或换版本号', 'TOOL_VERSION_EXISTS');
    if (await prisma.toolVersion.findUnique({ where: { toolId_version_os_arch: key } }))
      throw duplicate();
    const stored = await storeUpload(
      request.body,
      declaredLength(request),
      toolUploadMaxBytes(),
      '安装包',
    );
    let created;
    try {
      created = await prisma.toolVersion.create({
        data: {
          ...key,
          filename,
          size: BigInt(stored.size),
          sha256: stored.sha256,
          storageKey: stored.storageKey,
          releaseNotes: q.releaseNotes,
          createdById: request.currentUser!.id,
        },
        include: { createdBy: creator },
      });
    } catch (err) {
      await removeStored(stored.storageKey);
      if (isUniqueViolation(err)) throw duplicate();
      // 上传过程中工具被删了。
      if (isMissingRecord(err)) throw notFound('工具不存在');
      throw err;
    }
    await audit(request, 'tool.version_upload', 'tool_version', created.id, {
      toolId: id,
      code: tool.code,
      version: q.version,
      os: q.os,
      arch: q.arch,
      filename,
      size: stored.size,
      sha256: stored.sha256,
    });
    reply.code(201);
    return versionView(id, created);
  });

  /** 下载一个版本：禁用 409；隐藏对没有管理权限的用户 404；计入登录页下载量（同 IP 同文件 30 分钟一次）。 */
  app.get('/:id/versions/:versionId/download', read, async (request, reply) => {
    const { id, versionId } = versionParams.parse(request.params);
    const tool = await loadVisibleTool(request, id);
    if (!tool.enabled) throw conflict('工具已禁用，不能下载', 'TOOL_DISABLED');
    const version = tool.versions.find((v) => v.id === versionId);
    if (!version) throw notFound('版本不存在');
    return sendVersionFile(request, reply, tool, version, actorOf(request)!);
  });

  /**
   * 签发一次性下载链接（60 秒有效、只能用一次）：页面用普通链接让浏览器原生下载大文件，不走 blob。
   * 禁用 409；隐藏对没有管理权限的用户 404。
   */
  app.post('/:id/versions/:versionId/download-link', read, async (request) => {
    const { id, versionId } = versionParams.parse(request.params);
    const tool = await loadVisibleTool(request, id);
    if (!tool.enabled) throw conflict('工具已禁用，不能下载', 'TOOL_DISABLED');
    if (!tool.versions.some((v) => v.id === versionId)) throw notFound('版本不存在');
    const user = request.currentUser!;
    const link = await issueDownloadLink({
      toolId: id,
      versionId,
      userId: user.id,
      canManage: canManage(request),
      tenantId: user.tenantId,
    }).catch((err: Error) => {
      request.log.error({ err: { message: err.message } }, '签发工具下载链接失败');
      throw downloadUnavailable();
    });
    return {
      url: `/api/tools/download?token=${link.token}`,
      expiresAt: link.expiresAt.toISOString(),
    };
  });

  /**
   * 凭一次性下载令牌下载（不带 Authorization 头）：令牌缺失或格式不对 401，过期或已用过 410。
   * 下载时再查一次工具状态（签发后被禁用、隐藏也下不了）；下载记录和审计记签发人。
   */
  app.get('/download', async (request, reply) => {
    await enforcePublicRateLimit('tool-download', request.ip, { perMinute: 60 });
    const { token } = (request.query ?? {}) as { token?: unknown };
    if (!isDownloadToken(token)) throw unauthorized('下载链接无效', 'TOOL_DOWNLOAD_LINK_INVALID');
    const grant = await takeDownloadLink(token).catch((err: Error) => {
      request.log.error({ err: { message: err.message } }, '读取工具下载链接失败');
      throw downloadUnavailable();
    });
    if (!grant)
      throw new AppError(410, '下载链接已失效，请回到页面重新下载', 'TOOL_DOWNLOAD_LINK_GONE');
    const user = await prismaUnscoped.user.findUnique({
      where: { id: grant.userId },
      select: { id: true, username: true, tenantId: true, isActive: true },
    });
    if (!user?.isActive) throw unauthorized('下载链接无效', 'TOOL_DOWNLOAD_LINK_INVALID');
    // 审计记到签发时的租户范围，和带登录令牌下载一致。
    setCurrentTenantScope(grant.tenantId, false);
    const tool = await prisma.tool.findUnique({
      where: { id: grant.toolId },
      include: { versions: { where: { id: grant.versionId } } },
    });
    if (!tool || (tool.hidden && !grant.canManage)) throw notFound('工具不存在');
    if (!tool.enabled) throw conflict('工具已禁用，不能下载', 'TOOL_DISABLED');
    const version = tool.versions[0];
    if (!version) throw notFound('版本不存在');
    return sendVersionFile(request, reply, tool, version, {
      id: user.id,
      username: user.username,
      tenantId: user.tenantId,
    });
  });

  /** 下载溯源：按用户汇总 + 近 30 天每日下载量。 */
  app.get('/:id/downloads', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    await loadTool(id);
    return downloadSummary(id);
  });

  app.delete('/:id/versions/:versionId', manage, async (request, reply) => {
    const { id, versionId } = versionParams.parse(request.params);
    const version = await prisma.toolVersion.findFirst({ where: { id: versionId, toolId: id } });
    if (!version) throw notFound('版本不存在');
    await prisma.toolVersion.delete({ where: { id: versionId } });
    await removeStored(version.storageKey);
    await audit(request, 'tool.version_delete', 'tool_version', versionId, {
      toolId: id,
      version: version.version,
      os: version.os,
      arch: version.arch,
      filename: version.filename,
    });
    return reply.code(204).send();
  });
}
