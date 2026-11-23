// 复测启动器（依赖注入缝）。默认实现调用 W3c 失败用例复测服务 createFailedRetestTask；
// 测试可通过 policySuggestions.retestLauncher 注入替身。
import type { PrismaClient } from '@prisma/client';
import { AppError, badRequest } from '../../lib/errors.js';
import { createFailedRetestTask } from '../eval-tasks/failed-retest.js';

export interface RetestLaunchOptions {
  actorId: string | null;
  /** 复测经网关路由到被测对象时，可覆盖目标对象（默认沿用父任务的对象）。 */
  targetIdOverride?: string;
  findingId?: string;
}

export interface RetestLaunchResult {
  taskId: string;
}

export interface RetestLauncher {
  launch(
    db: PrismaClient,
    parentTaskId: string,
    options: RetestLaunchOptions,
  ): Promise<RetestLaunchResult>;
}

export const RETEST_SERVICE_UNAVAILABLE = 'RETEST_SERVICE_UNAVAILABLE';

export class RetestServiceUnavailableError extends Error {
  readonly code = RETEST_SERVICE_UNAVAILABLE;
  constructor() {
    super('复测服务未接入');
    this.name = 'RetestServiceUnavailableError';
  }
}

export function isRetestUnavailable(err: unknown): boolean {
  return (
    err instanceof RetestServiceUnavailableError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === RETEST_SERVICE_UNAVAILABLE)
  );
}

/** W3c 复测服务的业务错误码 → 策略建议复测状态（retestStatus）。 */
export const RETEST_ERROR_STATUS: Record<string, string> = {
  RETEST_NO_FAILED_QUESTIONS: 'NO_FAILED_QUESTIONS',
  RETEST_PARENT_NOT_FINISHED: 'PARENT_NOT_FINISHED',
  RETEST_NOT_SUPPORTED: 'NOT_SUPPORTED',
  RETEST_FINDING_SCOPE_MISMATCH: 'FINDING_SCOPE_MISMATCH',
  REMEDIATION_CLOSED_IMMUTABLE: 'REMEDIATION_CLOSED',
  RETEST_TARGET_NOT_EXECUTABLE: 'TARGET_NOT_EXECUTABLE',
  RETEST_ACTOR_MISSING: 'ACTOR_MISSING',
};

/** 复测发起失败时写入策略建议的状态与说明；未识别的错误归为 LAUNCH_FAILED。 */
export function retestFailureState(err: unknown): { status: string; error: string } {
  if (isRetestUnavailable(err)) {
    return { status: 'SERVICE_UNAVAILABLE', error: '待复测：复测服务未接入' };
  }
  const message = err instanceof Error ? err.message : String(err);
  const mapped = err instanceof AppError ? RETEST_ERROR_STATUS[err.code] : undefined;
  if (mapped) return { status: mapped, error: `复测未发起：${message}`.slice(0, 500) };
  return { status: 'LAUNCH_FAILED', error: `复测发起失败：${message}`.slice(0, 500) };
}

/**
 * 默认实现：调用 W3c 失败用例复测服务，按父任务 FAIL/ERROR 题目建复测任务并入队。
 * 发起人由调用方给出（下发人/审核人/当前刷新操作人）；为空时拒绝，不以父任务创建人等顶替。
 */
export const defaultRetestLauncher: RetestLauncher = {
  async launch(db, parentTaskId, options) {
    const actorId = options.actorId;
    if (!actorId) throw badRequest('无法确定复测发起人', 'RETEST_ACTOR_MISSING');
    const result = await createFailedRetestTask(db, parentTaskId, {
      actorId,
      targetIdOverride: options.targetIdOverride ?? null,
      findingId: options.findingId ?? null,
    });
    return { taskId: result.task.id };
  },
};
