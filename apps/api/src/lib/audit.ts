import { prisma } from '../db.js';
import { redactJson } from './redact.js';
import { asSystem } from './tenant-context.js';

export interface AuditInput {
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: unknown;
  /** 记到指定租户的操作日志（缺省 = 当前请求的租户）；租户管理这类平台级操作记到平台租户。 */
  tenantId?: string;
}

/** Best-effort audit log. Never throws — auditing must not break the request. */
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    // 必须在函数内 await：Prisma 的查询是惰性的，到 await 时才读取租户上下文。
    const create = async () => { await prisma.auditLog.create({
      data: {
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        detail: redactJson(input.detail ?? undefined) as any,
      },
    }); };
    await (input.tenantId ? asSystem(create) : create());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] failed to write log:', (err as Error).message);
  }
}
