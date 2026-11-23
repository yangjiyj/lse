import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../../db.js';
import { requirePermission } from '../../../plugins/auth.js';
import { writeAudit } from '../../../lib/audit.js';
import { forbidden } from '../../../lib/errors.js';
import { PLATFORM_TENANT_ID } from '../../../lib/tenant-models.js';
import type { CurrentUser } from '../../../lib/rbac.js';
import {
  enqueueBankUpdate,
  hasPendingBankUpdate,
  isBankUpdateRunning,
  type BankUpdateJobData,
} from './queue.js';
import { loadBankUpdateOverview } from './service.js';

/** 路由用到的外部动作；测试替换成同步执行或假实现。 */
export const bankUpdateRouteDeps = {
  enqueue: (data: BankUpdateJobData): Promise<void> => enqueueBankUpdate(data),
  hasPending: (kind: BankUpdateJobData['kind']): Promise<boolean> => hasPendingBankUpdate(kind),
};

/** 改的是全平台共享题库与词库：只有平台租户里的平台管理员能立即更新。 */
export const canRunBankUpdate = (u: Pick<CurrentUser, 'isPlatformAdmin' | 'tenantIsPlatform'> | undefined): boolean =>
  Boolean(u?.isPlatformAdmin && u.tenantIsPlatform);

const runBody = z.object({ kind: z.enum(['questions', 'keywords']) });

/** 挂在 /api/question-sets/builtin/updates 下。 */
export async function bankUpdateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [requirePermission('question_set:read')] }, async (request) => ({
    ...(await loadBankUpdateOverview(prisma)),
    canRun: canRunBankUpdate(request.currentUser),
  }));

  app.post('/run', { preHandler: [requirePermission('question_set:update')] }, async (request) => {
    if (!canRunBankUpdate(request.currentUser)) throw forbidden('仅平台租户的平台管理员可以立即更新题库与关键词库', 'PLATFORM_ADMIN_REQUIRED');
    const { kind } = runBody.parse(request.body ?? {});
    const label = kind === 'questions' ? '题库更新' : '关键词补充';
    if ((await isBankUpdateRunning(prisma, kind)) || (await bankUpdateRouteDeps.hasPending(kind))) {
      return { started: false, message: `${label}正在进行，请稍后在更新记录里查看结果` };
    }
    const actorName = request.currentUser!.username;
    await bankUpdateRouteDeps.enqueue({ kind, trigger: 'manual', actorName });
    await writeAudit({
      actorId: request.currentUser!.id,
      actorName,
      action: 'question_set.bank_update_run',
      tenantId: PLATFORM_TENANT_ID,
      targetType: 'question_set',
      targetId: 'gbt45654',
      detail: { kind },
    });
    return { started: true, message: `已开始${label}，完成后会出现在更新记录里` };
  });
}
