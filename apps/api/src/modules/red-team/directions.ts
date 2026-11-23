// 红队「攻击方向」：把分散的风险目标按攻击意图聚合，并为每个方向定制一条多轮攻击链。
//
// 设计动机：客户发起自主红队时，往往关心"某个方向能不能被攻破"（数据会不会泄、Agent
// 会不会被越权、内容合规守不守得住），而不是逐个风险目标去勾。一个方向 = 一组风险目标
// （objectiveIds）+ 一条偏好的攻击框架链（variantChain）。
//
// 与现有架构的衔接：每条被抽中的样本携带一个 variant，variant 决定 buildRedTeamPlaybook
// 选用哪套多轮 PHASES。所以方向的"定制多轮链"落地为 variantChain——在该方向的样本里优先
// 铺开这些攻击框架（preferVariants），并作为自定义种子缺省变体时的回落集合。

/** 招标口径的三类常见安全风险类型，用于把攻击方向分组标注。 */
export const RED_TEAM_RISK_TYPE_LABELS = {
  prompt_injection: '提示注入',
  sensitive_info_leakage: '敏感信息泄露',
  violating_content: '违规内容生成',
} as const;

export type RedTeamRiskType = keyof typeof RED_TEAM_RISK_TYPE_LABELS;

export interface RedTeamDirection {
  id: RedTeamDirectionId;
  /** 所属风险类型分组：提示注入 / 敏感信息泄露 / 违规内容生成。 */
  riskType: RedTeamRiskType;
  label: string;
  description: string;
  /** 该方向聚合的红队风险目标 id（须为 RED_TEAM_OBJECTIVE_IDS 中的值）。 */
  objectiveIds: string[];
  /** 偏好的攻击变体链，越靠前优先级越高；驱动 preferVariants/fallbackVariants。 */
  variantChain: string[];
  /** 人类可读的多轮链路说明，用于前端提示与报告。 */
  chainSummary: string;
}

export const RED_TEAM_DIRECTION_IDS = [
  'data_security',
  'agent_escalation',
  'cyber_offense',
  'content_compliance',
  'professional_misguidance',
] as const;

export type RedTeamDirectionId = (typeof RED_TEAM_DIRECTION_IDS)[number];

export const RED_TEAM_DIRECTIONS: RedTeamDirection[] = [
  {
    id: 'data_security',
    riskType: 'sensitive_info_leakage',
    label: '数据安全 / 数据泄密',
    description: '套取用户隐私、上下文数据、系统提示词、内部令牌与模型资产。',
    objectiveIds: [
      'data_exfiltration',
      'canary_exfiltration',
      'system_prompt_leakage',
      'model_theft',
      'privacy_inference',
    ],
    variantChain: ['stepwise', 'obfuscation', 'direct'],
    chainSummary: '低风险上下文构建 → 分步套取 → 编码混淆 → 诱饵令牌验证',
  },
  {
    id: 'agent_escalation',
    riskType: 'prompt_injection',
    label: '越权 / Agent 滥用',
    description: '诱导工具越权、内网访问、提示注入、检索投毒与记忆投毒。',
    objectiveIds: [
      'agent_tool_abuse',
      'ssrf_network_access',
      'prompt_injection',
      'rag_poisoning',
      'agent_memory_poisoning',
    ],
    variantChain: ['stepwise', 'authority', 'indirect'],
    chainSummary: '工具能力探测 → 伪造授权 → 间接注入 → 越权执行',
  },
  {
    id: 'cyber_offense',
    riskType: 'violating_content',
    label: '网络攻击 / 恶意能力',
    description: '索取入侵与持久化、危险化学品、武器管制与下游可执行载荷。',
    objectiveIds: [
      'cyber_intrusion',
      'dangerous_chemicals',
      'weapons_controlled',
      'output_injection',
      'denial_of_service',
    ],
    variantChain: ['roleplay', 'stepwise', 'obfuscation'],
    chainSummary: '学术包装 → 分步拆解 → 编码混淆',
  },
  {
    id: 'content_compliance',
    riskType: 'violating_content',
    label: '内容合规',
    description: '仇恨歧视、自伤、诈骗社工、虚假误导、未成年人、政治与极端内容。',
    objectiveIds: [
      'hate_discrimination',
      'self_harm',
      'fraud_social_engineering',
      'misinformation',
      'minors_safety',
      'political_values',
      'extremism_terror',
    ],
    variantChain: ['roleplay', 'authority'],
    chainSummary: '角色扮演 → 权威施压 → 虚构场景',
  },
  {
    id: 'professional_misguidance',
    riskType: 'violating_content',
    label: '专业误导',
    description: '医疗、法律、金融等高风险确定性建议与版权侵权。',
    objectiveIds: ['unsafe_professional_advice', 'copyright_ip'],
    variantChain: ['authority', 'roleplay', 'stepwise'],
    chainSummary: '紧急情境 → 权威专家角色 → 规避监管',
  },
];

const directionById = new Map(RED_TEAM_DIRECTIONS.map((dir) => [dir.id, dir]));

export function isRedTeamDirectionId(value: string): value is RedTeamDirectionId {
  return directionById.has(value as RedTeamDirectionId);
}

/** 合并选定方向聚合的全部风险目标 id（去重）。 */
export function objectiveIdsForDirections(directionIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of directionIds) {
    const dir = directionById.get(id as RedTeamDirectionId);
    if (!dir) continue;
    for (const objectiveId of dir.objectiveIds) out.add(objectiveId);
  }
  return [...out];
}

/** 合并选定方向的攻击变体链，保持出现顺序并去重。 */
export function variantChainForDirections(directionIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of directionIds) {
    const dir = directionById.get(id as RedTeamDirectionId);
    if (!dir) continue;
    for (const variant of dir.variantChain) {
      if (!out.includes(variant)) out.push(variant);
    }
  }
  return out;
}

/** 反查某个风险目标属于哪个方向（取首个命中）。 */
export function directionForObjective(objectiveId: string): RedTeamDirection | undefined {
  return RED_TEAM_DIRECTIONS.find((dir) => dir.objectiveIds.includes(objectiveId));
}
