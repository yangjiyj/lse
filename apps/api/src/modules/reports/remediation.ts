import type { Severity } from '@lse/shared';
import {
  resolveReportRiskDomain,
  isPrivacyMethodScenario,
  reportRiskTypeLabel,
  riskLabel,
  type ReportRiskLabelInput,
} from './labels.js';
import type { ReportFinding, ReportWrongAnswer } from './report-builder.js';
import type { ReportPortfolioRisk } from './report-risk-context.js';

export interface ReportRemediationItem {
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'UNKNOWN';
  title: string;
  riskCategoryLabel: string;
  evidence: string;
  action: string;
  verification: string;
  /** 工程整改分工，不替代法律责任认定。旧报告可缺省。 */
  responsibility?: string;
  /** 明确被测边界，防止将应用阻断写成基础模型修复。 */
  verificationScope?: string;
  status?: string | null;
  owner?: string | null;
  team?: string | null;
  controlLocation?: string | null;
  dueAt?: string | null;
  record?: string | null;
  retestTaskId?: string | null;
  acceptanceCriteria?: string | null;
  closureEvidence?: string | null;
  closedAt?: string | null;
}

interface RemediationInput {
  findings: ReportFinding[];
  wrongAnswers: ReportWrongAnswer[];
}

const SEVERITY_RANK: Record<Severity, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function priority(severity: Severity | null): ReportRemediationItem['priority'] {
  if (severity === null) return 'UNKNOWN';
  if (severity === 'CRITICAL' || severity === 'HIGH') return 'P0';
  if (severity === 'MEDIUM') return 'P1';
  return 'P2';
}

function severityRank(severity: Severity | null): number {
  return severity === null ? -1 : SEVERITY_RANK[severity];
}

function bestEvidence(finding: ReportFinding, wrongAnswers: ReportWrongAnswer[]): string {
  const related = wrongAnswers.find((w) => w.riskCategory === finding.riskCategory);
  return clean(
    related?.reason ??
      finding.evidence ??
      finding.title ??
      riskLabel(finding.riskCategory, finding.engine),
  );
}

function clean(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return '报告检出该类风险。';
  return s.length > 96 ? `${s.slice(0, 96)}...` : s;
}

/** 逐条整改建议的最小入参（finding 或 wrongAnswer 都能结构化适配）。 */
export interface RemediationFindingLike extends ReportRiskLabelInput {
  riskCategory: string;
  engine: string | null;
  title?: string | null;
  evidence?: string | null;
  remediationStatus?: string | null;
  remediationOwner?: string | null;
  remediationTeam?: string | null;
  remediationLocation?: string | null;
  remediationAction?: string | null;
  remediationDueAt?: Date | string | null;
  remediationRecord?: string | null;
  remediationAcceptanceCriteria?: string | null;
  remediationRetestTaskId?: string | null;
  remediationClosureEvidence?: string | null;
  remediationClosedAt?: Date | string | null;
}

type RemediationGuidance = Pick<
  ReportRemediationItem,
  'title' | 'action' | 'verification' | 'responsibility' | 'verificationScope'
>;

const APPLICATION_RESPONSIBILITY =
  '应用方确定使用范围并落实输入/输出护栏、数据与工具权限；接入平台实施网关和审批控制。第三方 API 的基础模型安全训练、权重与服务防护由供应商修复，应用方可升级或切换经验证的版本；自部署模型由模型维护方承担相应工作。评估平台保留证据、跟踪整改与复测。';
const APPLICATION_VERIFICATION_SCOPE =
  '固定模型版本、策略和测试条件，分别复测供应商 API（不含应用自有防护的裸模型端点）与完整应用。应用拦截有效不等于基础模型已修复；复测同时包含原样本、未参与整改的变体、多轮场景及正常业务误拦率。执行异常和待判定结果不计为通过。';

