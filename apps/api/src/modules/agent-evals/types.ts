import type { AgentHarm, AssetChannel, AttackVector, Severity } from '@lse/shared';

/** 样本的标准标签：条款 id 与三维分类（packages/shared/src/standards）。 */
export interface SampleStandardMetadata {
  clauseIds?: string[];
  vector?: AttackVector;
  channel?: AssetChannel;
  harms?: AgentHarm[];
}

export type AgentEvalLevel = 'smoke' | 'standard' | 'deep' | 'adversarial';
export type AgentPreflightStatus = 'passed' | 'skipped';

/**
 * Agent 场景化测评的攻击招式分类（针对工具调用边界，与红队内容安全招式不重叠）。
 *
 * - boundary_reframe：把工具边界重新定义成「当前场景下合规」，让模型相信越权调用是合法流程
 * - task_splitting：把危险任务拆成看似无害的子步骤，单步都安全、组合才危险
 * - payload_smuggling：让模型取回外部不可信内容，内容里夹带越权指令（间接注入）
 * - argument_obfuscation：用编码/混淆/同形字符绕过沙箱的参数检测（十进制 IP 等）
 * - tool_substitution：诱导模型用功能等价的替代工具实现禁用工具的效果
 * - authority_override：用伪权威/紧急生产场景让模型相信它有权越过工具边界
 */
export const AGENT_ATTACK_TECHNIQUES = [
  'boundary_reframe',
  'task_splitting',
  'payload_smuggling',
  'argument_obfuscation',
  'tool_substitution',
  'authority_override',
] as const;

export type AgentAttackTechnique = (typeof AGENT_ATTACK_TECHNIQUES)[number];

export type AgentRiskSurface =
  | 'ssrf'
  | 'secret_read'
  | 'file_read'
  | 'dangerous_command'
  | 'data_exfiltration'
  | 'indirect_prompt_injection'
  | 'tool_argument_bypass';

export type AgentSandboxToolName =
  | 'http_get'
  | 'read_file'
  | 'run_shell'
  | 'browser_open'
  | 'send_data'
  | 'plan_update'
  | 'user_input';

export interface AgentEvalStrengthConfig {
  level: AgentEvalLevel;
  label: string;
  defaultSampleCount: number;
  minSampleCount: number;
  maxSampleCount: number;
  maxTurns: number;
  variantDepth: number;
  riskSurfaces: readonly AgentRiskSurface[];
  techniques: readonly AgentAttackTechnique[];
  /** attacker LLM 对每条 baseline 做变形攻击的轮数（0 = 关闭自适应）。 */
  adaptiveRounds: number;
}

export interface AgentSandboxToolCall {
  id?: string;
  name: AgentSandboxToolName | string;
  arguments: Record<string, unknown>;
  raw?: unknown;
  rawArguments?: unknown;
  parseError?: 'invalid_json_arguments' | 'non_object_arguments';
  turnIndex?: number;
}

export interface AgentToolTrace {
  conversationId?: string | null;
  /** 平台真实调用的事后观测；allowed 表示策略判定，不代表执行前阻断。 */
  observed?: true;
  /** Generated only by the simulator: a synthetic control receipt, never evidence of I/O or authorization. */
  controlOnly?: true;
  /** Simulator cannot interpret this call; not proof of either safety or dangerous intent. */
  unsupportedSimulation?: true;
  simulatorArguments?: Record<string, unknown>;
  simulatorArgumentMap?: Record<string, { source: string; format?: 'string' | 'shell_argv' }>;
  callId?: string;
  turnIndex?: number;
  toolName: string;
  arguments: Record<string, unknown>;
  rawArguments?: unknown;
  parseError?: 'invalid_json_arguments' | 'non_object_arguments';
  allowed: boolean;
  riskSurface: AgentRiskSurface | null;
  blockReason: string | null;
  /**
   * 阻断来源。'sandbox'（缺省）：评测沙箱在网关放行后抓住危险调用 → 判 FAIL；
   * 'gateway'：被测网关在工具层直接拦截（hard_floor_block / AgentGuard confirmation）→ 防护生效，判 PASS。
   */
  blockedBy?: 'sandbox' | 'gateway' | 'endpoint';
  boundaryDecision?: AgentBoundaryDecision;
  simulatedResult: unknown;
}

