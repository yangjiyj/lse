// 前端展示用的枚举、标签映射、徽章配色与格式化工具。
// 枚举值与后端 @lse/shared/enums 严格对齐（此处硬编码以解耦 workspace 依赖）。

import {
  STANDARD_CATEGORY_LABELS,
  UNCATEGORIZED_LABEL,
  categoryOrFallback,
  normalizeCategoryName,
  standardTrainingDataLabel,
} from '@lse/shared';
import { PRODUCT_NAME } from './product-name';

export { standardTrainingDataLabel };

export const SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

// 报告可选章节（与后端 labels.ts REPORT_OPTIONAL_SECTIONS 对齐）。
export const REPORT_SECTIONS = [
  'resultOverview',
  'riskItems',
  'gbtCompliance',
  'redTeam',
  'remediation',
  'nextSteps',
  'appendix',
] as const;
export type ReportSectionKey = (typeof REPORT_SECTIONS)[number];
export const REPORT_SECTION_LABELS: Record<ReportSectionKey, string> = {
  resultOverview: '结果总览（图表与覆盖）',
  riskItems: '风险发现清单',
  gbtCompliance: '国家标准对照（GB/T 45654）',
  redTeam: '多轮攻击测试实录（红队）',
  remediation: '整改计划',
  nextSteps: '复测建议',
  appendix: '附录（方法论）',
};

export const REPORT_EXPORT_PROFILES = [
  'full',
  'leadership_brief',
  'remediation_work_order',
  'compliance_evidence',
] as const;
export type ReportExportProfile = (typeof REPORT_EXPORT_PROFILES)[number];
export const REPORT_EXPORT_PROFILE_META: Record<
  ReportExportProfile,
  { label: string; description: string; sections: ReportSectionKey[] }
> = {
  full: {
    label: '完整综合报告',
    description: '摘要、正文、整改与完整证据附录',
    sections: [...REPORT_SECTIONS],
  },
  leadership_brief: {
    label: '领导简报',
    description: '只保留结论、态势和行动建议',
    sections: ['resultOverview', 'remediation', 'nextSteps'],
  },
  remediation_work_order: {
    label: '整改任务书',
    description: '按优先级输出风险、责任与复测要求',
    sections: ['riskItems', 'remediation', 'nextSteps'],
  },
  compliance_evidence: {
    label: '合规证据包',
    description: '合规映射与完整证据链',
    sections: ['riskItems', 'gbtCompliance', 'appendix'],
  },
};

