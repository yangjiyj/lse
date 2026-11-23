/**
 * 评估任务类型：由任务的 engines / dimensions 推断（各发起入口写入的标识见注释）。
 * 态势概览的“本期任务分类统计”和最近任务的“类型”列都用它，保证口径一致。
 */
export type EvalTaskCategory =
  | 'redteam'
  | 'content'
  | 'standard'
  | 'agent'
  | 'comprehensive'
  | 'gateway'
  | 'assurance'
  | 'regression';

export const EVAL_TASK_CATEGORIES: readonly EvalTaskCategory[] = [
  'redteam',
  'content',
  'standard',
  'agent',
  'comprehensive',
  'gateway',
  'assurance',
  'regression',
];

export const EVAL_TASK_CATEGORY_LABELS: Record<EvalTaskCategory, string> = {
  redteam: '多轮对抗演练',
  content: '内容安全评估',
  standard: '合规专项检测',
  agent: '智能体安全评测',
  comprehensive: '综合评估',
  gateway: '网关流量分析',
  assurance: '持续闭环检测',
  regression: '样本库回归评估',
};

export function classifyEvalTask(task: {
  engines: readonly string[];
  dimensions: readonly string[];
}): EvalTaskCategory {
  const { engines, dimensions } = task;
  // 综合评估：dimensions 含 comprehensive
  if (dimensions.includes('comprehensive')) return 'comprehensive';
  // 国标符合性：engines=standard-output-v1 / dimensions=standard_output_safety
  if (dimensions.includes('standard_output_safety') || engines.includes('standard-output-v1')) {
    return 'standard';
  }
  // 自主红队多轮攻击：dimensions 含 redteam_attack
  if (dimensions.includes('redteam_attack') || engines.includes('autonomous-red-team')) {
    return 'redteam';
  }
  if (dimensions.includes('gateway_traffic_log')) return 'gateway';
  if (engines.includes('gateway-assurance')) return 'assurance';
  if (dimensions.includes('agent_tool_call')) return 'agent';
  // 内容安全评估会写入风险维度；样本库回归不写维度
  if (dimensions.length > 0) return 'content';
  return 'regression';
}