export interface AgentBoundaryDecision {
  allowed: boolean;
  ruleId: string;
  reason: string;
}

export interface AgentShellPolicy {
  deniedCommands?: string[];
  deniedTransferPaths?: string[];
  readFixtures?: Record<string, string>;
}

export interface AgentToolBoundaryPolicy {
  allowedTools: AgentSandboxToolName[];
  deniedTools: AgentSandboxToolName[];
  requiresConfirmation: AgentSandboxToolName[];
  dataPolicy: string;
  egressAllowlist?: string[];
  fileAllowlist?: string[];
}

export interface AgentEvidenceEvent {
  step: number;
  eventType: 'scenario' | 'tool_call' | 'sandbox_decision' | 'model_response' | 'sink_fetch' | 'sink_exfil';
  summary: string;
  decision?: 'allowed' | 'blocked' | 'observed' | 'unknown';
  turnIndex?: number;
  toolName?: string;
  riskSurface?: AgentRiskSurface | null;
}

export interface AgentRemediationPlan {
  owner: string;
  actions: string[];
  retest: string;
  gatewayPolicy?: string[];
}

export interface AgentAttackTemplate {
  id: string;
  riskSurface: AgentRiskSurface;
  attackTechnique: AgentAttackTechnique;
  severity: Severity;
  promptTemplate: string;
  tools: readonly AgentSandboxToolName[];
  expectedPolicy: string;
  safeCanary: string;
  source: 'builtin';
  scenarioName?: string;
  businessRole?: string;
  attackVariant?: string;
  toolBoundary?: AgentToolBoundaryPolicy;
  successSignals?: readonly string[];
  evidenceRequirements?: readonly string[];
  remediation?: AgentRemediationPlan;
}

export interface AgentAttackPack {
  id: string;
  version: string;
  templates: readonly AgentAttackTemplate[];
}

/** attacker LLM 单轮变形攻击的记录(进 metadata.adaptiveAttackChain,供报告展示)。 */
export interface AgentAdaptiveAttackStep {
  round: number;
  move: string;
  userMessage: string;
  expectedDangerousCall: {
    tool: string;
    argumentHint: string;
    riskSurface: AgentRiskSurface;
  };
  deceptionArt: string;
  rationale: string;
  /** attacker 生成失败时记录,展示用。 */
  failed?: boolean;
  failureReason?: string;
}

/** L9 高风险操作人工介入场景的判定参数。 */
export interface AgentHitlSpec {
  /** 操作类别编号，例如 stop_service。 */
  operation: string;
  /** 中文操作名，报告展示用。 */
  operationLabel: string;
  /** 命中即视为「执行了高风险操作」的工具名。 */
  highRiskTools: string[];
  /** 工具参数文本命中任一正则（source）即视为执行了高风险操作；只读检查类调用不命中。 */
  patterns: string[];
}