export const VERDICTS = ['PASS', 'FAIL', 'UNKNOWN', 'ERROR'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const EVAL_TASK_STATUSES = [
  'PENDING',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELED',
] as const;
export type EvalTaskStatus = (typeof EVAL_TASK_STATUSES)[number];

export const MODEL_CALL_STATUSES = ['SUCCESS', 'ERROR'] as const;
export type ModelCallStatus = (typeof MODEL_CALL_STATUSES)[number];

export const IMPORT_STATUSES = ['PENDING', 'SUCCESS', 'PARTIAL', 'FAILED'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const LICENSE_STATUSES = ['ACTIVE', 'EXPIRED', 'INVALID', 'REVOKED'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

export const QUESTION_TYPES = [
  'COMPLIANCE',
  'PROMPT_INJECTION',
  'SHOULD_REFUSE',
  'GENERAL',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_TEMPLATE_TYPES = [
  'compliance',
  'prompt_injection',
  'should_refuse',
  'general',
] as const;
export type QuestionTemplateType = (typeof QUESTION_TEMPLATE_TYPES)[number];

export const REPORT_KINDS = [
  'comprehensive',
  'safety_overview',
  'refusal_capability',
  'prompt_injection_resilience',
  'component_vulnerability',
  'service_assurance',
  'multilingual_coverage',
  'agent_tool_abuse',
  'usability_over_refusal',
  'gbt45654_content',
  'combined',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'critical';

export const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-severity-unknown-bg text-severity-unknown ring-black/5',
  info: 'bg-severity-low-bg text-severity-low ring-black/5',
  success: 'bg-severity-pass-bg text-severity-pass ring-black/5',
  warning: 'bg-severity-medium-bg text-severity-medium ring-black/5',
  danger: 'bg-severity-high-bg text-severity-high ring-black/5',
  critical: 'bg-severity-critical-bg text-severity-critical ring-black/5',
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  INFO: '提示',
  LOW: '低危',
  MEDIUM: '中危',
  HIGH: '高危',
  CRITICAL: '严重',
};

export const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  INFO: 'neutral',
  LOW: 'info',
  MEDIUM: 'warning',
  HIGH: 'danger',
  CRITICAL: 'critical',
};

/** 图表用的严重度色板（与徽章语义一致的实心色）。 */
export const SEVERITY_COLOR: Record<Severity, string> = {
  INFO: '#94a3b8',
  LOW: '#0ea5e9',
  MEDIUM: '#f59e0b',
  HIGH: '#f97316',
  CRITICAL: '#ef4444',
};

export const VERDICT_LABELS: Record<Verdict, string> = {
  PASS: '通过',
  FAIL: '未通过',
  UNKNOWN: '未判定',
  ERROR: '执行异常',
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

export const REVIEW_STATUS_LABELS: Record<string, string> = {
  UNREVIEWED: '未复核',
  NEEDS_REVIEW: '待人工复核',
  CONFIRMED: '人工确认风险',
  FALSE_POSITIVE: '人工确认误报',
  ACCEPTED_RISK: '已接受风险',
};

export function reviewStatusLabel(value: string | null | undefined): string {
  return value ? (REVIEW_STATUS_LABELS[value] ?? '未识别复核状态') : '未记录';
}

/** 风险处置台「待复核」筛选项：一个选项同时覆盖未复核 + 待人工复核（接口参数 reviewStatus=pending）。 */
export const PENDING_REVIEW_FILTER_LABEL = '待复核（未复核 + 待人工复核）';

// 评估对象类型（与后端 TargetType 对齐）。风险样本详情等处用本地映射，不依赖评估对象页的常量。
export const TARGET_TYPE_DISPLAY_LABELS: Record<string, string> = {
  MODEL: '模型',
  AGENT: '智能体',
  AGENT_API: '智能体接口',
  PLATFORM_APP: '平台智能体',
  ENDPOINT_AGENT: '终端智能体',
  PUBLIC_AGENT: '公开智能体',
  MCP_OPENAPI: '接口型智能体',
  GATEWAY_LOG: '网关日志源',
  JUDGE: '判定模型',
};

export function targetTypeDisplayLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return TARGET_TYPE_DISPLAY_LABELS[value] ?? fallbackLabel(value, '其他对象');
}

// 评估对象供应商（接入协议）中文名；未收录的英文值回退「其他」。
export const PROVIDER_DISPLAY_LABELS: Record<string, string> = {
  'openai-compatible': 'OpenAI 兼容接口',
  'openai-compatible-local': 'OpenAI 兼容接口（本地）',
  'openai-compatible-cloud': 'OpenAI 兼容接口（云端）',
  'pipechina-standard-openai': '国家管网标准模型接口',
  openai: 'OpenAI',
  'custom-agent': '自定义智能体',
  'public-agent': '公开智能体',
  'mcp-openapi': '接口型智能体',
  'platform-app': '平台智能体',
  agentshield: '智能体安全平台',
  'jiandun-fleet': `${PRODUCT_NAME}自管终端`,
  'newapi-agent-security-gateway': '智能体安全网关',
};

export function providerDisplayLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return PROVIDER_DISPLAY_LABELS[value] ?? fallbackLabel(value, '其他');
}

// 评估范围里的维度（任务创建时写入的维度码）。
export const SCOPE_DIMENSION_LABELS: Record<string, string> = {
  comprehensive: '综合评估',
  content_safety: '内容安全',
  redteam_attack: '红队对抗',
  agent_tool_call: '智能体工具调用',
  indirect_prompt_injection: '间接提示注入',
  runtime_trace: '运行轨迹分析',
  sample_regression: '样本库回归',
  standard_output_safety: '国标输出安全',
  multimodal_jailbreak: '多模态越狱',
  gateway_traffic_log: '网关流量日志',
  rag_quality: 'RAG 质量',
  rag_security: 'RAG 安全',
  robustness: '鲁棒性',
};

export function scopeDimensionLabel(code: string): string {
  const catalog = DIMENSION_CATALOG.find((d) => d.code === code)?.label;
  return SCOPE_DIMENSION_LABELS[code] ?? catalog ?? fallbackLabel(code, '其他维度');
}

export function scopeModuleLabel(code: string): string {
  return ENGINE_LABELS[code] ?? fallbackLabel(code, '其他评估模块');
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

/** 判定结果的白话解释，供徽章 tooltip 使用（客户看结论时一并看懂含义与下一步）。 */
export const VERDICT_HINTS: Record<Verdict, string> = {
  PASS: '当前启用的风险规则未产生有效风险。',
  FAIL: '当前样本判定为未通过，请结合风险证据复核并处置。',
  UNKNOWN: '现有证据不足，未形成有效判定。',
  ERROR: '样本执行异常，请排查调用或任务日志后重新评估。',
};

export function verdictHint(v: string | null | undefined): string {
  return v ? (VERDICT_HINTS[v as Verdict] ?? '') : '';
}

export const VERDICT_TONE: Record<Verdict, BadgeTone> = {
  PASS: 'success',
  FAIL: 'critical',
  UNKNOWN: 'neutral',
  ERROR: 'warning',
};

export const TASK_STATUS_LABELS: Record<EvalTaskStatus, string> = {
  PENDING: '排队中',
  RUNNING: '执行中',
  PAUSED: '已暂停',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELED: '已取消',
};

export const TASK_STATUS_TONE: Record<EvalTaskStatus, BadgeTone> = {
  PENDING: 'neutral',
  RUNNING: 'info',
  PAUSED: 'warning',
  COMPLETED: 'success',
  FAILED: 'critical',
  CANCELED: 'neutral',
};

export type EvaluationOutcomeKind = 'risk' | 'incomplete' | 'safe';

export interface EvaluationOutcomeInput {
  status: string;
  totalQuestions: number;
  processedQuestions: number;
  passedCount: number;
  failedCount: number;
  errorCount: number;
  unknownCount?: number;
  skippedEngineCount?: number;
  progress: number;
  /** 国标专项任务的指标结论（ATTAINED / NOT_ATTAINED / INSUFFICIENT_EVIDENCE）。 */
  standardRun?: { conclusion?: string | null } | null;
}

export interface EvaluationOutcome {
  kind: EvaluationOutcomeKind;
  headline: string;
  summary: string;
  detail: string;
  incomplete: boolean;
  unknownCount: number;
  skippedEngineCount: number;
}

/**
 * 统一任务结论：只有执行与判定均完整的全 PASS 任务才允许形成范围内安全结论。
 * 该函数同时服务任务列表和详情，避免页面只看 failedCount 各自推导结论。
 */
export function buildEvaluationOutcome(input: EvaluationOutcomeInput): EvaluationOutcome {
  const derivedUnknownCount = Math.max(
    input.processedQuestions - input.passedCount - input.failedCount - input.errorCount,
    0,
  );
  const reportedUnknownCount = Math.max(input.unknownCount ?? derivedUnknownCount, 0);
  const unknownCount = Math.max(reportedUnknownCount, derivedUnknownCount);
  const reportedResultCount =
    input.passedCount + input.failedCount + input.errorCount + reportedUnknownCount;
  const resultCountGap = input.processedQuestions - reportedResultCount;
  const skippedEngineCount = Math.max(input.skippedEngineCount ?? 0, 0);
  const summary = [
    `通过 ${input.passedCount}`,
    `风险 ${input.failedCount}`,
    `异常 ${input.errorCount}`,
    `未判定 ${unknownCount}`,
    `跳过引擎 ${skippedEngineCount}`,
  ].join(' · ');

  const incompleteReasons: string[] = [];
  if (input.status !== 'COMPLETED') {
    const status = TASK_STATUS_LABELS[input.status as EvalTaskStatus] ?? input.status;
    incompleteReasons.push(`任务状态为${status}`);
  }
  if (input.totalQuestions <= 0) incompleteReasons.push('没有可形成结论的样本');
  if (input.totalQuestions > 0 && input.processedQuestions < input.totalQuestions) {
    incompleteReasons.push(`仅处理 ${input.processedQuestions}/${input.totalQuestions} 个样本`);
  } else if (input.totalQuestions > 0 && input.processedQuestions > input.totalQuestions) {
    incompleteReasons.push('已处理结果数与样本总数不一致');
  } else if (!Number.isFinite(input.progress) || input.progress < 1) {
    incompleteReasons.push('任务进度尚未完成');
  }
  if (resultCountGap > 0) {
    incompleteReasons.push(`结果计数不完整：有 ${resultCountGap} 项未归类结果`);
  } else if (resultCountGap < 0) {
    incompleteReasons.push('结果计数不一致：已分类结果超过已处理数');
  }
  if (input.errorCount > 0) incompleteReasons.push(`${input.errorCount} 项执行异常`);
  if (unknownCount > 0) incompleteReasons.push(`${unknownCount} 项未判定`);
  if (skippedEngineCount > 0) incompleteReasons.push(`${skippedEngineCount} 个引擎运行被跳过`);
  // 国标专项：指标证据不足时，任务不能给出完整结论；指标未达阈值时，不能写「未发现风险」。
  const standardConclusion = input.standardRun?.conclusion ?? null;
  if (standardConclusion === 'INSUFFICIENT_EVIDENCE') incompleteReasons.push('国标指标证据不足');

  const incomplete = incompleteReasons.length > 0;
  if (input.failedCount > 0) {
    return {
      kind: 'risk',
      headline: `发现 ${input.failedCount} 项风险`,
      summary,
      detail: incomplete
        ? `已发现风险；同时评估不完整：${incompleteReasons.join('、')}。覆盖缺口补测前不能形成完整安全结论。`
        : '本次评估已发现需复核和整改的风险项。',
      incomplete,
      unknownCount,
      skippedEngineCount,
    };
  }

  if (standardConclusion === 'NOT_ATTAINED' && input.status === 'COMPLETED') {
    return {
      kind: 'risk',
      headline: '国标指标未达到阈值',
      summary,
      detail: incomplete
        ? `按 GB/T 45654 评估，存在未达到阈值的指标；同时评估不完整：${incompleteReasons.join('、')}。`
        : '按 GB/T 45654 评估，存在未达到阈值的指标，请查看下方「输出安全符合情况」。',
      incomplete,
      unknownCount,
      skippedEngineCount,
    };
  }

  const isStrictAllPass =
    standardConclusion !== 'INSUFFICIENT_EVIDENCE' &&
    input.status === 'COMPLETED' &&
    input.totalQuestions > 0 &&
    input.processedQuestions === input.totalQuestions &&
    input.passedCount === input.processedQuestions &&
    input.failedCount === 0 &&
    input.errorCount === 0 &&
    unknownCount === 0 &&
    skippedEngineCount === 0 &&
    Number.isFinite(input.progress) &&
    input.progress >= 1;

  if (!isStrictAllPass) {
    if (incompleteReasons.length === 0) {
      incompleteReasons.push('结果计数不完整：未满足全部已处理样本均通过');
    }
    return {
      kind: 'incomplete',
      headline: '评估不完整，未形成完整结论',
      summary,
      detail: `${incompleteReasons.join('、')}。请补齐执行与判定后再形成安全结论。`,
      incomplete: true,
      unknownCount,
      skippedEngineCount,
    };
  }

  return {
    kind: 'safe',
    headline: '本次评估范围内未发现风险',
    summary,
    detail: '本任务已完整执行；该结论仅覆盖本次样本和启用的评估能力。',
    incomplete: false,
    unknownCount,
    skippedEngineCount,
  };
}

export const MODEL_CALL_STATUS_LABELS: Record<ModelCallStatus, string> = {
  SUCCESS: '成功',
  ERROR: '错误',
};

export const MODEL_CALL_STATUS_TONE: Record<ModelCallStatus, BadgeTone> = {
  SUCCESS: 'success',
  ERROR: 'critical',
};

export const IMPORT_STATUS_LABELS: Record<ImportStatus, string> = {
  PENDING: '处理中',
  SUCCESS: '成功',
  PARTIAL: '部分成功',
  FAILED: '失败',
};

export const IMPORT_STATUS_TONE: Record<ImportStatus, BadgeTone> = {
  PENDING: 'neutral',
  SUCCESS: 'success',
  PARTIAL: 'warning',
  FAILED: 'critical',
};

export const LICENSE_STATUS_LABELS: Record<LicenseStatus, string> = {
  ACTIVE: '生效中',
  EXPIRED: '已过期',
  INVALID: '无效',
  REVOKED: '已吊销',
};

export const LICENSE_STATUS_TONE: Record<LicenseStatus, BadgeTone> = {
  ACTIVE: 'success',
  EXPIRED: 'warning',
  INVALID: 'critical',
  REVOKED: 'critical',
};

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  COMPLIANCE: '合规性',
  PROMPT_INJECTION: '提示注入',
  SHOULD_REFUSE: '应拒答',
  GENERAL: '通用',
};

export const TEMPLATE_TYPE_LABELS: Record<QuestionTemplateType, string> = {
  compliance: '合规性问题',
  prompt_injection: '提示注入问题',
  should_refuse: '应拒答问题',
  general: '通用问题',
};

export const REPORT_KIND_LABELS: Record<ReportKind, string> = {
  comprehensive: '综合评估报告',
  safety_overview: '安全评估总览',
  refusal_capability: '拒答能力专项',
  prompt_injection_resilience: '提示注入对抗专项',
  component_vulnerability: '组件漏洞专项',
  service_assurance: 'AI 服务安全核验报告',
  multilingual_coverage: '多语言覆盖专项',
  agent_tool_abuse: '智能体工具调用安全专项',
  usability_over_refusal: '过度拒答专项',
  gbt45654_content: '生成内容安全评估报告（GB/T 45654）',
  combined: '组合报告',
};

export const ENGINE_LABELS: Record<string, string> = {
  'rule-judge': '规则引擎',
  'sensitive-info': '敏感信息扫描',
  'endpoint-agent-eval': '终端智能体测评',
  'agent-tool-guard': '智能体操作守卫',
  'ai-infra-guard': '加强版红队引擎',
  'python-judge': 'AI 深度语义判定',
  'llm-judge': 'AI 评审复核',
  'newapi-agent-security-gateway': '智能体安全网关',
  'rag-eval': 'RAG 专项评估',
  'autonomous-red-team': '自主红队',
  'substance-judge': '实质判定',
  'composite-judge': '复合判定',
  'canary-exfil': '数据外泄取证',
  'skill-mcp-static': 'AI 组件漏洞扫描',
  'agent-llm-judge': '智能体判定模型',
  'adr-sensor-import': '运行轨迹导入分析',
};

/** 创建任务时可勾选的检测项目录（内置始终启用；未开通项需管理员在后端开启）。 */
export const ENGINE_CATALOG: Array<{
  code: string;
  label: string;
  builtin: boolean;
  hint: string;
}> = [
  {
    code: 'rule-judge',
    label: '规则引擎',
    builtin: true,
    hint: '依据关键词、拒答与合规规则识别响应风险，内置常开。',
  },
  {
    code: 'sensitive-info',
    label: '敏感信息扫描',
    builtin: true,
    hint: '检测响应中是否存在敏感信息泄露，内置常开。',
  },
  {
    code: 'agent-tool-guard',
    label: '智能体操作守卫',
    builtin: false,
    hint: '盯 AI 调用工具时的越权动作：读本地文件、读环境变量、访问内部地址等，内置可选。',
  },
  {
    code: 'python-judge',
    label: 'AI 深度语义判定',
    builtin: false,
    hint: '用 AI 深度理解模型回答是否越界。当前未开通，如需请联系管理员开启。',
  },
  {
    code: 'llm-judge',
    label: 'AI 评审复核',
    builtin: false,
    hint: '使用独立判定模型复核响应；在评估对象中配置后自动生效。',
  },
];

/** 创建任务时可勾选的评估维度目录。 */
export const DIMENSION_CATALOG: Array<{ code: string; label: string; hint: string }> = [
  { code: 'compliance', label: '内容合规', hint: '检测违法违规和业务内容边界。' },
  {
    code: 'prompt_injection',
    label: '提示注入',
    hint: '检测越权指令执行、系统设定泄露和间接注入。',
  },
  { code: 'refusal', label: '拒答边界', hint: '检测高风险请求是否得到安全处置。' },
  { code: 'sensitive_info', label: '敏感信息泄露', hint: '检测密钥、口令等敏感信息泄露。' },
  { code: 'privacy_leakage', label: '隐私泄露', hint: '检测个人信息和隐私数据泄露。' },
  { code: 'cyber_abuse', label: '网络攻击滥用', hint: '检测恶意代码和未授权攻击能力输出。' },
  {
    code: 'fraud_social_engineering',
    label: '诈骗与社会工程',
    hint: '检测诈骗、钓鱼和身份冒充内容。',
  },
  { code: 'system_prompt_leakage', label: '系统设定泄露', hint: '检测系统提示和内部规则泄露。' },
  { code: 'training_data_extraction', label: '训练数据提取', hint: '检测训练数据或记忆内容提取。' },
  {
    code: 'rag_data_poisoning',
    label: '检索增强污染',
    hint: '检测污染资料导致的错误回答或危险输出。',
  },
  { code: 'agent_tool_abuse', label: '工具越权操作', hint: '检测智能体工具权限和参数边界。' },
  { code: 'data_exfiltration', label: '数据外传', hint: '检测非授权数据外发行为。' },
  {
    code: 'ssrf_network_access',
    label: '内网越权访问',
    hint: '检测非授权内网、回环和云元数据访问。',
  },
  {
    code: 'output_injection',
    label: '输出注入',
    hint: '检测输出中可能影响下游系统的恶意指令或代码。',
  },
  {
    code: 'misinformation_hallucination',
    label: '事实可靠性',
    hint: '检测事实编造、误导性结论和前后矛盾。',
  },
  {
    code: 'unsafe_professional_advice',
    label: '高风险专业建议',
    hint: '检测医疗、法律和金融等高风险建议。',
  },
  { code: 'bias_discrimination', label: '偏见与歧视', hint: '检测歧视性或不公平输出。' },
  {
    code: 'model_denial_of_service',
    label: '资源消耗',
    hint: '检测异常资源消耗和服务可用性风险。',
  },
  { code: 'model_theft', label: '模型能力探测', hint: '检测模型能力探测和仿制风险。' },
  { code: 'robustness', label: '鲁棒性', hint: '检测语义改写、编码和多语言变体下的策略稳定性。' },
];

export const AGENT_RISK_SURFACE_LABELS: Record<string, string> = {
  ssrf: '越界访问内网/服务器（SSRF）',
  secret_read: '密钥读取',
  file_read: '本地文件读取',
  dangerous_command: '危险命令',
  data_exfiltration: '数据外传',
  indirect_prompt_injection: '外部内容夹带指令',
  tool_argument_bypass: '篡改工具参数绕过限制',
};

// 兜底：遇到未收录枚举时，若原值已是中文（后端可能直接下发中文标签）就原样显示；
// 否则返回中文占位，绝不让英文枚举/技术 id 裸露到客户可见文本（原始 code 交由调用方放进 tooltip 排查）。
const CJK_RE = /[一-鿿]/;
function fallbackLabel(raw: string, generic: string): string {
  return CJK_RE.test(raw) ? raw : generic;
}

export function agentRiskSurfaceLabel(s: string | null | undefined): string {
  if (!s) return '—';
  return AGENT_RISK_SURFACE_LABELS[s] ?? fallbackLabel(s, '其他风险项');
}

export function severityLabel(s: string | null | undefined): string {
  if (!s) return '—';
  return SEVERITY_LABELS[s as Severity] ?? fallbackLabel(s, '未知等级');
}

export function verdictLabel(v: string | null | undefined): string {
  if (!v) return '—';
  return VERDICT_LABELS[v as Verdict] ?? fallbackLabel(v, '其他');
}

export function engineLabel(code: string | null | undefined): string {
  if (!code) return '—';
  return ENGINE_LABELS[code] ?? fallbackLabel(code, '其他判定依据');
}

export function questionTypeLabel(t: string | null | undefined): string {
  if (!t) return '—';
  return QUESTION_TYPE_LABELS[t as QuestionType] ?? fallbackLabel(t, '其他');
}

export function reportKindLabel(t: string | null | undefined): string {
  if (!t) return REPORT_KIND_LABELS.safety_overview;
  return REPORT_KIND_LABELS[t as ReportKind] ?? fallbackLabel(t, '专项报告');
}

// 风险类别中文映射（与后端 apps/api/src/modules/reports/labels.ts 的 RISK_CATEGORY_LABELS 同步）。
// 注意：llm_judge_*、agent_llm_judge_*、python_judge_*、engine_error 是「判定来源」，不是风险类别，
// 不得出现在这张表里；展示时统一回退为「未分类」（见 riskCategoryLabel，判定来源本身的中文在 @lse/shared 的 risk-labels.ts）。
export const RISK_CATEGORY_LABELS: Record<string, string> = {
  forbidden_content: '命中禁止内容',
  should_refuse: '已有效拒答',
  should_refuse_violation: '未有效拒答',
  expected_answer: '命中应答要点',
  missing_expected: '缺失应答要点',
  general: '通用（未判定）',
  prompt_injection: '提示注入',
  compliance: '合规风险',
  legal_compliance: '违法违规/合规风险',
  harmful_capability: '有害能力/高风险请求风险',
  cyber_abuse: '网络滥用/恶意代码风险',
  fraud_social_engineering: '诈骗与社会工程风险',
  misinformation_hallucination: '幻觉误导/事实一致性风险',
  unsafe_professional_advice: '高风险专业建议风险',
  bias_discrimination: '偏见歧视/公平性风险',
  training_data_extraction: '训练数据/记忆提取风险',
  rag_data_poisoning: '知识库污染风险',
  data_exfiltration: '数据外传/越权披露风险',
  canary_exfiltration: '诱饵数据外发风险',
  ssrf_network_access: '越界访问内网/服务器风险',
  model_denial_of_service: '资源消耗/模型拒服风险',
  model_theft: '模型盗用/能力探测风险',
  privacy_leakage: '隐私与敏感信息泄露风险',
  sensitive_info: '敏感信息检查',
  sensitive_info_secret: '敏感凭据泄露',
  sensitive_info_pii: '个人信息泄露',
  component_vulnerability: '组件漏洞/供应链风险',
  system_prompt_leakage: '系统设定泄露风险',
  agent_tool_abuse: '工具调用/越权代理风险',
  output_injection: '回答夹带恶意指令/脚本风险',
  general_safety: '通用安全风险',
  redteam_scan: '红队扫描发现',
  redteam_probe: '红队探针发现',
  redteam_attack: '红队对抗发现',
  gateway_policy_event: '策略命中事件',
  uncategorized: UNCATEGORIZED_LABEL,
};

const RISK_CATEGORY_DYNAMIC: Array<{ p: RegExp; f: (n: string) => string }> = [
  { p: /^redteam_finding_(\d+)$/, f: (n) => `红队发现项 #${n}` },
  { p: /^garak_probe_(\d+)$/, f: (n) => `红队探针项 #${n}` },
  { p: /^pyrit_attack_(\d+)$/, f: (n) => `红队对抗项 #${n}` },
];

function knownRiskCategoryLabel(code: string): string {
  const known = RISK_CATEGORY_LABELS[code];
  if (known) return known;
  for (const { p, f } of RISK_CATEGORY_DYNAMIC) {
    const m = code.match(p);
    if (m) return f(m[1] ?? code);
  }
  // 国标专项的 31 个类别键、生成器模板的英文类别名：统一翻成中文，不露英文类别码。
  const standard = STANDARD_CATEGORY_LABELS[code];
  if (standard) return standard;
  const alias = normalizeCategoryName(code);
  if (alias !== code) return alias;
  return fallbackLabel(code, '其他风险项');
}

/**
 * 风险类别中文名。
 * 判定来源（llm_judge_fail 等）不是类别：有 domainLabel（样本所属风险域的中文名）就显示风险域，
 * 否则显示「未分类」。存量数据里仍有这类值，所以展示层必须回退。
 */
export function riskCategoryLabel(
  code: string | null | undefined,
  domainLabel?: string | null,
): string {
  if (!code) return '—';
  return categoryOrFallback(code, knownRiskCategoryLabel, domainLabel);
}

// 沙箱工具名中文映射（被测智能体可调用的工具；枚举与后端 AgentSandboxToolName 对齐）
export const TOOL_NAME_LABELS: Record<string, string> = {
  read_file: '读取文件',
  run_shell: '执行命令',
  send_data: '发送数据',
  http_get: '网络请求',
  browser_open: '打开网页',
  // 兼容历史/别名命名
  http_fetch: '网络请求',
  list_files: '列出文件',
};

export function toolNameLabel(name: string | null | undefined): string {
  if (!name) return '—';
  return TOOL_NAME_LABELS[name] ?? fallbackLabel(name, '其他工具');
}

// 智能体工具守卫 / 评估沙箱的英文 blockReason → 中文。
// 这些原句由后端 apps/api/src/modules/agent-evals/tool-sandbox.ts 生成，
// 历史评估数据里已落库为英文，因此在展示层统一本地化（同时覆盖历史与新数据）。
const AGENT_BLOCK_REASON_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /Blocked outbound data transfer containing canary, secret, token, credential, or PII-like data\.?/gi,
    'AI 试图把敏感数据发到外部：其中含预埋的诱饵数据 / 密钥 / 访问令牌 / 账号凭证或疑似个人信息',
  ],
  [/Blocked SSRF target or metadata endpoint:?\s*/gi, '尝试探测内网 / 云元数据等越界目标：'],
  [/Blocked sensitive file read:?\s*/gi, '读取敏感文件：'],
  [/Blocked arbitrary absolute file read:?\s*/gi, '读取任意绝对路径文件：'],
  [
    /Blocked shell command that reads secrets, env vars, or sensitive files\.?/gi,
    '执行了读取密钥 / 环境变量 / 敏感文件的命令',
  ],
  [/Blocked dangerous shell command:?\s*/gi, '执行高危命令：'],
  [/Blocked unknown sandbox tool:?\s*/gi, '调用未知沙箱工具：'],
  [/Blocked malformed tool arguments JSON\.?/gi, '工具参数 JSON 格式错误'],
  [
    /Tool boundary blocked (.+?): not in allowed tools\.?\s*/gi,
    '工具边界拦截 $1：不在允许工具清单内。',
  ],
  [
    /Tool boundary blocked (.+?): denied by scenario boundary\.?\s*/gi,
    '工具边界拦截 $1：被场景边界拒绝。',
  ],
  [
    /Tool boundary blocked (.+?): human confirmation is required\.?\s*/gi,
    '工具边界拦截 $1：需人工确认。',
  ],
  [/sandbox blocked tool call/gi, '沙箱已阻断该工具调用'],
  [
    /Simulated tool result; no real side effect was performed\.?/gi,
    '模拟工具结果；未产生真实副作用',
  ],
];

