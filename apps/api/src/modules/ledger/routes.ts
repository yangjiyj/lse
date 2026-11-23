import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  DETECT_JOB_ITEM_KINDS,
  LEDGER_ASSET_TYPES,
  LEDGER_RELATION_KINDS,
  type LedgerAssetType,
} from '@lse/shared';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { tenantFilterWhere, tenantMatches } from '../../lib/all-tenants.js';
import { organizationSubtreeIds } from '../organizations/service.js';
import { createDetectJob, getDetectJobDetail, startDetectJob } from '../detect-jobs/service.js';
import { assetQuickItems, schemeDateText } from '../detect-schemes/service.js';
import {
  LEDGER_NAME_MAX,
  assetInclude,
  createLedgerAsset,
  createLedgerRelation,
  importLedgerEndpoints,
  importLedgerTargets,
  ledgerAssetDetail,
  ledgerDisplayName,
  serializeAssets,
  updateLedgerAsset,
} from './service.js';

const idParams = z.object({ id: z.string().uuid() });

/** 可空文本：去首尾空白，空串当作清空。 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

const tagsSchema = z
  .array(z.string().trim().min(1).max(32))
  .max(20)
  .transform((tags) => [...new Set(tags)]);

const baseFields = {
  name: z.string().trim().min(1, '请填写名称').max(LEDGER_NAME_MAX),
  code: optionalText(64).optional(),
  description: z.string().trim().max(2000).optional(),
  ownerName: optionalText(50).optional(),
  ownerDepartment: optionalText(100).optional(),
  organizationId: z.string().uuid().nullable().optional(),
  tags: tagsSchema.optional(),
  attrs: z.unknown().optional(),
  fleetEndpointId: z.string().uuid().nullable().optional(),
  modelTargetId: z.string().uuid().nullable().optional(),
};

const createSchema = z.object({ type: z.enum(LEDGER_ASSET_TYPES), ...baseFields }).strict();
const updateSchema = z.object({ ...baseFields, name: baseFields.name.optional() }).strict();

const listQuery = z.object({
  type: z.enum(LEDGER_ASSET_TYPES).optional(),
  q: z.string().trim().max(200).optional(),
  organizationId: z.string().uuid().optional(),
  includeDescendants: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

const idList = z.array(z.string().uuid()).min(1).max(1000);
const importEndpointsSchema = z.object({ endpointIds: idList.optional() }).strict();
const importTargetsSchema = z.object({ targetIds: idList.optional() }).strict();
const quickJobSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    items: z
      .array(
        z
          .object({
            jobKind: z.enum(DETECT_JOB_ITEM_KINDS),
            title: z.string().trim().min(1).max(200),
            params: z.record(z.unknown()),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    maxParallel: z.number().int().min(1).max(10).optional(),
    start: z.boolean().optional(),
  })
  .strict();

const relationSchema = z
  .object({
    fromId: z.string().uuid(),
    toId: z.string().uuid(),
    kind: z.enum(LEDGER_RELATION_KINDS),
  })
  .strict();

/** 审计里留的资产快照（不含专有字段明细）。 */
const auditView = (a: { id: string; type: string; name: string; code: string | null }) => ({
  type: a.type,
  name: a.name,
  code: a.code,
});

/**
 * 应用台账（2.8.1）：应用平台、服务器、终端、通用软件、AI 模型及组件的维护、导入与关系。
 * 读要 ledger:read，写要 ledger:manage；租户内数据，「全部租户」视角只读（写由 authenticate 拒绝）。
 */
