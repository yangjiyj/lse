import {
  CONTENT_DOMAIN_TO_ANNEX_MAJOR,
  clausesForAgentHarm,
  clausesForPostureRule,
  legacyLiveRisk,
  type LiveRiskType,
  type RiskDomain,
} from '@lse/shared';

// GB/T 45654-2025《网络安全技术 生成式人工智能服务安全基本要求》附录 A 大类对照。
// 条款以 packages/shared/src/standards 的标准条款主表为准；这里只保留风险域到附录 A 大类、
// OWASP、ATLAS 的参考映射，供旧报告章节使用。
// 规则：附录 A 是「生成内容」风险，只有生成内容本身构成该类风险的风险域才映射附录 A；
// 工具调用、外发、SSRF、资源消耗等智能体行为不映射附录 A（改由智能体 8 项要求与终端检查清单对照）。

// 附录A 风险类别（官方名称）。
export const GBT45654_ANNEX_A_LABELS: Record<string, string> = {
  'A.1': 'A.1 违反社会主义核心价值观的内容',
  'A.2': 'A.2 歧视性内容',
  'A.3': 'A.3 商业违法违规',
  'A.4': 'A.4 侵犯他人合法权益',
  'A.5': 'A.5 无法满足特定服务类型的安全需求',
};

// MITRE ATLAS 战术阶段（中文）——对抗性机器学习/LLM 攻击链阶段。
// 只到「战术阶段」粒度（标准里 tactic 名称稳定）；具体技术编号(AML.Txxxx)待合规专家复核后补，避免误标。
export const ATLAS_TACTIC = {
  reconnaissance: '侦察',
  resourceDev: '资源开发',
  initialAccess: '初始访问',
  modelAccess: '模型访问',
  execution: '执行',
  persistence: '持久化',
  privilegeEscalation: '权限提升',
  defenseEvasion: '防御规避',
  credentialAccess: '凭据访问',
  discovery: '发现',
  collection: '收集',
  exfiltration: '数据外泄',
  impact: '影响',
} as const;

// OWASP Agentic AI 智能体威胁（中文）——OWASP Agentic Security Initiative 威胁清单的中文摘要。
// 用中文描述而非英文编号(ASI-Txx)，编号待合规专家复核后补；面向智能体/工具调用类风险。
export const AGENTIC_THREAT = {
  toolMisuse: '工具滥用',
  privilegeCompromise: '权限提升/越权',
  intentBreaking: '意图篡改/目标操纵',
  memoryPoisoning: '记忆/知识库投毒',
  identitySpoofing: '身份伪造/冒用',
  cascadingHallucination: '级联幻觉',
  hitlOverwhelm: '人工复核淹没',
  unexpectedRce: '非预期代码执行',
} as const;

export const COMPLIANCE_MAPPING_STATUS = 'PENDING_REVIEW' as const;
export const COMPLIANCE_MAPPING_NOTE =
  '待官方文本复核。以下为基于风险类别的候选参考映射，适用条款和攻击阶段须结合具体证据人工核验；命中映射数不代表测试覆盖、标准达标或认证结论。未命中也不能证明已测试且通过。';

type ComplianceEntry = {
  gbt45654: string[];
  owasp: string[];
  atlas: string[]; // ATLAS 战术阶段(中文)
  agentic: string[]; // OWASP Agentic 智能体威胁(中文)
};

const A = ATLAS_TACTIC;
const G = AGENTIC_THREAT;

