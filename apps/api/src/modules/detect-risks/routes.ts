import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { DETECT_CATEGORIES } from '@lse/shared';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { tenantFilterWhere } from '../../lib/all-tenants.js';
import { prisma } from '../../db.js';
import { badRequest, permissionDenied } from '../../lib/errors.js';
import {
  RISK_SOURCES,
  RISK_SOURCES_BY_CATEGORY,
  RISK_SOURCE_KEYS,
  RISK_SOURCE_PERMISSIONS,
  canReadRiskSource,
} from './sources.js';
import { RISK_SEVERITY_KEYS, RiskCounter, detectRiskStats, type RiskSeverityKey } from './stats.js';
import { listRiskResults } from './results.js';
import { appProfile, profileListItems, profileRange } from './profile.js';

const time = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), '时间格式不对')
  .transform((v) => new Date(v));

const resultsQuery = z.object({
  category: z.enum(DETECT_CATEGORIES),
  source: z.enum(RISK_SOURCE_KEYS).optional(),
  severity: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
    .pipe(
      z.array(z.enum(RISK_SEVERITY_KEYS as [RiskSeverityKey, ...RiskSeverityKey[]])).optional(),
    ),
  since: time.optional(),
  until: time.optional(),
  /** 只看某个应用平台画像范围里的风险（台账资产 id） */
  profile: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const statsQuery = z.object({
  since: time.optional(),
  until: time.optional(),
  profile: z.string().uuid().optional(),
});

/**
 * 计数用的 counter：带 profile 时按画像范围、平台所属租户算（要 ledger:read，平台不存在 404、
 * 不是平台 400），否则按全部租户视角的租户筛选。
 */
async function resultsCounter(
  request: FastifyRequest,
  q: { since?: Date; until?: Date; profile?: string },
) {
  const window = { since: q.since ?? null, until: q.until ?? null };
  if (!q.profile) {
    return {
      window,
      profile: null,
      counter: new RiskCounter(window, undefined, tenantFilterWhere(request).tenantId),
    };
  }
  if (!request.currentUser!.permissions.has('ledger:read')) throw permissionDenied(['ledger:read']);
  const range = await profileRange(q.profile);
  return {
    window,
    profile: { id: range.platform.id, name: range.platform.name },
    counter: new RiskCounter(window, range.scope, range.platform.tenantId ?? undefined),
  };
}

/** 检测结果四视角（2.5.3）：按类别和来源列出有效风险，口径与首页「四类风险」一致。 */
export async function detectResultsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // 四类页签上的数：与首页「四类风险」同一个 detectRiskStats，时间窗口取页面的 since/until。
  app.get(
    '/stats',
    { preHandler: [requirePermission(...RISK_SOURCE_PERMISSIONS)] },
    async (request) => {
      const q = statsQuery.parse(request.query);
      const perms = request.currentUser!.permissions;
      const { window, profile, counter } = await resultsCounter(request, q);
      const stats = await detectRiskStats((code) => perms.has(code), counter);
      return { ...window, profile, ...stats };
    },
  );

  app.get('/', { preHandler: [requirePermission(...RISK_SOURCE_PERMISSIONS)] }, async (request) => {
    const q = resultsQuery.parse(request.query);
    const perms = request.currentUser!.permissions;
    const can = (code: string) => perms.has(code);
    const inCategory = RISK_SOURCES_BY_CATEGORY[q.category];
    if (q.source && RISK_SOURCES[q.source].category !== q.category) {
      throw badRequest('该来源不属于所选类别', 'DETECT_SOURCE_CATEGORY');
    }
    const visible = inCategory.filter((s) => canReadRiskSource(s, can));
    const source = q.source ?? visible[0];
    if (!source || !canReadRiskSource(source, can)) {
      throw permissionDenied([
        ...new Set(
          (q.source ? [q.source] : inCategory).flatMap((s) => RISK_SOURCES[s].permissions),
        ),
      ]);
    }
    // 来源合计和取页共用一个 counter：选中来源的分档计数、未登记 AI 服务都只算一次。
    const { profile, counter } = await resultsCounter(request, q);
    const [sources, list] = await Promise.all([
      Promise.all(
        visible.map(async (s) => ({
          source: s,
          label: RISK_SOURCES[s].label,
          total: (await counter.count(s)).total,
        })),
      ),
      listRiskResults(
        source,
        { severities: q.severity, page: q.page, pageSize: q.pageSize },
        counter,
      ),
    ]);
    return {
      category: q.category,
      source,
      profile,
      sources,
      items: list.items,
      total: list.total,
      page: q.page,
      pageSize: q.pageSize,
    };
  });
}

const profileListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * 受测应用安全画像（2.5.6）：画像主体是台账里的应用平台，要 ledger:read；
 * 风险部分按风险来源的权限过滤，识别结论、最近评估、终端硬件按各自模块的读权限过滤。
 * 与应用台账一样：菜单不进「全部租户」视角，接口在该视角下只读，画像各块只取平台所属租户的。
 */
export async function appProfileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  const read = { preHandler: [requirePermission('ledger:read')] };

  app.get('/', read, async (request) => {
    const q = profileListQuery.parse(request.query);
    const where: Prisma.LedgerAssetWhereInput = {
      type: 'platform',
      ...tenantFilterWhere(request),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              { code: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.ledgerAsset.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          tenantId: true,
          name: true,
          code: true,
          ownerName: true,
          organizationId: true,
        },
      }),
      prisma.ledgerAsset.count({ where }),
    ]);
    const perms = request.currentUser!.permissions;
    return {
      items: await profileListItems(rows, (code) => perms.has(code)),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  });

  app.get('/:assetId', read, async (request) => {
    const { assetId } = z.object({ assetId: z.string().uuid() }).parse(request.params);
    const perms = request.currentUser!.permissions;
    return appProfile(assetId, (code) => perms.has(code));
  });
}
