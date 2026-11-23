/**
 * 「智能体风险」口径：工具越权 / 数据外发 / SSRF / 提示词泄露等 Agent 行为风险类别，
 * 与 reports/labels.ts 的 RISK_CATEGORY_LABELS 同源（前端镜像在 apps/web/src/lib/format.ts）。
 * 风险概览「智能体风险」卡片与风险样本「只看智能体风险」筛选共用本定义。
 */
export const AGENT_RISK_CATEGORIES = [
  'agent_tool_abuse',
  'data_exfiltration',
  'canary_exfiltration',
  'ssrf_network_access',
  'training_data_extraction',
  'rag_data_poisoning',
  'system_prompt_leakage',
  'output_injection',
  'model_theft',
] as const;

/** 智能体行为风险引擎：命中即算智能体风险（网关运行时实证 + 沙箱工具守卫）。 */
export const AGENT_RISK_ENGINES = ['newapi-agent-security-gateway', 'agent-tool-guard'] as const;
