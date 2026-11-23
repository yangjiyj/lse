import {
  JUDGE_SOURCE_LABELS,
  RISK_DOMAIN,
  RISK_DOMAIN_LABELS,
  isJudgeSourceCategory,
  type RiskDomain,
  type Severity,
  type Verdict,
} from '@lse/shared';

export const SEVERITY_LABELS: Record<Severity, string> = {
  CRITICAL: '严重',
  HIGH: '高危',
  MEDIUM: '中危',
  LOW: '低危',
  INFO: '提示',
};
export const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

export function severityLabel(severity: Severity | null | undefined): string {
  return severity ? SEVERITY_LABELS[severity] : '未知';
}

// 报告里「可选」章节（核心章节：概览/评分/风险分布/引擎/总体研判/结论 始终包含）。
// 生成报告时可勾选、下载导出时可再筛——控制这些章节是否进入交付件。
export const REPORT_OPTIONAL_SECTIONS = [
  'resultOverview',
  'riskItems',
  'gbtCompliance',
  'redTeam',
  'remediation',
  'nextSteps',
  'appendix',
] as const;
export type ReportSectionKey = (typeof REPORT_OPTIONAL_SECTIONS)[number];
export const REPORT_SECTION_LABELS: Record<ReportSectionKey, string> = {
  resultOverview: '结果总览（判定构成、热力图、发现率、框架覆盖）',
  riskItems: '风险发现清单',
  gbtCompliance: 'GB/T 45654 条款映射（非认证结论）',
  redTeam: '多轮对抗记录',
  remediation: '整改计划（路线图、整改主题卡、跟踪表）',
  nextSteps: '复测建议',
  appendix: '附录（评估方法）',
};
export const REPORT_SECTION_HINTS: Record<ReportSectionKey, string> = {
  resultOverview: '展示判定构成、严重度分布、风险热力图、各类别发现率和框架覆盖矩阵。',
  riskItems: '逐项展示风险类型、严重等级、判定依据和证据。',
  gbtCompliance: '将风险与 GB/T 45654 相关条款进行映射，用于核查评估覆盖；不构成符合性认证。',
  redTeam: '展示多轮对抗过程、攻击策略、模型响应和逐轮判定。',
  remediation: '展示整改责任、处置动作和复测要求。',
  nextSteps: '展示评估完成后的处置与复测安排。',
  appendix: '展示评估方法、适用标准和结论边界。',
};
export const VERDICT_LABELS: Record<Verdict, string> = {
  FAIL: '未通过',
  PASS: '通过',
  ERROR: '执行异常',
  UNKNOWN: '未判定',
};

export const EVIDENCE_STRENGTH_LABELS: Record<string, string> = {
  CONTROLLED_EXECUTION: '受控执行轨迹',
  TOOL_CALL_ATTEMPT: '工具调用企图',
  CUSTOMER_BLOCKED: '客户侧阻断',
  SANDBOX_BLOCKED: '评估沙箱阻断',
  TEXT_OBSERVED: '回答文本证据',
  INFERRED: '执行器推断',
  NO_EVIDENCE: '无可用证据',
};

export const EXECUTION_OUTCOME_LABELS: Record<string, string> = {
  EXECUTED: '已执行',
  CUSTOMER_BLOCKED: '客户侧阻断',
  SANDBOX_BLOCKED: '评估沙箱阻断',
  NOT_ATTEMPTED: '未尝试执行',
  UNKNOWN: '未知',
};

export function evidenceStrengthLabel(value: string | null | undefined): string {
  return value ? (EVIDENCE_STRENGTH_LABELS[value] ?? '未识别证据强度') : '未记录';
}

export function executionOutcomeLabel(value: string | null | undefined): string {
  return value ? (EXECUTION_OUTCOME_LABELS[value] ?? '未识别执行结果') : '未记录';
}

export const REMEDIATION_STATUS_LABELS: Record<string, string> = {
  OPEN: '待整改',
  IN_PROGRESS: '整改中',
  READY_FOR_RETEST: '待复测',
  VERIFIED_CLOSED: '验证关闭',
  REOPENED: '复测重开',
  NOT_APPLICABLE: '不适用',
};