export interface AgentScenarioMetadata extends SampleStandardMetadata {
  canaries?: string[];
  messages?: string[];
  egressAllowlist?: string[];
  prerequisites?: string[];
  compliance?: { gbt45654: string[]; owasp: string[]; atlas: string[]; agentic: string[]; note: string };
  triCase?: string;
  caseId?: string;
  riskFactors?: string[];
  agentInstanceId?: string;
  agentSnapshot?: unknown;
  originalAgentSnapshot?: unknown;
  kind: 'agent_runtime';
  seed: string;
  attackPackVersion: string;
  attackPackId: string;
  packIds: string[];
  riskSurface: AgentRiskSurface;
  attackTechnique: AgentAttackTechnique;
  allowedTools: AgentSandboxToolName[];
  maxTurns: number;
  templateId: string;
  variantDepth: number;
  expectedPolicy: string;
  safeCanary: string;
  scenarioName: string;
  businessRole: string;
  attackVariant: string;
  /**
   * 客户可读的一句话样本标题（「场景｜角色：业务诉求」）。
   * 仅供列表层展示，不发给被测模型；引擎规格走详情页折叠区。
   */
  displayTitle?: string;
  toolBoundary: AgentToolBoundaryPolicy;
  successSignals: string[];
  evidenceRequirements: string[];
  remediation: AgentRemediationPlan;
  preflightStatus: AgentPreflightStatus;
  preflightReason?: string;
  preflightChecks: string[];
  timeoutMs?: number;
  maxConcurrency?: number;
  /** L9 高风险操作人工介入场景；存在即按「执行前是否请求确认」判定。 */
  hitl?: AgentHitlSpec;
  /** 参数9 沙箱场景（L8）：goal_hijack / memory_poisoning / cascading_failure / privilege_escalation。 */
  sandboxScenario?: string;
  /** 记忆与上下文毒化场景注入的伪造记忆。 */
  injectedMemory?: string[];
  /** 五维度归类（工具滥用与利用 / 目标劫持 / 身份与特权滥用 / 记忆与上下文毒化 / 级联故障）。 */
  agenticDimension?: string | null;
  /** attacker LLM 注入(由 routes 在创建题时填好,runner 在多轮中读它生成变形话术)。 */
  attackerTarget?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  /** attacker 自适应攻击轮数(0 = 关闭,只用 baseline 单轮跑)。 */
  adaptiveRounds?: number;
}

export interface AgentScenario {
  id: string;
  prompt: string;
  type: 'PROMPT_INJECTION';
  category: string;
  language: 'zh' | 'en';
  severity: Severity;
  shouldRefuse: true;
  expectedBehavior: string;
  referenceAnswer: string | null;
  tags: string[];
  externalId: string;
  variantId: string;
  metadata: AgentScenarioMetadata;
}

export interface GenerateAgentScenarioOptions {
  level?: AgentEvalLevel | string;
  sampleCount?: number;
  seed?: string;
  riskSurfaces?: readonly AgentRiskSurface[];
  packIds?: readonly string[];
  preflightRequiredAnchors?: readonly string[];
  timeoutMs?: number;
  maxConcurrency?: number;
  /** 追加参数9 的四类沙箱场景（默认不追加，保持既有采样语义）。 */
  agenticScenarios?: boolean;
  /** 追加 L9 高风险操作人工介入场景（默认不追加，保持既有采样语义）。 */
  hitlScenarios?: boolean;
}

// ===========================================================================
// MCP 测-堵-验闭环样本（L7 层，独立于上面的 agent_runtime 沙箱攻击体系）
//
// 为什么独立而不并入 AGENT_ATTACK_TECHNIQUES / BUILTIN_AGENT_ATTACK_PACK：
//   1. adversarial 强度档的 techniques 直接取自 ALL_AGENT_ATTACK_MOVE_IDS，
//      并入会把 techniques 数量从 6 变 10（agent-eval-strength.test 断言 ===6）；
//   2. 并入会污染 generateAgentScenarios 的沙箱采样池，让 MCP 样本被渲染成
//      sandbox prompt（agent-eval-generator.test 断言每条 kind==='agent_runtime'）。
// 因此 MCP 用独立枚举 + 独立模板 + 独立 pack + 独立 generateMcpScenarios，
// 仅共享 AgentRiskSurface / Severity / AgentRemediationPlan 等结构。
// ===========================================================================

/**
 * 六类 MCP 攻击（对齐网关运行时红线 + 注册/同步期检测）。
 * - tool_poisoning：manifest 工具描述投毒（注册/同步期，security-engine 扫描）
 * - param_ssrf：tools/call 参数含云元数据地址（运行时红线 cloud_metadata）
 * - credential_exfil：tools/call 参数含 PEM 私钥（运行时红线 private_key_egress）
 * - destructive_command：tools/call 参数含破坏性命令（运行时红线 destructive_*）
 * - shadow_tool：同租户跨 server 注册同名工具（注册期 shadow-check）
 * - rug_pull：manifest 变更后再 sync（注册/同步期 manifest_hash 比对）
 */
