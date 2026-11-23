import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import { writeAudit } from '../../lib/audit.js';
import {
  auditDownload,
  resolveDownloadWatermark,
  textWatermarkHeader,
} from '../../lib/data-security.js';
import { redactString } from '../../lib/redact.js';
import { enqueueBatchEvaluation } from '../../lib/queue.js';
import {
  createBatchPlan,
  generateBatchReport,
  getBatchDetail,
  planAccess,
  requirePlan,
  validatePlanConfiguration,
} from './service.js';

const ids = z.object({ id: z.string().uuid() });
const createBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    targetIds: z.array(z.string().uuid()).min(1).max(50),
    questionSetIds: z.array(z.string().uuid()).min(1).max(50),
    sampleCount: z.number().int().min(1).max(100000).default(10000),
    seed: z.string().trim().min(1).max(200),
    judgeMode: z.enum(['MODEL', 'RULES']).default('MODEL'),
    strategy: z.enum(['ROUND_ROBIN', 'SEQUENTIAL', 'PARALLEL']).default('ROUND_ROBIN'),
    concurrency: z.number().int().min(1).max(32).default(4),
    targetConcurrency: z.number().int().min(1).max(16).default(2),
    batchSize: z.number().int().min(1).max(200).default(50),
    rpm: z.number().int().min(1).max(60000).default(600),
    maxAttempts: z.number().int().min(1).max(5).default(3),
    maxRequests: z.number().int().min(1).max(10000000).optional(),
    maxDurationMinutes: z.number().int().min(1).max(10080).default(1440),
    callbackUrl: z.string().url().max(500).optional(),
  })
  .strict();