// 统一风险维度表：风险域 → {GB/T 45654 附录A 条款, OWASP LLM Top10(2025), MITRE ATLAS 战术阶段, OWASP Agentic 威胁}。
// 命名全中文（条款/标准代码保留为行业通用引用，恒与中文标签成对呈现）。起步版，待合规专家复核。
export const COMPLIANCE_MAP: Record<RiskDomain, ComplianceEntry> = {
  prompt_injection: {
    gbt45654: [],
    owasp: ['LLM01'],
    atlas: [],
    agentic: [],
  },
  component_vulnerability: { gbt45654: [], owasp: ['LLM03'], atlas: [], agentic: [] }, // 基础设施漏洞，非附录A内容风险
  legal_compliance: {
    gbt45654: ['A.1', 'A.3'],
    owasp: [],
    atlas: [],
    agentic: [],
  },
  privacy_leakage: {
    gbt45654: ['A.4'],
    owasp: ['LLM02'],
    atlas: [A.collection, A.exfiltration],
    agentic: [],
  },
  harmful_capability: { gbt45654: ['A.1'], owasp: [], atlas: [], agentic: [] },
  cyber_abuse: { gbt45654: ['A.1'], owasp: [], atlas: [], agentic: [] },
  fraud_social_engineering: {
    gbt45654: ['A.1'],
    owasp: [],
    atlas: [],
    agentic: [],
  },
  misinformation_hallucination: {
    gbt45654: ['A.5'],
    owasp: ['LLM09'],
    atlas: [],
    agentic: [],
  },
  unsafe_professional_advice: {
    gbt45654: ['A.5'],
    owasp: ['LLM09'],
    atlas: [],
    agentic: [],
  },
  bias_discrimination: { gbt45654: ['A.2'], owasp: [], atlas: [], agentic: [] },
  system_prompt_leakage: {
    gbt45654: [],
    owasp: ['LLM07'],
    atlas: [],
    agentic: [],
  }, // 普通提示词披露不能推定商业秘密或凭据泄露
  training_data_extraction: {
    gbt45654: ['A.3', 'A.4'],
    owasp: ['LLM02'],
    atlas: [A.exfiltration, A.collection],
    agentic: [],
  },
  rag_data_poisoning: {
    gbt45654: [],
    owasp: ['LLM04', 'LLM08'],
    atlas: [A.resourceDev, A.persistence],
    agentic: [G.memoryPoisoning],
  },
  agent_tool_abuse: {
    gbt45654: [],
    owasp: ['LLM06'],
    atlas: [A.execution, A.privilegeEscalation],
    agentic: [G.toolMisuse, G.privilegeCompromise],
  }, // 越权可致侵权/危害
  data_exfiltration: {
    gbt45654: [], // 智能体外发行为，不是生成内容风险
    owasp: ['LLM02', 'LLM06'],
    atlas: [A.exfiltration],
    agentic: [G.toolMisuse],
  },
  ssrf_network_access: {
    gbt45654: [],
    owasp: ['LLM06'],
    atlas: [A.discovery],
    agentic: [G.toolMisuse],
  }, // 网络越权，非附录A内容风险
  output_injection: {
    gbt45654: [],
    owasp: ['LLM05'],
    atlas: [A.execution],
    agentic: [G.unexpectedRce],
  }, // 下游执行，非附录A内容风险
  model_denial_of_service: { gbt45654: [], owasp: ['LLM10'], atlas: [A.impact], agentic: [] }, // 可用性，非附录A内容风险
  model_theft: {
    gbt45654: [], // 能力探测与模型窃取不是生成内容风险
    owasp: ['LLM10'],
    atlas: [A.exfiltration, A.modelAccess],
    agentic: [],
  },
  general_safety: { gbt45654: [], owasp: [], atlas: [], agentic: [] },
};

const OWASP_LABELS: Record<string, string> = {
  LLM01: 'LLM01 提示词注入',
  LLM02: 'LLM02 敏感信息泄露',
  LLM03: 'LLM03 供应链',
  LLM04: 'LLM04 数据与模型投毒',
  LLM05: 'LLM05 输出处理不当',
  LLM06: 'LLM06 过度代理',
  LLM07: 'LLM07 系统提示泄露',
  LLM08: 'LLM08 向量与嵌入弱点',
  LLM09: 'LLM09 错误信息',
  LLM10: 'LLM10 无限制消耗',
};

export function owaspLabel(code: string): string {
  return OWASP_LABELS[code] ?? code;
}

export function gbtAnnexLabel(code: string): string {
  return GBT45654_ANNEX_A_LABELS[code] ?? code;
}

