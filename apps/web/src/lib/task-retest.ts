/**
 * 「复测 / 重新评估」按钮要不要给用户点。
 *
 * 后端 POST /eval-tasks/:id/re-eval（apps/api/src/modules/eval-tasks/routes.ts）对下面几类任务一律拒绝，
 * 这里按同一口径提前判断：不能复测的任务不显示可点的按钮，避免点了才弹一句「请去别处发起」。
 * 运行中、排队中只是暂时不可点，由页面自己的 disabled 处理，不算「不支持」。
 */
export const ENDPOINT_TASK_ENTRY_MESSAGE =
  '真机测评需要重新选择智能体和风险范围，并确认影响，请通过新建评估发起。';

export interface RetestableTask {
  status: string;
  name?: string;
  endpointMode?: 'posture' | 'live';
  engines: string[];
  modelTarget?: { targetType?: string } | null;
  standardRun?: { id: string } | null;
}

/** 不支持复测时返回原因（用于提示文字），支持则返回 null。 */
export function reEvalBlockedReason(task: RetestableTask): string | null {
  if (
    task.modelTarget?.targetType === 'ENDPOINT_AGENT' ||
    task.engines.includes('endpoint-agent-eval')
  ) {
    if (task.endpointMode === 'posture') return null;
    return ENDPOINT_TASK_ENTRY_MESSAGE;
  }
  if (task.standardRun) return '标准专项必须创建新的标准运行，不支持在原任务上复测。';
  if (task.engines.includes('ai-infra-guard')) return '历史 AIG 任务仅供查看，不支持复测。';
  if (task.engines.includes('agent-fanout')) {
    return '间接提示注入评估不支持直接重新执行，请在评估任务页重新发起。';
  }
  return null;
}
