import type { Severity } from './enums.js';
import { severityToRiskLevel, RISK_LEVEL_LABELS, type RiskLevel } from './risk-level.js';

/**
 * 风险判定与合规对齐：把判定引擎产出的 riskCategory / 题目类别归入统一的合规风险类别，
 * 并关联国家现行法律法规。只写法律法规名称与条目主题，不写具体条号（仓库无权威条号来源）。
 */
export const COMPLIANCE_RISK_CATEGORIES = [
  'political',
  'violence',
  'pornography',
  'terrorism',
  'illegal_guidance',
  'bias_discrimination',
  'prompt_injection',
  'indirect_prompt_injection',
  'sensitive_info_leakage',
  'custom_risk_content',
] as const;

export type ComplianceRiskCategory = (typeof COMPLIANCE_RISK_CATEGORIES)[number];

export const COMPLIANCE_RISK_CATEGORY_LABELS: Record<ComplianceRiskCategory, string> = {
  political: '涉政',
  violence: '涉暴',
  pornography: '涉黄',
  terrorism: '恐怖主义',
  illegal_guidance: '非法行为指导',
  bias_discrimination: '偏见歧视',
  prompt_injection: '提示注入',
  indirect_prompt_injection: '间接提示注入',
  sensitive_info_leakage: '敏感信息泄露',
  custom_risk_content: '自定义风险内容',
};

export interface LegalReference {
  /** 法律法规或国家标准名称（含书名号）。 */
  law: string;
  /** 关联的条目主题（不含条号）。 */
  topic: string;
}

const GENAI_MEASURES = '《生成式人工智能服务管理暂行办法》';
const CYBERSECURITY_LAW = '《网络安全法》';
const DATA_SECURITY_LAW = '《数据安全法》';
const PIPL = '《个人信息保护法》';
const GBT45654 = 'GB/T 45654-2025《网络安全技术 生成式人工智能服务安全基本要求》';

export const COMPLIANCE_LEGAL_REFERENCES: Record<ComplianceRiskCategory, LegalReference[]> = {
  political: [
    {
      law: GENAI_MEASURES,
      topic: '坚持社会主义核心价值观，不得生成危害国家安全、煽动颠覆国家政权等内容',
    },
    { law: CYBERSECURITY_LAW, topic: '不得利用网络从事危害国家安全、荣誉和利益的活动' },
    { law: GBT45654, topic: '附录A 违反社会主义核心价值观的内容' },
  ],
  violence: [
    { law: GENAI_MEASURES, topic: '不得生成暴力等法律、行政法规禁止的内容' },
    { law: CYBERSECURITY_LAW, topic: '不得利用网络传播暴力信息' },
    { law: GBT45654, topic: '附录A 违反社会主义核心价值观的内容（宣扬暴力）' },
  ],
  pornography: [
    { law: GENAI_MEASURES, topic: '不得生成淫秽色情等法律、行政法规禁止的内容' },
    { law: CYBERSECURITY_LAW, topic: '不得利用网络传播淫秽色情信息' },
    { law: GBT45654, topic: '附录A 违反社会主义核心价值观的内容（淫秽色情）' },
  ],
  terrorism: [
    { law: '《反恐怖主义法》', topic: '禁止宣扬恐怖主义、极端主义，禁止传播相关信息' },
    { law: GENAI_MEASURES, topic: '不得生成宣扬恐怖主义、极端主义的内容' },
    { law: CYBERSECURITY_LAW, topic: '不得利用网络宣扬恐怖主义、极端主义' },
  ],
  illegal_guidance: [
    { law: '《刑法》', topic: '传授犯罪方法及相关犯罪的刑事责任' },
    { law: CYBERSECURITY_LAW, topic: '不得提供专门用于从事危害网络安全活动的程序、工具或方法' },
    { law: GENAI_MEASURES, topic: '不得生成法律、行政法规禁止的内容' },
  ],
  bias_discrimination: [
    {
      law: GENAI_MEASURES,
      topic:
        '在算法设计、训练数据选择、模型生成和优化中采取有效措施防止产生民族、信仰、国别、地域、性别、年龄、职业、健康等歧视',
    },
    { law: GBT45654, topic: '附录A 歧视性内容' },
  ],
  prompt_injection: [
    { law: CYBERSECURITY_LAW, topic: '网络运营者的网络运行安全保护义务' },
    { law: GENAI_MEASURES, topic: '服务提供者应采取安全措施，保障服务安全、稳定、持续' },
    { law: GBT45654, topic: '模型安全与安全措施要求' },
  ],
  indirect_prompt_injection: [
    { law: CYBERSECURITY_LAW, topic: '网络运营者的网络运行安全保护义务' },
    { law: DATA_SECURITY_LAW, topic: '数据处理活动的数据安全保护义务' },
    { law: GBT45654, topic: '模型安全与安全措施要求' },
  ],
  sensitive_info_leakage: [
    { law: PIPL, topic: '敏感个人信息的处理规则与个人信息安全保护义务' },
    { law: DATA_SECURITY_LAW, topic: '数据安全保护义务与重要数据保护' },
    { law: CYBERSECURITY_LAW, topic: '网络信息安全与用户信息保护' },
  ],
  custom_risk_content: [
    { law: DATA_SECURITY_LAW, topic: '数据分类分级保护与重要数据保护' },
    { law: '《关键信息基础设施安全保护条例》', topic: '关键信息基础设施运营者的安全保护义务' },
    { law: PIPL, topic: '敏感个人信息的处理规则' },
  ],
};

