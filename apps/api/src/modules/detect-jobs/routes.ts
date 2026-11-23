import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DETECT_JOB_ITEM_KINDS } from '@lse/shared';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import {
  DETECT_JOB_MAX_ITEMS,
  DETECT_JOB_MAX_PARALLEL,
  createDetectJob,
  deleteDetectJob,
  getDetectJobDetail,
  listDetectJobs,
  pauseDetectJob,
  resumeDetectJob,
  startDetectJob,
  stopDetectJob,
  type DetectJobActionContext,
} from './service.js';
import { writeAudit } from '../../lib/audit.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import { createDetectJobReport } from './report.js';

// 组合任务接口 /api/detect-jobs（2.4.2、2.4.9）：读要 detect_task:read，写要 detect_task:manage；
// 建任务另要每个子任务的发起权限。

const READ = { preHandler: [requirePermission('detect_task:read')] };
const MANAGE = { preHandler: [requirePermission('detect_task:manage')] };

const idParams = z.object({ id: z.string().uuid() });
const createBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    maxParallel: z.number().int().min(1).max(DETECT_JOB_MAX_PARALLEL).optional(),
    items: z
      .array(
        z
          .object({
            kind: z.enum(DETECT_JOB_ITEM_KINDS),
            title: z.string().trim().max(200).optional(),
            params: z.unknown(),
            toolId: z.string().uuid().nullable().optional(),
            ledgerAssetId: z.string().uuid().nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(DETECT_JOB_MAX_ITEMS),
    start: z.boolean().optional(),
  })
  .strict();
const reportBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    templateId: z.string().uuid().optional(),
  })
  .strict();
const listQuery = z.object({
  status: z.enum(['PENDING', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELED']).optional(),
  strategyId: z.string().uuid().optional(),
  schemeId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

function actionContext(req: FastifyRequest): DetectJobActionContext {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' ? ua : null };
}

export async function detectJobRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/', READ, async (req) => listDetectJobs(listQuery.parse(req.query)));

  app.get('/:id', READ, async (req) => {
    const { id } = idParams.parse(req.params);
    return getDetectJobDetail(id, req.currentUser!);
  });

  // 建组合任务；start: true 是「一键启动」，建完立即按并发上限启动子任务。
  app.post('/', MANAGE, async (req, reply) => {
    const body = createBody.parse(req.body);
    const user = req.currentUser!;
    const ctx = actionContext(req);
    const { id } = await createDetectJob(user, {
      name: body.name,
      maxParallel: body.maxParallel,
      items: body.items.map((item) => ({ ...item, params: item.params })),
      triggeredBy: 'manual',
    });
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'detect_job.create',
      targetType: 'detect_job',
      targetId: id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      detail: {
        name: body.name,
        maxParallel: body.maxParallel ?? null,
        kinds: body.items.map((i) => i.kind),
        start: body.start ?? false,
      },
    });
    if (body.start) await startDetectJob(user, id, ctx);
    reply.code(201);
    return getDetectJobDetail(id, req.currentUser!);
  });

  const lifecycle = {
    start: startDetectJob,
    pause: pauseDetectJob,
    resume: resumeDetectJob,
    stop: stopDetectJob,
  } as const;
  for (const [action, run] of Object.entries(lifecycle)) {
    app.post(`/:id/${action}`, MANAGE, async (req) => {
      const { id } = idParams.parse(req.params);
      await run(req.currentUser!, id, actionContext(req));
      return getDetectJobDetail(id, req.currentUser!);
    });
  }

  // 综合检测报告（2.4.7）：组合任务结束且至少一项完成后可生成，报告类型沿用组合报告。
  app.post(
    '/:id/report',
    {
      preHandler: [
        requirePermission('report:generate'),
        requirePermission('detect_task:read'),
        requireLicensedFeature('content_retention'),
      ],
    },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = reportBody.parse(req.body ?? {});
      const out = await createDetectJobReport(req.currentUser!, id, body, actionContext(req));
      reply.code(201);
      return { ...out, kind: 'combined' };
    },
  );

  app.delete('/:id', MANAGE, async (req) => {
    const { id } = idParams.parse(req.params);
    await deleteDetectJob(req.currentUser!, id, actionContext(req));
    return { id, deleted: true };
  });
}
