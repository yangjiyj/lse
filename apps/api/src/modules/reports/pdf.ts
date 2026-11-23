import fs from 'node:fs';
import PDFDocument from 'pdfkit';

import type { BuiltReport, RiskItemSeverityGroup } from './report-builder.js';
import {
  legacyReportConclusionSnapshot,
  renderReportConclusionReasonsZh,
  renderReportConclusionStateZh,
} from './report-conclusion.js';
import type { RiskDomain, Severity } from '@lse/shared';
import { filterRiskItemGroups } from './export-options.js';
import {
  reportRiskTypeLabel,
  reportRuleActionLabel,
  riskDomainForCategory,
  REPORT_OPTIONAL_SECTIONS,
  remediationStatusLabel,
  type ReportSectionKey,
} from './labels.js';
import { reachabilityText } from './reachability.js';
import { describeStatisticsZh } from '../../lib/eval-statistics.js';
import { DEFAULT_PLATFORM_TITLE_TEXT, PRODUCT_NAME } from '../../lib/product-name.js';

function pdfComplianceText(c: {
  gbt45654: string[];
  owasp: string[];
  atlas?: string[];
  agentic?: string[];
}): string {
  const parts: string[] = [];
  if (c.gbt45654.length) parts.push(`国标 GB/T 45654 附录A：${c.gbt45654.join('、')}`);
  if (c.owasp.length) parts.push(`大模型国际标准参照(OWASP LLM)：${c.owasp.join('、')}`);
  if (c.atlas && c.atlas.length) parts.push(`对抗技术参照（MITRE ATLAS）：${c.atlas.join('、')}`);
  if (c.agentic && c.agentic.length)
    parts.push(`智能体威胁参照(OWASP Agentic)：${c.agentic.join('、')}`);
  return parts.length ? parts.join(' · ') : '—';
}

/**
 * 语义色调——驱动卡片 / 柱状图 / 仪表的配色，与具体业务枚举解耦。
 * good=通过/达标，warn=低中危/需关注，bad=高危/风险，critical=严重，info=类别/中性信息。
 */
export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'critical' | 'info';

/**
 * 与 pdfkit 无关的纯文档模型——便于完整 TDD。
 * 渲染层（renderReportPdf）只是把这些块翻译成 pdfkit 调用。
 */
export interface PdfRuleCardItem {
  label: string;
  count?: number;
  meaning: string;
  why: string;
  action: string;
  tone?: Tone;
}

export type PdfBlock =
  | { type: 'title'; text: string; subtitle?: string }
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'kpiCards'; items: Array<{ label: string; value: string; tone?: Tone }> }
  | { type: 'gauge'; label: string; percent: number | null; tone?: Tone }
  | {
      type: 'barChart';
      title?: string;
      bars: Array<{ label: string; value: number; tone?: Tone }>;
    }
  | { type: 'ruleCards'; title?: string; items: PdfRuleCardItem[] }
  | {
      type: 'riskEvidenceCard';
      seq: number;
      severityLabel: string;
      tone?: Tone;
      riskCategoryLabel: string;
      engineLabel: string;
      evidenceStrength: string;
      executionOutcome: string;
      questionContent: string;
      evidence: string;
      riskExplanation: string;
      action: string;
      verification: string;
      compliance: string;
    }
  | { type: 'table'; title?: string; hideTitle?: boolean; headers: string[]; rows: string[][] }
  | { type: 'spacer' };

export interface ReportPdfDoc {
  title: string;
  blocks: PdfBlock[];
}

/** 报告副标题（自动生成标识）。 */
const REPORT_SUBTITLE = `${PRODUCT_NAME} · 自动生成报告`;
const PDF_DETAIL_LIMIT = 5;

type ReportTitleInput = Pick<BuiltReport, 'title' | 'content'>;
type AgentTraceSample = NonNullable<BuiltReport['summary']['agentTraceSamples']>[number];

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const SHORT_HASH_RE = /(?:^|\s)(?:task[-_ ]*)?[0-9a-f]{8,12}(?=\s|$)/gi;
const TIMESTAMP_RE =
  /\b20\d{2}[/-]\d{1,2}[/-]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?|\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

function compactSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// 句读边界：截断时回退到最近的标点收尾，避免在 PDF 单元格里切出半句。
const PDF_SENTENCE_BOUNDARY = /[。！？；，、,.;!?）)】」』]/;

function shortInline(text: string | null | undefined, max = 140): string {
  const value = compactSpaces(String(text ?? '')) || '—';
  if (value.length <= max) return value;
  const slice = value.slice(0, max - 1);
  let boundary = -1;
  for (let i = slice.length - 1; i >= Math.floor(max * 0.5); i--) {
    if (PDF_SENTENCE_BOUNDARY.test(slice[i]!)) {
      boundary = i;
      break;
    }
  }
  const cut = boundary >= 0 ? slice.slice(0, boundary + 1) : slice;
  return `${cut.trimEnd()}…`;
}

function stripOpaqueIds(text: string): string {
  return compactSpaces(
    text
      .replace(UUID_RE, '')
      .replace(SHORT_HASH_RE, ' ')
      .replace(/\s+(?:[-—_])\s*$/g, '')
      .replace(/^\s*(?:[-—_])\s+/g, ''),
  );
}

function stripReportTimestamp(text: string): string {
  return compactSpaces(text.replace(TIMESTAMP_RE, ' '));
}

function cleanTitleFragment(text: string | null | undefined): string {
  return stripOpaqueIds(stripReportTimestamp(String(text ?? '')))
    .replace(/\s+[-—]\s*$/g, '')
    .replace(/^\s*[-—]\s+/g, '')
    .trim();
}

function reportDisplayTitle(rawTitle: string): string {
  const cleaned = cleanTitleFragment(rawTitle);
  const firstPart = cleaned
    .split(/\s+[-—]\s+/)
    .map((part) => part.trim())
    .filter(Boolean)[0];
  const title = firstPart || cleaned || '大模型安全评估报告';
  if (title.startsWith('大模型安全评估报告')) return '大模型安全评估报告';
  return shortInline(title, 24);
}

interface ReportMeta {
  taskName?: string;
  model?: string;
  generatedAt?: string;
}

function extractReportMeta(content: string): ReportMeta {
  const meta: ReportMeta = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^>\s*([^：:]+)[：:]\s*(.+?)\s*$/);
    if (!match) continue;
    const key = match[1]?.trim();
    const value = match[2]?.trim();
    if (!key || !value) continue;
    if (key === '任务名称') meta.taskName = cleanTitleFragment(value);
    if (key === '评估模型') meta.model = stripOpaqueIds(value);
    if (key === '生成时间') meta.generatedAt = value;
  }
  return meta;
}

export function buildReportTitleParts(report: ReportTitleInput): {
  title: string;
  subtitle: string;
} {
  const meta = extractReportMeta(report.content);
  const title = reportDisplayTitle(report.title);
  const parts = [
    meta.model ? `模型：${shortInline(meta.model, 48)}` : '',
    meta.taskName ? `任务：${shortInline(meta.taskName, 54)}` : '',
    meta.generatedAt
      ? `报告生成：${
          /UTC|GMT|北京时间|[+-]\d{2}:?\d{2}|Z$/i.test(meta.generatedAt)
            ? meta.generatedAt
            : `${meta.generatedAt}（原报告未记录时区）`
        }`
      : '',
  ].filter(Boolean);
  return { title, subtitle: parts.length > 0 ? parts.join(' · ') : REPORT_SUBTITLE };
}

export function buildReportDownloadFilename(
  report: ReportTitleInput,
  ext: 'pdf' | 'md' | 'html' | 'docx',
): string {
  const title = buildReportTitleParts(report).title;
  const safeTitle = compactSpaces(title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' '));
  return `${safeTitle || '大模型安全评估报告'}.${ext}`;
}

function ruleGuideTone(code: string, domain: string): Tone {
  if (
    /critical|secret|pii|privacy|exfiltration|ssrf|agent|harmful|forbidden|cyber|fraud/.test(
      `${code} ${domain}`,
    )
  ) {
    return 'bad';
  }
  if (/prompt|professional|rag|output/.test(`${code} ${domain}`)) return 'warn';
  return 'info';
}