const pagination = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export async function batchEvaluationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.get('/', { preHandler: [requirePermission('eval_task:read')] }, async (request) => {
    const { page, pageSize } = pagination.parse(request.query);
    const where = planAccess(request.currentUser!);
    const [plans, total] = await Promise.all([
      prisma.batchEvaluation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true },
      }),
      prisma.batchEvaluation.count({ where }),
    ]);
    const items = await Promise.all(plans.map((p) => getBatchDetail(p.id)));
    return { items, total, page, pageSize };
  });
  app.post(
    '/',
    {
      preHandler: [
        requirePermission('eval_task:create'),
        requirePermission('model_target:read'),
        requirePermission('question_set:read'),
        requireLicensedFeature('web_ai'),
      ],
    },
    async (request, reply) => {
      const plan = await createBatchPlan(createBody.parse(request.body), request.currentUser!);
      await writeAudit({
        actorId: request.currentUser!.id,
        action: 'batch_evaluation.create',
        targetType: 'batch_evaluation',
        targetId: plan.id,
      });
      return reply.code(201).send(plan);
    },
  );
  app.get('/:id', { preHandler: [requirePermission('eval_task:read')] }, async (request) => {
    const { id } = ids.parse(request.params);
    await requirePlan(id, request.currentUser!);
    return getBatchDetail(id);
  });
  for (const action of ['start', 'pause', 'resume', 'cancel', 'retry-errors'] as const) {
    app.post(
      `/:id/${action}`,
      {
        preHandler: [
          requirePermission(action === 'start' ? 'eval_task:create' : 'eval_task:re_eval'),
          requireLicensedFeature('web_ai'),
        ],
      },
      async (request) => {
        const { id } = ids.parse(request.params);
        const plan = await requirePlan(id, request.currentUser!);
        const options = z
          .object({
            maxRequests: z.number().int().min(1).max(10000000).optional(),
            maxDurationMinutes: z.number().int().min(1).max(10080).optional(),
          })
          .strict()
          .parse(request.body ?? {});
        if (action === 'pause' || action === 'cancel') {
          const allowed =
            action === 'pause'
              ? (['PENDING', 'RUNNING'] as const)
              : (['PENDING', 'RUNNING', 'PAUSED', 'FAILED'] as const);
          if (!(allowed as readonly string[]).includes(plan.status))
            throw conflict('当前状态不能执行此操作');
          const changed = await prisma.batchEvaluation.updateMany({
            where: { id, status: { in: [...allowed] } },
            data: {
              status: action === 'pause' ? 'PAUSED' : 'CANCELED',
              stopReason: action === 'pause' ? 'USER_PAUSED' : 'USER_CANCELED',
              finishedAt: action === 'cancel' ? new Date() : null,
            },
          });
          if (!changed.count) throw conflict('计划状态已变更，请刷新后操作');
        } else {
          const allowed =
            action === 'start'
              ? ['PENDING']
              : action === 'resume'
                ? ['PAUSED', 'FAILED']
                : ['PAUSED', 'FAILED', 'COMPLETED'];
          if (!allowed.includes(plan.status)) throw conflict('当前状态不能启动或恢复此计划');
          if (plan.leaseUntil && plan.leaseUntil > new Date() && plan.status !== 'PENDING')
            throw conflict('正在结束在途调用，请稍后继续');
          await validatePlanConfiguration(id);
          const maxRequests = options.maxRequests ?? plan.maxRequests;
          const maxDurationMinutes = options.maxDurationMinutes ?? plan.maxDurationMinutes;
          if (maxRequests <= plan.requestsUsed)
            throw badRequest('调用预算已耗尽，请增加预算后继续');
          if (plan.startedAt && Date.now() - plan.startedAt.getTime() >= maxDurationMinutes * 60000)
            throw badRequest('执行时间上限已达到，请增加时间上限后继续');
          await prisma.$transaction(async (tx) => {
            const changed = await tx.batchEvaluation.updateMany({
              where: {
                id,
                status: plan.status,
                OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
              },
              data: {
                status: 'PENDING',
                startedAt: plan.startedAt ?? new Date(),
                maxRequests,
                maxDurationMinutes,
                stopReason: null,
                finishedAt: null,
              },
            });
            if (!changed.count) throw conflict('计划状态已变更或在途调用尚未结束');
            if (action === 'retry-errors') {
              const reset =
                await tx.$executeRaw`UPDATE "batch_evaluation_results" SET "status" = 'PENDING', "verdict" = NULL, "errorMessage" = NULL, "retryCount" = "retryCount" + 1, "targetAttemptLimit" = "attempts" + ${plan.maxAttempts}, "judgeAttemptLimit" = "judgeAttempts" + ${plan.maxAttempts} WHERE "runId" IN (SELECT "id" FROM "batch_evaluation_runs" WHERE "planId" = ${id}) AND "status" = 'DONE' AND "verdict" IN ('ERROR', 'UNKNOWN')`;
              if (!reset) throw badRequest('没有可重试的异常或待判定样本');
            }
            await tx.batchEvaluationRun.updateMany({
              where: { planId: id },
              data: { status: 'PENDING' },
            });
          });
          try {
            await enqueueBatchEvaluation(id);
          } catch {
            await prisma.batchEvaluation.updateMany({
              where: { id, status: 'PENDING' },
              data: { status: 'FAILED', stopReason: 'QUEUE_UNAVAILABLE' },
            });
            throw conflict('执行队列暂不可用，计划和样本已保留，请稍后恢复');
          }
        }
        await writeAudit({
          actorId: request.currentUser!.id,
          action: `batch_evaluation.${action}`,
          targetType: 'batch_evaluation',
          targetId: id,
        });
        return getBatchDetail(id);
      },
    );
  }
  app.get(
    '/:id/results',
    { preHandler: [requirePermission('eval_task:read'), requirePermission('eval_task:log_view')] },
    async (request) => {
      const { id } = ids.parse(request.params);
      await requirePlan(id, request.currentUser!);
      const query = pagination
        .extend({
          runId: z.string().uuid().optional(),
          verdict: z.enum(['PASS', 'FAIL', 'ERROR', 'UNKNOWN']).optional(),
        })
        .parse(request.query);
      const where = {
        run: { planId: id },
        ...(query.runId ? { runId: query.runId } : {}),
        ...(query.verdict ? { verdict: query.verdict } : {}),
      };
      const [rows, total] = await Promise.all([
        prisma.batchEvaluationResult.findMany({
          where,
          include: { run: { select: { targetName: true } }, sample: true },
          orderBy: [{ run: { position: 'asc' } }, { sample: { sequence: 'asc' } }],
          take: query.pageSize,
          skip: (query.page - 1) * query.pageSize,
        }),
        prisma.batchEvaluationResult.count({ where }),
      ]);
      return {
        items: rows.map((row) => ({
          id: row.id,
          runId: row.runId,
          targetName: row.run.targetName,
          sequence: row.sample.sequence,
          prompt: redactString((row.sample.snapshot as { content?: string }).content ?? ''),
          response: row.response === null ? null : redactString(row.response),
          verdict: row.verdict,
          severity: row.severity,
          category: row.category,
          errorMessage: row.errorMessage,
          attempts: row.attempts + row.judgeAttempts,
          latencyMs: row.latencyMs,
          totalTokens: row.totalTokens,
          evidence: row.evidence.map((value) => redactString(value)),
        })),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    },
  );
  app.get(
    '/:id/report',
    { preHandler: [requirePermission('eval_task:read'), requirePermission('report:read')] },
    async (request) => {
      const { id } = ids.parse(request.params);
      await requirePlan(id, request.currentUser!);
      const { runId } = z.object({ runId: z.string().uuid().optional() }).parse(request.query);
      return generateBatchReport(id, runId, false);
    },
  );
  app.get(
    '/:id/report/download',
    { preHandler: [requirePermission('eval_task:read'), requirePermission('report:download')] },
    async (request, reply) => {
      const { id } = ids.parse(request.params);
      await requirePlan(id, request.currentUser!);
      const { runId } = z.object({ runId: z.string().uuid().optional() }).parse(request.query);
      const report = await generateBatchReport(id, runId, false);
      const watermark = await resolveDownloadWatermark(request.currentUser!);
      await auditDownload(
        request.currentUser!,
        {
          kind: 'batch_evaluation_report',
          targetType: 'batch_evaluation',
          targetId: id,
          detail: { runId: runId ?? null },
        },
        request,
      );
      const filename =
        (report.title.replace(/[\\/\r\n\0:*?"<>|]/g, ' ').slice(0, 160) || '批量评估报告') + '.md';
      reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="batch-evaluation-report.md"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        );
      return reply.send((watermark ? textWatermarkHeader(watermark) : '') + report.content);
    },
  );
}