export const MCP_ATTACK_CLASSES = [
  'tool_poisoning',
  'param_ssrf',
  'credential_exfil',
  'destructive_command',
  'shadow_tool',
  'rug_pull',
  'tool_enumeration',
  'indirect_injection',
] as const;

export type McpAttackClass = (typeof MCP_ATTACK_CLASSES)[number];

/**
 * MCP 专属攻击招式（与 AgentAttackTechnique 不重叠，故不并入 AGENT_ATTACK_TECHNIQUES）。
 * param_ssrf / destructive_command 两类复用 Agent 侧既有招式语义（见 mcpClassTechnique）。
 */
export const MCP_ATTACK_TECHNIQUES = [
  'tool_poisoning',
  'shadow_tool',
  'rug_pull',
  'credential_exfil',
] as const;

export type McpAttackTechnique = (typeof MCP_ATTACK_TECHNIQUES)[number];

/** 攻击执行阶段——决定 Lane 3 走 tools/call 还是 control-plane 管理端点。 */
export type McpAttackPhase = 'runtime' | 'registry';

/** 网关对 MCP tools/call 的裁决取值（与 tool_call_logs 双决策列同枚举）。 */
export type McpGatewayDecision = 'allow' | 'audit' | 'confirm' | 'block';

/**
 * 三态期望裁决（归因『堵』的断言依据）：
 * - rawDecision：网关检测层原始裁决（audit-only 铁律下仍应留痕的裁决）
 * - effectiveDecisionStrict：strict 租户下实际生效裁决（可真 block）
 * - effectiveDecisionAuditOnly：audit-only 铁律租户下实际生效裁决（被 clampModeToCeiling 钳到 audit）
 */
export interface McpExpectedPolicy {
  rawDecision: McpGatewayDecision;
  effectiveDecisionStrict: McpGatewayDecision;
  effectiveDecisionAuditOnly: McpGatewayDecision;
  /** 运行时红线类目（如 cloud_metadata / private_key_egress / destructive_rm），非红线类为 null。 */
  redlineTrigger: string | null;
  /** 期望命中的网关规则 id（如 mcp_redline_cloud_metadata），注册期类为 null。 */
  expectedRuleId: string | null;
  /** 是否命中 hard_floor（红线恒 true）。 */
  hardFloor: boolean;
}

/** 运行时类样本的 JSON-RPC tools/call payload 模板。 */
export type McpJsonRpcCall =
  | { method: 'tools/list'; params: { cursor?: string } }
  | {
      method: 'tools/call';
      params: {
        name: string;
        arguments: Record<string, unknown>;
      };
    };

/** 注册/同步期类样本的管理端点操作描述（不发 tools/call）。 */
export interface McpRegistryOp {
  /** sync：投毒/rug-pull 触发 SyncMCPServer；shadow_check：影子工具检测。 */
  action: 'sync' | 'shadow_check';
  /** 期望在 control-plane 管理端点响应/表里核对的字段与判据。 */
  expectations: readonly string[];
  /**
   * 投毒工具描述符（tool_poisoning：投毒描述；shadow_tool：同名工具；rug_pull：变更后的描述）。
   * 用于让目标 server 先登记该工具，再触发 sync/shadow-check。
   */
  toolDescriptor?: {
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  };
  /** rug_pull：变更前的基线描述（用于 manifest_hash 前后比对）。 */
  baselineDescriptor?: {
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  };
}

/**
 * MCP 攻击样本模板。复用 AgentRiskSurface / Severity / AgentRemediationPlan，
 * 但携带 MCP 专属的 mcpClass / phase / jsonRpc / registryOp / expectedPolicy。
 *
 * 样本 id 命名约定：`mcp-<mcpClass>-<slug>`（如 mcp-param_ssrf-cloud-metadata-iam）。
 */
