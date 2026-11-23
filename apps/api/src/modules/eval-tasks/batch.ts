import { platformAppEnabled } from '../eval-targets/platform-adapters/index.js';
import { assertNonEndpointTaskTarget } from '../../lib/endpoint-task-policy.js';
import type { FastifyInstance } from 'fastify';
import { MAX_SAMPLE_SIZE, sampledTotal } from './sampling.js';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { computePassRate } from '@lse/shared';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/auth.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { loadEnabledQuestionSets } from '../question-sets/enabled.js';
import { enqueueEvalTask } from '../../lib/queue.js';
import { riskLevelsByTask, withScore } from './analytics.js';
import { compareTaskFailRates, statisticsFromTaskRow } from '../../lib/eval-statistics.js';
import { weightedScoresByTask } from '../../lib/weighted-score.js';

export const MAX_BATCH_MODELS = 10;

const batchCreateBody = z.object({
  name: z.string().trim().min(1).max(180),
  description: z.string().trim().max(2000).optional(),
  modelTargetIds: z.array(z.string().uuid()).min(2).max(MAX_BATCH_MODELS),
  questionSetIds: z.array(z.string().uuid()).min(1),
  engines: z
    .array(z.string().trim().min(1))
    .default([])
    .refine((list) => !list.includes('ai-infra-guard'), { message: 'AI_INFRA_GUARD_RETIRED' }),
  dimensions: z.array(z.string().trim().min(1)).default([]),
  concurrency: z.number().int().min(1).max(32).default(4),
  sampleSize: z.number().int().min(1).max(MAX_SAMPLE_SIZE).optional(),
  sampleSeed: z.string().trim().min(1).max(120).optional(),
});

const compareQuery = z
  .object({
    ids: z
      .string()
      .optional()
      .transform((v) =>
        v
          ? [
              ...new Set(
                v
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              ),
            ]
          : [],
      ),
    batchId: z.string().trim().min(1).max(100).optional(),
  })
  .refine((q) => q.ids.length > 0 || q.batchId, { message: '请指定 ids 或 batchId' });

type CategoryRow = { taskId: string; category: string | null; passed: bigint; failed: bigint };

/** 按题目分类统计各任务的通过/不通过数（只计 PASS / FAIL 判定）。 */
async function categoryPassRates(taskIds: string[]) {
  const rows = await prisma.$queryRaw<CategoryRow[]>(Prisma.sql`
    SELECT r."taskId" AS "taskId", q."category" AS "category",
      COUNT(*) FILTER (WHERE r."finalVerdict" = 'PASS') AS "passed",
      COUNT(*) FILTER (WHERE r."finalVerdict" = 'FAIL') AS "failed"
    FROM "eval_results" r JOIN "questions" q ON q."id" = r."questionId"
    WHERE r."taskId" IN (${Prisma.join(taskIds)})
    GROUP BY r."taskId", q."category"`);
  const map = new Map<
    string,
    Array<{ category: string; passed: number; failed: number; passRate: number | null }>
  >();
  for (const row of rows) {
    const passed = Number(row.passed);
    const failed = Number(row.failed);
    if (passed + failed === 0) continue;
    const list = map.get(row.taskId) ?? [];
    list.push({
      category: row.category || '未分类',
      passed,
      failed,
      passRate: computePassRate(passed, failed),
    });
    map.set(row.taskId, list);
  }
  return map;
}