export function remediationStatusLabel(value: string | null | undefined): string {
  return value ? (REMEDIATION_STATUS_LABELS[value] ?? '未识别整改状态') : '未建立整改记录';
}
export const STATUS_LABELS: Record<string, string> = {
  PENDING: '待执行',
  RUNNING: '执行中',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELED: '已取消',
  CANCELLED: '已取消',
};
export const ENGINE_STATUS_LABELS: Record<string, string> = {
  ERROR: '执行异常',
  PENDING: '待执行',
  RUNNING: '运行中',
  SUCCESS: '成功',
  FAILED: '失败',
  SKIPPED: '跳过',
};

export const ENGINE_LABELS: Record<string, string> = {
  'autonomous-red-team': '自主红队评估',
  'agent-llm-judge': '智能体判定模型',
  'rule-judge': '规则引擎',
  'sensitive-info': '敏感信息扫描',
  'endpoint-agent-eval': '终端智能体测评',
  'agent-tool-guard': '智能体工具守卫',
  'python-judge': '语义判定',
  'llm-judge': '判定模型',
  'ai-infra-guard': 'AI-Infra-Guard 红队',
  garak: 'garak 探针扫描',
  pyrit: 'PyRIT 多轮红队评估',
  'newapi-agent-security-gateway': '智能体安全网关',
  'skill-mcp-static': 'AI 组件漏洞扫描',
  'rag-eval': 'RAG 专项评估',
};

// 风险类别代码 → 中文标签。
// 覆盖所有判定引擎 / 规则可产出的「静态」代码（rule-judge、sensitive scan、
// executor、python/llm judge、ai-infra-guard/garak/pyrit 适配器）。
// 报告里绝不能出现未翻译的英文枚举。
export const RISK_CATEGORY_LABELS: Record<string, string> = {
  // 规则引擎 —— 内容合规
  forbidden_content: '命中禁止内容',
  // 规则引擎 —— 应拒答（区分「已正确拒答」与「未拒答违规」）
  should_refuse: '应拒答（已拒答）',
  should_refuse_violation: '高风险请求越界',
  // 规则引擎 —— 期望应答
  expected_answer: '命中应答要点',
  missing_expected: '缺失应答要点',
  // 规则引擎 —— 兜底（无规则，不下结论）
  general: '通用（未判定）',
  // 提示注入
  prompt_injection: '提示注入',
  // 合规风险（题集标签）
  compliance: '合规风险',
  legal_compliance: '违法违规/合规风险',
  harmful_capability: '有害能力/高风险请求风险',
  cyber_abuse: '网络滥用/恶意代码风险',
  fraud_social_engineering: '诈骗与社会工程风险',
  misinformation_hallucination: '幻觉误导/事实一致性风险',
  unsafe_professional_advice: '高风险专业建议风险',
  bias_discrimination: '偏见歧视/公平性风险',
  training_data_extraction: '训练数据/记忆提取风险',
  rag_data_poisoning: 'RAG/知识库污染风险',
  data_exfiltration: '数据外传/越权披露风险',
  ssrf_network_access: 'SSRF/内网访问风险',
  model_denial_of_service: '资源消耗/模型拒服风险',
  model_theft: '模型盗用/能力探测风险',
  // 敏感信息
  privacy_leakage: '隐私与敏感信息泄露风险',
  sensitive_info: '敏感信息检查',
  sensitive_info_secret: '敏感凭据泄露',
  sensitive_info_pii: '个人信息泄露',
  // 执行 / 引擎状态与 LLM 评审：这些是「判定来源」不是业务风险类别，
  // 中文只在 @lse/shared 的 risk-labels.ts 定义一次（页面、报告标签、报告摘要共用）。
  ...JUDGE_SOURCE_LABELS,
  // 组件 / 提示 / 代理域风险
  component_vulnerability: '组件漏洞/供应链风险',
  system_prompt_leakage: '系统提示词泄露风险',
  agent_tool_abuse: '工具调用/越权代理风险',
  output_injection: '输出处理/脚本注入风险',
  general_safety: '通用安全风险',
  // 红队引擎（AI-Infra-Guard / garak / PyRIT）
  redteam_scan: '红队扫描发现',
  redteam_probe: '红队探针发现',
  redteam_attack: '红队对抗发现',
  gateway_policy_event: '网关策略事件',
};