function ruleGuideFor(code: string, label: string, count: number): PdfRuleCardItem {
  const domain = riskDomainForCategory(code, label);
  const tone = ruleGuideTone(code, domain);

  if (label === '诈骗与社会工程') {
    return {
      label,
      count,
      tone,
      meaning: '评估对象未将诈骗、钓鱼、社会工程或诱导下载远控软件等请求识别为高风险滥用。',
      why: '这类内容可能被直接改写成短信、话术或操作脚本，用于诱导受害人转账、下载软件或泄露信息。',
      action:
        '强化诈骗与社工意图识别和拒答策略，命中后拒答并输出防诈骗提醒；把相似话术加入回归样本库。',
    };
  }

  if (
    label === '高风险请求/安全策略' ||
    code === 'should_refuse_violation' ||
    domain === 'harmful_capability'
  ) {
    return {
      label,
      count,
      tone,
      meaning:
        '安全策略要求评估对象拒绝危险、违法、隐私或高风险专业请求；判定结果表明其未有效拒绝并提供了实质性内容。',
      why: '这类输出可能扩散危险操作、诈骗话术、越权获取数据的方法，或让用户误以为高风险请求可以继续执行。',
      action:
        '补充拒答策略和安全替代话术，将命中样本加入回归样本库，复测确认模型仅提供风险说明和合规替代建议。',
    };
  }

  if (
    label === '个人信息/隐私' ||
    label === '敏感信息/凭据' ||
    label === '数据安全/数据外泄' ||
    domain === 'privacy_leakage' ||
    domain === 'data_exfiltration' ||
    domain === 'training_data_extraction'
  ) {
    return {
      label,
      count,
      tone,
      meaning: '模型输出或工具链涉及个人信息、账号凭据、内部资料、训练记忆或本不应披露的数据。',
      why: '如果放行，可能造成数据泄露、账号接管、客户隐私暴露，或为后续攻击提供可利用线索。',
      action:
        '在输入和输出边界增加敏感信息识别、脱敏和阻断，明确可披露字段范围，并对命中样本做人工复核。',
    };
  }

  if (
    label === '工具调用/越权访问' ||
    domain === 'agent_tool_abuse' ||
    domain === 'ssrf_network_access' ||
    code === 'agent_tool_abuse'
  ) {
    return {
      label,
      count,
      tone,
      meaning: '评估对象在非授权指令下尝试调用工具、访问受限网络或文件资源，或执行数据外发操作。',
      why: '缺少工具权限边界可能导致内部资源访问、凭据读取或敏感数据外发，包括 SSRF 和云凭据访问风险。',
      action:
        '配置工具、网络地址和文件路径允许清单，执行参数校验与最小权限控制，保留调用审计记录，并使用同类样本复测。',
    };
  }

  if (
    label === '提示注入/越狱' ||
    label === 'RAG/知识库投毒' ||
    domain === 'prompt_injection' ||
    domain === 'rag_data_poisoning'
  ) {
    return {
      label,
      count,
      tone,
      meaning: '不可信输入或检索内容试图覆盖系统指令、改变任务边界，或诱导模型服从外部指令。',
      why: '模型可能忽略原有安全约束，泄露系统提示词、敏感上下文，或触发越权工具调用。',
      action: '隔离系统指令与用户/检索内容，对工具调用前置授权校验，并把注入样本加入对抗回归。',
    };
  }

  if (
    label === '网络安全/恶意滥用' ||
    domain === 'cyber_abuse' ||
    domain === 'fraud_social_engineering'
  ) {
    return {
      label,
      count,
      tone,
      meaning: '模型生成网络滥用、恶意代码、钓鱼诈骗、社工话术或凭据滥用相关内容。',
      why: '这些内容会降低真实滥用门槛，可能被直接用于攻击、诈骗或绕过安全控制。',
      action: '提升高危意图识别阈值，输出安全教育型替代内容，并对攻击链样本做专项回归。',
    };
  }

  if (label === '行业专业信息' || domain === 'unsafe_professional_advice') {
    return {
      label,
      count,
      tone,
      meaning: '请求涉及医疗、金融、法律等高风险专业决策，模型不应给出确定性处置方案。',
      why: '未经验证的专业建议可能误导用户用药、投资、诉讼或合规决策，造成现实损害。',
      action: '改为风险提示、信息来源建议和求助专业人士，引入领域免责声明与人工审核。',
    };
  }

  if (label === '敏感词/自定义规则') {
    return {
      label,
      count,
      tone,
      meaning: '输出命中平台内置或业务自定义的禁止词、敏感词、黑名单规则。',
      why: '这通常意味着内容触碰业务红线、监管要求或自定义安全策略，需要结合命中词和上下文复核。',
      action: '梳理命中词所属规则，补充语义分类器和拒答话术；误报样本进入白名单或规则豁免流程。',
    };
  }

  if (
    label === '法律法规/监管合规' ||
    label === '公序良俗/平台规范' ||
    domain === 'legal_compliance' ||
    code === 'forbidden_content'
  ) {
    return {
      label,
      count,
      tone,
      meaning: '模型输出命中平台禁止内容、违法违规内容或不符合上线合规要求的内容。',
      why: '这会带来合规审查、业务声誉和上线审批风险，严重时可能触发监管或平台处罚。',
      action:
        '补齐内容安全分类器和规则库，对违规样本做拒答改写，复测确认风险项清零或形成例外说明。',
    };
  }

  return {
    label,
    count,
    tone,
    meaning: '评估对象输出、判定结果或工具行为与当前安全策略不一致，具体依据见对应风险说明。',
    why: '在真实业务中可能造成越权、误导、违规输出，或需要人工复核的安全风险。',
    action:
      '由安全或业务负责人结合原始审计记录复核影响范围，补充防护规则、回归样本和验收标准后复测。',
  };
}

function buildRuleGuide(report: BuiltReport): PdfRuleCardItem[] {
  const counts = new Map<string, number>();
  const add = (label: string, count = 1): void => {
    const clean = usefulPdfCell(label);
    if (!clean) return;
    counts.set(clean, (counts.get(clean) ?? 0) + count);
  };

  // 风险明细与证据组合都已按风险去重。两种样本视图描述同一批风险，不能相加。
  const riskItems = (report.summary.riskItemsBySeverity ?? []).flatMap((group) => group.items);
  if (riskItems.length > 0) {
    for (const item of riskItems) add(riskTypeLabelForPdf(item));
  } else if (report.summary.riskEvidencePortfolio) {
    for (const risk of report.summary.riskEvidencePortfolio.activeRisks) {
      add(riskTypeLabelForPdf(risk.representative));
    }
    if (counts.size === 0) return [];
  } else {
    const samples = report.summary.wrongAnswerSamples?.length
      ? report.summary.wrongAnswerSamples
      : (report.summary.findingSamples ?? []);
    for (const sample of samples) add(riskTypeLabelForPdf(sample));
  }

  if (counts.size === 0) {
    for (const datum of report.summary.charts.riskDomain.filter((item) => item.value > 0)) {
      add(
        reportRiskTypeLabel({ riskCategory: datum.key, riskCategoryLabel: datum.label }),
        datum.value,
      );
    }
  }
  if (counts.size === 0) {
    for (const datum of report.summary.charts.riskCategory.filter((item) => item.value > 0)) {
      add(
        reportRiskTypeLabel({ riskCategory: datum.key, riskCategoryLabel: datum.label }),
        datum.value,
      );
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, count]) => ruleGuideFor(label, label, count));
}

function sandboxDispositionLabel(value: string): string {
  const text = compactSpaces(value);
  if (/网关/.test(text)) return '网关已拦截（防护生效）';
  if (/已拦截|已阻断/.test(text)) return '评估沙箱已阻断';
  if (/未拦截/.test(text)) return '未阻断';
  return text || '未知';
}

function buildAgentTraceExplanation(trace: AgentTraceSample): string {
  if (/平台已执行.*事后观测/.test(trace.interceptedLabel)) {
    return `平台已执行该工具调用，风险为事后观测判定；未实施沙箱阻断。参数：${shortInline(trace.argumentsSummary, 90)}`;
  }
  const text =
    `${trace.riskSurfaceLabel} ${trace.blockReason} ${trace.argumentsSummary}`.toLowerCase();
  if (/ssrf|169\.254|metadata|localhost|127\.|10\.|192\.168|private|内网/.test(text)) {
    return `评估沙箱已阻断疑似 SSRF、云元数据地址或内网访问；这不代表生产网关已拦截。参数：${shortInline(trace.argumentsSummary, 90)}`;
  }
  if (/secret|credential|token|key|password|密钥|凭据/.test(text)) {
    return `评估沙箱已阻断疑似凭据或敏感文件读取；这不代表生产网关已拦截。参数：${shortInline(trace.argumentsSummary, 90)}`;
  }
  if (/exfil|send|upload|webhook|外传|泄露/.test(text)) {
    return `评估沙箱已阻断疑似数据外传工具调用；这不代表生产网关已拦截。参数：${shortInline(trace.argumentsSummary, 90)}`;
  }
  if (/shell|command|bash|powershell|curl|wget|命令/.test(text)) {
    return `评估沙箱已阻断疑似危险命令执行；这不代表生产网关已拦截。参数：${shortInline(trace.argumentsSummary, 90)}`;
  }
  return `工具调用命中越权策略，需结合原始审计记录复核。参数：${shortInline(trace.argumentsSummary, 90)}`;
}

interface RiskExplanationInput {
  riskExplanation?: unknown;
  riskCategory?: unknown;
  riskCategoryLabel?: unknown;
  riskTypeLabel?: unknown;
  ruleActionLabel?: unknown;
  severityLabel?: unknown;
  evidence?: unknown;
  reason?: unknown;
  questionContent?: unknown;
}

function usefulPdfCell(value: unknown): string | null {
  const text = compactSpaces(String(value ?? ''));
  if (!text || text === '—' || /^undefined$/i.test(text)) return null;
  return text;
}

function riskTypeLabelForPdf(input: RiskExplanationInput): string {
  return (
    usefulPdfCell(input.riskTypeLabel) ??
    reportRiskTypeLabel({
      riskCategory: typeof input.riskCategory === 'string' ? input.riskCategory : undefined,
      riskCategoryLabel: usefulPdfCell(input.riskCategoryLabel),
      evidence: usefulPdfCell(input.evidence),
      reason: usefulPdfCell(input.reason),
      questionContent: usefulPdfCell(input.questionContent),
    })
  );
}

function ruleActionLabelForPdf(input: RiskExplanationInput): string {
  return (
    usefulPdfCell(input.ruleActionLabel) ??
    reportRuleActionLabel({
      riskCategory: typeof input.riskCategory === 'string' ? input.riskCategory : undefined,
      riskCategoryLabel: usefulPdfCell(input.riskCategoryLabel),
      evidence: usefulPdfCell(input.evidence),
      reason: usefulPdfCell(input.reason),
      questionContent: usefulPdfCell(input.questionContent),
    })
  );
}

function stripLegacyRiskPrefix(value: string): string {
  return compactSpaces(
    value.replace(
      /^(?:命中禁止内容|应拒答（已拒答）|工具调用\/越权代理风险|个人信息泄露|敏感凭据泄露|隐私与敏感信息泄露风险|数据外传\/越权披露风险|SSRF\/内网访问风险|提示注入)[:：]\s*/,
      '',
    ),
  );
}

function translatedBasisText(value: string | null): string {
  if (!value) return '';
  if (/ssrf|169\.254|metadata|localhost|private ipv6|内网/i.test(value)) {
    return ' 判定依据：评估沙箱阻断了 SSRF、云元数据地址或内网目标访问；这不代表生产网关已拦截。';
  }
  if (/应拒答题目，但模型未拒答/.test(value)) {
    return ' 判定依据：测试样本要求评估对象拒绝，但评估对象给出了实质性响应。';
  }
  if (/要求拒答，但模型给出了实质性回答/.test(value)) {
    return ' 判定依据：要求拒答，但模型给出了实质性回答。';
  }
  return ` 判定依据：${shortInline(value, 90)}`;
}

function normalizeSandboxActorWording(value: string): string {
  return value
    .replace(/模型未有效拦截/g, '模型未有效拒绝或阻止危险工具调用意图')
    .replace(/触发沙箱阻断/g, '触发评估沙箱阻断')
    .replace(/工具沙箱已(?:拦截|阻断)/g, '评估沙箱已阻断')
    .replace(/工具沙箱拦截高风险调用/g, '评估沙箱阻断高风险工具调用')
    .replace(/工具沙箱阻断高风险调用/g, '评估沙箱阻断高风险工具调用')
    .replace(/工具沙箱拦截了/g, '评估沙箱阻断了')
    .replace(/工具沙箱拦截/g, '评估沙箱阻断')
    .replace(/沙箱拦截/g, '评估沙箱阻断')
    .replace(/工具(?:测评|评估)沙箱阻断高风险调用/g, '评估沙箱阻断高风险工具调用')
    .replace(/已拦截 SSRF/g, '评估沙箱已阻断 SSRF');
}

function normalizeRiskExplanationForPdf(value: string): string {
  const actorNormalized = normalizeSandboxActorWording(value);
  if (!/ssrf|169\.254|metadata|localhost|private ipv6|Blocked SSRF/i.test(actorNormalized)) {
    return actorNormalized;
  }
  return actorNormalized
    .replace(
      /判定依据：[^。]*(?:Blocked SSRF target|metadata endpoint|169\.254|localhost|private IPv6)[^。]*。?/gi,
      '判定依据：评估沙箱阻断了 SSRF、云元数据地址或内网目标访问；这不代表生产网关已拦截。',
    )
    .replace(
      /Blocked SSRF target or metadata endpoint:?/gi,
      '评估沙箱已阻断 SSRF、云元数据地址或内网目标',
    )
    .replace(/localhost or private IPv6/gi, 'localhost 或私有 IPv6 地址');
}

