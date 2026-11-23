import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import {
  TRANSFER_KINDS,
  TransferRejected,
  executeTransfer,
  planTransfer,
} from '../../lib/tenant-transfer.js';

const kindSchema = z.enum(['model-target', 'fleet-endpoint', 'question-set', 'agent-sample']);

const transferInputSchema = z.object({
  kind: kindSchema,
  // 评估对象/终端/题集是 uuid，自建样本的主键是 slug（如 vec-direct-creds-backup），不能统一按 uuid 校验。
  ids: z.array(z.string().trim().min(1).max(100)).min(1, '请至少选择一个对象').max(200, '一次最多转移 200 个对象'),
  targetTenantId: z.string().uuid(),
});

/** 审计里最多记这么多个根对象名，避免一条日志塞进上百个 UUID。 */
const AUDIT_ROOT_LIMIT = 20;

/**
 * 资产租户归属转移：仅平台管理员（租户管理权限）。
 * 挂在 /api/tenants 下，所以「全部租户」只读视角下也允许调用（写白名单已包含 /api/tenants）。
 */
export async function tenantTransferRoutes(app: FastifyInstance): Promise<void> {
  app.get('/transfer/kinds', async () => ({
    items: TRANSFER_KINDS.map((item) => ({ kind: item.kind, label: item.label })),
  }));

  app.post('/transfer/preflight', async (request) => {
    const body = transferInputSchema.parse(request.body);
    return planTransfer(body);
  });

  app.post('/transfer', async (request) => {
    const body = transferInputSchema.parse(request.body);
    let result;
    try {
      result = await executeTransfer(body);
    } catch (err) {
      if (err instanceof TransferRejected) throw conflict(err.message, 'TRANSFER_REJECTED');
      throw err;
    }

    const user = request.currentUser!;
    const source = result.plan.sourceTenant.id;
    const target = result.plan.targetTenant.id;
    const detail = {
      kind: body.kind,
      kindLabel: result.plan.kindLabel,
      from: { id: source, name: result.plan.sourceTenant.name },
      to: { id: target, name: result.plan.targetTenant.name },
      roots: result.plan.roots.slice(0, AUDIT_ROOT_LIMIT).map((root) => ({ id: root.id, name: root.name })),
      rootTotal: result.plan.roots.length,
      counts: result.applied,
      totalRows: result.totalRows,
    };

    // 两边各留一条：源租户看得到「什么被转走了」，目标租户看得到「什么转进来了」。
    await writeAudit({
      tenantId: target,
      actorId: user.id,
      actorName: user.username,
      action: 'tenant.asset.transfer-in',
      targetType: 'tenant',
      targetId: target,
      detail,
    });
    if (source) {
      await writeAudit({
        tenantId: source,
        actorId: user.id,
        actorName: user.username,
        action: 'tenant.asset.transfer-out',
        targetType: 'tenant',
        targetId: source,
        detail,
      });
    }

    return result;
  });
}
