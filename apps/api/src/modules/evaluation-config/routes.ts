import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { notFound } from '../../lib/errors.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { loadEvaluationSettings, weightedScoreForTask } from '../../lib/weighted-score.js';

const idParams = z.object({ id: z.string().uuid() });

/**
 * 配置管理的只读消费端：发起评测读取单次评测题数，任务详情读取综合评测得分。
 * 修改走 /api/system-settings（evaluation 分组，平台设置权限 + 审计）。
 */
export async function evaluationConfigRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get(
    '/',
    { preHandler: [requirePermission('eval_task:read', 'eval_task:create')] },
    async () => loadEvaluationSettings(),
  );

  // 综合评测得分：按评估类型（题型）统计通过/风险样本及风险严重度，套用配置的两组权重占比。
  // 与任务列表、详情、多模型对比、态势概览 TOP5 的 evalScore 同一口径（lib/weighted-score.ts）。
  app.get(
    '/tasks/:id/score',
    { preHandler: [requirePermission('eval_task:read')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const task = await prisma.evalTask.findUnique({ where: { id }, select: { id: true } });
      if (!task) throw notFound('评估任务不存在');
      const config = await loadEvaluationSettings();
      const result = await weightedScoreForTask(id, config);
      return {
        ...result,
        dimensionWeights: config.dimensionWeights,
        scoreWeights: config.scoreWeights,
      };
    },
  );
}
