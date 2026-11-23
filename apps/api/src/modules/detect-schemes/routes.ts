import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { DETECT_JOB_ITEM_KINDS, isToolTaskEntryKey, type ToolTaskEntryKey } from '@lse/shared';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { tenantFilterWhere } from '../../lib/all-tenants.js';
import { sendAttachment } from '../../lib/attachment.js';
import { resolveDownloadWatermark } from '../../lib/data-security.js';
import { DOCX_CONTENT_TYPE } from '../reports/docx/docx-kit.js';
import { canManage, creator, versionsOf } from '../tools/access.js';
import type { ToolVersionView } from '../tools/service.js';
import { LEDGER_LINK_SELECT, ledgerDisplayName } from '../ledger/service.js';
import { readLedgerAttrs } from '../ledger/attrs.js';
import { buildSchemeGuideDocx } from './guide-docx.js';
import { getDetectJobDetail, listDetectJobs, startDetectJob } from '../detect-jobs/service.js';
import {
  addSchemeItem,
  createSchemeJob,
  assertRequirementAssets,
  deleteSchemeItem,
  generateScheme,
  reorderSchemeItems,
  serializeItem,
  updateSchemeItem,
  loadScheme,
  loadWritableScheme,
  requirementSchema,
  itemInclude,
  readRequirement,
  resolveRequirementAssets,
  rethrowSchemeUnique,
  schemeDetail,
  schemeJobCounts,
  serializeSchemeBase,
} from './service.js';

const idParams = z.object({ id: z.string().uuid() });
const nameSchema = z.string().trim().min(1, '请填写方案名称').max(100);
const createSchema = z.object({ name: nameSchema, requirement: requirementSchema }).strict();
const updateSchema = z
  .object({ name: nameSchema.optional(), requirement: requirementSchema.optional() })
  .strict();
const itemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
const PARAMS_MAX_CHARS = 20_000;
const paramsSchema = z
  .record(z.unknown())
  .refine((v) => JSON.stringify(v).length <= PARAMS_MAX_CHARS, { message: '参数过大' });
const itemFields = {
  assetId: z.string().uuid().nullable().optional(),
  mode: z.enum(['auto', 'manual']),
  jobKind: z.enum(DETECT_JOB_ITEM_KINDS).nullable().optional(),
  params: paramsSchema.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().max(2000).optional(),
  enabled: z.boolean().optional(),
};
const itemCreateSchema = z
  .object({
    ...itemFields,
    entryKey: z
      .string()
      .refine(isToolTaskEntryKey, { message: '未知的检测入口' })
      .transform((v) => v as ToolTaskEntryKey),
  })
  .strict();
const itemUpdateSchema = z.object({ ...itemFields, mode: itemFields.mode.optional() }).strict();
const reorderSchema = z.object({ ids: z.array(z.string().uuid()).max(2000) }).strict();
const createJobSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    itemIds: z.array(z.string().uuid()).min(1).max(200).optional(),
    maxParallel: z.number().int().min(1).max(10).optional(),
    start: z.boolean().optional(),
  })
  .strict();

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const versionCollator = new Intl.Collator('en', { numeric: true });

/**
 * 最新版本列表：每个系统/架构取最新的一个文件。按上传时间、版本号（数字按大小）、id 依次倒序，
 * 内置探针没有上传时间时按版本号取，结果稳定。
 */