/** 同一分类器驱动汇总和逐项整改；防御措施不能依赖模型自行遵守授权。 */
export function remediationGuidance(finding: RemediationFindingLike): RemediationGuidance {
  const domain = resolveReportRiskDomain(finding);
  const guide = domainGuidance(finding);
  return {
    ...guide,
    ...(finding.remediationAction ? { action: finding.remediationAction } : {}),
    ...(finding.remediationAcceptanceCriteria
      ? { verification: finding.remediationAcceptanceCriteria }
      : {}),
    responsibility:
      finding.remediationOwner || finding.remediationTeam
        ? [finding.remediationOwner, finding.remediationTeam].filter(Boolean).join(' / ')
        : domain === 'component_vulnerability'
          ? '组件/部署维护方核实资产和受影响版本并修补；第三方托管资产由其供应商处置。评估平台复核扫描证据和修复结果。'
          : APPLICATION_RESPONSIBILITY,
    verificationScope: finding.remediationLocation
      ? `控制位置：${finding.remediationLocation}`
      : domain === 'component_vulnerability'
        ? '在同一受影响资产与组件版本上复扫并核验运行版本。模型在对话中描述漏洞不构成部署组件存在漏洞的证据，不能据此关闭内容安全风险。'
        : APPLICATION_VERIFICATION_SCOPE,
  };
}

function persistedRemediationFields(
  finding: RemediationFindingLike,
): Pick<
  ReportRemediationItem,
  | 'status'
  | 'owner'
  | 'team'
  | 'controlLocation'
  | 'dueAt'
  | 'record'
  | 'retestTaskId'
  | 'acceptanceCriteria'
  | 'closureEvidence'
  | 'closedAt'
> {
  const asIso = (value: Date | string | null | undefined): string | null | undefined =>
    value instanceof Date ? value.toISOString() : value;
  return {
    status: finding.remediationStatus,
    owner: finding.remediationOwner,
    team: finding.remediationTeam,
    controlLocation: finding.remediationLocation,
    dueAt: asIso(finding.remediationDueAt),
    record: finding.remediationRecord,
    retestTaskId: finding.remediationRetestTaskId,
    acceptanceCriteria: finding.remediationAcceptanceCriteria,
    closureEvidence: finding.remediationClosureEvidence,
    closedAt: asIso(finding.remediationClosedAt),
  };
}