// 引擎按序号产出的动态代码（redteam_finding_3、garak_probe_7 …），
// 无法逐条映射，但已知前缀可本地化为「中文 + 序号」，避免英文枚举泄露到报告。
const DYNAMIC_RISK_PREFIXES: Array<{ pattern: RegExp; label: (seq: string) => string }> = [
  { pattern: /^redteam_finding_(\d+)$/, label: (seq) => `红队发现项 #${seq}` },
  { pattern: /^garak_probe_(\d+)$/, label: (seq) => `Garak 探针项 #${seq}` },
  { pattern: /^pyrit_attack_(\d+)$/, label: (seq) => `PyRIT 攻击项 #${seq}` },
];

function ownString(record: object, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function registeredRiskLabel(code: string): string | undefined {
  const known = ownString(RISK_CATEGORY_LABELS, code);
  if (known) return known;
  for (const { pattern, label } of DYNAMIC_RISK_PREFIXES) {
    const match = pattern.exec(code);
    if (match) return label(match[1] ?? '');
  }
  return undefined;
}

// 网关/红队引擎还会产出自由格式英文类别（domain_blocklist、promptinject.* …），
// 交付证据层保留中文包装后的原始代码，便于客户定位具体策略或探针。
export function riskLabel(code: string, engine?: string): string {
  const safeCode = typeof code === 'string' ? code : '';
  const registered = registeredRiskLabel(safeCode);
  if (registered) return registered;
  if (engine === 'newapi-agent-security-gateway') return `网关策略事件（${safeCode}）`;
  if (engine === 'garak' || engine === 'pyrit') return `红队发现（${safeCode}）`;
  return safeCode || '其他安全风险';
}

// 总体研判是外发模型边界：只允许封闭的本地高层标签，不携带自由格式类别代码。
export function riskLabelForJudge(code: string, engine?: string): string {
  const safeCode = typeof code === 'string' ? code : '';
  // 引擎判词（llm_judge_*/python_judge_*/engine_error）不是业务风险类别，客户看到「LLM 评审不通过」
  // 无法据此整改；这类一律回退到基于类别的业务风险分类（与风险项标题口径一致）。
  if (isJudgeSourceCategory(safeCode)) {
    return reportRiskTypeLabel({ riskCategory: safeCode, engine });
  }
  const registered = registeredRiskLabel(safeCode);
  if (registered) return registered;
  if (engine === 'newapi-agent-security-gateway') return '网关策略事件';
  if (engine === 'garak' || engine === 'pyrit') return '红队发现';
  return '其他安全风险';
}

export interface ReportRiskLabelInput {
  riskCategory?: string | null;
  riskCategoryLabel?: string | null;
  engine?: string | null;
  title?: string | null;
  evidence?: string | null;
  reason?: string | null;
  questionContent?: string | null;
}

const REPORT_RISK_TYPE_BY_CODE: Record<string, string> = {
  prompt_injection: '提示注入/越狱',
  rag_data_poisoning: 'RAG/知识库投毒',
  training_data_extraction: '数据安全/数据外泄',
  data_exfiltration: '数据安全/数据外泄',
  privacy_leakage: '个人信息/隐私',
  sensitive_info_pii: '个人信息/隐私',
  sensitive_info: '敏感信息/凭据',
  sensitive_info_secret: '敏感信息/凭据',
  system_prompt_leakage: '敏感信息/凭据',
  fraud_social_engineering: '诈骗与社会工程',
  cyber_abuse: '网络安全/恶意滥用',
  unsafe_professional_advice: '行业专业信息',
  legal_compliance: '法律法规/监管合规',
  compliance: '法律法规/监管合规',
  bias_discrimination: '公序良俗/平台规范',
  agent_tool_abuse: '工具调用/越权访问',
  ssrf_network_access: '工具调用/越权访问',
  output_injection: '输出注入/下游安全',
  model_denial_of_service: '服务稳定性/资源滥用',
  model_theft: '模型资产安全',
  forbidden_content: '敏感词/自定义规则',
  harmful_capability: '高风险请求/安全策略',
  should_refuse_violation: '高风险请求/安全策略',
  redteam_scan: '红队发现/对抗样本',
  redteam_probe: '红队发现/对抗样本',
  redteam_attack: '红队发现/对抗样本',
  gateway_policy_event: '网关策略/访问控制',
  general_safety: '通用安全风险',
  general: '通用安全风险',
};

const REPORT_RISK_TYPE_BY_DOMAIN: Record<RiskDomain, string> = {
  prompt_injection: '提示注入/越狱',
  component_vulnerability: '组件漏洞/供应链',
  legal_compliance: '法律法规/监管合规',
  privacy_leakage: '个人信息/隐私',
  harmful_capability: '高风险请求/安全策略',
  cyber_abuse: '网络安全/恶意滥用',
  fraud_social_engineering: '诈骗与社会工程',
  misinformation_hallucination: '事实准确性/误导风险',
  unsafe_professional_advice: '行业专业信息',
  bias_discrimination: '公序良俗/平台规范',
  system_prompt_leakage: '敏感信息/凭据',
  training_data_extraction: '数据安全/数据外泄',
  rag_data_poisoning: 'RAG/知识库投毒',
  agent_tool_abuse: '工具调用/越权访问',
  data_exfiltration: '数据安全/数据外泄',
  ssrf_network_access: '工具调用/越权访问',
  output_injection: '输出注入/下游安全',
  model_denial_of_service: '服务稳定性/资源滥用',
  model_theft: '模型资产安全',
  general_safety: '通用安全风险',
};

function reportRiskText(input: ReportRiskLabelInput): string {
  return [
    input.riskCategory,
    input.riskCategoryLabel,
    input.engine,
    input.title,
    input.evidence,
    input.reason,
    input.questionContent,
  ]
    .filter(Boolean)
    .join(' ');
}

/** 去匿名化方法/模拟演练不等于已经取得真实个人信息。 */
export function isPrivacyMethodScenario(input: ReportRiskLabelInput): boolean {
  const text = reportRiskText(input);
  return (
    /去匿名|去标识.*还原|重识别|重新识别|de.?anonym|re.?identif|身份关联|关联身份/i.test(text) &&
    /方法|步骤|流程|思路|推断|模拟|合成|演练|假设|示例|method|procedure|synthetic|simulat/i.test(
      text,
    )
  );
}

export function reportRiskTypeLabel(input: ReportRiskLabelInput): string {
  const domain = resolveReportRiskDomain(input);
  if (domain === 'privacy_leakage' && isPrivacyMethodScenario(input)) {
    return '隐私推断/去匿名化风险';
  }
  if (domain === 'general_safety' && input.engine === 'newapi-agent-security-gateway')
    return '网关策略/访问控制';
  const category = input.riskCategory?.trim() ?? '';
  // 规则命中、红队来源不是独立业务风险；有具体领域时统一使用领域标签。
  if (
    domain === 'general_safety' ||
    category === 'sensitive_info_secret' ||
    category === 'sensitive_info'
  ) {
    const byCode = ownString(REPORT_RISK_TYPE_BY_CODE, category);
    if (byCode) return byCode;
  }
  return ownString(REPORT_RISK_TYPE_BY_DOMAIN, domain) ?? '通用安全风险';
}

export function reportRuleActionLabel(input: ReportRiskLabelInput): string {
  const category = input.riskCategory?.trim() ?? '';
  const label = input.riskCategoryLabel?.trim() ?? '';
  const text = reportRiskText(input);
  const actionText = `${category} ${label} ${input.reason ?? ''} ${input.evidence ?? ''}`;

  if (/should_refuse_violation/i.test(actionText)) {
    return '命中高风险请求规则';
  }
  if (/^should_refuse$|应拒答（已拒答）|已拒答/i.test(actionText)) return '应拒答且已拒答';
  if (/forbidden_content|命中禁止|禁止词|敏感词|自定义规则/i.test(actionText)) {
    return '命中禁止词/自定义规则';
  }
  if (/missing_expected|缺失应答要点/i.test(actionText)) return '缺失应答要点';
  if (/expected_answer|命中应答要点/i.test(actionText)) return '命中应答要点';
  if (input.engine === 'newapi-agent-security-gateway' || category === 'gateway_policy_event') {
    return riskLabel(category || 'gateway_policy_event', input.engine ?? undefined);
  }
  if (input.engine === 'garak' || input.engine === 'pyrit' || category.startsWith('redteam_')) {
    return riskLabel(category || 'redteam_scan', input.engine ?? undefined);
  }
  if (/ssrf|工具调用|agent|function call|tool|内网|metadata/i.test(text)) return '工具调用越权';
  if (/prompt.?injection|jailbreak|skeleton key|leetspeak|提示注入|越狱|忽略.*指令/i.test(text)) {
    return '疑似提示注入绕过';
  }
  if (isPrivacyMethodScenario(input)) return '隐私侵害方法输出风险（待核验）';
  if (/个人信息|隐私|敏感|凭据|密钥|secret|token|password|数据外泄|数据外传/i.test(text)) {
    return '敏感信息输出风险（待复核）';
  }
  if (label && !/^[-—]$/.test(label) && !/^通用（未判定）$/.test(label)) return label;
  return '安全策略命中';
}

export function engineLabel(code: string | null | undefined): string {
  if (!code) return '—';
  return ownString(ENGINE_LABELS, code) ?? code;
}

// executor 把 finding 标签存成结构化的 "[engine] riskCategory"（机器可读），
// 但它会经 finding.title→证据流进报告/导出，原样展示就泄露英文枚举（如 [llm-judge] llm_judge_fail）。
// 渲染层统一回写成中文风险类别标签；只在 engine 或 code 至少一个可识别时改写，避免误伤普通方括号文本。
export function localizeFindingTag(text: string | null | undefined): string {
  if (!text) return text ?? '';
  return text.replace(
    /\[([a-z0-9_.-]+)\]\s*([a-z0-9_.]+)/gi,
    (whole, engine: string, code: string) => {
      const risk = ownString(RISK_CATEGORY_LABELS, code);
      const eng = ownString(ENGINE_LABELS, engine);
      if (!risk && !eng) return whole;
      return risk ?? riskLabel(code, engine);
    },
  );
}

export function riskDomainLabel(code: string): string {
  return ownString(RISK_DOMAIN_LABELS, code) ?? code;
}

/**
 * 统一报告风险域：显式领域/组件检测类别优先，题目只是场景上下文。
 * 不能从“讲解组件漏洞”推断部署组件存在漏洞，也不能从“输出”推断下游执行注入。
 */
export function resolveReportRiskDomain(input: ReportRiskLabelInput): RiskDomain {
  const category = input.riskCategory?.trim().toLowerCase() ?? '';
  if ((RISK_DOMAIN as readonly string[]).includes(category) && category !== 'general_safety') {
    return category as RiskDomain;
  }
  if (
    /^(?:component|dependency|supply_chain|container|package)[_.-](?:vulnerability|cve|risk|finding)(?:[_.-]|$)/.test(
      category,
    ) ||
    /^cve-\d{4}-\d+$/i.test(category)
  ) {
    return 'component_vulnerability';
  }
  if (
    category === 'sensitive_info_secret' ||
    category === 'sensitive_info_pii' ||
    category === 'sensitive_info'
  ) {
    return 'privacy_leakage';
  }
  const text = [
    category,
    input.riskCategoryLabel,
    input.evidence,
    input.reason,
    input.questionContent,
    // 红队标题中的攻击包装名称不是被测业务风险。
    /红队.*(?:越狱|攻击)|red.?team/i.test(input.title ?? '') ? '' : input.title,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // 实际扫描器的结果可识别组件证据；普通模型内容即使提到 CVE 也不能进入该域。
  if (
    /^(?:trivy|nuclei)$/.test(input.engine ?? '') &&
    /cve-\d{4}-\d+|受影响组件|组件版本|dependency|package|漏洞/.test(text)
  ) {
    return 'component_vulnerability';
  }
  if (isPrivacyMethodScenario(input)) return 'privacy_leakage';
  if (/system[_ -]?prompt|系统提示/.test(text)) return 'system_prompt_leakage';
  if (/training[_ -]?data|memorization|训练数据|记忆提取/.test(text))
    return 'training_data_extraction';
  if (
    /retrieved_doc|retrieval|vector|knowledge.?base|知识库|检索文档|不可信上下文|投毒|污染|\brag\b/.test(
      text,
    )
  ) {
    return 'rag_data_poisoning';
  }
  if (/ssrf|metadata|169\.254|内网访问|云元数据/.test(text)) return 'ssrf_network_access';
  if (/exfiltration|data[_ -]?exfil|越权披露|数据外传|导出敏感/.test(text))
    return 'data_exfiltration';
  if (
    /cyber|malware|credential attack|exploit|撞库|恶意代码|木马|勒索软件|网络滥用|凭据攻击|网络攻击|网络入侵|入侵方法|入侵步骤|漏洞利用|绕过防护|提权/.test(
      text,
    )
  ) {
    return 'cyber_abuse';
  }
  if (/fraud|phishing|social engineering|scam|诈骗|钓鱼|社工/.test(text))
    return 'fraud_social_engineering';
  if (/misinformation|hallucination|factuality|幻觉|事实一致|谣言/.test(text))
    return 'misinformation_hallucination';
  if (/privacy|pii|个人信息|隐私|身份证|手机号|住址|邮箱|病历|医疗记录|客户资料/.test(text)) {
    return 'privacy_leakage';
  }
  if (/api[_ -]?key|secret|credential|password|凭据|密钥|私钥|访问令牌|敏感信息/.test(text))
    return 'privacy_leakage';
  if (/professional|medical|financial|legal advice|医疗|金融|专业建议/.test(text))
    return 'unsafe_professional_advice';
  if (/bias|discrimination|fairness|偏见|歧视|公平/.test(text)) return 'bias_discrimination';
  if (/model[_ -]?(dos|denial)|token flood|资源消耗|拒服/.test(text))
    return 'model_denial_of_service';
  if (/model[_ -]?(theft|extraction)|capability probing|模型盗用|能力探测/.test(text))
    return 'model_theft';
  if (/output[_ -]?injection|xss|脚本注入|输出处理不当|下游执行/.test(text))
    return 'output_injection';
  if (/tool[_ .-]|agent[_ .-]|function call|越权代理|工具调用|工具越权/.test(text))
    return 'agent_tool_abuse';
  if (/prompt.?inject|jailbreak|越狱|提示注入|忽略.*指令|编码绕过/.test(text))
    return 'prompt_injection';
  if (
    /bullying|霸凌|欺凌|self[_ -]?harm|suicide|自杀|自伤|自残|轻生|should_refuse|refusal|harmful|未拒答|应拒答|危险|有害/.test(
      text,
    )
  ) {
    return 'harmful_capability';
  }
  if (/forbidden|illegal|compliance|违法|违规|禁止|合规/.test(text)) return 'legal_compliance';
  return 'general_safety';
}
export function riskDomainForCategory(code: string, title?: string | null): RiskDomain {
  return resolveReportRiskDomain({ riskCategory: code, title });
}

export const REPORT_TIME_ZONE = 'Asia/Shanghai';
const reportDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
/** 报告使用明确的交付时区，不继承容器 TZ，也不读取访问者电脑时间。 */
export function formatDateTime(d: Date): string {
  if (!Number.isFinite(d.getTime())) return '时间未记录';
  const parts = Object.fromEntries(
    reportDateFormatter.formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}（北京时间 UTC+08:00）`;
}
export function formatDateTimeNullable(d: Date | null | undefined): string {
  return d ? formatDateTime(d) : '—';
}
