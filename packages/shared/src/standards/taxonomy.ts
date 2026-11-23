/**
 * 三维分类：攻击手法（vector）× 资产与通道（channel）× 危害后果（harm）。
 *
 * 只有「危害后果」对接标准条款；攻击手法和通道用于组织攻击库、解释攻击从哪里进来。
 * 内容安全线的危害后果直接用 GB/T 45654 附录 A 的 31 项（见 clauses-content.ts）；
 * 智能体与终端两条线共用下面的 AGENT_HARMS。
 *
 * 旧分类（风险面、攻击招式、终端风险类型、运行态 vector/harm、MCP 攻击类、平台应用场景）
 * 一律经 legacy* 适配函数折算到三维，不再新增平行的分类表。
 */
import type { RuntimeChannel, RuntimeHarm, RuntimeVector } from '../runtime-eval.js';
import type { LiveRiskType } from '../fleet-live-eval.js';

export const ATTACK_VECTORS = [
  'direct_request',
  'jailbreak',
  'indirect_injection',
  'tool_poisoning',
  'memory_config_poisoning',
  'multi_step',
  'task_overreach',
  'supply_chain',
  'config_weakness',
] as const;
export type AttackVector = (typeof ATTACK_VECTORS)[number];

export const ATTACK_VECTOR_LABELS: Record<AttackVector, string> = {
  direct_request: '直接请求',
  jailbreak: '越狱与规避话术',
  indirect_injection: '间接注入',
  tool_poisoning: '工具描述或返回投毒',
  memory_config_poisoning: '记忆和配置文件投毒',
  multi_step: '多步拆分',
  task_overreach: '任务诱导的过度操作',
  supply_chain: '供应链（技能、插件、依赖）',
  config_weakness: '配置缺陷',
};

export const ASSET_CHANNELS = [
  'user_input',
  'multi_turn',
  'document',
  'code_comment',
  'dependency',
  'web_page',
  'tool_description',
  'tool_result',
  'knowledge_base',
  'memory_file',
  'agent_config',
  'ci_config',
  'image',
] as const;
export type AssetChannel = (typeof ASSET_CHANNELS)[number];

export const ASSET_CHANNEL_LABELS: Record<AssetChannel, string> = {
  user_input: '用户输入',
  multi_turn: '多轮对话',
  document: '文档',
  code_comment: '代码注释',
  dependency: '依赖与第三方说明',
  web_page: '网页',
  tool_description: '工具描述',
  tool_result: '工具返回',
  knowledge_base: '知识库',
  memory_file: '记忆文件',
  agent_config: '智能体配置',
  ci_config: '构建与 CI 配置',
  image: '图片',
};

/** 智能体与终端两条线共用的危害后果。 */
export const AGENT_HARMS = [
  'credential_read',
  'data_exfiltration',
  'destructive_delete',
  'tamper_files',
  'out_of_scope_write',
  'untrusted_exec',
  'persistence',
  'privilege_escalation',
  'internal_network_access',
  'sensitive_disclosure',
  'injected_instruction_followed',
  'content_violation',
  'resource_abuse',
  'control_bypass',
] as const;
export type AgentHarm = (typeof AGENT_HARMS)[number];

export const AGENT_HARM_LABELS: Record<AgentHarm, string> = {
  credential_read: '读取凭据',
  data_exfiltration: '数据外发',
  destructive_delete: '删除数据',
  tamper_files: '覆盖或篡改文件',
  out_of_scope_write: '越界写入',
  untrusted_exec: '执行不可信或远程代码',
  persistence: '植入持久化',
  privilege_escalation: '越权与提权',
  internal_network_access: '访问内网或云元数据',
  sensitive_disclosure: '泄露敏感信息',
  injected_instruction_followed: '执行了非用户意图的指令',
  content_violation: '生成违规内容',
  resource_abuse: '资源滥用',
  control_bypass: '绕过或关闭管控',
};

export interface AxisTags {
  vector?: AttackVector;
  channel?: AssetChannel;
  harms: AgentHarm[];
}

// ── 旧分类折算 ─────────────────────────────────────────────

const RUNTIME_VECTOR_MAP: Record<RuntimeVector, AttackVector> = {
  direct: 'direct_request',
  indirect: 'indirect_injection',
  tool_poison: 'tool_poisoning',
  memory_config: 'memory_config_poisoning',
  multi_step: 'multi_step',
  overreach: 'task_overreach',
};

const RUNTIME_CHANNEL_MAP: Record<RuntimeChannel, AssetChannel> = {
  doc: 'document',
  code: 'code_comment',
  dep: 'dependency',
  web: 'web_page',
  mcp: 'tool_result',
};

const RUNTIME_HARM_MAP: Record<RuntimeHarm, AgentHarm> = {
  exfiltrate: 'data_exfiltration',
  delete: 'destructive_delete',
  overwrite: 'tamper_files',
  exec_remote: 'untrusted_exec',
  credential_read: 'credential_read',
  persist: 'persistence',
  escalate: 'privilege_escalation',
  sabotage: 'tamper_files',
};

export function legacyRuntimeVector(v: RuntimeVector): AttackVector {
  return RUNTIME_VECTOR_MAP[v];
}
export function legacyRuntimeChannel(c: RuntimeChannel): AssetChannel {
  return RUNTIME_CHANNEL_MAP[c];
}
export function legacyRuntimeHarm(h: RuntimeHarm): AgentHarm {
  return RUNTIME_HARM_MAP[h];
}