export function latestPerPlatform(versions: ToolVersionView[]): ToolVersionView[] {
  const sorted = [...versions].sort(
    (a, b) =>
      (b.createdAt ?? '').localeCompare(a.createdAt ?? '') ||
      versionCollator.compare(b.version, a.version) ||
      b.id.localeCompare(a.id),
  );
  const seen = new Set<string>();
  return sorted.filter((v) => {
    const key = `${v.os}/${v.arch}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 方案里启用的清单项用到的入口。 */
async function enabledEntryKeys(schemeId: string): Promise<string[]> {
  const rows = await prisma.detectSchemeItem.findMany({
    where: { schemeId, enabled: true },
    distinct: ['entryKey'],
    select: { entryKey: true },
  });
  return rows.map((r) => r.entryKey);
}

/**
 * 配套工具：工具中心里 taskEntry 是这些入口、启用的工具；没有 tool:manage 的用户只给不隐藏的。
 * 内置探针的版本从安装包清单读（versionsOf）。
 */
async function schemeTools(request: FastifyRequest, entryKeys: string[]) {
  if (entryKeys.length === 0) return [];
  const tools = await prisma.tool.findMany({
    where: {
      taskEntry: { in: entryKeys },
      enabled: true,
      ...(canManage(request) ? {} : { hidden: false }),
    },
    include: {
      createdBy: creator,
      versions: { include: { createdBy: creator } },
      manuals: { include: { createdBy: creator }, orderBy: { createdAt: 'asc' } },
    },
    orderBy: [{ builtin: 'desc' }, { name: 'asc' }],
  });
  return Promise.all(
    tools.map(async (tool) => ({
      id: tool.id,
      code: tool.code,
      name: tool.name,
      category: tool.category,
      description: tool.description,
      instructions: tool.instructions,
      builtin: tool.builtin,
      hidden: tool.hidden,
      entryKeys: tool.taskEntry ? [tool.taskEntry] : [],
      detailPath: `/tools/${tool.id}`,
      versions: latestPerPlatform(await versionsOf(tool)),
    })),
  );
}

/**
 * 检测方案（2.8.2～2.8.4）：需求配置、方案清单、作业指导书。
 * 读要 scheme:read，写要 scheme:manage；租户内数据，「全部租户」视角只读（写由 authenticate 拒绝）。
 */
export async function detectSchemeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  const read = { preHandler: [requirePermission('scheme:read')] };
  const manage = { preHandler: [requirePermission('scheme:manage')] };

  const audit = (
    request: { currentUser?: { id: string; username: string } },
    action: string,
    targetId: string,
    detail: unknown,
  ) =>
    writeAudit({
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action,
      targetType: 'detect_scheme',
      targetId,
      detail,
    });

  app.get('/', read, async (request) => {
    const q = listQuery.parse(request.query);
    const where: Prisma.DetectSchemeWhereInput = {
      ...tenantFilterWhere(request),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.detectScheme.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { _count: { select: { items: true } } },
      }),
      prisma.detectScheme.count({ where }),
    ]);
    const jobs = await schemeJobCounts(rows.map((r) => r.id));
    return {
      items: rows.map((r) => {
        const job = jobs.get(r.id) ?? { total: 0, active: 0 };
        return serializeSchemeBase(r, {
          itemCount: r._count.items,
          jobCount: job.total,
          activeJobCount: job.active,
        });
      }),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  });

  app.get('/:id', read, async (request) => {
    const { id } = idParams.parse(request.params);
    return schemeDetail(id);
  });

  app.post('/', manage, async (request, reply) => {
    const body = createSchema.parse(request.body);
    await assertRequirementAssets(body.requirement.assetIds);
    const user = request.currentUser!;
    const scheme = await prisma.detectScheme
      .create({
        data: {
          name: body.name,
          requirement: body.requirement as Prisma.InputJsonObject,
          createdById: user.id,
        },
      })
      .catch(rethrowSchemeUnique);
    await audit(request, 'detect_scheme.create', scheme.id, {
      name: scheme.name,
      categories: body.requirement.categories,
      assetCount: body.requirement.assetIds.length,
    });
    reply.code(201);
    return schemeDetail(scheme.id);
  });

  app.patch('/:id', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = updateSchema.parse(request.body);
    if (body.name === undefined && body.requirement === undefined) {
      throw badRequest('没有要修改的内容');
    }
    const before = await loadWritableScheme(id);
    // 详情回填时可能带着已从台账删掉的对象：原配置里有的直接忽略，新加的必须在本租户台账里。
    const requirement = body.requirement
      ? {
          ...body.requirement,
          assetIds: await resolveRequirementAssets(
            body.requirement.assetIds,
            readRequirement(before.requirement).assetIds,
          ),
        }
      : undefined;
    await prisma.detectScheme
      .update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(requirement ? { requirement: requirement as Prisma.InputJsonObject } : {}),
        },
      })
      .catch(rethrowSchemeUnique);
    await audit(request, 'detect_scheme.update', id, {
      before: { name: before.name },
      after: { name: body.name ?? before.name },
      fields: Object.keys(body),
    });
    return schemeDetail(id);
  });

  app.delete('/:id', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    const scheme = await loadScheme(id);
    const job = (await schemeJobCounts([id])).get(id);
    if (job && job.total > 0) throw conflict('方案已建任务，请归档', 'SCHEME_HAS_JOBS');
    await prisma.detectScheme.delete({ where: { id } });
    await audit(request, 'detect_scheme.delete', id, { name: scheme.name });
    return { ok: true };
  });

  app.post('/:id/archive', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    const scheme = await loadScheme(id);
    if (!scheme.archivedAt) {
      await prisma.detectScheme.update({ where: { id }, data: { archivedAt: new Date() } });
      await audit(request, 'detect_scheme.archive', id, { name: scheme.name });
    }
    return schemeDetail(id);
  });

  app.post('/:id/generate', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    const result = await generateScheme(id);
    await audit(request, 'detect_scheme.generate', id, result);
    return schemeDetail(id);
  });

  app.post('/:id/items', manage, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = itemCreateSchema.parse(request.body);
    const item = await addSchemeItem(id, body);
    await audit(request, 'detect_scheme.item_create', id, {
      itemId: item.id,
      entryKey: item.entryKey,
      mode: item.mode,
      title: item.title,
    });
    reply.code(201);
    return serializeItem(item);
  });

  app.patch('/:id/items/:itemId', manage, async (request) => {
    const { id, itemId } = itemParams.parse(request.params);
    const body = itemUpdateSchema.parse(request.body);
    if (Object.keys(body).length === 0) throw badRequest('没有要修改的内容');
    const { after } = await updateSchemeItem(id, itemId, body);
    await audit(request, 'detect_scheme.item_update', id, {
      itemId,
      title: after.title,
      fields: Object.keys(body),
    });
    return serializeItem(after);
  });

  app.delete('/:id/items/:itemId', manage, async (request) => {
    const { id, itemId } = itemParams.parse(request.params);
    const item = await deleteSchemeItem(id, itemId);
    await audit(request, 'detect_scheme.item_delete', id, {
      itemId,
      title: item.title,
      entryKey: item.entryKey,
    });
    return { ok: true };
  });

  app.post('/:id/items/reorder', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = reorderSchema.parse(request.body);
    await reorderSchemeItems(id, body.ids);
    await audit(request, 'detect_scheme.item_update', id, { reorder: body.ids.length });
    return schemeDetail(id);
  });

  app.get(
    '/:id/tools',
    { preHandler: [requirePermission('scheme:read'), requirePermission('tool:read')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      await loadScheme(id);
      return { items: await schemeTools(request, await enabledEntryKeys(id)) };
    },
  );

  // 作业指导书：没有 tool:read 时不写配套工具相关的内容。
  app.get('/:id/guide', read, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const scheme = await loadScheme(id);
    const requirement = readRequirement(scheme.requirement);
    const user = request.currentUser!;
    const withTools = user.permissions.has('tool:read');
    const [items, assets, tools, watermark] = await Promise.all([
      prisma.detectSchemeItem.findMany({
        where: { schemeId: id, enabled: true },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        include: itemInclude,
      }),
      prisma.ledgerAsset.findMany({
        where: { id: { in: requirement.assetIds } },
        select: {
          id: true,
          type: true,
          name: true,
          code: true,
          ownerName: true,
          ownerDepartment: true,
          attrs: true,
          ...LEDGER_LINK_SELECT,
        },
      }),
      withTools ? enabledEntryKeys(id).then((keys) => schemeTools(request, keys)) : [],
      resolveDownloadWatermark(user),
    ]);
    const byId = new Map(assets.map((a) => [a.id, a]));
    const buffer = await buildSchemeGuideDocx({
      schemeName: scheme.name,
      requirement,
      assets: requirement.assetIds
        .map((assetId) => byId.get(assetId))
        .filter((a): a is NonNullable<typeof a> => Boolean(a))
        .map((a) => ({
          type: a.type,
          name: ledgerDisplayName(a),
          code: a.code,
          ownerName: a.ownerName,
          ownerDepartment: a.ownerDepartment,
          attrs: readLedgerAttrs(a.attrs),
        })),
      items: items.map((item) => ({
        title: item.title,
        category: item.category,
        entryKey: item.entryKey,
        mode: item.mode,
        note: item.note,
        assetName: item.asset ? ledgerDisplayName(item.asset) : null,
      })),
      tools: withTools ? tools : null,
      watermark: watermark?.text ?? null,
      now: new Date(),
    });
    const ua = request.headers['user-agent'];
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'detect_scheme.guide_download',
      targetType: 'detect_scheme',
      targetId: id,
      ip: request.ip,
      userAgent: typeof ua === 'string' ? ua : null,
      detail: {
        name: scheme.name,
        items: items.length,
        tools: tools.length,
        watermark: Boolean(watermark),
      },
    });
    return sendAttachment(reply, buffer, {
      contentType: DOCX_CONTENT_TYPE,
      filename: `${scheme.name}-作业指导书.docx`,
      fallbackName: 'detect-scheme-guide.docx',
    });
  });

  // 按清单建组合任务（2.8.4）：要同时能维护方案和管理组合任务。
  app.post(
    '/:id/jobs',
    { preHandler: [requirePermission('scheme:manage'), requirePermission('detect_task:manage')] },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = createJobSchema.parse(request.body ?? {});
      const ua = request.headers['user-agent'];
      const ctx = { ip: request.ip, userAgent: typeof ua === 'string' ? ua : null };
      const user = request.currentUser!;
      const { jobId, itemCount } = await createSchemeJob(user, id, body, ctx);
      // 组合任务建好就记方案的审计，启动失败也不漏。
      await audit(request, 'detect_scheme.create_job', id, {
        jobId,
        items: itemCount,
        start: body.start ?? false,
      });
      if (body.start) await startDetectJob(user, jobId, ctx);
      reply.code(201);
      return getDetectJobDetail(jobId);
    },
  );

  app.get(
    '/:id/jobs',
    { preHandler: [requirePermission('scheme:read'), requirePermission('detect_task:read')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      await loadScheme(id);
      return listDetectJobs({ schemeId: id, page: 1, pageSize: 100 });
    },
  );

  app.post('/:id/unarchive', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    const scheme = await loadScheme(id);
    if (scheme.archivedAt) {
      await prisma.detectScheme.update({ where: { id }, data: { archivedAt: null } });
      await audit(request, 'detect_scheme.unarchive', id, { name: scheme.name });
    }
    return schemeDetail(id);
  });
}