// 关键词顺序即优先级：先匹配更具体的类别（间接提示注入先于提示注入，恐怖主义先于涉暴）。
const CATEGORY_MATCHERS: Array<[ComplianceRiskCategory, RegExp]> = [
  ['custom_risk_content', /custom[_-]?risk|自定义风险/i],
  [
    'indirect_prompt_injection',
    /indirect[_-]?prompt[_-]?injection|间接.{0,2}注入|rag[_-]?poison|RAG ?污染|记忆.{0,4}投毒|memory[_-]?poison/i,
  ],
  [
    'prompt_injection',
    /prompt[_-]?injection|jailbreak|越狱|提示.{0,1}注入|system[_-]?prompt|系统提示词/i,
  ],
  ['terrorism', /terror|extremis|恐怖|极端主义/i],
  ['political', /politic|政治|涉政|核心价值观|颠覆|国家政权/i],
  ['pornography', /porn|sexual|色情|淫秽|涉黄/i],
  ['bias_discrimination', /bias|discriminat|hate|歧视|偏见|仇恨/i],
  ['violence', /violen|暴力|涉暴|自我伤害|self[_-]?harm|weapon|武器/i],
  [
    'sensitive_info_leakage',
    /sensitive[_-]?info|privacy|pii|secret|credential|exfil|泄露|泄密|隐私|个人信息|数据外传/i,
  ],
  [
    'illegal_guidance',
    /illegal|crime|criminal|fraud|chemical|cyber|intrusion|harmful|违法|犯罪|诈骗|危险物品|危险化学|网络攻击|管制/i,
  ],
];

/** 把任意风险类别文本（引擎 riskCategory、题目类别、风险域）归入合规风险类别；无法归类时返回 null。 */
export function classifyComplianceRiskCategory(
  ...texts: Array<string | null | undefined>
): ComplianceRiskCategory | null {
  for (const text of texts) {
    if (!text) continue;
    for (const [category, re] of CATEGORY_MATCHERS) {
      if (re.test(text)) return category;
    }
  }
  return null;
}

export function legalReferencesForCategory(
  category: ComplianceRiskCategory | null,
): LegalReference[] {
  return category ? COMPLIANCE_LEGAL_REFERENCES[category] : [];
}

export interface FindingComplianceView {
  riskLevel: RiskLevel;
  riskLevelLabel: string;
  complianceCategory: ComplianceRiskCategory | null;
  complianceCategoryLabel: string | null;
  legalReferences: LegalReference[];
}

/** 评估结论视图：风险等级（高/中/低）+ 合规风险类别 + 关联法律法规。 */
export function describeFindingCompliance(input: {
  severity: Severity;
  riskCategory?: string | null;
  questionCategory?: string | null;
}): FindingComplianceView {
  const riskLevel = severityToRiskLevel(input.severity);
  const complianceCategory = classifyComplianceRiskCategory(
    input.riskCategory,
    input.questionCategory,
  );
  return {
    riskLevel,
    riskLevelLabel: RISK_LEVEL_LABELS[riskLevel],
    complianceCategory,
    complianceCategoryLabel: complianceCategory
      ? COMPLIANCE_RISK_CATEGORY_LABELS[complianceCategory]
      : null,
    legalReferences: legalReferencesForCategory(complianceCategory),
  };
}
