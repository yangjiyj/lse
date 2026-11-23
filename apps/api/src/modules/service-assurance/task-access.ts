import { prisma } from '../../db.js';
import { forbidden, notFound } from '../../lib/errors.js';
import type { CurrentUser } from '../../lib/rbac.js';

export type TaskAccessOperation = 'read' | 'scan' | 'verify' | 'review' | 'report';

const OPERATION_PERMISSION: Record<TaskAccessOperation, string> = {
  read: 'service_assurance:read',
  scan: 'service_assurance:scan',
  verify: 'service_assurance:verify',
  review: 'service_assurance:review',
  report: 'service_assurance:read',
};

export interface TaskAccessRecord {
  id: string;
  createdById: string | null;
}

export interface TaskAccessStore {
  evalTask: {
    findUnique(args: {
      where: { id: string };
      select: { id: true; createdById: true };
    }): Promise<TaskAccessRecord | null>;
  };
}

const prismaTaskAccessStore: TaskAccessStore = {
  evalTask: {
    findUnique: async (args) => prisma.evalTask.findUnique(args),
  },
};

export async function assertTaskAccess(
  user: CurrentUser,
  taskId: string,
  operation: TaskAccessOperation,
  store: TaskAccessStore = prismaTaskAccessStore,
): Promise<TaskAccessRecord> {
  const permission = OPERATION_PERMISSION[operation];
  if (!user.permissions.has(permission)) {
    throw forbidden('缺少服务安全核验操作权限', 'SERVICE_ASSURANCE_PERMISSION_DENIED');
  }

  const task = await store.evalTask.findUnique({
    where: { id: taskId },
    select: { id: true, createdById: true },
  });
  if (!task) throw notFound('评估任务不存在', 'EVAL_TASK_NOT_FOUND');

  if (user.isBuiltin || task.createdById === user.id) return task;
  if (task.createdById === null && operation === 'read') return task;

  if (operation === 'read') {
    throw notFound('评估任务不存在', 'EVAL_TASK_NOT_FOUND');
  }
  throw forbidden('无权操作该评估任务', 'EVAL_TASK_ACCESS_DENIED');
}

export function assertAssurancePermission(user: CurrentUser, operation: TaskAccessOperation): void {
  if (!user.permissions.has(OPERATION_PERMISSION[operation])) {
    throw forbidden('缺少服务安全核验操作权限', 'SERVICE_ASSURANCE_PERMISSION_DENIED');
  }
}

export interface RunAccessRecord {
  taskId: string | null;
  createdById: string | null;
}

/**
 * 已关联评估任务的核验沿用任务对象权限；未关联的核验归属发起人，
 * 仅发起人与内置管理员可见、可操作（读取时对他人按不存在处理）。
 */
export async function assertRunAccess(
  user: CurrentUser,
  run: RunAccessRecord,
  operation: TaskAccessOperation,
  store: TaskAccessStore = prismaTaskAccessStore,
): Promise<void> {
  if (run.taskId) {
    await assertTaskAccess(user, run.taskId, operation, store);
    return;
  }
  assertAssurancePermission(user, operation);
  if (user.isBuiltin || (run.createdById !== null && run.createdById === user.id)) return;
  if (operation === 'read') {
    throw notFound('服务安全核验运行不存在', 'SERVICE_ASSURANCE_RUN_NOT_FOUND');
  }
  throw forbidden('无权操作该核验记录', 'SERVICE_ASSURANCE_RUN_ACCESS_DENIED');
}
