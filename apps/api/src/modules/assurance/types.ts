export type AssuranceOwner = 'gateway' | 'lse' | 'both' | 'none';

export interface GatewayAssurancePolicyContract {
  policyId: string;
  version: string;
  category: string;
  mode: string;
  expectedDecision: 'allow' | 'audit' | 'alert' | 'block' | string;
  severity: string;
  detector: string;
  evidenceRequired: boolean;
  sampleGenerationHint: string;
  negativeContext: string[];
  sampleVariants?: GatewayAssuranceSampleVariant[];
}

export interface GatewayAssuranceSampleVariant {
  variantId: string;
  label: string;
  strategy: string;
  weight: number;
  turnCount?: number;
}

export interface GatewayAssuranceCoverage {
  policySource: string;
  coverageScope: string;
  policyCount: number;
  sampleVariantCount: number;
  minimumVariantsEach: number;
}

export interface GatewayAssuranceLinkContract {
  linkId: string;
  required: boolean;
}

export interface GatewayAssuranceContract {
  schemaVersion: 'gateway-assurance-contract/v1' | string;
  tenantId: string;
  generatedAt?: string;
  coverage?: GatewayAssuranceCoverage;
  policies: GatewayAssurancePolicyContract[];
  linkContracts: GatewayAssuranceLinkContract[];
}

export interface GatewayAssuranceEvidenceChecks {
  requestLog: boolean;
  contentLog: boolean;
  securityEngine: boolean;
  policyDecision: boolean;
  securityEvent: boolean;
  alert: boolean;
  uiVisible: boolean;
  deepLink: boolean;
  writeback: boolean;
  outbox: boolean;
  /**
   * MCP 专属（Lane 2 assuranceEvidenceResponse 新增）：
   * - toolCall：该请求有任意 tool_call_logs 行（网关收到并记录了工具调用）
   * - toolDecision：有 tool_type='mcp' 的工具决策行（MCP allow/audit 只落此表、不写 security_event）
   */
  toolCall?: boolean;
  toolDecision?: boolean;
}

/**
 * 网关归因端点为每个 MCP 工具调用返回的裁决摘要（Lane 2 mcp_tool_decisions[]）。
 * 「验」段核心：raw=block+hardFloor 判「检测到」，effective 判「是否真拦」，
 * audit-only 天花板下 effective 被钳到 audit 属正常（留痕在、堵不在）。
 */
export interface McpToolDecision {
  toolName: string;
  toolType: string;
  rawDecision: string;
  effectiveDecision: string;
  mode: string;
  hardFloor: boolean;
  riskLevel: string;
  status: string;
  matchedPolicyId: string | null;
  provenance: string;
  /** 从 evidence_json 抽出的命中规则名（如 mcp_redline_cloud_metadata）。 */
  ruleIds: string[];
  traceId: string | null;
  createdAt: string | null;
}

export interface GatewayAssuranceEvidence {
  schemaVersion: 'gateway-assurance-evidence/v1' | string;
  tenantId: string;
  query: Record<string, string>;
  checks: GatewayAssuranceEvidenceChecks;
  sources: Record<string, string>;
  events: unknown[];
}

export interface AssuranceExpectedChecks {
  requestLog: boolean;
  contentLog: boolean;
  securityEvent: boolean;
  alert: boolean;
  block: boolean;
  uiVisible: boolean;
  writeback: boolean;
  outbox: boolean;
}

export interface AssuranceSamplePlanItem {
  sampleId: string;
  policyId: string;
  variantId?: string;
  variantLabel?: string;
  category: string;
  prompt: string;
  turns?: AssuranceSampleTurn[];
  traceId: string;
  evalRunId: string;
  taskId: string;
  targetId: string;
  expectedDecision: string;
  expected: AssuranceExpectedChecks;
}

export interface AssuranceSampleTurn {
  role: 'user';
  content: string;
}

export interface AssuranceSamplePlan {
  runId: string;
  taskId: string;
  targetId: string;
  samples: AssuranceSamplePlanItem[];
}

export interface AssuranceEvidenceSummary {
  sampleId: string;
  policyId: string;
  variantId: string;
  traceId: string;
  eventCount: number;
  policyHitCount: number;
  ruleIds: string[];
  actions: string[];
  verdicts: string[];
}

export type AssuranceFailureCode =
  | 'GW_NO_REQUEST_LOG'
  | 'GW_NO_CONTENT_LOG'
  | 'GW_NO_SECURITY_EVENT'
  | 'GW_NO_ALERT'
  | 'GW_NO_POLICY_HIT'
  | 'GW_WRONG_DECISION'
  | 'GW_EXPECTED_BLOCK_BUT_ALLOWED'
  | 'GW_EXPECTED_AUDIT_BUT_BLOCKED'
  | 'GW_UI_NOT_VISIBLE'
  | 'GW_EVIDENCE_LINK_BROKEN'
  | 'GW_ASYNC_AUDIT_STUCK'
  | 'GW_REDACTION_BROKEN'
  | 'GW_SEVERITY_MISMATCH'
  | 'GW_REDTEAM_BYPASS'
  | 'GW_AGENT_SCENARIO_BYPASS'
  // ---- MCP 测-堵-验闭环归因码（Lane 3）----
  // 「堵」：应命中红线却在 tool_call_logs 无 rule_id（真网关缺陷，仅当样本在红线覆盖域内）。
  | 'GW_MCP_REDLINE_MISS'
  // 「验」：tool_call_logs 无该请求的 MCP 工具决策行（网关未记录裁决）。
  | 'GW_MCP_NO_TOOL_CALL_LOG'
  // 「验」：trace_id 未落到 tool_call_logs（补落库前的历史缺口）。
  | 'GW_MCP_TRACE_UNLINKED'
  // 注册/同步期 observe-only 检测缺失。
  | 'GW_MCP_POISON_NOT_FLAGGED'
  | 'GW_MCP_SHADOW_NOT_DETECTED'
  | 'GW_MCP_RUGPULL_NOT_DETECTED'
  | 'LSE_TRACE_HEADER_MISSING'
  | 'LSE_NO_WRITEBACK'
  | 'LSE_ATTACK_SCENARIO_EXECUTION_FAILED'
  // LSE 侧：MCP 目标缺 serverID/gatewayBaseUrl，攻击根本没经网关（平台配置的锅）。
  | 'LSE_MCP_TARGET_MISCONFIGURED'
  // LSE 侧：MCP 发起器传输/连接失败（未拿到网关响应）。
  | 'LSE_MCP_INVOKE_FAILED'
  // 样本落在网关红线覆盖域之外，miss 属真阴性而非网关失效（不归网关的锅）。
  | 'GW_REDLINE_NOT_APPLICABLE'
  | 'BOTH_EVIDENCE_SCHEMA_DRIFT';

export interface AssuranceAttribution {
  owner: AssuranceOwner;
  failureCodes: AssuranceFailureCode[];
  source?: 'assurance_sample' | 'attack_defense';
  sampleId?: string;
  taskId?: string;
  controlGroupId?: string;
  detail?: Record<string, unknown>;
}