/** 终端真机测评（classic）的 6 类风险。 */
const LIVE_RISK_MAP: Record<LiveRiskType, AxisTags> = {
  exfiltration: { harms: ['data_exfiltration'] },
  destructive_delete: { harms: ['destructive_delete'] },
  out_of_scope_write: { harms: ['out_of_scope_write'] },
  untrusted_command: { vector: 'indirect_injection', harms: ['untrusted_exec'] },
  indirect_instruction: { vector: 'indirect_injection', harms: ['injected_instruction_followed'] },
  credential_access: { harms: ['credential_read'] },
};
export function legacyLiveRisk(t: LiveRiskType): AxisTags {
  return LIVE_RISK_MAP[t];
}

/** 沙箱智能体评估的 7 个风险面（agent-evals/types.ts AgentRiskSurface）。 */
const AGENT_RISK_SURFACE_MAP: Record<string, AgentHarm[]> = {
  ssrf: ['internal_network_access'],
  secret_read: ['credential_read'],
  file_read: ['sensitive_disclosure'],
  dangerous_command: ['untrusted_exec'],
  data_exfiltration: ['data_exfiltration'],
  indirect_prompt_injection: ['injected_instruction_followed'],
  tool_argument_bypass: ['privilege_escalation'],
};
export function legacyAgentRiskSurface(surface: string): AgentHarm[] {
  return AGENT_RISK_SURFACE_MAP[surface] ?? [];
}

/** 沙箱攻击包的 6 种招式（L1–L6）都是规避话术，任务拆分单列。 */
const AGENT_TECHNIQUE_MAP: Record<string, AttackVector> = {
  boundary_reframe: 'jailbreak',
  task_splitting: 'multi_step',
  payload_smuggling: 'jailbreak',
  argument_obfuscation: 'jailbreak',
  tool_substitution: 'jailbreak',
  authority_override: 'jailbreak',
};
export function legacyAgentTechnique(technique: string): AttackVector | undefined {
  return AGENT_TECHNIQUE_MAP[technique];
}

/** MCP 专项（L7）的 8 个攻击类。 */
const MCP_CLASS_MAP: Record<string, AxisTags> = {
  tool_poisoning: { vector: 'tool_poisoning', channel: 'tool_description', harms: ['injected_instruction_followed'] },
  param_ssrf: { vector: 'direct_request', channel: 'tool_result', harms: ['internal_network_access'] },
  credential_exfil: { vector: 'direct_request', harms: ['credential_read', 'data_exfiltration'] },
  destructive_command: { vector: 'direct_request', harms: ['untrusted_exec', 'destructive_delete'] },
  shadow_tool: { vector: 'supply_chain', channel: 'tool_description', harms: ['injected_instruction_followed'] },
  rug_pull: { vector: 'tool_poisoning', channel: 'tool_description', harms: ['injected_instruction_followed'] },
  tool_enumeration: { vector: 'direct_request', harms: ['sensitive_disclosure'] },
  indirect_injection: { vector: 'indirect_injection', channel: 'tool_result', harms: ['injected_instruction_followed'] },
};
export function legacyMcpClass(cls: string): AxisTags | undefined {
  return MCP_CLASS_MAP[cls];
}

/** 平台应用评估（Dify/Coze）场景。 */
const PLATFORM_APP_MAP: Record<string, AxisTags> = {
  orchestration_leakage: { vector: 'direct_request', channel: 'agent_config', harms: ['sensitive_disclosure'] },
  knowledge_access: { vector: 'direct_request', channel: 'knowledge_base', harms: ['sensitive_disclosure'] },
  indirect_url: { vector: 'indirect_injection', channel: 'web_page', harms: ['injected_instruction_followed'] },
  tool_egress: { vector: 'direct_request', channel: 'tool_result', harms: ['data_exfiltration'] },
  output_egress: { vector: 'indirect_injection', channel: 'user_input', harms: ['data_exfiltration'] },
  multi_turn: { vector: 'multi_step', channel: 'multi_turn', harms: ['data_exfiltration'] },
};
export function legacyPlatformAppScenario(scenario: string): AxisTags | undefined {
  return PLATFORM_APP_MAP[scenario];
}

/**
 * 平台 20 个风险域里属于智能体行为后果的部分；内容类风险域不在此表（它们归附录 A，
 * 见 clauses-content.ts 的 CONTENT_DOMAIN_TO_ANNEX_MAJOR），提示注入是攻击手法不是后果。
 */
const RISK_DOMAIN_HARM_MAP: Record<string, AgentHarm[]> = {
  agent_tool_abuse: ['privilege_escalation'],
  data_exfiltration: ['data_exfiltration'],
  ssrf_network_access: ['internal_network_access'],
  output_injection: ['untrusted_exec'],
  system_prompt_leakage: ['sensitive_disclosure'],
  privacy_leakage: ['sensitive_disclosure'],
  training_data_extraction: ['sensitive_disclosure'],
  model_denial_of_service: ['resource_abuse'],
};
export function legacyRiskDomainHarms(domain: string): AgentHarm[] {
  return RISK_DOMAIN_HARM_MAP[domain] ?? [];
}

/** 风险域里属于「攻击手法」的部分。 */
const RISK_DOMAIN_VECTOR_MAP: Record<string, AttackVector> = {
  prompt_injection: 'jailbreak',
  rag_data_poisoning: 'memory_config_poisoning',
};
export function legacyRiskDomainVector(domain: string): AttackVector | undefined {
  return RISK_DOMAIN_VECTOR_MAP[domain];
}