export function registerBatchRoutes(app: FastifyInstance): void {
  // 多模型同批次：同一批样本对多个模型各建一个任务，共用 batchId。
  app.post(
    '/batch',
    { preHandler: [requirePermission('eval_task:create'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = batchCreateBody.parse(request.body);
      const modelIds = [...new Set(body.modelTargetIds)];
      if (modelIds.length < 2)
        throw badRequest('多模型对比至少选择 2 个不同的评估模型', 'BATCH_MODELS_TOO_FEW');
      const targets = await prisma.modelTarget.findMany({ where: { id: { in: modelIds } } });
      if (targets.length !== modelIds.length)
        throw badRequest('部分所选评估对象不存在', 'MODEL_TARGET_NOT_FOUND');
      targets.forEach(assertNonEndpointTaskTarget);
      if (targets.some(t => t.targetType === 'PLATFORM_APP') && !platformAppEnabled())
        throw forbidden('平台智能体测评功能未启用', 'PLATFORM_APP_DISABLED');
      const invalid = targets.find((t) => !t.isActive || t.targetType === 'GATEWAY_LOG');
      if (invalid) {
        throw badRequest(
          `评估对象「${invalid.name}」已禁用或不能用于主动评估`,
          'MODEL_TARGET_NOT_EXECUTABLE',
        );
      }
      const setIds = [...new Set(body.questionSetIds)];
      const sets = await loadEnabledQuestionSets(prisma, setIds);
      const totalQuestions = sampledTotal(
        sets.reduce((sum, s) => sum + s.questionCount, 0),
        body.sampleSize,
      );
      // 同批次共用同一抽样种子，保证多模型对比的是同一批题目。
      const sampleSeed = body.sampleSize ? (body.sampleSeed ?? randomUUID()) : null;

      const batchId = randomUUID();
      const byId = new Map(targets.map((t) => [t.id, t]));
      const created = await prisma.$transaction(
        modelIds.map((modelTargetId) =>
          prisma.evalTask.create({
            data: {
              name: `${body.name} · ${byId.get(modelTargetId)!.name}`.slice(0, 200),
              description: body.description ?? null,
              status: 'PENDING',
              modelTargetId,
              engines: body.engines,
              dimensions: body.dimensions,
              concurrency: body.concurrency,
              totalQuestions,
              sampleSize: body.sampleSize ?? null,
              sampleSeed,
              batchId,
              createdById: request.currentUser!.id,
              questionSets: { create: setIds.map((questionSetId) => ({ questionSetId })) },
            },
            select: { id: true, name: true, modelTargetId: true },
          }),
        ),
      );
      for (const task of created) await enqueueEvalTask(task.id);
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'eval_task.batch_create',
        targetType: 'eval_task_batch',
        targetId: batchId,
        detail: {
          name: body.name,
          modelTargetIds: modelIds,
          taskIds: created.map((t) => t.id),
          questionSetIds: setIds,
          totalQuestions,
        },
      });
      reply.code(201);
      return { batchId, tasks: created };
    },
  );

  // 多模型对比分析：得分、通过率、高中低风险数、分类别通过率。
  app.get('/compare', { preHandler: [requirePermission('eval_task:read')] }, async (request) => {
    const q = compareQuery.parse(request.query);
    const where: Prisma.EvalTaskWhereInput =
      q.ids.length > 0 ? { id: { in: q.ids } } : { batchId: q.batchId };
    const tasks = await prisma.evalTask.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: {
        id: true,
        name: true,
        status: true,
        batchId: true,
        passedCount: true,
        failedCount: true,
        errorCount: true,
        processedQuestions: true,
        totalQuestions: true,
        modelTarget: { select: { id: true, name: true } },
      },
    });
    if (tasks.length === 0) throw notFound('未找到可对比的评估任务');
    const ids = tasks.map((t) => t.id);
    const [levels, categories, scores] = await Promise.all([
      riskLevelsByTask(ids),
      categoryPassRates(ids),
      weightedScoresByTask(ids),
    ]);
    const stats = new Map(tasks.map((t) => [t.id, statisticsFromTaskRow(t)]));
    // 以最早创建的任务为基线，逐个提示失败率差异是否超出统计波动。
    const baseline = tasks[0]!;
    const differences = tasks.slice(1).map((t) => ({
      taskId: t.id,
      baselineTaskId: baseline.id,
      ...compareTaskFailRates(stats.get(baseline.id)!, stats.get(t.id)!),
    }));
    return {
      differences,
      items: tasks.map((t) => ({
        ...withScore(t, levels.get(t.id), scores),
        statistics: stats.get(t.id)!,
        modelName: t.modelTarget?.name ?? '—',
        passRate: computePassRate(t.passedCount, t.failedCount),
        categories: (categories.get(t.id) ?? []).sort((a, b) =>
          a.category.localeCompare(b.category, 'zh-CN'),
        ),
      })),
    };
  });
}