const AGENT_RISK_SURFACE_TOKEN_RE =
  /\b(ssrf|secret_read|file_read|dangerous_command|data_exfiltration|indirect_prompt_injection|tool_argument_bypass)\b/g;
const AGENT_TOOL_NAME_TOKEN_RE = /\b(http_get|read_file|run_shell|browser_open|send_data)\b/g;

/**
 * 把「评估沙箱阻断高风险工具调用：send_data / data_exfiltration / Blocked outbound…」这类
 * 中英混杂的判定理由整段中文化：归一旧前缀 → 翻译英文原因句 → 替换 riskSurface 枚举与工具名 token。
 * 用于风险样本详情、智能体轨迹面板、任务详情等所有展示判定理由/证据的位置。
 */
export function localizeAgentEvidence(text: string | null | undefined): string {
  if (!text) return '—';
  let out = text
    .replace(/工具沙箱拦截高风险调用/g, '评估沙箱阻断高风险工具调用')
    .replace(/工具沙箱拦截/g, '评估沙箱阻断');
  for (const [re, zh] of AGENT_BLOCK_REASON_RULES) out = out.replace(re, zh);
  out = out.replace(AGENT_RISK_SURFACE_TOKEN_RE, (m) => AGENT_RISK_SURFACE_LABELS[m] ?? m);
  out = out.replace(AGENT_TOOL_NAME_TOKEN_RE, (m) => TOOL_NAME_LABELS[m] ?? m);
  return out;
}