function domainGuidance(
  finding: RemediationFindingLike,
): Pick<ReportRemediationItem, 'title' | 'action' | 'verification'> {
  const category = finding.riskCategory;
  const domain = resolveReportRiskDomain(finding);

  if (finding.engine === 'newapi-agent-security-gateway' || category === 'gateway_policy_event') {
    return {
      title: '闭环处置网关策略事件',
      action:
        '复核网关事件对应的真实用户权限和处置结果，将需阻断的告警放行事件改为阻断；输出内容在交付用户前检查，模型侧策略作为补充，特权操作由后端授权。',
      verification:
        '在网关侧重放或复测同类流量，核验实际内容放行和工具执行结果、异常分支及审计记录。',
    };
  }

  if (domain === 'component_vulnerability') {
    return {
      title: '修复组件与供应链风险',
      action:
        '先核实扫描命中的资产、组件和受影响版本；升级实际部署组件并复扫，对暂不能升级的项目记录缓解措施及剩余风险。',
      verification:
        '核验实际运行版本及扫描证据，确认对应漏洞已修复。书面接受剩余风险应单列，不能等同漏洞修复。',
    };
  }

  if (domain === 'system_prompt_leakage') {
    return {
      title: '核验提示词披露影响并外置安全控制',
      action:
        '核验是否披露真实秘密或造成越权；移除提示词中的密钥，将授权、额度和会话隔离放在模型外的代码中。仅披露普通指令不自动等同凭据泄露，提示词也不能作为保密或授权边界。',
      verification:
        '以合成秘密和越权请求复测，检查是否发生敏感数据披露或权限绕过；分别记录普通提示词复述与实际安全影响。',
    };
  }

  if (domain === 'privacy_leakage' && isPrivacyMethodScenario(finding)) {
    return {
      title: '限制隐私推断与去匿名化方法输出',
      action:
        '将去匿名化、跨源关联身份等请求纳入输入和输出内容策略，限制非授权个人画像；采用合成数据验证。当前方法或模拟样例不能直接认定已取得真实个人信息，需另核验证据。',
      verification:
        '用合成身份和留出的变体复测方法输出边界；分别记录方法风险与经验证的真实个人信息披露，不能把虚构号码或模拟匹配当成实际泄露。',
    };
  }

  if (domain === 'privacy_leakage') {
    const secret =
      category === 'sensitive_info_secret' ||
      /api[_ -]?key|secret|credential|password|凭据|密钥|私钥|访问令牌/i.test(
        [finding.evidence, finding.reason, finding.questionContent].filter(Boolean).join(' '),
      );
    return {
      title: secret ? '阻断凭据与密钥泄露' : '收敛个人信息输出边界',
      action:
        '先核实内容是否真实、来源及授权，排除合成数据误报；限制进入模型的敏感信息，按用户/租户控制检索权限，并在输出前阻断或脱敏。已确认泄露的凭据由持有方轮换并处置。',
      verification:
        '使用合成凭据或个人信息及跨用户场景复测，确认非授权数据不可取得、输出原文被阻断且允许业务正常；模拟内容和真实披露分别记证据。',
    };
  }

  if (
    domain === 'agent_tool_abuse' ||
    domain === 'ssrf_network_access' ||
    domain === 'data_exfiltration'
  ) {
    return {
      title: '约束智能体工具调用权限',
      action:
        '应用后端按真实用户权限实施工具允许清单、参数校验、网络地址与文件目录限制；凭据最小授权，高风险操作增加人工确认。网页、邮件和文档作为非可信输入隔离，不能由模型自行判定授权。',
      verification:
        '以合成工具输出、metadata IP、本地文件和环境变量场景复测；即使模型提出越权调用，后端也拒绝且无实际副作用，同时核验正常操作与审批不可绕过。',
    };
  }

  if (domain === 'cyber_abuse') {
    return {
      title: '限制网络滥用内容与操作能力',
      action:
        '对入侵、恶意代码和规避防护请求实施输入意图识别与输出审查，限制可操作内容并引导到授权防御场景；如接入工具，另做后端授权和最小权限。题目提到组件漏洞不代表应升级被测组件。',
      verification:
        '在合成网络场景中复测原样本和变体，检查用户实际收到的内容及工具副作用；正常防御问答仍可完成，不能用组件扫描替代内容安全复测。',
    };
  }

  if (domain === 'prompt_injection' || domain === 'rag_data_poisoning') {
    return {
      title:
        domain === 'rag_data_poisoning' ? '隔离不可信检索内容与访问权限' : '加固提示注入与指令隔离',
      action:
        '隔离系统指令、用户输入与外部内容，检索前校验数据权限，输出前审查敏感内容；工具权限由模型外代码强制执行。关键词、提示词调整、RAG 或微调均不能单独保证抵御注入。',
      verification:
        '复测直接/间接提示注入和多轮变体，验证实际数据披露、越权操作及内容放行结果；留出未参与整改的样本，不能只验证原攻击字符串被拦截。',
    };
  }

  if (domain === 'legal_compliance' || domain === 'harmful_capability') {
    return {
      title: domain === 'legal_compliance' ? '阻断禁止内容输出' : '补齐高风险意图识别与拦截策略',
      action:
        '应用方明确禁止或需要人工审核的业务场景，在调用前识别意图、输出前检查危险内容并提供安全替代建议；风险持续超出可接受范围时缩小场景、暂停能力或切换模型。',
      verification:
        '复测原样本、同类扩展及多轮请求，确认用户实际收到的回答不含被禁止的可操作内容，并核验正常业务误拦与人工审核流程。',
    };
  }

  if (finding.engine === 'garak' || finding.engine === 'pyrit' || category.startsWith('redteam_')) {
    return {
      title: '收敛红队发现的攻击面',
      action:
        '先核验完整攻击对话和模型响应，按实际内容、数据访问或工具行为确定风险；应用方补充相应护栏，基础模型缺陷向供应商提交脱敏证据，不能仅以攻击名称决定整改。',
      verification:
        '固定攻击预算复测原路径和未参与整改的变体，分别核验裸模型与完整应用，保留失败、拒答、异常和待复核记录。',
    };
  }

  if (category === 'llm_judge_fail') {
    return {
      title: '复核并研判待确认的高风险回答',
      action:
        '由安全负责人结合完整输入、响应和实际使用范围人工复核，区分误报、模拟风险与真实影响；明确整改责任及措施后再复测，未复核不能直接写成已确认泄露或越权。',
      verification:
        '复核完成后复测同批样本和留出的变体，确认风险缓解效果；书面风险接受与修复分别记录。',
    };
  }

  const label = riskLabel(category, finding.engine ?? undefined);
  return {
    title: /[一-鿿]/.test(label) ? '针对「' + label + '」补充回归用例' : '针对检出风险补充回归用例',
    action:
      '先复核本次响应的具体问题并明确应用场景，补充相应内容规则、事实核查或人工审核；将失败样本固化并保留未参与整改的验证集。',
    verification:
      '复测同类样本并抽样人工复核，检查风险输出与正常业务质量；记录仍存在的风险和适用范围，不以添加提示词作为修复证明。',
  };
}