export function complianceClausesForDomain(domain: string): ComplianceEntry {
  return Object.hasOwn(COMPLIANCE_MAP, domain)
    ? COMPLIANCE_MAP[domain as RiskDomain]
    : { gbt45654: [], owasp: [], atlas: [], agentic: [] };
}

/** 反查候选映射的风险域；不能用于推导测试覆盖。 */
export function riskDomainsForGbtAnnex(code: string): RiskDomain[] {
  return (Object.keys(COMPLIANCE_MAP) as RiskDomain[]).filter((domain) =>
    COMPLIANCE_MAP[domain].gbt45654.includes(code),
  );
}

// 平台黑盒测试的逐场景候选映射；普通编排披露不等于商业秘密泄露。
export const PLATFORM_APP_COMPLIANCE: Record<string, ComplianceEntry> = {
  orchestration_leakage: { gbt45654: [], owasp: ['LLM07'], atlas: [A.discovery], agentic: [G.intentBreaking] },
  knowledge_access: { gbt45654: [], owasp: ['LLM02', 'LLM08'], atlas: [A.collection], agentic: [G.memoryPoisoning] },
  indirect_url: { gbt45654: [], owasp: ['LLM01', 'LLM06'], atlas: [A.exfiltration], agentic: [G.intentBreaking, G.toolMisuse] },
  tool_egress: { gbt45654: [], owasp: ['LLM02', 'LLM06'], atlas: [A.exfiltration], agentic: [G.toolMisuse, G.privilegeCompromise] },
  output_egress: { gbt45654: [], owasp: ['LLM02', 'LLM05'], atlas: [A.exfiltration], agentic: [G.toolMisuse] },
};

// 平台智能体样本包 v2 的 6 个模板映射；写法同 PLATFORM_APP_COMPLIANCE，OWASP 编号只用确定存在的 LLM01、LLM02、LLM06。
// 候选参考映射，不代表测试覆盖或标准达标（见 COMPLIANCE_MAPPING_NOTE）。
export const PLATFORM_APP_V2_COMPLIANCE: Record<string, ComplianceEntry> = {
  orchestration_leakage: { gbt45654: [], owasp: ['LLM01', 'LLM02'], atlas: [A.discovery], agentic: [G.intentBreaking] },
  knowledge_access: { gbt45654: [], owasp: ['LLM02'], atlas: [A.collection], agentic: [G.privilegeCompromise] },
  indirect_url: { gbt45654: [], owasp: ['LLM01', 'LLM06'], atlas: [A.exfiltration], agentic: [G.intentBreaking, G.toolMisuse] },
  tool_egress: { gbt45654: [], owasp: ['LLM02', 'LLM06'], atlas: [A.exfiltration, A.discovery], agentic: [G.toolMisuse, G.privilegeCompromise] },
  output_egress: { gbt45654: [], owasp: ['LLM01', 'LLM02'], atlas: [A.exfiltration], agentic: [G.toolMisuse] },
  multi_turn: { gbt45654: [], owasp: ['LLM01', 'LLM06'], atlas: [A.defenseEvasion, A.exfiltration], agentic: [G.intentBreaking, G.toolMisuse] },
};

/** 终端配置体检规则对照的标准条款（TC260-PG-20266A 附录 A 检查项）。取代此前无出处的「①②④」。 */
export function endpointPostureClauses(ruleId: string): string[] {
  return clausesForPostureRule(ruleId);
}

/** 终端真机测评场景（按风险类型）对照的标准条款：在研强制国标 8 项要求 + 指引检查项。 */
export function endpointLiveRiskClauses(risk: string | null | undefined): string[] {
  if (!risk) return [];
  const tags = legacyLiveRisk(risk as LiveRiskType);
  if (!tags) return [];
  return [...new Set(tags.harms.flatMap((h) => clausesForAgentHarm(h, 'endpoint')))];
}

/** 附录 A 大类映射与主表保持一致（单测校验）。 */
export function annexMajorsForDomain(domain: string): readonly string[] {
  return CONTENT_DOMAIN_TO_ANNEX_MAJOR[domain] ?? [];
}
