import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { DETECT_JOB_ITEM_KINDS } from '@lse/shared';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { MAX_PLAN_INTERVAL_MINUTES, MIN_PLAN_INTERVAL_MINUTES } from '../eval-plans/service.js';
import {
  DETECT_JOB_MAX_ITEMS,
  DETECT_JOB_MAX_PARALLEL,
  getDetectJobDetail,
  listDetectJobs,
  type DetectJobActionContext,
} from './service.js';
import {
  defaultDetectStrategyScheduler,
  type DetectStrategyScheduler,
} from './strategy-scheduler.js';
import {
  assertStrategySchedule,
  prepareStrategyItems,
  serializeStrategy,
  triggerDetectStrategy,
} from './strategies.js';

// 检测策略接口 /api/detect-strategies（2.4.3）：读要 detect_task:read，写要 detect_task:manage。

export interface DetectStrategyRoutesOptions {
  scheduler?: DetectStrategyScheduler;
}

const READ = { preHandler: [requirePermission('detect_task:read')] };
const MANAGE = { preHandler: [requirePermission('detect_task:manage')] };

const idParams = z.object({ id: z.string().uuid() });
const itemSchema = z
  .object({
    kind: z.enum(DETECT_JOB_ITEM_KINDS),
    title: z.string().trim().max(200).optional(),
    params: z.unknown(),
    toolId: z.string().uuid().nullable().optional(),
    ledgerAssetId: z.string().uuid().nullable().optional(),
  })
  .strict();
const fields = {
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000),
  items: z.array(itemSchema).min(1).max(DETECT_JOB_MAX_ITEMS),
  maxParallel: z.number().int().min(1).max(DETECT_JOB_MAX_PARALLEL),
  cron: z.string().trim().min(9).max(120).nullable(),
  timezone: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
  minIntervalMinutes: z
    .number()
    .int()
    .min(MIN_PLAN_INTERVAL_MINUTES)
    .max(MAX_PLAN_INTERVAL_MINUTES),
};
const createBody = z
  .object({
    name: fields.name,
    description: fields.description.default(''),
    items: fields.items,
    maxParallel: fields.maxParallel.default(4),
    cron: fields.cron.default(null),
    timezone: fields.timezone.default('Asia/Shanghai'),
    enabled: fields.enabled.default(true),
    minIntervalMinutes: fields.minIntervalMinutes.default(60),
  })
  .strict();
const updateBody = z.object(fields).partial().strict();
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const toItems = (items: z.infer<typeof itemSchema>[]) =>
  items.map((item) => ({ ...item, params: item.params }));

function actionContext(req: FastifyRequest): DetectJobActionContext {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' ? ua : null };
}

function nameTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw conflict('同名检测策略已存在', 'DETECT_STRATEGY_NAME_TAKEN');
  }
  throw err;
}

async function loadStrategy(id: string) {
  const s = await prisma.detectStrategy.findUnique({
    where: { id },
    include: { _count: { select: { jobs: true } } },
  });
  if (!s) throw notFound('检测策略不存在', 'DETECT_STRATEGY_NOT_FOUND');
  return s;
}

async function creators(ids: Array<string | null>) {
  const want = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (!want.length) return new Map<string, { id: string; username: string }>();
  const rows = await prisma.user.findMany({
    where: { id: { in: want } },
    select: { id: true, username: true },
  });
  return new Map(rows.map((u) => [u.id, u]));
}