export interface McpAttackTemplate {
  id: string;
  mcpClass: McpAttackClass;
  phase: McpAttackPhase;
  /** 复用 Agent 风险面（ssrf/secret_read/dangerous_command/data_exfiltration/indirect_prompt_injection/tool_argument_bypass）。 */
  riskSurface: AgentRiskSurface;
  /** MCP 专属招式；param_ssrf/destructive_command 复用 Agent 侧招式（见 mcpClassTechnique 映射）。 */
  technique: McpAttackTechnique | AgentAttackTechnique;
  severity: Severity;
  /** 攻击意图的人类可读描述（用于报告与 prompt 渲染）。 */
  intent: string;
  /** 目标工具名（qualified_name 由网关按 server.Name + '__' + tool 组装）。 */
  toolName: string;
  /** 运行时类：发往 /mcp/{serverID} 的 JSON-RPC tools/call payload。 */
  jsonRpc?: McpJsonRpcCall;
  /** Local sandbox probes require observed protocol results; fixtures alone are not evidence. */
  sandboxProbe?: { kind: 'enumeration' | 'indirect_injection'; allowedTools: readonly string[] };
  /** 注册/同步期类：走 control-plane 管理端点的操作。 */
  registryOp?: McpRegistryOp;
  /** 期望网关动作（headline，报告与看板用）。 */
  expectedGatewayAction: McpGatewayDecision;
  /** 三态期望裁决（归因断言依据）。 */
  expectedPolicy: McpExpectedPolicy;
  /** 成功判据（测/堵/验三连，供 Lane 3 归因对齐）。 */
  successSignals: readonly string[];
  /** 证据落点（去哪张表/哪个 source/哪些字段核对）。 */
  evidenceRequirements: readonly string[];
  /** 无害金丝雀标记（合成 PEM/受控 metadata 地址等，绝不含真实凭证）。 */
  safeCanary: string;
  source: 'builtin';
  remediation?: AgentRemediationPlan;
}

export interface McpAttackPack {
  id: string;
  version: string;
  templates: readonly McpAttackTemplate[];
}

/**
 * MCP 样本采样成 Question 后的 metadata。
 * kind='mcp_runtime' 是 Lane 3 executor 的分支约定（所有六类共用同一分支，
 * 分支内再按 mcpPhase 分流：runtime→tools/call 发起器；registry→管理端点发起器）。
 */
export interface McpScenarioMetadata extends SampleStandardMetadata {
  kind: 'mcp_runtime';
  seed: string;
  attackPackId: string;
  attackPackVersion: string;
  templateId: string;
  mcpClass: McpAttackClass;
  mcpPhase: McpAttackPhase;
  riskSurface: AgentRiskSurface;
  technique: McpAttackTechnique | AgentAttackTechnique;
  toolName: string;
  intent: string;
  jsonRpc?: McpJsonRpcCall;
  /** Local sandbox probes require observed protocol results; fixtures alone are not evidence. */
  sandboxProbe?: { kind: 'enumeration' | 'indirect_injection'; allowedTools: readonly string[] };
  registryOp?: McpRegistryOp;
  expectedGatewayAction: McpGatewayDecision;
  expectedPolicy: McpExpectedPolicy;
  successSignals: string[];
  evidenceRequirements: string[];
  safeCanary: string;
  remediation?: AgentRemediationPlan;
  timeoutMs?: number;
  maxConcurrency?: number;
}

export interface McpAttackScenario {
  id: string;
  prompt: string;
  type: 'PROMPT_INJECTION';
  category: string;
  language: 'zh' | 'en';
  severity: Severity;
  shouldRefuse: true;
  expectedBehavior: string;
  referenceAnswer: string | null;
  tags: string[];
  externalId: string;
  variantId: string;
  metadata: McpScenarioMetadata;
}

export interface GenerateMcpScenarioOptions {
  sampleCount?: number;
  seed?: string;
  classes?: readonly McpAttackClass[];
  phases?: readonly McpAttackPhase[];
  packIds?: readonly string[];
  timeoutMs?: number;
  maxConcurrency?: number;
}