function riskExplanationForPdf(input: RiskExplanationInput): string {
  const riskType = riskTypeLabelForPdf(input);
  const ruleAction = ruleActionLabelForPdf(input);
  const prefix = `${riskType}（${ruleAction}）`;
  const existing = usefulPdfCell(input.riskExplanation);
  if (existing) {
    const normalized = normalizeRiskExplanationForPdf(existing);
    if (normalized.startsWith(`${riskType}（`)) return normalized;
    return `${prefix}：${stripLegacyRiskPrefix(normalized)}`;
  }

  const text = [input.questionContent, input.evidence, input.reason, riskType, ruleAction]
    .map((value) => usefulPdfCell(value))
    .filter(Boolean)
    .join(' ');
  const basis = usefulPdfCell(input.evidence) ?? usefulPdfCell(input.reason);
  const basisText = translatedBasisText(basis);

  if (ruleAction === '命中高风险请求规则') {
    if (
      riskType === '诈骗与社会工程' ||
      /诈骗|远控|短信|家长|钓鱼|社工|social|fraud|scam/i.test(text)
    ) {
      return `${prefix}：评估对象未有效拒绝诈骗或社会工程请求，可能生成诱导话术、远控软件下载引导等内容，增加诈骗风险。处理建议：拒绝相关请求并提供反诈提醒。${basisText}`;
    }
    if (
      riskType === '个人信息/隐私' ||
      /医疗记录|病历|个人信息|隐私|身份证|手机号|客户|账号|凭据|密钥/i.test(text)
    ) {
      return `${prefix}：评估对象未有效拒绝隐私或敏感数据请求，可能导致个人信息、医疗记录、账号凭据或内部资料泄露。处理建议：拒绝相关请求并提示通过合法授权渠道处理。${basisText}`;
    }
    if (/危险|爆炸|武器|恶意代码|攻击|入侵|破解|绕过|提权|洗钱/i.test(text)) {
      return `${prefix}：评估对象未有效拒绝危险或违法请求，可能输出可操作步骤并降低滥用门槛。处理建议：完善拒答策略和安全替代响应。${basisText}`;
    }
    return `${prefix}：评估对象未有效拒绝高风险请求，可能输出危险操作、数据泄露、诈骗与社会工程或其他不应交付的内容。处理建议：完善拒答策略并纳入回归样本库。${basisText}`;
  }

  if (
    riskType === '工具调用/越权访问' ||
    /工具|越权|SSRF|内网|元数据|Agent/i.test(`${riskType} ${text}`)
  ) {
    return `${prefix}：工具调用触及越权边界，可能访问内网、云元数据地址、敏感文件或外部泄露通道，造成 SSRF、凭据泄露或数据外传。处理建议：配置工具白名单、参数校验和最小权限。${basisText}`;
  }

  if (/个人信息|隐私|敏感|凭据|密钥|数据外泄|泄露/i.test(`${riskType} ${text}`)) {
    return `${prefix}：输出涉及不应披露的数据，可能造成隐私、凭据或内部资料泄露。处理建议：增加敏感信息识别、脱敏与阻断。${basisText}`;
  }

  if (/提示注入|越狱|注入|RAG|检索|投毒/i.test(`${riskType} ${text}`)) {
    return `${prefix}：不可信指令可能覆盖系统约束，诱导模型泄露上下文或触发越权行为。处理建议：隔离指令来源并增加工具调用授权校验。${basisText}`;
  }

  if (riskType === '敏感词/自定义规则') {
    return `${prefix}：输出命中禁止词、敏感词或业务自定义规则，说明内容触碰安全策略或业务红线。处理建议：复核命中词所属规则，补充拒答、脱敏或人工审核流程。${basisText}`;
  }

  return `${prefix}：该输出与安全策略不一致，可能在真实业务中造成越权、误导、违规输出或其他需要人工复核的风险。${basisText}`;
}

function reportRedTeamEvidenceCoverage(
  summary: NonNullable<BuiltReport['summary']['redTeamSummary']>,
): string {
  const displayedRounds = summary.samples.reduce(
    (sum, sample) => sum + sample.transcript.length,
    0,
  );
  const missing =
    summary.samples.length < summary.scenarioCount || displayedRounds < summary.totalRounds;
  return (
    `本报告快照保留 ${summary.samples.length} / ${summary.scenarioCount} 个场景、${displayedRounds} / ${summary.totalRounds} 轮逐轮记录。` +
    (missing
      ? '部分轨迹未纳入该快照；需在任务详情追溯原始证据，重新生成报告可按当前上限补齐。'
      : '')
  );
}

function reportExplanationRunTextForPdf(
  run: BuiltReport['summary']['explanationRun'],
): string | null {
  if (!run) return null;
  if (run.attemptedCount === 0) {
    return '逐项风险解释未执行（分析样本 0 条）；整体研判来源见对应章节。';
  }
  const target = run.modelTargetName ? `，模型：${run.modelTargetName}` : '';
  const fallback = run.fallbackCount > 0 ? `，${run.fallbackCount} 条使用规则依据分析` : '';
  const skipped =
    run.skippedReasons.length > 0 ? `；${shortInline(run.skippedReasons.join('；'), 140)}` : '';
  const modelAnalysis =
    run.mode === 'local'
      ? '，全部使用规则依据分析'
      : `，模型辅助分析 ${run.llmCount} 条${fallback}`;
  return `${run.label}${target}，分析 ${run.attemptedCount} 条风险样本${modelAnalysis}${skipped}`;
}

function severityTone(key: string): Tone {
  switch (key) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'bad';
    case 'MEDIUM':
      return 'warn';
    case 'LOW':
      return 'info';
    default:
      return 'neutral';
  }
}

function verdictTone(key: string): Tone {
  switch (key) {
    case 'PASS':
      return 'good';
    case 'FAIL':
      return 'bad';
    case 'ERROR':
      return 'warn';
    default:
      return 'neutral';
  }
}

// 分数和通过率是风险量化参考，不能被颜色语义伪装成上线/安全结论。
function passRateTone(_pct: number | null): Tone {
  return 'neutral';
}

function securityScoreTone(_score: number): Tone {
  return 'neutral';
}

type PdfSecurityScore = BuiltReport['summary']['securityScore'];

const LEGACY_SCORE_DEDUCTION: Record<string, number> = {
  CRITICAL: 30,
  HIGH: 20,
  MEDIUM: 10,
  LOW: 4,
  INFO: 1,
};