export async function detectStrategyRoutes(
  app: FastifyInstance,
  options: DetectStrategyRoutesOptions = {},
): Promise<void> {
  const scheduler = options.scheduler ?? defaultDetectStrategyScheduler();
  app.addHook('preHandler', authenticate);

  const audit = (req: FastifyRequest, action: string, id: string, detail?: unknown) => {
    const ctx = actionContext(req);
    return writeAudit({
      actorId: req.currentUser!.id,
      actorName: req.currentUser!.username,
      action,
      targetType: 'detect_strategy',
      targetId: id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      detail,
    });
  };

  app.get('/', READ, async (req) => {
    const q = listQuery.parse(req.query);
    const [total, rows] = await Promise.all([
      prisma.detectStrategy.count(),
      prisma.detectStrategy.findMany({
        include: { _count: { select: { jobs: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    const users = await creators(rows.map((r) => r.createdById));
    return {
      items: rows.map((r) => serializeStrategy(r, users)),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  });

  app.get('/:id', READ, async (req) => {
    const { id } = idParams.parse(req.params);
    const s = await loadStrategy(id);
    return serializeStrategy(s, await creators([s.createdById]));
  });

  app.get('/:id/jobs', READ, async (req) => {
    const { id } = idParams.parse(req.params);
    await loadStrategy(id);
    const q = listQuery.parse(req.query);
    return listDetectJobs({ strategyId: id, page: q.page, pageSize: q.pageSize });
  });

  app.post('/', MANAGE, async (req, reply) => {
    const body = createBody.parse(req.body ?? {});
    assertStrategySchedule(body);
    const items = await prepareStrategyItems(req.currentUser!, toItems(body.items));
    const s = await prisma.detectStrategy
      .create({
        data: {
          name: body.name,
          description: body.description,
          items,
          maxParallel: body.maxParallel,
          cron: body.cron,
          timezone: body.timezone,
          enabled: body.enabled,
          minIntervalMinutes: body.minIntervalMinutes,
          createdById: req.currentUser!.id,
        },
        include: { _count: { select: { jobs: true } } },
      })
      .catch(nameTaken);
    await scheduler.sync(s);
    await audit(req, 'detect_strategy.create', s.id, {
      name: s.name,
      cron: s.cron,
      timezone: s.timezone,
      enabled: s.enabled,
      kinds: body.items.map((i) => i.kind),
    });
    reply.code(201);
    return serializeStrategy(s, await creators([s.createdById]));
  });

  app.patch('/:id', MANAGE, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = updateBody.parse(req.body ?? {});
    const existing = await loadStrategy(id);
    const merged = {
      cron: body.cron === undefined ? existing.cron : body.cron,
      timezone: body.timezone ?? existing.timezone,
      minIntervalMinutes: body.minIntervalMinutes ?? existing.minIntervalMinutes,
    };
    if (body.cron !== undefined || body.timezone || body.minIntervalMinutes || body.enabled) {
      assertStrategySchedule(merged);
    }
    const items = body.items
      ? await prepareStrategyItems(req.currentUser!, toItems(body.items))
      : undefined;
    const s = await prisma.detectStrategy
      .update({
        where: { id },
        data: {
          name: body.name,
          description: body.description,
          items,
          maxParallel: body.maxParallel,
          cron: merged.cron,
          timezone: merged.timezone,
          minIntervalMinutes: merged.minIntervalMinutes,
          enabled: body.enabled,
        },
        include: { _count: { select: { jobs: true } } },
      })
      .catch(nameTaken);
    await scheduler.sync(s);
    await audit(req, 'detect_strategy.update', s.id, {
      changed: Object.keys(body),
      cron: s.cron,
      enabled: s.enabled,
    });
    return serializeStrategy(s, await creators([s.createdById]));
  });

  app.delete('/:id', MANAGE, async (req) => {
    const { id } = idParams.parse(req.params);
    const existing = await loadStrategy(id);
    // 已产生的组合任务保留（strategyId 置空）。
    await prisma.detectStrategy.delete({ where: { id } });
    await scheduler.remove(id);
    await audit(req, 'detect_strategy.delete', id, {
      name: existing.name,
      keptJobCount: existing._count.jobs,
    });
    return { id, deleted: true };
  });

  // 立即执行：按策略建组合任务并启动（一键启动）。
  app.post('/:id/run', MANAGE, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    await loadStrategy(id);
    const result = await triggerDetectStrategy(id, {
      triggeredBy: 'manual',
      user: req.currentUser!,
      ctx: actionContext(req),
    });
    reply.code(201);
    return getDetectJobDetail(result.jobId!, req.currentUser!);
  });
}