// 智能体动作放行/阻断
export function agentDecisionLabel(decision: string | null | undefined): string {
  if (decision === 'allowed') return '放行';
  if (decision === 'blocked') return '阻断';
  return decision ?? '—';
}

// 组件扫描目标类型
export const SCAN_TARGET_KIND_LABELS: Record<string, string> = {
  endpoint: '接口地址（单个 API）',
  openapi: '接口清单文件（OpenAPI）',
  mcp: 'MCP 工具服务',
};

/** 扫描目标类型的选型引导（供下拉项旁 tooltip）。 */
export const SCAN_TARGET_KIND_HINTS: Record<string, string> = {
  endpoint: '针对单个接口地址执行评估。',
  openapi: '有接口清单文件（OpenAPI 规范）时，一次性把里面的接口都测了。',
  mcp: '供智能体调用的工具服务（MCP）。',
};

export function scanTargetKindLabel(kind: string | null | undefined): string {
  if (!kind) return '—';
  return SCAN_TARGET_KIND_LABELS[kind] ?? fallbackLabel(kind, '其他目标');
}

// 运行/执行状态通用中文映射（组件扫描、运行记录等）
export const RUN_STATUS_LABELS: Record<string, string> = {
  SUCCESS: '成功',
  FAILED: '失败',
  ERROR: '错误',
  PENDING: '待执行',
  RUNNING: '运行中',
  CANCELED: '已取消',
  PARTIAL: '部分完成',
};

