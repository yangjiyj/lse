import { badRequest } from './errors.js';

export const ENDPOINT_TASK_ENTRY_MESSAGE = '终端智能体请在对象详情页发起配置体检或真机测评';

/** 普通任务入口不得绕过终端审批和真实终端执行链路。 */
export function assertNonEndpointTaskTarget(target: { targetType: string }): void {
  if (target.targetType === 'ENDPOINT_AGENT') throw badRequest(ENDPOINT_TASK_ENTRY_MESSAGE);
}

export interface TaskTargetLookup {
  modelTarget: {
    findUnique(args: {
      where: { id: string };
      select: { targetType: true };
    }): Promise<{ targetType: string } | null>;
  };
}

export async function assertNonEndpointTaskTargetId(
  db: TaskTargetLookup,
  id: string,
): Promise<void> {
  const target = await db.modelTarget.findUnique({ where: { id }, select: { targetType: true } });
  if (target) assertNonEndpointTaskTarget(target);
}
