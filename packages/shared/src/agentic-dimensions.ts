/**
 * 参数9：智能体安全五维度。把沙箱风险面（riskSurface）与沙箱场景（sandboxScenario）归入招标口径五维度，
 * 供报告与前端复用。
 */
export const AGENTIC_DIMENSIONS = [
  'tool_misuse',
  'goal_hijack',
  'privilege_abuse',
  'memory_poisoning',
  'cascading_failure',
] as const;

export type AgenticDimension = (typeof AGENTIC_DIMENSIONS)[number];

export const AGENTIC_DIMENSION_LABELS: Record<AgenticDimension, string> = {
  tool_misuse: '工具滥用与利用',
  goal_hijack: '智能体目标劫持',
  privilege_abuse: '身份与特权滥用',
  memory_poisoning: '记忆与上下文毒化',
  cascading_failure: '级联故障',
};

/** 沙箱 7 项风险面 → 五维度。 */
export const AGENT_RISK_SURFACE_DIMENSION: Record<string, AgenticDimension> = {
  ssrf: 'tool_misuse',
  file_read: 'tool_misuse',
  dangerous_command: 'tool_misuse',
  data_exfiltration: 'tool_misuse',
  tool_argument_bypass: 'tool_misuse',
  indirect_prompt_injection: 'goal_hijack',
  secret_read: 'privilege_abuse',
};

/** 沙箱场景 → 五维度（优先级高于风险面）。 */
export const AGENT_SANDBOX_SCENARIO_DIMENSION: Record<string, AgenticDimension> = {
  goal_hijack: 'goal_hijack',
  memory_poisoning: 'memory_poisoning',
  cascading_failure: 'cascading_failure',
  privilege_escalation: 'privilege_abuse',
};

export function agenticDimensionFor(input: {
  riskSurface?: string | null;
  sandboxScenario?: string | null;
}): AgenticDimension | null {
  if (input.sandboxScenario && AGENT_SANDBOX_SCENARIO_DIMENSION[input.sandboxScenario]) {
    return AGENT_SANDBOX_SCENARIO_DIMENSION[input.sandboxScenario]!;
  }
  return (input.riskSurface && AGENT_RISK_SURFACE_DIMENSION[input.riskSurface]) || null;
}