export async function ledgerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  const read = { preHandler: [requirePermission('ledger:read')] };
  const manage = { preHandler: [requirePermission('ledger:manage')] };

  app.get('/assets', read, async (request) => {
    const q = listQuery.parse(request.query);
    const user = request.currentUser!;
    let organizationIds: string[] | undefined;
    if (q.organizationId) {
      organizationIds = [q.organizationId];
      if (q.includeDescendants === 'true') {
        const org = await prisma.organization.findUnique({
          where: { id: q.organizationId },
          select: { id: true, tenantId: true },
        });
        if (org && tenantMatches(user, org.tenantId)) {
          organizationIds = await organizationSubtreeIds(org);
        }
      }
    }
    const base: Prisma.LedgerAssetWhereInput = {
      ...tenantFilterWhere(request),
      ...(organizationIds ? { organizationId: { in: organizationIds } } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              { code: { contains: q.q, mode: 'insensitive' } },
              { attrs: { path: ['ip'], string_contains: q.q } },
            ],
          }
        : {}),
    };
    const where: Prisma.LedgerAssetWhereInput = { ...base, ...(q.type ? { type: q.type } : {}) };
    const [rows, total, grouped] = await Promise.all([
      prisma.ledgerAsset.findMany({
        where,
        include: assetInclude,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.ledgerAsset.count({ where }),
      prisma.ledgerAsset.groupBy({ by: ['type'], where: base, _count: { _all: true } }),
    ]);
    const counts = Object.fromEntries(LEDGER_ASSET_TYPES.map((t) => [t, 0])) as Record<
      LedgerAssetType,
      number
    >;
    for (const g of grouped) {
      if (g.type in counts) counts[g.type as LedgerAssetType] = g._count._all;
    }
    return {
      items: await serializeAssets(rows),
      total,
      page: q.page,
      pageSize: q.pageSize,
      counts,
    };
  });

  app.get('/assets/:id', read, async (request) => {
    const { id } = idParams.parse(request.params);
    const detail = await ledgerAssetDetail(id, {
      withJobs: request.currentUser!.permissions.has('detect_task:read'),
    });
    if (!detail) throw notFound('资产不存在');
    return detail;
  });

  app.post('/assets', manage, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const user = request.currentUser!;
    const asset = await createLedgerAsset(user, body);
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'ledger.asset_create',
      targetType: 'ledger_asset',
      targetId: asset.id,
      detail: auditView(asset),
    });
    reply.code(201);
    const [view] = await serializeAssets([asset]);
    return view;
  });

  app.patch('/assets/:id', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = updateSchema.parse(request.body);
    if (Object.keys(body).length === 0) throw badRequest('没有要修改的内容');
    const user = request.currentUser!;
    const { before, after } = await updateLedgerAsset(user, id, body);
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'ledger.asset_update',
      targetType: 'ledger_asset',
      targetId: id,
      detail: { before: auditView(before), after: auditView(after), fields: Object.keys(body) },
    });
    const [view] = await serializeAssets([after]);
    return view;
  });

  app.delete('/assets/:id', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    const user = request.currentUser!;
    const asset = await prisma.ledgerAsset.findUnique({ where: { id } });
    if (!asset) throw notFound('资产不存在');
    // 关系级联删除；方案清单项的 assetId 置空（外键 SET NULL）。
    await prisma.ledgerAsset.delete({ where: { id } });
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'ledger.asset_delete',
      targetType: 'ledger_asset',
      targetId: id,
      detail: auditView(asset),
    });
    return { ok: true };
  });

  app.post('/assets/import-endpoints', manage, async (request) => {
    const body = importEndpointsSchema.parse(request.body ?? {});
    const user = request.currentUser!;
    const result = await importLedgerEndpoints(user, body.endpointIds);
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'ledger.import_endpoints',
      targetType: 'ledger_asset',
      detail: { ...result, requested: body.endpointIds?.length ?? 'all' },
    });
    return result;
  });

  app.post('/assets/import-targets', manage, async (request) => {
    const body = importTargetsSchema.parse(request.body ?? {});
    const user = request.currentUser!;
    const result = await importLedgerTargets(user, body.targetIds);
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'ledger.import_targets',
      targetType: 'ledger_asset',
      detail: { ...result, requested: body.targetIds?.length ?? 'all' },
    });
    return result;
  });

  // 按台账快速建任务（2.8.4）：单个资产按清单生成规则出候选项，auto 项带就绪判断。
  app.get('/assets/:id/quick-items', read, async (request) => {
    const { id } = idParams.parse(request.params);
    return assetQuickItems(id);
  });

  app.post(
    '/assets/:id/quick-job',
    { preHandler: [requirePermission('ledger:read'), requirePermission('detect_task:manage')] },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = quickJobSchema.parse(request.body);
      const asset = await prisma.ledgerAsset.findUnique({
        where: { id },
        include: {
          fleetEndpoint: { select: { hostname: true, tenantId: true } },
          modelTarget: { select: { name: true, tenantId: true } },
        },
      });
      if (!asset) throw notFound('资产不存在');
      const user = request.currentUser!;
      const ua = request.headers['user-agent'];
      const ctx = { ip: request.ip, userAgent: typeof ua === 'string' ? ua : null };
      const name = body.name ?? `${ledgerDisplayName(asset)} · ${schemeDateText()}`;
      const { id: jobId } = await createDetectJob(user, {
        name,
        maxParallel: body.maxParallel,
        items: body.items.map((item) => ({
          kind: item.jobKind,
          title: item.title,
          params: item.params,
          ledgerAssetId: asset.id,
        })),
        triggeredBy: 'quick',
      });
      await writeAudit({
        actorId: user.id,
        actorName: user.username,
        action: 'detect_job.create',
        targetType: 'detect_job',
        targetId: jobId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        detail: {
          name,
          maxParallel: body.maxParallel ?? null,
          kinds: body.items.map((i) => i.jobKind),
          start: body.start ?? false,
          ledgerAssetId: asset.id,
          triggeredBy: 'quick',
        },
      });
      if (body.start) await startDetectJob(user, jobId, ctx);
      reply.code(201);
      return getDetectJobDetail(jobId);
    },
  );

  app.post('/relations', manage, async (request, reply) => {
    const body = relationSchema.parse(request.body);
    const user = request.currentUser!;
    const { relation, from, to } = await createLedgerRelation(body);
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'ledger.relation_create',
      targetType: 'ledger_relation',
      targetId: relation.id,
      detail: {
        kind: relation.kind,
        from: auditView({ ...from, code: null }),
        to: auditView({ ...to, code: null }),
      },
    });
    reply.code(201);
    return { id: relation.id, fromId: relation.fromId, toId: relation.toId, kind: relation.kind };
  });

  app.delete('/relations/:id', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    const user = request.currentUser!;
    const relation = await prisma.ledgerRelation.findUnique({ where: { id } });
    if (!relation) throw notFound('关系不存在');
    await prisma.ledgerRelation.delete({ where: { id } });
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'ledger.relation_delete',
      targetType: 'ledger_relation',
      targetId: id,
      detail: { kind: relation.kind, fromId: relation.fromId, toId: relation.toId },
    });
    return { ok: true };
  });
}
