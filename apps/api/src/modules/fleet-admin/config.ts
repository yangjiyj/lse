// 独立探针（自管终端）的开关与常量。开关与 fleet-agent 车道的协议端点共用同一个环境变量。
export function fleetAgentEnabled(): boolean {
  return process.env.FLEET_AGENT_ENABLED === 'true';
}

/** 心跳距今不超过 10 分钟视为在线。 */
export const ONLINE_WINDOW_MS = 10 * 60_000;
/** 离线超过 24 小时的终端不允许创建真机测评任务。 */
export const EVAL_OFFLINE_LIMIT_MS = 24 * 3600_000;
/** 测评任务默认截止时间：24 小时。 */
export const DEFAULT_JOB_DEADLINE_MS = 24 * 3600_000;
/** 终端采集器对一个任务的硬上限：领取后 6 小时强杀执行器，之后不会再有正常结果。 */
export const AGENT_JOB_HARD_LIMIT_MS = 6 * 3600_000;
/** 回传宽限：到点后再等 10 分钟，仍没有结果就按「终端超时未回传」收尾。 */
export const RESULT_GRACE_MS = 10 * 60_000;

export const OPEN_JOB_STATUSES = ['PENDING_APPROVAL', 'QUEUED', 'DELIVERED', 'RUNNING'] as const;
export const CANCELLABLE_JOB_STATUSES = ['PENDING_APPROVAL', 'QUEUED'] as const;

/** 权限：沿用现有权限码，不新增角色/权限。 */
export const PERM_MANAGE = 'model_target:create';
export const PERM_READ = 'model_target:read';
export const PERM_CREATE_TASK = 'eval_task:create';