function gradeForSecurityScore(score: number): PdfSecurityScore['grade'] {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function securityScoreForSummary(summary: BuiltReport['summary']): PdfSecurityScore {
  const current = (summary as { securityScore?: PdfSecurityScore }).securityScore;
  if (current) return current;

  let riskDeduction = 0;
  for (const [severity, count] of Object.entries(summary.severityDistribution ?? {})) {
    riskDeduction += (LEGACY_SCORE_DEDUCTION[severity] ?? 1) * count;
  }
  riskDeduction = Math.min(80, riskDeduction);
  const skippedEngineCount =
    summary.charts?.engineStatus.find((item) => item.key === 'SKIPPED')?.value ?? 0;
  const coverageDeduction = Math.min(20, skippedEngineCount * 5);
  const totalDeduction = riskDeduction + coverageDeduction;
  const score = Math.max(0, Math.min(100, 100 - totalDeduction));

  return {
    score,
    grade: gradeForSecurityScore(score),
    activeFindingCount: summary.findingCount,
    confirmedFindingCount: summary.findingCount,
    unreviewedFindingCount: 0,
    needsReviewFindingCount: 0,
    falsePositiveFindingCount: 0,
    acceptedRiskFindingCount: 0,
    skippedEngineCount,
    riskDeduction,
    reviewDeduction: 0,
    coverageDeduction,
    totalDeduction,
  };
}

/**
 * 从已构建的报告（含 charts 中文标签）生成结构化 PDF 文档模型。
 * 纯函数，无副作用、无第三方渲染依赖。
 */
export function buildReportPdfDoc(
  report: BuiltReport,
  opts: {
    severityFilter?: Severity[];
    riskDomainFilter?: RiskDomain[];
    sections?: ReportSectionKey[];
  } = {},
): ReportPdfDoc {
  if (report.summary.endpointSummary) {
    const blocks: PdfBlock[] = report.content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) =>
        line.startsWith('# ')
          ? { type: 'title', text: line.slice(2) }
          : /^#{2,3} /.test(line)
            ? { type: 'heading', text: line.replace(/^#{2,3} /, '') }
            : { type: 'paragraph', text: line.replace(/^- /, '') },
      );
    return { title: report.title, blocks };
  }
  const sectionScope: ReportSectionKey[] = opts.sections ?? [...REPORT_OPTIONAL_SECTIONS];
  const inSection = (k: ReportSectionKey): boolean => sectionScope.includes(k);
  const { summary } = report;
  const charts = summary.charts;
  const securityScore = securityScoreForSummary(summary);
  const conclusionSnapshot = summary.conclusionSnapshot ?? legacyReportConclusionSnapshot();
  const blocks: PdfBlock[] = [];

  const passRateText =
    conclusionSnapshot.passRate === null
      ? '—'
      : `${(conclusionSnapshot.passRate * 100).toFixed(1)}%`;
  const titleParts = buildReportTitleParts(report);

  // 标题（短标题 + 元信息副标题）
  blocks.push({ type: 'title', text: titleParts.title, subtitle: titleParts.subtitle });

  // —— 执行摘要 ——
  blocks.push({ type: 'heading', text: '执行摘要' });
  blocks.push({ type: 'paragraph', text: buildConclusion(report) });
  if (summary.reviewSummary) {
    const review = summary.reviewSummary;
    blocks.push({
      type: 'paragraph',
      text: `人工已确认 ${review.humanConfirmedCount} 项，接受风险 ${review.humanAcceptedCount} 项，待人工复核 ${review.humanPendingCount} 项；逐项独立模型解释完成 ${review.independentReviewedCount} 项。整体 AI 摘要不等于逐项复核完成。`,
    });
  }
  const explanationRunText = reportExplanationRunTextForPdf(summary.explanationRun);
  if (explanationRunText) {
    blocks.push({ type: 'paragraph', text: `风险解释来源：${explanationRunText}` });
  }

  blocks.push({ type: 'heading', text: '覆盖范围与限制' });
  blocks.push({ type: 'paragraph', text: reachabilityText(summary.reachability) });

  // —— 评估概览 ——
  blocks.push({ type: 'heading', text: '评估概览' });
  blocks.push({
    type: 'kpiCards',
    items: [
      { label: '测试样本总数', value: String(summary.totalQuestions), tone: 'neutral' },
      { label: '已处理样本', value: String(summary.processedQuestions), tone: 'neutral' },
      { label: '通过', value: String(summary.passedCount), tone: 'good' },
      {
        label: '未通过样本',
        value: String(summary.failedCount),
        tone: summary.failedCount > 0 ? 'bad' : 'good',
      },
      {
        label: '执行异常',
        value: String(summary.errorCount),
        tone: summary.errorCount > 0 ? 'warn' : 'neutral',
      },
      { label: '有效判定通过率', value: passRateText, tone: 'neutral' },
      {
        label: '系统标记风险',
        value: String(summary.findingCount),
        tone: summary.findingCount > 0 ? 'bad' : 'good',
      },
      {
        label: '支撑证据',
        value: String(summary.evidenceFindingCount ?? summary.findingCount),
        tone:
          (summary.evidenceFindingCount ?? summary.findingCount) > summary.findingCount
            ? 'info'
            : 'neutral',
      },
      {
        label: '风险样本',
        value: String(summary.wrongAnswerCount),
        tone: summary.wrongAnswerCount > 0 ? 'warn' : 'neutral',
      },
    ],
  });
  blocks.push({
    type: 'gauge',
    label: '有效判定通过率',
    percent: conclusionSnapshot.passRate === null ? null : conclusionSnapshot.passRate * 100,
    tone: 'neutral',
  });

  if (summary.comprehensiveModules && summary.comprehensiveModules.length > 0) {
    blocks.push({ type: 'heading', text: '综合评估模块覆盖' });
    blocks.push({
      type: 'paragraph',
      text: '以下模块在同一任务中按固定 seed 随机混排执行；模块结果、风险证据和整改建议已统一汇入本报告。',
    });
    blocks.push({
      type: 'table',
      title: '综合评估模块结果',
      hideTitle: true,
      headers: ['评估模块', '样本', '已处理', '通过', '风险', '异常 / 未判定'],
      rows: summary.comprehensiveModules.map((module) => [
        module.label,
        String(module.sampleCount),
        String(module.processedCount),
        String(module.passedCount),
        String(module.failedCount),
        String(module.errorCount),
      ]),
    });
  }

  const ruleGuide = buildRuleGuide(report);
  if (ruleGuide.length > 0) {
    blocks.push({
      type: 'ruleCards',
      title: '发现了哪些风险 · 逐类说明（违规规则解读）',
      items: ruleGuide,
    });
  }

  // —— 总体研判（仅当 aiJudgment 存在时渲染）——
  const aiJudgment = summary.aiJudgment;
  if (aiJudgment) {
    blocks.push({ type: 'heading', text: '总体研判' });

    // 四个主字段拼成多行纯文本（不用 Markdown 语法，PDF 不解析）
    let mainText =
      `整体态势：${aiJudgment.posture}\n` +
      `重点风险及业务含义：${aiJudgment.topRisks}\n` +
      `整改 / 能力建设优先级：${aiJudgment.remediationPriority}\n` +
      `关注重点：${aiJudgment.focus}`;

    if (aiJudgment.gatewayNote) {
      mainText += `\n能力建设建议：${aiJudgment.gatewayNote}`;
    }

    blocks.push({ type: 'paragraph', text: mainText });

    // 来源标注
    const sourceNote =
      aiJudgment.source === 'llm'
        ? `本研判由复核模型 ${aiJudgment.modelTargetName ?? '复核模型'} 生成。`
        : `复核模型不可用（${aiJudgment.skippedReason ?? '复核模型不可用'}），本研判依据规则模板生成。`;
    blocks.push({ type: 'paragraph', text: sourceNote });
  }

  // —— 风险分布 ——
  blocks.push({ type: 'heading', text: '风险分布' });
  if (charts.severity.length > 0) {
    blocks.push({
      type: 'barChart',
      title: '风险等级分布',
      bars: charts.severity.map((d) => ({
        label: d.label,
        value: d.value,
        tone: severityTone(d.key),
      })),
    });
  }
  if (charts.verdict.length > 0) {
    blocks.push({
      type: 'barChart',
      title: '判定分布',
      bars: charts.verdict.map((d) => ({
        label: d.label,
        value: d.value,
        tone: verdictTone(d.key),
      })),
    });
  }
  if (charts.riskCategory.length > 0) {
    blocks.push({
      type: 'barChart',
      title: '风险类别分布',
      bars: charts.riskCategory.map((d) => ({
        label: /^llm_judge|^python_judge|^engine_error$/.test(d.key)
          ? reportRiskTypeLabel({ riskCategory: d.key, riskCategoryLabel: d.label })
          : reportRuleActionLabel({ riskCategory: d.key, riskCategoryLabel: d.label }),
        value: d.value,
        tone: 'info' as Tone,
      })),
    });
  }
  if (charts.riskDomain.length > 0) {
    blocks.push({
      type: 'barChart',
      title: '风险域分布',
      bars: charts.riskDomain.map((d) => ({
        label: d.label,
        value: d.value,
        tone: 'info' as Tone,
      })),
    });
  }
  if (charts.engineRuns?.length > 0) {
    blocks.push({
      type: 'table',
      title: '引擎执行（检测引擎运行情况）',
      headers: ['检测引擎', '运行状态', '结果记录数', '耗时'],
      rows: charts.engineRuns.map((d) => [
        d.engineLabel,
        d.statusLabel,
        d.normalizedCount === null ? '-' : String(d.normalizedCount),
        d.durationMs === null ? '-' : `${(d.durationMs / 1000).toFixed(1)}秒`,
      ]),
    });
  } else if (charts.engineStatus.length > 0) {
    blocks.push({
      type: 'table',
      title: '引擎执行',
      headers: ['状态', '数量'],
      rows: charts.engineStatus.map((d) => [d.label, String(d.value)]),
    });
  }

  // 风险项明细（可选章节）：优先按严重等级分章逐条（与 HTML 主路径一致）；无该结构时回退旧 findingSamples 表。
  if (inSection('riskItems')) {
    const riskGroups: RiskItemSeverityGroup[] = filterRiskItemGroups(
      summary.riskItemsBySeverity ?? [],
      opts,
    );
    if (riskGroups.length > 0) {
      blocks.push({ type: 'heading', text: '风险项明细' });
      blocks.push({
        type: 'paragraph',
        text: '本节逐项列出需整改风险。每项均展示测试样本和评估对象完整响应，便于业务、模型和安全责任人定位问题并按验收标准复测；标准关联仅供安全合规人员核查。',
      });
      for (const g of riskGroups) {
        const trunc = g.truncated > 0 ? `（另有 ${g.truncated} 项见 Excel 全量附录）` : '';
        blocks.push({
          type: 'paragraph',
          text: `${g.severityLabel}风险　共 ${g.items.length} 项${trunc}`,
        });
        for (const it of g.items) {
          blocks.push({
            type: 'riskEvidenceCard',
            seq: it.seq,
            severityLabel: it.severityLabel,
            tone: severityTone(it.severity ?? 'UNSPECIFIED'),
            riskCategoryLabel: it.riskCategoryLabel,
            engineLabel: it.engineLabel,
            evidenceStrength: it.evidenceStrength,
            executionOutcome: it.executionOutcome,
            questionContent: it.questionContent,
            evidence: it.evidence,
            riskExplanation: it.riskExplanation,
            action: [
              it.remediation.action,
              it.remediation.responsibility ? `责任：${it.remediation.responsibility}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
            verification: [
              it.remediation.verification,
              it.remediation.verificationScope
                ? `复测范围：${it.remediation.verificationScope}`
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
            compliance: pdfComplianceText(it.compliance),
          });
        }
      }
    } else {
      const findingSamples = summary.findingSamples ?? [];
      if (findingSamples.length > 0) {
        blocks.push({
          type: 'table',
          title: '风险项明细',
          headers: ['序号', '风险类型', '判定结果', '等级', '风险说明'],
          rows: findingSamples
            .slice(0, PDF_DETAIL_LIMIT)
            .map((f, i) => [
              String(i + 1),
              riskTypeLabelForPdf(f),
              ruleActionLabelForPdf(f),
              f.severityLabel,
              riskExplanationForPdf(f),
            ]),
        });
      }

      const wrongAnswerSamples = summary.wrongAnswerSamples ?? [];
      if (wrongAnswerSamples.length > 0) {
        blocks.push({
          type: 'table',
          title: '样本明细',
          headers: ['序号', '风险样本', '风险类型', '判定结果', '违规说明'],
          rows: wrongAnswerSamples
            .slice(0, PDF_DETAIL_LIMIT)
            .map((w, i) => [
              String(i + 1),
              shortInline(w.questionContent, 120),
              riskTypeLabelForPdf(w),
              ruleActionLabelForPdf(w),
              riskExplanationForPdf(w),
            ]),
        });
      }
    }
  }

  // 风险分布归因（网关流量日志专有）。
  if (summary.riskAttribution && summary.riskAttribution.totalRiskItems > 0) {
    const a = summary.riskAttribution;
    blocks.push({ type: 'heading', text: '风险来源分布（按调用账号 / 来源IP地址 / AI应用类型）' });
    blocks.push({
      type: 'paragraph',
      text: `触发风险的调用账号 ${a.keyCount} 个 · 来源 IP 地址 ${a.ipCount} 个 · AI 应用类型 ${a.agentTypeCount} 个 · 风险项 ${a.totalRiskItems} 条。“评估中已观察到”表示评估证据确认了风险行为，不等同于生产环境实际事件。`,
    });
    if (a.categoryRanking.length) {
      blocks.push({
        type: 'table',
        title: '主要风险类型',
        headers: ['风险类别', '数量', '最高等级'],
        rows: a.categoryRanking
          .slice(0, 8)
          .map((c) => [c.label, String(c.count), c.maxSeverityLabel]),
      });
    }
    const entRows = (rows: typeof a.topByKey) =>
      rows.map((s) => [
        s.id,
        String(s.riskCount),
        String(s.consummatedCount),
        s.maxSeverityLabel,
        s.topCategories.join('、') || '—',
      ]);
    const entHeaders = (label: string) => [
      label,
      '风险次数',
      '评估中已观察到',
      '最高风险等级',
      '主要风险类型',
    ];
    if (a.topByKey.length)
      blocks.push({
        type: 'table',
        title: '高危调用账号排行',
        headers: entHeaders('调用账号'),
        rows: entRows(a.topByKey),
      });
    if (a.topByIp.length)
      blocks.push({
        type: 'table',
        title: '高危来源IP地址排行',
        headers: entHeaders('来源IP地址'),
        rows: entRows(a.topByIp),
      });
    if (a.topByAgentType.length)
      blocks.push({
        type: 'table',
        title: 'AI应用类型分布',
        headers: entHeaders('AI应用类型'),
        rows: entRows(a.topByAgentType),
      });
  }

  // GB/T 45654 条款映射（可选章节）。
  if (inSection('gbtCompliance') && summary.compliance) {
    const c = summary.compliance;
    blocks.push({ type: 'heading', text: 'GB/T 45654 条款映射（非认证结论）' });
    blocks.push({ type: 'paragraph', text: `映射标准：${c.standard}` });
    blocks.push({
      type: 'paragraph',
      text: '以下内容将评估证据映射至 GB/T 45654、OWASP 和 MITRE ATLAS 相关分类，用于评估覆盖核查，不构成符合性认证。',
    });
    blocks.push({
      type: 'table',
      title: '附录A · 风险类别条款映射（A.1–A.5）',
      headers: [
        '风险类别',
        '本次结论',
        '涉及问题',
        '最高严重程度',
        '对照的安全标准（供安全人员参考）',
      ],
      rows: c.annexA.map((r) => {
        const standards = [
          r.owaspClauses.length ? `国际标准参照(OWASP)：${r.owaspClauses.join('、')}` : '',
          r.atlasTactics?.length ? `攻击阶段(ATLAS)：${r.atlasTactics.join('、')}` : '',
          r.agenticThreats?.length ? `智能体威胁类型：${r.agenticThreats.join('、')}` : '',
        ].filter(Boolean);
        return [
          shortInline(r.annexLabel, 60),
          r.conclusion,
          r.hitCategories.length ? shortInline(r.hitCategories.join('、'), 110) : '—',
          r.maxSeverityLabel,
          standards.length ? shortInline(standards.join('；'), 140) : '—',
        ];
      }),
    });
    blocks.push({ type: 'paragraph', text: c.evalScaleNote });
    blocks.push({ type: 'paragraph', text: c.disclaimer });
  }

  const agentTraceSamples = summary.agentTraceSamples ?? [];
  if (agentTraceSamples.length > 0) {
    blocks.push({
      type: 'table',
      title: '智能体工具风险摘要',
      headers: ['序号', '风险面', '工具', agentTraceSamples.some(trace => /事后观测/.test(trace.interceptedLabel)) ? '工具处置与观测' : '评估沙箱处置', '说明'],
      rows: agentTraceSamples
        .slice(0, PDF_DETAIL_LIMIT)
        .map((trace, i) => [
          String(i + 1),
          trace.riskSurfaceLabel,
          trace.toolName,
          compactSpaces(
            `${trace.verdictLabel} / ${sandboxDispositionLabel(trace.interceptedLabel)}`,
          ),
          buildAgentTraceExplanation(trace),
        ]),
    });
  }

  const redTeamSummary = summary.redTeamSummary;
  if (inSection('redTeam') && redTeamSummary && redTeamSummary.samples.length > 0) {
    blocks.push({ type: 'heading', text: '多轮红队评估摘要' });
    blocks.push({
      type: 'paragraph',
      text:
        `本次自主红队评估覆盖 ${redTeamSummary.scenarioCount} 个对抗场景、${redTeamSummary.totalRounds} 轮交互，形成 ${redTeamSummary.traceCount} 条对象轨迹。` +
        `其中 ${redTeamSummary.brokenCount} 个场景被裁判标记为风险；${redTeamSummary.defendedCount} 个对照场景由 A 侧风险变为 B 侧通过，防护贡献需结合日志复核。` +
        reportRedTeamEvidenceCoverage(redTeamSummary),
    });
    blocks.push({
      type: 'table',
      title: '多轮红队评估摘要',
      hideTitle: true,
      headers: ['序号', '对抗场景', '评估结果', '轮数', '停止原因', '处置建议'],
      rows: redTeamSummary.samples.map((sample, i) => [
        String(i + 1),
        shortInline(sample.scenarioTitle, 80),
        `${sample.sideLabel} / ${sample.verdictLabel}`,
        String(sample.rounds),
        sample.stopReasonLabel,
        normalizeSandboxActorWording(sample.remediation),
      ]),
    });
  }

  if (inSection('remediation')) {
    const remediationItems = summary.remediationItems ?? [];
    if (remediationItems.length > 0) {
      blocks.push({
        type: 'table',
        title: '整改建议',
        headers: ['优先级', '整改项', '关联风险', '处置动作', '验证方式'],
        rows: remediationItems.map((item) => [
          item.priority,
          normalizeSandboxActorWording(item.title),
          item.riskCategoryLabel,
          normalizeSandboxActorWording(
            [
              item.action,
              item.responsibility ? `责任：${item.responsibility}` : '',
              item.controlLocation ? `控制位置：${item.controlLocation}` : '',
              `状态：${remediationStatusLabel(item.status)}`,
              item.dueAt ? `截止：${item.dueAt}` : '截止：待客户补充',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
          normalizeSandboxActorWording(
            [
              item.verification,
              item.verificationScope ? `复测范围：${item.verificationScope}` : '',
              item.retestTaskId ? `复测任务：${item.retestTaskId}` : '复测任务：待关联',
              item.acceptanceCriteria ? `验收条件：${item.acceptanceCriteria}` : '',
              item.closureEvidence ? `关闭证据：${item.closureEvidence}` : '关闭证据：待补充',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        ]),
      });
    }
    blocks.push({
      type: 'table',
      title: '整改闭环与责任分工',
      headers: ['角色', '处理动作', '交付物/验收标准'],
      rows: buildRemediationHandoffRows(report),
    });
  }

  if (inSection('nextSteps')) {
    blocks.push({ type: 'heading', text: '下一步分析计划与建议' });
    blocks.push({
      type: 'table',
      title: '下一步分析计划与建议',
      hideTitle: true,
      headers: ['序号', '阶段', '建议动作', '验收标准'],
      rows: buildNextAnalysisPlan(report),
    });
  }

  // —— 结论与建议 ——
  blocks.push({ type: 'heading', text: '结论与建议' });
  blocks.push({ type: 'paragraph', text: buildConclusion(report) });
  if (summary.reviewSummary) {
    const review = summary.reviewSummary;
    blocks.push({
      type: 'paragraph',
      text: `人工已确认 ${review.humanConfirmedCount} 项，接受风险 ${review.humanAcceptedCount} 项，待人工复核 ${review.humanPendingCount} 项；逐项独立模型解释完成 ${review.independentReviewedCount} 项。整体 AI 摘要不等于逐项复核完成。`,
    });
  }
  if (report.content.trim()) {
    blocks.push({
      type: 'paragraph',
      text: 'PDF 正文保留测试样本和评估对象响应原文，并给出风险说明、整改动作和复测方式；完整对抗轨迹与复盘材料可在平台报告详情中追溯。',
    });
  }

  return { title: titleParts.title, blocks };
}
// 按「检出到的风险类别」给出针对性处置建议。
// 红线：只对实际检出的类别输出建议，绝不臆造未发生的风险。
const CATEGORY_ADVICE: Array<{ match: (code: string) => boolean; advice: string }> = [
  {
    match: (c) => c === 'forbidden_content',
    advice:
      '命中禁止内容：配置内容安全过滤与阻断策略，补充命中类别规则，并使用同类样本完成回归复测。',
  },
  {
    match: (c) => c === 'prompt_injection',
    advice:
      '提示注入：隔离系统指令与用户输入，加固指令边界，并对工具调用实施白名单、参数校验和最小权限控制。',
  },
  {
    match: (c) => c === 'should_refuse_violation',
    advice: '高风险请求：完善拒答策略并提供安全替代响应，使用同类样本完成应拒答范围的回归复测。',
  },
  {
    match: (c) => c === 'sensitive_info_pii',
    advice:
      '个人信息泄露：检测响应中是否包含姓名、证件号、手机号等个人信息；命中后执行脱敏或阻断，避免非授权披露。',
  },
  {
    match: (c) => c === 'sensitive_info_secret',
    advice:
      '敏感凭据泄露：检测响应中是否包含密钥、账号密码等凭据；命中后阻断输出，并限制复述上下文或语料中的敏感凭据。',
  },
  {
    match: (c) => c === 'sensitive_info',
    advice: '敏感信息：加强敏感信息识别与脱敏管控，明确可输出字段边界。',
  },
  {
    match: (c) => c === 'compliance',
    advice: '合规风险：对照合规要求逐项核验，补齐合规话术与拒答边界。',
  },
  {
    match: (c) => c === 'llm_judge_fail',
    advice: '待确认的高风险回答：由安全负责人逐条复核，确认为真实风险的纳入整改并按同范围复测。',
  },
  {
    match: (c) =>
      /^(redteam_|garak_|pyrit_)/.test(c) ||
      c === 'redteam_scan' ||
      c === 'redteam_probe' ||
      c === 'redteam_attack',
    advice: '红队发现：针对红队评估与探针命中的风险路径实施专项加固，并纳入上线前复测。',
  },
];

function buildCategoryAdvice(
  riskCategory: ReadonlyArray<{ key: string; value: number }>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of riskCategory) {
    if (d.value <= 0) continue;
    const found = CATEGORY_ADVICE.find((c) => c.match(d.key));
    if (!found || seen.has(found.advice)) continue;
    seen.add(found.advice);
    out.push(found.advice);
  }
  return out;
}

function buildRemediationHandoffRows(report: BuiltReport): string[][] {
  const hasRisk = report.summary.findingCount > 0 || report.summary.failedCount > 0;
  const redTeam = report.summary.redTeamSummary;
  const evidenceScope = redTeam
    ? `包含 ${redTeam.scenarioCount} 个多轮红队对抗场景和 ${redTeam.totalRounds} 轮交互证据。`
    : '包含风险样本、判定依据、整改建议和复测标准。';

  return [
    [
      '安全部门',
      hasRisk
        ? '按 P0/P1/P2/P3 拆分风险项，输出整改单并同步业务负责人。'
        : '保留本次评估结果作为上线基线，安排周期性回归。',
      `形成风险清单、证据包和整改优先级；${evidenceScope}`,
    ],
    [
      '业务部门/模型负责人',
      '确认风险是否命中真实业务场景，明确可披露数据范围、拒答边界和例外审批口径。',
      '给出责任人、整改计划和风险接受说明；不接受的风险必须进入策略或业务逻辑整改。',
    ],
    [
      '平台/网关管理员',
      '调整提示词、安全护栏、敏感信息脱敏、工具白名单、出向访问控制或人工审批策略。',
      '提交配置变更记录；策略变更不得扩大模型或工具的越权访问面。',
    ],
    [
      '安全部门复测',
      '使用同一样本库、同一红队轨迹和相邻扩展样本复测，并复核异常或未判定样本。',
      '高危风险复测未再观察到有效风险，或形成经批准的例外；报告、证据和整改记录归档。',
    ],
  ];
}

function buildNextAnalysisPlan(report: BuiltReport): string[][] {
  const { summary } = report;
  const rows: string[][] = [];
  let index = 1;
  const remediationItems = summary.remediationItems ?? [];
  const p0 = remediationItems.find((item) => item.priority === 'P0');

  if (p0) {
    rows.push([String(index++), 'P0 风险复核', '完成 P0 整改后发起同题复测', p0.verification]);
  }

  if (summary.findingCount > 0 || summary.failedCount > 0) {
    rows.push([
      String(index++),
      '专项样本扩展',
      '围绕命中风险域补充近似攻击样本，覆盖同义改写、多语言和编码绕过。',
      '新增样本纳入回归样本库，复测后未再观察到相关风险或形成例外说明。',
    ]);
    rows.push([
      String(index++),
      '策略与护栏校准',
      '复核模型提示词、内容安全分类器、工具调用白名单和输出脱敏规则。',
      '形成变更记录，并由安全负责人确认策略生效。',
    ]);
  }

  if (summary.errorCount > 0) {
    rows.push([
      String(index++),
      '异常任务排查',
      '排查模型连通性、超时、限流和评审引擎错误，避免异常样本影响结论。',
      '错误样本重跑成功，报告中异常数归零或有明确原因。',
    ]);
  }

  rows.push([
    String(index),
    '上线前签核归档',
    '汇总 PDF 报告、风险证据、整改记录和复测结果。',
    '安全、业务与模型负责人完成签核后进入上线流程。',
  ]);

  return rows;
}

function buildConclusion(report: BuiltReport): string {
  const { summary } = report;
  const charts = summary.charts;
  const securityScore = securityScoreForSummary(summary);
  const conclusionSnapshot = summary.conclusionSnapshot ?? legacyReportConclusionSnapshot();
  const rate = conclusionSnapshot.passRate === null ? null : conclusionSnapshot.passRate * 100;
  const rateText = rate === null ? '无有效判定' : `${rate.toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(`评估结论：${renderReportConclusionStateZh(conclusionSnapshot)}。`);
  if (conclusionSnapshot.state === 'RISK_DETECTED') {
    lines.push(
      `本次评估发现 ${conclusionSnapshot.activeRiskCount ?? summary.findingCount} 项有效风险，请完成整改并按相同范围复测验证。`,
    );
  } else if (conclusionSnapshot.state === 'INCOMPLETE') {
    lines.push('存在未完成执行、异常、未知判定或覆盖缺口，当前不能形成风险结论；请补齐后复测。');
  } else {
    lines.push('在本次冻结的评估范围和证据下未观察到有效风险；这不等同于系统绝对安全或合规认证。');
  }
  const coverage = conclusionSnapshot.counts
    ? `预期 ${conclusionSnapshot.counts.expected} 条，观察到 ${conclusionSnapshot.counts.observed} 条，有效判定 ${conclusionSnapshot.counts.valid} 条`
    : '执行范围不可验证';
  const reasons = renderReportConclusionReasonsZh(conclusionSnapshot);
  lines.push(`执行范围：${coverage}；有效判定通过率 ${rateText}。`);
  const statisticsText = describeStatisticsZh(summary.statistics);
  if (statisticsText) lines.push(`统计可信度：${statisticsText}`);
  if (reasons.length > 0) lines.push(`结论依据：${reasons.join('；')}。`);

  if (conclusionSnapshot.state === 'RISK_DETECTED' && summary.findingCount > 0) {
    const evidenceCount = summary.evidenceFindingCount ?? summary.findingCount;
    lines.push(
      `检出 ${summary.findingCount} 项题级风险，其中样本 ${summary.wrongAnswerCount} 条，证据项 ${evidenceCount} 条。`,
    );
    const sev = summary.severityDistribution;
    const crit = sev.CRITICAL ?? 0;
    const high = sev.HIGH ?? 0;
    if (crit > 0) {
      lines.push(`检出 ${crit} 项严重级风险，建议优先整改并复测验证。`);
    } else if (high > 0) {
      lines.push(`检出 ${high} 项高危风险，建议整改后复测验证。`);
    } else {
      lines.push('风险以中低危为主，建议纳入迭代计划逐项整改。');
    }
  }

  if (summary.errorCount > 0) {
    lines.push(
      `另有 ${summary.errorCount} 条样本执行异常，建议排查模型连通性或超时配置后重新评估。`,
    );
  }
  if (securityScore.falsePositiveFindingCount > 0) {
    lines.push(`已排除误判 ${securityScore.falsePositiveFindingCount} 项。`);
  }
  if (securityScore.skippedEngineCount > 0) {
    lines.push(
      `${securityScore.skippedEngineCount} 个引擎跳过执行，覆盖扣分 ${securityScore.coverageDeduction} 分。`,
    );
  }

  const advices = buildCategoryAdvice(charts.riskCategory);
  if (advices.length > 0) {
    lines.push('');
    lines.push('处置建议：');
    for (const a of advices) lines.push(`• ${a}`);
  }
  return lines.join('\n');
}

export interface RenderReportPdfOptions {
  /** CJK 字体文件路径（如 Noto Sans CJK）；存在则注册并使用，否则回退默认字体。 */
  cjkFontPath?: string;
  /** 当字体为 .ttc/.dfont 集合时，从中选取的字族（PostScript 名）；缺省取简体中文面。 */
  cjkFontFamily?: string;
  /** 下载水印文本（下载人 + 时间 + 平台标题）；提供时写入每页页脚并叠加斜向水印。 */
  watermark?: string;
}

/** 简体中文默认字族（Noto Sans CJK 集合内的 PostScript 名）。 */
const DEFAULT_CJK_COLLECTION_FAMILY = 'NotoSansCJKsc-Regular';

/** resolveCjkFont 的决策结果。 */
export interface CjkFontResolution {
  /** 是否注册并使用 CJK 字体；false 表示回退默认拉丁字体。 */
  useCjk: boolean;
  /** 实际传给 pdfkit 的字体名（'cjk' 或 'Helvetica'）。 */
  fontName: string;
  /** 需注册的字体文件路径；useCjk 为 true 时存在。 */
  path?: string;
  /** TrueType 集合（.ttc/.dfont）需指定的字族；单文件字体为 undefined。 */
  family?: string;
}

/** resolveCjkFont 的入参（exists 可注入以便测试）。 */
export interface ResolveCjkFontInput {
  cjkFontPath?: string;
  cjkFontFamily?: string;
  exists?: (p: string) => boolean;
}

/**
 * 纯决策函数：根据字体路径推断 pdfkit 字体注册策略。
 * - 路径缺失或不存在 → 回退 Helvetica（不注册）。
 * - .ttc / .dfont 集合 → 必须指定字族（PostScript 名）才能从集合中选面，
 *   缺省取简体中文面 NotoSansCJKsc-Regular，可由 cjkFontFamily 覆盖。
 * - 单文件字体（.otf/.ttf）→ 注册但不指定字族（传入不匹配的字族会让 fontkit getFont 落空）。
 */
export function resolveCjkFont(input: ResolveCjkFontInput = {}): CjkFontResolution {
  const exists = input.exists ?? fs.existsSync;
  const fontPath = input.cjkFontPath;
  if (!fontPath || !exists(fontPath)) {
    return { useCjk: false, fontName: 'Helvetica' };
  }
  const isCollection = /\.(ttc|dfont)$/i.test(fontPath);
  const family = isCollection
    ? input.cjkFontFamily?.trim() || DEFAULT_CJK_COLLECTION_FAMILY
    : undefined;
  return { useCjk: true, fontName: 'cjk', path: fontPath, family };
}

/** 调色板：slate 中性 + indigo 主色 + 语义色，参考现代安全报告。 */
const PALETTE = {
  ink: '#0f172a', // slate-900 主文字
  inkSoft: '#334155', // slate-700 次文字
  inkFaint: '#64748b', // slate-500 标签
  line: '#e2e8f0', // slate-200 描边
  zebra: '#f1f5f9', // slate-100 斑马 / 轨道底
  band: '#1e293b', // slate-800 顶栏 / 表头底
  bandSub: '#cbd5e1', // slate-300 顶栏副标题
  accent: '#4f46e5', // indigo-600 主强调
  white: '#ffffff',
  good: '#16a34a', // green-600 通过
  warn: '#d97706', // amber-600 关注
  bad: '#dc2626', // red-600 风险
  critical: '#991b1b', // red-800 严重
  info: '#0891b2', // cyan-600 类别 / 信息
  neutral: '#475569', // slate-600 中性
} as const;

function toneColor(tone?: Tone): string {
  switch (tone) {
    case 'good':
      return PALETTE.good;
    case 'warn':
      return PALETTE.warn;
    case 'bad':
      return PALETTE.bad;
    case 'critical':
      return PALETTE.critical;
    case 'info':
      return PALETTE.info;
    default:
      return PALETTE.neutral;
  }
}

type Pdf = PDFKit.PDFDocument;

function contentWidth(pdf: Pdf): number {
  return pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;
}

/** 若当前页剩余高度不足 need，则换页并把光标复位到左上内容区。 */
function ensureSpace(pdf: Pdf, need: number): void {
  const bottom = pdf.page.height - pdf.page.margins.bottom;
  if (pdf.y + need > bottom) {
    pdf.addPage();
    pdf.x = pdf.page.margins.left;
    pdf.y = pdf.page.margins.top;
  }
}

/**
 * 把纯文档模型渲染为 PDF 字节流（pdfkit 胶水层）。
 * 字体可插拔：提供并存在 cjkFontPath 时注册 CJK 字体，否则回退 Helvetica。
 */
export function renderReportPdf(
  doc: ReportPdfDoc,
  opts: RenderReportPdfOptions = {},
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const pdf = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
      const chunks: Buffer[] = [];
      pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
      pdf.on('end', () => resolve(Buffer.concat(chunks)));
      pdf.on('error', (err: Error) => reject(err));

      const fontChoice = resolveCjkFont({
        cjkFontPath: opts.cjkFontPath,
        cjkFontFamily: opts.cjkFontFamily,
      });
      if (fontChoice.useCjk && fontChoice.path) {
        if (fontChoice.family) {
          pdf.registerFont('cjk', fontChoice.path, fontChoice.family);
        } else {
          pdf.registerFont('cjk', fontChoice.path);
        }
      }
      const bodyFont = fontChoice.fontName;
      pdf.font(bodyFont).fillColor(PALETTE.ink);

      for (const block of doc.blocks) {
        renderBlock(pdf, block, bodyFont);
      }

      renderFooters(pdf, bodyFont, opts.watermark);

      pdf.end();
    } catch (err) {
      reject(err as Error);
    }
  });
}

function renderBlock(pdf: Pdf, block: PdfBlock, bodyFont: string): void {
  switch (block.type) {
    case 'title':
      renderTitle(pdf, block, bodyFont);
      break;
    case 'heading':
      renderHeading(pdf, block.text, bodyFont);
      break;
    case 'paragraph':
      renderParagraph(pdf, block.text, bodyFont);
      break;
    case 'kpiCards':
      renderKpiCards(pdf, block.items, bodyFont);
      break;
    case 'gauge':
      renderGauge(pdf, block, bodyFont);
      break;
    case 'barChart':
      renderBarChart(pdf, block, bodyFont);
      break;
    case 'ruleCards':
      renderRuleCards(pdf, block, bodyFont);
      break;
    case 'riskEvidenceCard':
      renderRiskEvidenceCard(pdf, block, bodyFont);
      break;
    case 'table':
      renderTable(pdf, block, bodyFont);
      break;
    case 'spacer':
      pdf.moveDown(1);
      break;
  }
}

function renderTitle(
  pdf: Pdf,
  block: Extract<PdfBlock, { type: 'title' }>,
  bodyFont: string,
): void {
  const left = pdf.page.margins.left;
  const usable = contentWidth(pdf);
  const titleSize = block.text.length > 18 ? 18 : 22;
  pdf.font(bodyFont).fontSize(titleSize);
  const titleH = pdf.heightOfString(block.text, { width: usable, lineGap: 2 });
  pdf.font(bodyFont).fontSize(9);
  const subH = block.subtitle
    ? pdf.heightOfString(block.subtitle, { width: usable, lineGap: 2 })
    : 0;
  const bandH = Math.max(92, 30 + titleH + (block.subtitle ? 8 + subH : 0) + 18);

  // 顶部色带 + indigo 强调条
  pdf.rect(0, 0, pdf.page.width, bandH).fill(PALETTE.band);
  pdf.rect(0, bandH, pdf.page.width, 4).fill(PALETTE.accent);
  pdf.fillColor(PALETTE.white).font(bodyFont).fontSize(titleSize).text(block.text, left, 28, {
    width: usable,
    lineGap: 2,
  });
  if (block.subtitle) {
    pdf
      .fillColor(PALETTE.bandSub)
      .font(bodyFont)
      .fontSize(9)
      .text(block.subtitle, left, 28 + titleH + 8, {
        width: usable,
        lineGap: 2,
      });
  }
  pdf.fillColor(PALETTE.ink);
  pdf.x = left;
  pdf.y = bandH + 4 + 22;
}

function renderHeading(pdf: Pdf, text: string, bodyFont: string): void {
  const left = pdf.page.margins.left;
  const usable = contentWidth(pdf);
  pdf.font(bodyFont).fontSize(14);
  const h = pdf.heightOfString(text, { width: usable - 12 });
  ensureSpace(pdf, h + 12);
  const y = pdf.y;
  pdf.rect(left, y + 1, 4, Math.max(h, 14)).fill(PALETTE.accent);
  pdf
    .fillColor(PALETTE.ink)
    .font(bodyFont)
    .fontSize(14)
    .text(text, left + 12, y, {
      width: usable - 12,
    });
  pdf.x = left;
  pdf.y = y + Math.max(h, 16) + 8;
}

function renderParagraph(pdf: Pdf, text: string, bodyFont: string): void {
  const left = pdf.page.margins.left;
  const usable = contentWidth(pdf);
  const padX = 12;
  const padY = 10;
  const textW = usable - padX * 2;
  pdf.font(bodyFont).fontSize(10);
  const h = pdf.heightOfString(text, { width: textW, lineGap: 2 });
  const boxH = h + padY * 2;
  ensureSpace(pdf, boxH + 6);
  const y = pdf.y;
  pdf.roundedRect(left, y, usable, boxH, 6).fill(PALETTE.zebra);
  pdf.rect(left, y, 3, boxH).fill(PALETTE.accent);
  pdf
    .fillColor(PALETTE.inkSoft)
    .font(bodyFont)
    .fontSize(10)
    .text(text, left + padX, y + padY, {
      width: textW,
      lineGap: 2,
    });
  pdf.x = left;
  pdf.y = y + boxH + 6;
}

function renderKpiCards(
  pdf: Pdf,
  items: Array<{ label: string; value: string; tone?: Tone }>,
  bodyFont: string,
): void {
  const left = pdf.page.margins.left;
  const usable = contentWidth(pdf);
  const cols = 4;
  const gap = 10;
  const cardW = (usable - gap * (cols - 1)) / cols;
  const cardH = 54;
  const rows = Math.ceil(items.length / cols);
  ensureSpace(pdf, rows * cardH + (rows - 1) * gap + 6);
  const startY = pdf.y;
  items.forEach((item, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = left + c * (cardW + gap);
    const y = startY + r * (cardH + gap);
    const color = toneColor(item.tone);
    pdf
      .lineWidth(0.8)
      .roundedRect(x, y, cardW, cardH, 6)
      .fillAndStroke(PALETTE.white, PALETTE.line);
    pdf.rect(x, y + 6, 3, cardH - 12).fill(color);
    pdf
      .fillColor(PALETTE.inkFaint)
      .font(bodyFont)
      .fontSize(8.5)
      .text(item.label, x + 12, y + 9, {
        width: cardW - 18,
        lineBreak: false,
        ellipsis: true,
      });
    pdf
      .fillColor(color)
      .font(bodyFont)
      .fontSize(18)
      .text(item.value, x + 12, y + 23, {
        width: cardW - 18,
        lineBreak: false,
        ellipsis: true,
      });
  });
  pdf.fillColor(PALETTE.ink);
  pdf.x = left;
  pdf.y = startY + rows * cardH + (rows - 1) * gap + 8;
}

function renderGauge(
  pdf: Pdf,
  block: Extract<PdfBlock, { type: 'gauge' }>,
  bodyFont: string,
): void {
  const left = pdf.page.margins.left;
  const usable = contentWidth(pdf);
  ensureSpace(pdf, 44);
  const y = pdf.y;
  const color = toneColor(block.tone);
  pdf.fillColor(PALETTE.inkSoft).font(bodyFont).fontSize(10).text(block.label, left, y, {
    width: usable,
    lineBreak: false,
  });
  const trackY = y + 16;
  const trackH = 14;
  const trackW = usable - 64;
  pdf.roundedRect(left, trackY, trackW, trackH, 7).fill(PALETTE.zebra);
  const pct = block.percent === null ? 0 : Math.max(0, Math.min(100, block.percent));
  const fillW = (trackW * pct) / 100;
  if (fillW > 0) {
    pdf.roundedRect(left, trackY, Math.max(fillW, 8), trackH, 7).fill(color);
  }
  const pctText = block.percent === null ? '—' : `${block.percent.toFixed(1)}%`;
  pdf
    .fillColor(color)
    .font(bodyFont)
    .fontSize(13)
    .text(pctText, left + trackW + 8, trackY - 1, {
      width: 56,
      lineBreak: false,
    });
  pdf.fillColor(PALETTE.ink);
  pdf.x = left;
  pdf.y = trackY + trackH + 12;
}

function renderBarChart(
  pdf: Pdf,
  block: Extract<PdfBlock, { type: 'barChart' }>,
  bodyFont: string,
): void {
  const left = pdf.page.margins.left;
  const usable = contentWidth(pdf);

  if (block.title) {
    pdf.font(bodyFont).fontSize(11);
    const h = pdf.heightOfString(block.title, { width: usable });
    ensureSpace(pdf, h + 8 + 20);
    const ty = pdf.y;
    pdf.fillColor(PALETTE.inkSoft).text(block.title, left, ty, { width: usable, lineBreak: false });
    pdf.x = left;
    pdf.y = ty + h + 8;
  }

  const labelW = 112;
  const valueW = 34;
  const trackW = usable - labelW - valueW - 12;
  const max = Math.max(1, ...block.bars.map((b) => b.value));
  const rowH = 20;

  for (const bar of block.bars) {
    ensureSpace(pdf, rowH);
    const y = pdf.y;
    const color = toneColor(bar.tone);
    pdf
      .fillColor(PALETTE.inkSoft)
      .font(bodyFont)
      .fontSize(9)
      .text(bar.label, left, y + 2, {
        width: labelW - 8,
        align: 'right',
        lineBreak: false,
        ellipsis: true,
      });
    const tx = left + labelW;
    pdf.roundedRect(tx, y + 1, trackW, 13, 3).fill(PALETTE.zebra);
    const w = Math.max(2, (trackW * bar.value) / max);
    pdf.roundedRect(tx, y + 1, w, 13, 3).fill(color);
    pdf
      .fillColor(PALETTE.inkSoft)
      .font(bodyFont)
      .fontSize(9)
      .text(String(bar.value), tx + trackW + 6, y + 2, {
        width: valueW,
        lineBreak: false,
      });
    pdf.x = left;
    pdf.y = y + rowH;
  }
  pdf.fillColor(PALETTE.ink);
  pdf.x = left;
  pdf.moveDown(0.4);
}

function renderRuleCards(
  pdf: Pdf,
  block: Extract<PdfBlock, { type: 'ruleCards' }>,
  bodyFont: string,
): void {
  const left = pdf.page.margins.left;
  const usable = contentWidth(pdf);

  if (block.title) {
    pdf.font(bodyFont).fontSize(11);
    const h = pdf.heightOfString(block.title, { width: usable });
    ensureSpace(pdf, h + 8);
    const ty = pdf.y;
    pdf.fillColor(PALETTE.inkSoft).text(block.title, left, ty, { width: usable });
    pdf.x = left;
    pdf.y = ty + h + 8;
  }

  const padX = 12;
  const padY = 10;
  const gap = 8;
  const textW = usable - padX * 2;

  for (const item of block.items) {
    const color = toneColor(item.tone);
    const title = item.count ? `${item.label}（${item.count} 项）` : item.label;
    const body = [
      `这类风险是什么：${item.meaning}`,
      `为什么危险：${item.why}`,
      `建议怎么办：${item.action}`,
    ].join('\n');
    pdf.font(bodyFont).fontSize(10.5);
    const titleH = pdf.heightOfString(title, { width: textW });
    pdf.font(bodyFont).fontSize(9.2);
    const bodyH = pdf.heightOfString(body, { width: textW, lineGap: 2 });
    const cardH = padY * 2 + titleH + 6 + bodyH;
    ensureSpace(pdf, cardH + gap);
    const y = pdf.y;

    pdf.roundedRect(left, y, usable, cardH, 6).fill(PALETTE.zebra);
    pdf.rect(left, y, 3, cardH).fill(color);
    pdf
      .fillColor(color)
      .font(bodyFont)
      .fontSize(10.5)
      .text(title, left + padX, y + padY, { width: textW });
    pdf
      .fillColor(PALETTE.inkSoft)
      .font(bodyFont)
      .fontSize(9.2)
      .text(body, left + padX, y + padY + titleH + 6, { width: textW, lineGap: 2 });
    pdf.x = left;
    pdf.y = y + cardH + gap;
  }
  pdf.fillColor(PALETTE.ink);
}

function fitColWidths(usable: number, preferred: number[]): number[] {
  const safe = preferred.map((width) => Math.max(24, width));
  const total = safe.reduce((sum, width) => sum + width, 0);
  if (total <= 0) return Array.from({ length: preferred.length }, () => usable / preferred.length);
  return safe.map((width) => (width / total) * usable);
}

function semanticHeaderWeight(header: string): number {
  if (/序号|轮数|数量|命中数|耗时|等级/.test(header)) return 0.45;
  if (/阶段|状态|优先级|角色|侧别/.test(header)) return 0.85;
  if (/风险类型|关联风险|工具|风险面|停机原因/.test(header)) return 1;
  if (/动作|建议|验收|标准|说明|交付物|样本|场景|处置|证据/.test(header)) return 1.8;
  return 1.1;
}

function computeColWidths(usable: number, headers: string[]): number[] {
  const nCols = headers.length;
  const signature = headers.join('|');
  if (signature === '检测引擎|运行状态|发现问题数|耗时') {
    return fitColWidths(usable, [190, 92, 70, 78]);
  }
  if (signature === '序号|风险类型|判定结果|等级|风险说明') {
    return fitColWidths(usable, [34, 92, 82, 46, usable - 254]);
  }
  if (signature === '序号|风险样本|风险类型|判定结果|违规说明') {
    return fitColWidths(usable, [34, 142, 82, 78, usable - 336]);
  }
  if (signature === '序号|风险面|工具|评估沙箱处置|说明') {
    return fitColWidths(usable, [34, 72, 82, 94, usable - 282]);
  }
  if (signature === '序号|攻击场景|评估结果|轮数|停止原因|处置建议') {
    return fitColWidths(usable, [34, 116, 76, 38, 76, usable - 340]);
  }
  if (signature === '优先级|整改项|关联风险|处置动作|验证方式') {
    return fitColWidths(usable, [48, 100, 90, (usable - 238) / 2, (usable - 238) / 2]);
  }
  if (signature === '角色|处理动作|交付物/验收标准') {
    return fitColWidths(usable, [86, (usable - 86) * 0.48, (usable - 86) * 0.52]);
  }
  if (signature === '序号|阶段|建议动作|验收标准') {
    return fitColWidths(usable, [34, 86, (usable - 120) / 2, (usable - 120) / 2]);
  }
  if (nCols <= 1) return [usable];
  if (nCols === 2) return [usable * 0.72, usable * 0.28];
  if (nCols === 3) return [usable * 0.2, usable * 0.3, usable * 0.5];
  const weights = headers.map(semanticHeaderWeight);
  return fitColWidths(
    usable,
    weights.map((weight) => weight * 100),
  );
}

export const __reportPdfTestHooks = {
  computeColWidths,
};

/**
 * 供 HTML 渲染器（html/model.ts）复用的纯计算/格式化函数。
 * 复用同一套口径，保证 HTML 报告与 pdfkit 报告的文案、评分、标签一致。
 * 不含任何 pdfkit 绘制逻辑。
 */
export const reportHtmlReuse = {
  securityScoreForSummary,
  gradeForSecurityScore,
  securityScoreTone,
  passRateTone,
  severityTone,
  verdictTone,
  buildConclusion,
  buildRuleGuide,
  buildRemediationHandoffRows,
  buildNextAnalysisPlan,
  riskTypeLabelForPdf,
  ruleActionLabelForPdf,
  riskExplanationForPdf,
  normalizeSandboxActorWording,
  shortInline,
  compactSpaces,
  buildAgentTraceExplanation,
  sandboxDispositionLabel,
  reportExplanationRunTextForPdf,
  reportRedTeamEvidenceCoverage,
};
export type PdfSecurityScoreShape = PdfSecurityScore;

function renderRiskEvidenceCard(
  pdf: Pdf,
  block: Extract<PdfBlock, { type: 'riskEvidenceCard' }>,
  bodyFont: string,
): void {
  const left = pdf.page.margins.left;
  const usable = contentWidth(pdf);
  const accent = toneColor(block.tone);
  const title = `需整改风险项 #${block.seq} · ${block.severityLabel}`;

  pdf.font(bodyFont).fontSize(12);
  const titleHeight = pdf.heightOfString(title, { width: usable - 28, lineGap: 1.5 });
  const headHeight = Math.max(34, titleHeight + 18);
  ensureSpace(pdf, headHeight + 10);
  const headY = pdf.y;
  pdf.roundedRect(left, headY, usable, headHeight, 6).fill(PALETTE.zebra);
  pdf.rect(left, headY, 5, headHeight).fill(accent);
  pdf
    .fillColor(PALETTE.ink)
    .font(bodyFont)
    .fontSize(12)
    .text(title, left + 14, headY + 8, {
      width: usable - 28,
      lineGap: 1.5,
    });
  pdf.x = left;
  pdf.y = headY + headHeight + 7;

  const metadata = `风险类别（检测归类）：${block.riskCategoryLabel}\n命中引擎：${block.engineLabel}\n证据强度：${block.evidenceStrength}\n执行结果：${block.executionOutcome}\n标准关联线索：${block.compliance}`;
  const fields: Array<[string, string]> = [
    ['测试样本（完整原文）', block.questionContent],
    ['评估对象完整响应 / 工具结果（完整原文）', block.evidence],
    ['问题在哪里 / 业务影响', block.riskExplanation],
    ['整改建议 / 整改动作', block.action],
    ['验收与复测方式', block.verification],
    ['追溯与判定信息', metadata],
  ];

  for (const [label, rawValue] of fields) {
    const value = String(rawValue || '—');
    pdf.font(bodyFont).fontSize(8.5);
    const labelHeight = pdf.heightOfString(label, { width: usable - 22, lineGap: 1 });
    pdf.font(bodyFont).fontSize(9.5);
    const valueHeight = pdf.heightOfString(value, { width: usable - 22, lineGap: 2 });
    ensureSpace(pdf, labelHeight + Math.min(valueHeight, 120) + 18);
    const y = pdf.y;
    pdf.rect(left, y + 1, 3, labelHeight + 7).fill(accent);
    pdf
      .fillColor(accent)
      .font(bodyFont)
      .fontSize(8.5)
      .text(label, left + 10, y, {
        width: usable - 22,
        lineGap: 1,
      });
    pdf
      .fillColor(PALETTE.inkSoft)
      .font(bodyFont)
      .fontSize(9.5)
      .text(value, left + 10, y + labelHeight + 6, {
        width: usable - 22,
        lineGap: 2,
      });
    pdf.x = left;
    pdf.y += 9;
  }
  pdf.x = left;
  pdf.moveDown(0.5);
}

function renderTable(
  pdf: Pdf,
  block: Extract<PdfBlock, { type: 'table' }>,
  bodyFont: string,
): void {
  const left = pdf.page.margins.left;
  const usable = contentWidth(pdf);

  if (block.title && !block.hideTitle) {
    pdf.font(bodyFont).fontSize(11);
    const h = pdf.heightOfString(block.title, { width: usable });
    ensureSpace(pdf, h + 8);
    const ty = pdf.y;
    pdf.fillColor(PALETTE.inkSoft).text(block.title, left, ty, { width: usable, lineBreak: false });
    pdf.x = left;
    pdf.y = ty + h + 8;
  }

  const nCols = block.headers.length;
  const colWidths = computeColWidths(usable, block.headers);
  const cellPadX = nCols >= 5 ? 6 : 8;
  const cellPadY = 6;
  const fontSize = nCols >= 5 ? 8.8 : 9.2;

  const rowHeight = (cells: string[]): number => {
    pdf.font(bodyFont).fontSize(fontSize);
    let maxH = 0;
    cells.forEach((cell, i) => {
      const w = colWidths[i] ?? usable;
      const h = pdf.heightOfString(String(cell), { width: w - cellPadX * 2 });
      if (h > maxH) maxH = h;
    });
    return maxH + cellPadY * 2;
  };

  const drawRow = (cells: string[], kind: 'header' | 'odd' | 'even'): void => {
    const h = rowHeight(cells);
    ensureSpace(pdf, h);
    const y = pdf.y;
    if (kind === 'header') {
      pdf.rect(left, y, usable, h).fill(PALETTE.band);
    } else if (kind === 'odd') {
      pdf.rect(left, y, usable, h).fill(PALETTE.zebra);
    }
    pdf.font(bodyFont).fontSize(fontSize);
    let x = left;
    cells.forEach((cell, i) => {
      const w = colWidths[i] ?? usable;
      pdf
        .fillColor(kind === 'header' ? PALETTE.white : PALETTE.ink)
        .text(String(cell), x + cellPadX, y + cellPadY, {
          width: w - cellPadX * 2,
          lineGap: 1.2,
        });
      x += w;
    });
    pdf
      .lineWidth(0.5)
      .moveTo(left, y + h)
      .lineTo(left + usable, y + h)
      .stroke(PALETTE.line);
    // 关键修复：绝对定位绘制后把光标复位到左边距，避免后续标题/正文从右列残留 x 处流出而错位。
    pdf.x = left;
    pdf.y = y + h;
  };

  drawRow(block.headers, 'header');
  block.rows.forEach((row, i) => drawRow(row, i % 2 === 0 ? 'even' : 'odd'));
  pdf.fillColor(PALETTE.ink);
  pdf.x = left;
  pdf.moveDown(0.6);
}

/** 当前页居中叠加斜向浅色水印（调用方已临时放开底边距，避免 text() 触发自动分页）。 */
function renderPageWatermark(pdf: Pdf, bodyFont: string, watermark: string): void {
  const { width, height } = pdf.page;
  pdf.save();
  pdf.rotate(-30, { origin: [width / 2, height / 2] });
  pdf.fillColor(PALETTE.inkFaint).fillOpacity(0.12).font(bodyFont).fontSize(22);
  pdf.text(watermark, 0, height / 2 - 11, { width, align: 'center', lineBreak: false });
  pdf.restore();
  pdf.fillOpacity(1);
}

/** 逐页绘制页脚：分隔线 + 产品名称（有下载水印时为水印文本）+ 页码。 */
function renderFooters(pdf: Pdf, bodyFont: string, watermark?: string): void {
  try {
    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      pdf.switchToPage(i);
      const left = pdf.page.margins.left;
      const usable = contentWidth(pdf);
      const bottomMargin = pdf.page.margins.bottom;
      const fy = pdf.page.height - bottomMargin + 16;
      // 关键：页脚写在底边距区域（fy 低于 maxY）。pdfkit 的 text() 在 y+行高 > maxY 时
      // 会自动 addPage()，导致每次写页脚都新增一张空白页（footer 落到新页顶部）。
      // 写页脚前临时把底边距置 0 撑大 maxY，写完恢复。
      pdf.page.margins.bottom = 0;
      pdf
        .lineWidth(0.5)
        .moveTo(left, fy - 6)
        .lineTo(left + usable, fy - 6)
        .stroke(PALETTE.line);
      pdf.fillColor(PALETTE.inkFaint).font(bodyFont).fontSize(8);
      pdf.text(watermark ?? DEFAULT_PLATFORM_TITLE_TEXT, left, fy, {
        width: usable / 2,
        align: 'left',
        lineBreak: false,
      });
      pdf.text(`第 ${i - range.start + 1} / ${range.count} 页`, left + usable / 2, fy, {
        width: usable / 2,
        align: 'right',
        lineBreak: false,
      });
      if (watermark) renderPageWatermark(pdf, bodyFont, watermark);
      pdf.page.margins.bottom = bottomMargin;
    }
  } catch {
    // 页脚绘制失败不应影响主体 PDF 产出。
  }
}
