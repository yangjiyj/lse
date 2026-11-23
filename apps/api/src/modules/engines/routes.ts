import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { prisma } from '../../db.js';
import { engineCatalog } from './catalog.js';
import { LLM_JUDGE_ENGINE } from './llm-judge.js';
import { registerAiAssetStaticRoutes } from './ai-asset/static-routes.js';
import { registerAiComponentRoutes } from './ai-asset/component-routes.js';
import { registerRelayAuditRoutes } from './relay-audit.js';
import { registerCustomRiskRoutes } from './custom-risk/routes.js';

/** 是否存在「激活且凭据完整」的裁判模型(JUDGE)——AI 评审复核据此判定可用。 */
async function hasUsableJudgeTarget(): Promise<boolean> {
  const judge = await prisma.modelTarget.findFirst({
    where: { targetType: 'JUDGE', isActive: true },
    select: { baseUrl: true, apiKey: true, model: true },
  });
  return Boolean(judge && judge.baseUrl?.trim() && judge.apiKey?.trim() && judge.model?.trim());
}

/** 引擎目录路由：供前端创建评估任务时展示可选引擎及其可用状态。 */
export async function engineRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/', { preHandler: [requirePermission('eval_task:read')] }, async () => {
    const catalog = engineCatalog();
    // llm-judge(AI 评审复核)除全局 env 开关外，配置了激活的裁判模型(JUDGE)同样视为可用，
    // 否则会把"靠裁判模型在跑"的复核误标为未部署。
    if (!(await hasUsableJudgeTarget())) return catalog;
    return catalog.map((e) => (e.engine === LLM_JUDGE_ENGINE ? { ...e, available: true } : e));
  });

  await registerAiAssetStaticRoutes(app);
  await registerAiComponentRoutes(app);
  await registerRelayAuditRoutes(app);
  await registerCustomRiskRoutes(app);
}