export function buildRemediationItems(input: RemediationInput): ReportRemediationItem[] {
  if (input.findings.length === 0) return [];
  const byCategory = new Map<string, ReportFinding>();
  for (const finding of input.findings) {
    const key = remediationGroupKey(finding);
    const prev = byCategory.get(key);
    if (!prev || severityRank(finding.severity) > severityRank(prev.severity)) {
      byCategory.set(key, finding);
    }
  }

  return [...byCategory.values()]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, 8)
    .map((finding) => ({
      priority: priority(finding.severity),
      riskCategoryLabel: remediationCategoryLabel(finding, riskLabel),
      evidence: bestEvidence(finding, input.wrongAnswers),
      ...remediationGuidance(finding),
      ...persistedRemediationFields(finding),
    }));
}

function strictWrongAnswerReason(risk: ReportPortfolioRisk): string | null {
  const finding = risk.representative;
  const wrongAnswer = risk.context.wrongAnswer;
  if (
    !risk.resultId ||
    risk.findings.length !== 1 ||
    !wrongAnswer ||
    wrongAnswer.resultId !== risk.resultId ||
    wrongAnswer.riskCategory !== finding.riskCategory ||
    wrongAnswer.engine !== finding.engine
  ) {
    return null;
  }
  return wrongAnswer.reason ?? null;
}

function firstNonBlank(...values: Array<string | null | undefined>): string | undefined {
  return values.find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

type RiskCategoryLabeler = (code: string, engine?: string) => string;

export interface RiskRemediationOptions {
  categoryLabel?: RiskCategoryLabeler;
}

function riskEvidence(risk: ReportPortfolioRisk, categoryLabel: RiskCategoryLabeler): string {
  const finding = risk.representative;
  return clean(
    firstNonBlank(finding.evidence, strictWrongAnswerReason(risk), finding.title) ??
      categoryLabel(finding.riskCategory, finding.engine),
  );
}

/**
 * 从题级有效风险生成整改建议。
 * 调用方应传 activeRisks；函数仍防御性忽略没有有效 Finding 的风险。
 */
export function buildRemediationItemsFromRisks(
  risks: readonly ReportPortfolioRisk[],
  options: RiskRemediationOptions = {},
): ReportRemediationItem[] {
  const categoryLabel = options.categoryLabel ?? riskLabel;
  const byCategory = new Map<string, ReportPortfolioRisk>();
  for (const risk of risks) {
    if (risk.activeFindings.length === 0) continue;
    const finding = risk.representative;
    const key = remediationGroupKey(riskGuidanceInput(risk));
    const previous = byCategory.get(key);
    if (
      !previous ||
      severityRank(finding.severity) > severityRank(previous.representative.severity)
    ) {
      byCategory.set(key, risk);
    }
  }

  return [...byCategory.values()]
    .sort(
      (a, b) => severityRank(b.representative.severity) - severityRank(a.representative.severity),
    )
    .slice(0, 8)
    .map((risk) => {
      const finding = risk.representative;
      return {
        priority: priority(finding.severity),
        riskCategoryLabel: remediationCategoryLabel(riskGuidanceInput(risk), categoryLabel),
        evidence: riskEvidence(risk, categoryLabel),
        ...remediationGuidance(riskGuidanceInput(risk)),
        ...persistedRemediationFields(riskGuidanceInput(risk)),
      };
    });
}

function riskGuidanceInput(risk: ReportPortfolioRisk): RemediationFindingLike {
  return {
    ...risk.representative,
    questionContent: risk.context.questionContent,
    reason: risk.context.reason,
  };
}

function remediationGroupKey(finding: RemediationFindingLike): string {
  return [
    finding.riskCategory,
    resolveReportRiskDomain(finding),
    isPrivacyMethodScenario(finding),
  ].join(':');
}

function remediationCategoryLabel(
  finding: RemediationFindingLike,
  labeler: RiskCategoryLabeler,
): string {
  return /^llm_judge|^python_judge|^engine_error$/.test(finding.riskCategory) ||
    isPrivacyMethodScenario(finding)
    ? reportRiskTypeLabel(finding)
    : labeler(finding.riskCategory, finding.engine ?? undefined);
}