export function runStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return RUN_STATUS_LABELS[status] ?? fallbackLabel(status, '其他状态');
}

// 智能体攻击场景包中文名
export const AGENT_PACK_LABELS: Record<string, string> = {
  'builtin-agent-attacks': '内置智能体攻击包',
};

export function agentPackLabel(id: string | null | undefined): string {
  if (!id) return '—';
  return AGENT_PACK_LABELS[id] ?? fallbackLabel(id, '攻击场景包');
}

const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateFmt = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return dateTimeFmt.format(d);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return dateFmt.format(d);
}

/** 入参为 0..1 的比率，输出百分比文本；null 显示破折号。 */
export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('zh-CN').format(n);
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** 截断长文本用于表格展示。 */
export function truncate(s: string | null | undefined, max = 80): string {
  if (!s) return '—';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ===========================================================================
// 智能体样本的「客户语言」翻译层
//
// 存在理由：Finding.detail.trace 里证据是齐全的（工具名/参数/是否放行/阻断原因），
// 但此前只有详情弹窗消费它，列表层只显示判定徽标 + 0.00/1 参考分。客户因此无法
// 区分「模型真的指示了危险操作」和「平台自己调用失败」。以下函数把 trace 压成
// 一句人话，供列表行直接展示。
// ===========================================================================

/** 单个样本从 trace 归纳出的行为摘要。 */
export interface AgentBehaviorSummary {
  /** 一句话结论，如「模型要求读取密钥文件（沙箱已阻断）」。 */
  text: string;
  /** 是否存在被放行的危险调用——放行意味着真实环境里会真的执行。 */
  hasAllowedRisk: boolean;
  /** 危险调用总次数。 */
  riskCount: number;
  /** 被沙箱阻断的次数。 */
  blockedCount: number;
}

interface MinimalTraceItem {
  toolName?: unknown;
  allowed?: unknown;
  blockReason?: unknown;
  riskSurface?: unknown;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 从 findings[].detail.trace 归纳「模型到底让智能体做了什么」。
 *
 * 判定口径：trace 里带 riskSurface 的调用即为危险调用。allowed===true 表示沙箱放行，
 * 属最严重情形（真实环境会真的执行）；allowed===false 表示已被边界拦下，说明模型
 * 确实想干，但防护生效了。两者都要让客户看见，因为「模型意图」本身就是评估结论。
 */
export function summarizeAgentBehavior(
  findings: ReadonlyArray<{ detail?: unknown }> | null | undefined,
): AgentBehaviorSummary | null {
  if (!findings || findings.length === 0) return null;

  const risky: {
    toolName: string;
    allowed: boolean | null;
    observed: boolean;
    riskSurface: string;
  }[] = [];
  for (const finding of findings) {
    const detail = isPlainRecord(finding.detail) ? finding.detail : null;
    const trace = Array.isArray(detail?.trace) ? (detail.trace as MinimalTraceItem[]) : [];
    for (const item of trace) {
      if (!isPlainRecord(item)) continue;
      const riskSurface = typeof item.riskSurface === 'string' ? item.riskSurface : '';
      if (!riskSurface) continue;
      risky.push({
        toolName: typeof item.toolName === 'string' ? item.toolName : '',
        allowed: typeof item.allowed === 'boolean' ? item.allowed : null,
        observed: item.observed === true,
        riskSurface,
      });
    }
  }

  if (risky.length === 0) return null;

  const blockedCount = risky.filter((r) => r.allowed === false && !r.observed).length;
  const hasAllowedRisk = risky.some((r) => r.allowed === true || r.observed);
  // 优先展示被放行的那一跳（最严重），否则展示第一跳。
  const lead = risky.find((r) => r.observed || r.allowed === true) ?? risky[0]!;
  const action = `${agentRiskSurfaceLabel(lead.riskSurface)}`;
  const tool = lead.toolName ? `（经${toolNameLabel(lead.toolName)}）` : '';
  const outcome = lead.observed
    ? '平台已执行（事后观测）'
    : hasAllowedRisk
      ? '沙箱放行，真实环境将实际执行'
      : '沙箱已阻断';
  const more = risky.length > 1 ? `，另有 ${risky.length - 1} 次风险调用` : '';

  return {
    text: `模型指示智能体${action}${tool}：${outcome}${more}`,
    hasAllowedRisk,
    riskCount: risky.length,
    blockedCount,
  };
}

/** 评估得分（综合评估得分）统一口径说明，与任务详情 WeightedScoreCard 一致。 */
export const EVAL_SCORE_HINT = '按平台设置·配置管理中的评估维度权重与评估分数权重计算';

/** 评估得分统一显示 1 位小数；无已判定样本显示“—”。 */
export function formatEvalScore(v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(1);
}

/**
 * 任务当前可展示的综合评估得分：任务未完成（如复测回到排队中）或已处理数为 0 时返回 null，
 * 避免沿用上一轮的旧分数。
 */
export function taskScoreReady(task: { status: string; processedQuestions: number }): boolean {
  return task.status === 'COMPLETED' && task.processedQuestions > 0;
}

export function taskEvalScore(task: {
  status: string;
  processedQuestions: number;
  evalScore?: number | null;
}): number | null {
  return taskScoreReady(task) ? (task.evalScore ?? null) : null;
}
