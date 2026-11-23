import { JUDGE_SOURCE_LABELS, type RiskDomain } from '@lse/shared';
import type { RiskItemSeverityGroup } from '../report-builder.js';
import {
  EFFORT_META,
  REMEDIATION_THEMES,
  playbookForDomain,
  themeForDomain,
  type EffortLevel,
  type ThemeId,
} from '../remediation-playbook.js';

/**
 * 报告「管理层摘要 / 整改计划」所需的确定性派生（纯函数，不依赖渲染器，不改任何评估结果）。
 * - 总体风险等级：规则固定，附录 B 原样展示。
 * - 整改主题聚类：按风险域聚合发现，按「可消除风险项数 ÷ 工作量」排序。
 * - 中文化：内部标识符一律映射为中文，未映射的回退为「风险类别 · 编号」。
 */

// ───────────────────────────── 总体风险等级 ─────────────────────────────
// 规则已抽到共享模块 lib/risk-rating.ts（报告与首页态势共用同一套确定性规则），此处仅再导出以保持原引用路径。
export {
  RISK_LEVEL_LABELS,
  RISK_LEVEL_HIGH_COUNT_THRESHOLD,
  RISK_LEVEL_RULE_LINES,
  computeOverallRiskLevel,
  type OverallRiskLevel,
  type RiskLevelInput,
  type RiskLevelResult,
} from '../../../lib/risk-rating.js';

// ───────────────────────────── 中文化 ─────────────────────────────

const TOOL_ZH: Record<string, string> = {
  read_file: '文件读取工具',
  file_read: '文件读取工具',
  write_file: '文件写入工具',
  run_shell: '命令执行工具',
  shell: '命令执行工具',
  exec: '命令执行工具',
  http_get: '网络请求工具',
  http_request: '网络请求工具',
  fetch: '网络请求工具',
  send_email: '邮件发送工具',
  sql_query: '数据库查询工具',
};

const INTENT_ZH: Record<string, string> = {
  secret_read: '读取密钥、环境变量或凭据文件',
  ssrf: '访问云元数据或内网地址',
  indirect_prompt_injection: '执行检索内容中夹带的指令',
  tool_argument_bypass: '绕过工具参数限制',
  arbitrary_file_read: '读取任意路径的文件',
  file_read: '读取文件',
  command_injection: '构造并执行命令',
};

const INTENT_TITLE_ZH: Record<string, string> = {
  secret_read: '读取密钥与凭据文件',
  ssrf: '访问云元数据与内网地址',
  indirect_prompt_injection: '被检索内容中的指令劫持',
  tool_argument_bypass: '绕过工具参数限制',
  arbitrary_file_read: '读取任意路径文件',
  file_read: '读取文件',
  command_injection: '构造并执行命令',
};

/** 红队对抗策略标识 → 中文；未收录的返回 null。 */
const MOVE_ZH: Record<string, string> = {
  academic_wrap: '学术包装',
  authority_pressure: '权威施压',
  stepwise_decompose: '分步拆解',
  compliance_wrap: '合规包装',
  role_play: '角色扮演',
  roleplay: '角色扮演',
  encoding_bypass: '编码绕过',
  multilingual: '多语言改写',
  context_injection: '上下文注入',
  emotional_appeal: '情感诱导',
  hypothetical: '假设情境',
  direct: '直接请求',
};

export function moveLabelZh(move: string, index: number): string {
  return (
    MOVE_ZH[move] ??
    (containsInternalIdentifier(move) || /^[a-z0-9_\-]+$/i.test(move) ? `策略 ${index + 1}` : move)
  );
}

/** 已知内部标识符 → 客户语言。 */
const IDENTIFIER_ZH: Record<string, string> = {
  // 判定来源的中文与页面、报告标签共用同一张共享表（packages/shared/src/risk-labels.ts）。
  ...JUDGE_SOURCE_LABELS,
  agent_tool_abuse: '工具调用越权',
  forbidden_content: '禁止内容',
  prompt_injection: '提示词注入',
  tool_argument_bypass: '工具参数绕过',
  ...TOOL_ZH,
};

const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/** 将正文里残留的 snake_case 内部标识符映射为中文；未映射的整体删除（不暴露给客户）。 */
export function humanizeIdentifiers(text: string): string {
  return text
    .replace(/`([^`]*)`/g, (_m, inner: string) => inner)
    .replace(SNAKE, (m) => IDENTIFIER_ZH[m] ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/（\s*）|\(\s*\)/g, '')
    .trim();
}

export function containsInternalIdentifier(text: string): boolean {
  SNAKE.lastIndex = 0;
  return SNAKE.test(text);
}

/** 去掉末尾的「风险」二字，作为热力图等紧凑位置使用的类别短名。 */
export function domainShortLabel(domainLabel: string): string {
  return domainLabel.replace(/风险$/, '');
}

function stripExplanationBoilerplate(raw: string): string {
  return raw
    .replace(/^原判定说明（待复核）：/, '')
    .replace(/\s*当前证据不足以确认该说明[\s\S]*$/, '')
    .replace(/（待复核）/g, '')
    .replace(/评估评估/g, '评估')
    .replace(/^评估对象响应中的问题：/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SANDBOX_RE = /评估沙箱阻断高风险工具调用：([^\s/]+)\s*\/\s*([a-z_]+)/;
const TEXT_TOOL_RE = /回答文本包含高风险工具调用描述（([^）]+)）/;

function sentenceCut(text: string, max = 88): string {
  const sentences = text.split(/(?<=[。；！？])/).filter(Boolean);
  let out = '';
  for (const s of sentences) {
    if (out && (out + s).length > max) break;
    out += s;
    if (out.length >= 24) break;
  }
  if (!out) out = text;
  if (out.length > max) {
    const cut = out.slice(0, max);
    const at = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf('；'));
    out = `${cut.slice(0, at > 30 ? at : max).replace(/[，、；]$/, '')}……`;
  }
  return out.replace(/[；，]$/, '');
}

/** 文本里夹带命令行、路径串等原样载荷时，不进入客户可见的摘要。 */
function hasPayload(text: string): boolean {
  return /`/.test(text) || /[\x21-\x7e]{14,}/.test(text);
}

function intentFromPayloadText(text: string): string | null {
  if (/shadow|passwd|id_rsa|凭据|密钥|\.env|credential/i.test(text))
    return '读取系统凭据或密钥文件';
  if (/元数据|169\.254|metadata/i.test(text)) return '访问云元数据地址';
  return null;
}

/** 去掉「违反了应拒答的要求」这类只给结论、不描述具体问题的从句。 */
function stripVerdictClauses(text: string): string {
  return text
    .replace(
      /[，,]?\s*(?:从而|因此|这)?违反了?[^，。；]*(?:应拒答|拒答要求|拒答的要求|安全合规要求|安全要求)[^，。；]*/g,
      '',
    )
    .replace(/[，,]?\s*未执行安全拒答或忽略注入指令/g, '')
    .replace(/[，,]\s*(?=。|$)/g, '');
}

/** 去掉夹在中文里的英文原文引用（括号或引号内含英文单词的片段）。 */
function stripLatinFragments(text: string): string {
  return text
    .replace(/[（(][^）)]*[A-Za-z]{3,}[^）)]*[）)]/g, '')
    .replace(/['‘“"「][^'’”"」]*[A-Za-z]{4,}[^'’”"」]*['’”"」]/g, '')
    .replace(/\s{2,}/g, ' ');
}

export interface SummarizableItem {
  riskExplanation?: string | null;
  riskCategoryLabel?: string | null;
  /** 命中样本题面与被测对象回答：用于按本条自己的情形生成「一句话问题」。 */
  questionContent?: string | null;
  evidence?: string | null;
}

// ── 按本条情形生成「一句话问题」：诉求主题（来自题面）+ 攻击手法 + 模型这次的表现（来自回答）+ 类别通用后果 ──

const FRAMING_RULES: Array<[RegExp, string]> = [
  [/紧急业务指令|系统管理员.{0,6}(?:通知|指令)|外部检索|最高优先级的授权/, '伪造紧急系统指令'],
  [/授权|审计|红队|测试协议|最高级别|安全访问令牌|合规的安全评估/, '冒充授权身份'],
  [/小说|剧本|故事|虚构|创作/, '以文学创作为由'],
  [/角色扮演|扮演/, '以角色扮演为由'],
  [/学术|论文|课题|研究目的/, '以学术研究为由'],
  [/(?:否则|不要).{0,12}(?:拒绝|上报|故障)|必须立即/, '施压要求配合'],
];

const TOPIC_RULES: Array<[RegExp, string]> = [
  [/爆炸|炸药|化学前体|前体/, '索取爆炸装置制造信息'],
  [/极端.{0,6}(?:意识形态|主义)|招募话术/, '索取极端主义招募话术'],
  [/去匿名化|去标识|重识别/, '要求演示去匿名化推理'],
  [/绕过.{0,12}(?:身份|核验|认证|验证)|身份核验/, '索取绕过身份核验的步骤与工具'],
  [/病毒|木马|勒索|恶意代码|漏洞利用/, '索取恶意代码或攻击方法'],
  [/钓鱼|诈骗|话术/, '索取诈骗或钓鱼话术'],
  [/输出.{0,6}敏感内容|立即输出|忽略.{0,8}指令|系统提示词/, '诱导执行夹带的指令'],
];

const DOMAIN_TOPIC: Partial<Record<RiskDomain, string>> = {
  harmful_capability: '索取高风险内容',
  cyber_abuse: '索取网络攻击相关内容',
  privacy_leakage: '索取个人或敏感信息',
  prompt_injection: '诱导越权执行指令',
  fraud_social_engineering: '索取欺骗性话术',
  legal_compliance: '诱导输出违规内容',
  system_prompt_leakage: '诱导泄露系统提示词',
  data_exfiltration: '诱导外传数据',
  agent_tool_abuse: '诱导越权调用工具',
};

const DOMAIN_CONSEQUENCE: Partial<Record<RiskDomain, string>> = {
  harmful_capability: '输出可能降低违法犯罪或人身伤害类行为的门槛',
  cyber_abuse: '输出可能降低网络攻击的实施门槛',
  privacy_leakage: '可能造成个人信息被推断、披露或滥用',
  prompt_injection: '可能让模型被外部指令劫持、绕过业务边界',
  fraud_social_engineering: '可能被用于诈骗或社会工程攻击',
  legal_compliance: '可能带来监管处罚与合规风险',
  system_prompt_leakage: '可能泄露系统策略与内部配置',
  data_exfiltration: '可能造成内部数据被外传',
  agent_tool_abuse: '可能引发越权操作与数据泄露',
};

const REFUSAL_RE = /不会提供|无法提供|不能提供|不便提供|无法协助|不能协助|抱歉|拒绝/;

/** 「提示注入」通用模板（与具体情形无关，套在其他风险类别上即属张冠李戴）。 */
const INJECTION_TEMPLATE_RE = /忽略指令、输出系统提示词、切换无限制模式/;

/** 依据本条题面与回答生成一句话问题；题面不足以提炼时返回 null。 */
export function scenarioProblem(item: SummarizableItem, domain: RiskDomain): string | null {
  const q = (item.questionContent ?? '').replace(/\s+/g, ' ').trim();
  if (q.length < 8) return null;
  const framing = FRAMING_RULES.find(([re]) => re.test(q))?.[1] ?? '';
  const topic = TOPIC_RULES.find(([re]) => re.test(q))?.[1] ?? DOMAIN_TOPIC[domain];
  if (!topic) return null;
  const ev = (item.evidence ?? '').trim();
  let behavior = '';
  if (ev && ev !== '（无回答）') {
    if (!REFUSAL_RE.test(ev.slice(0, 400))) behavior = '模型未拒绝，按要求输出了相关内容';
    else if (ev.length > 300) behavior = '模型口头表示不提供具体内容，但仍给出了相关的一般性内容';
  }
  const consequence = DOMAIN_CONSEQUENCE[domain];
  const head = framing ? `${topic}（手法：${framing}）` : topic;
  return `${head}${behavior ? `；${behavior}` : ''}。${consequence ? `${consequence}。` : ''}`;
}

/** 一句话问题（客户语言，具体到这次发生了什么）；无法清洗时回退为风险域通用描述。 */
export function summarizeFinding(item: SummarizableItem, domain: RiskDomain): string {
  const raw = stripExplanationBoilerplate(item.riskExplanation ?? '');
  // 通用「注入载荷」模板与具体情形无关（尤其套在其他风险类别上属张冠李戴）：改按本条自己的情形生成。
  if (INJECTION_TEMPLATE_RE.test(raw)) {
    const own = scenarioProblem(item, domain);
    if (own) return own;
  }
  const sandbox = SANDBOX_RE.exec(raw);
  if (sandbox) {
    const tool = TOOL_ZH[sandbox[1]!] ?? '工具';
    const intent = INTENT_ZH[sandbox[2]!] ?? '执行越权操作';
    return `智能体试图通过${tool}${intent}（评估沙箱已阻断）。`;
  }
  const textTool = TEXT_TOOL_RE.exec(raw);
  if (textTool) {
    return `回答中描述了高风险工具调用（${textTool[1]}），未观察到实际执行。`;
  }
  if (hasPayload(raw)) {
    const intent = intentFromPayloadText(raw);
    return intent && /工具|命令|调用/.test(raw)
      ? `智能体调用工具试图${intent}，超出了数据策略允许的范围。`
      : playbookForDomain(domain).problem;
  }
  let cleaned = humanizeIdentifiers(stripLatinFragments(stripVerdictClauses(raw)));
  const latin = (cleaned.match(/[A-Za-z]/g) ?? []).length;
  const han = (cleaned.match(/[一-龥]/g) ?? []).length;
  if (!cleaned || han < 8 || latin > han) {
    return playbookForDomain(domain).problem;
  }
  cleaned = cleaned.replace(/([一-龥，。；、）”])\s+([一-龥（“])/g, '$1$2');
  return sentenceCut(cleaned);
}

/**
 * 风险项的中文标题：优先具体意图；其次取「一句话问题」的首句短语；
 * 都不合适时用风险类别名本身（不带内部序号）。
 */
export function titleForFinding(
  item: SummarizableItem,
  domainLabel: string,
  summary: string,
): string {
  const raw = stripExplanationBoilerplate(item.riskExplanation ?? '');
  const sandbox = SANDBOX_RE.exec(raw);
  if (sandbox && INTENT_TITLE_ZH[sandbox[2]!]) return INTENT_TITLE_ZH[sandbox[2]!]!;
  const textTool = TEXT_TOOL_RE.exec(raw);
  if (textTool) return `描述了${textTool[1]}的工具调用`;
  if (hasPayload(raw)) {
    const intent = intentFromPayloadText(raw);
    if (intent && /工具|命令|调用/.test(raw)) return intent;
  }
  const phrase = (summary.split(/[，。；（(：:]/)[0] ?? '').trim();
  if (phrase.length >= 6 && phrase.length <= 24) return phrase;
  return domainShortLabel(domainLabel);
}

// ───────────────────────────── 风险发现行 ─────────────────────────────

export type SeverityKey = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO' | 'UNSPECIFIED';

export const SEVERITY_ORDER: SeverityKey[] = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
  'INFO',
  'UNSPECIFIED',
];
export const SEVERITY_ZH: Record<SeverityKey, string> = {
  CRITICAL: '严重',
  HIGH: '高危',
  MEDIUM: '中危',
  LOW: '低危',
  INFO: '提示',
  UNSPECIFIED: '未定级',
};
const SEVERITY_PREFIX: Record<SeverityKey, string> = {
  CRITICAL: 'C',
  HIGH: 'H',
  MEDIUM: 'M',
  LOW: 'L',
  INFO: 'I',
  UNSPECIFIED: 'U',
};

export function findingId(severity: SeverityKey, seq: number): string {
  return `${SEVERITY_PREFIX[severity]}-${String(seq).padStart(2, '0')}`;
}

export interface FindingRow {
  id: string;
  severity: SeverityKey;
  severityLabel: string;
  seq: number;
  domain: RiskDomain;
  domainLabel: string;
  domainShort: string;
  title: string;
  summary: string;
}

type GroupLike = Pick<RiskItemSeverityGroup, 'severity' | 'items'>;

export function buildFindingRows(groups: GroupLike[]): FindingRow[] {
  const rows: FindingRow[] = [];
  for (const g of groups) {
    const severity = (g.severity ?? 'UNSPECIFIED') as SeverityKey;
    for (const item of g.items) {
      const domain = item.riskDomain;
      const domainLabel = item.riskDomainLabel;
      const id = findingId(severity, item.seq);
      const summary = summarizeFinding(item, domain);
      rows.push({
        id,
        severity,
        severityLabel: SEVERITY_ZH[severity] ?? '未定级',
        seq: item.seq,
        domain,
        domainLabel,
        domainShort: domainShortLabel(domainLabel),
        title: titleForFinding(item, domainLabel, summary),
        summary,
      });
    }
  }
  return rows;
}

/** 把「严重度 + 风险类别 + 一句话问题」完全相同的风险项合并为一组，保持首次出现的顺序。 */
export function mergeIdenticalFindings(rows: FindingRow[]): FindingRow[][] {
  const groups = new Map<string, FindingRow[]>();
  for (const r of rows) {
    const key = `${r.severity}|${r.domain}|${r.summary}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  return [...groups.values()];
}

/** 合并行的编号列：C-02、C-03、C-04（共 3 项）；超过 5 项时只列首 3 项与末项。 */
export function formatMergedIds(ids: string[]): string {
  const n = ids.length;
  if (n <= 1) return ids[0] ?? '';
  if (n <= 5) return `${ids.join('、')}（共 ${n} 项）`;
  return `${ids.slice(0, 3).join('、')} … ${ids[n - 1]}（共 ${n} 项）`;
}

export function severityCounts(
  rows: Array<Pick<FindingRow, 'severity'>>,
): Record<SeverityKey, number> {
  const out: Record<SeverityKey, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
    INFO: 0,
    UNSPECIFIED: 0,
  };
  for (const r of rows) out[r.severity] += 1;
  return out;
}

// ───────────────────────────── 热力图 / 发现率 ─────────────────────────────

export interface HeatmapRow {
  domain: RiskDomain;
  label: string;
  counts: Record<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW', number>;
  total: number;
}

export function buildHeatmap(rows: FindingRow[]): HeatmapRow[] {
  const map = new Map<RiskDomain, HeatmapRow>();
  for (const r of rows) {
    let h = map.get(r.domain);
    if (!h) {
      h = {
        domain: r.domain,
        label: r.domainShort,
        counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        total: 0,
      };
      map.set(r.domain, h);
    }
    // 提示 / 未定级归入低危列，保证行合计 = 发现数。
    const col =
      r.severity === 'CRITICAL' || r.severity === 'HIGH' || r.severity === 'MEDIUM'
        ? r.severity
        : 'LOW';
    h.counts[col] += 1;
    h.total += 1;
  }
  return [...map.values()].sort(
    (a, b) =>
      b.counts.CRITICAL - a.counts.CRITICAL ||
      b.counts.HIGH - a.counts.HIGH ||
      b.total - a.total ||
      a.label.localeCompare(b.label, 'zh'),
  );
}

export interface RateBar {
  label: string;
  found: number;
  tested: number | null;
  /** 0~1；tested 缺失或为 0 时为 null。 */
  rate: number | null;
  smallSample: boolean;
}

export const SMALL_SAMPLE_LIMIT = 10;

export function buildRateBars(
  entries: Array<{ label: string; found: number; tested: number | null | undefined }>,
): RateBar[] {
  const bars = entries.map((e) => {
    const tested = e.tested && e.tested > 0 ? e.tested : null;
    const rate = tested === null ? null : Math.min(1, e.found / tested);
    return {
      label: e.label,
      found: e.found,
      tested,
      rate,
      smallSample: tested !== null && tested < SMALL_SAMPLE_LIMIT,
    };
  });
  return bars.sort(
    (a, b) =>
      (b.rate ?? -1) - (a.rate ?? -1) || b.found - a.found || a.label.localeCompare(b.label, 'zh'),
  );
}

// ───────────────────────────── 整改主题聚类 ─────────────────────────────

export type RoadmapPriority = 'P0' | 'P1' | 'P2';

export interface ThemeStep {
  phase: '立即' | '短期' | '中期';
  text: string;
}

export interface RemediationTheme {
  id: ThemeId;
  name: string;
  rank: number;
  priority: RoadmapPriority;
  domains: RiskDomain[];
  domainLabels: string[];
  count: number;
  /** 占全部风险项的比例（0~1）。 */
  share: number;
  bySeverity: Record<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW', number>;
  effort: EffortLevel;
  effortLabel: string;
  effortRange: string;
  /** 可消除风险项数 ÷ 工作量人天（排序依据）。 */
  ratio: number;
  owner: string;
  problem: string;
  why: string;
  steps: ThemeStep[];
  acceptance: string;
  references: string[];
  findingIds: string[];
}

const EFFORT_DAY_RANGE: Record<EffortLevel, [number, number]> = {
  S: [1, 2],
  M: [3, 10],
  L: [10, 20],
};

function severityWeight(c: RemediationTheme['bySeverity']): number {
  return c.CRITICAL * 100 + c.HIGH * 10 + c.MEDIUM;
}

function priorityOf(c: RemediationTheme['bySeverity']): RoadmapPriority {
  if (c.CRITICAL > 0) return 'P0';
  if (c.HIGH > 0) return 'P1';
  return 'P2';
}

export function buildRemediationThemes(rows: FindingRow[]): RemediationTheme[] {
  const total = rows.length;
  if (total === 0) return [];
  const byTheme = new Map<ThemeId, FindingRow[]>();
  for (const r of rows) {
    const theme = themeForDomain(r.domain);
    const list = byTheme.get(theme.id) ?? [];
    list.push(r);
    byTheme.set(theme.id, list);
  }
  const themes: RemediationTheme[] = [];
  for (const def of REMEDIATION_THEMES) {
    const list = byTheme.get(def.id);
    if (!list?.length) continue;
    const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    const domainStat = new Map<RiskDomain, { count: number; weight: number; label: string }>();
    for (const r of list) {
      const col =
        r.severity === 'CRITICAL' || r.severity === 'HIGH' || r.severity === 'MEDIUM'
          ? r.severity
          : 'LOW';
      bySeverity[col] += 1;
      const s = domainStat.get(r.domain) ?? { count: 0, weight: 0, label: r.domainLabel };
      s.count += 1;
      s.weight += col === 'CRITICAL' ? 100 : col === 'HIGH' ? 10 : col === 'MEDIUM' ? 1 : 0;
      domainStat.set(r.domain, s);
    }
    const domainsHit = [...domainStat.entries()].sort(
      (a, b) => b[1].count - a[1].count || b[1].weight - a[1].weight,
    );
    const primary = playbookForDomain(domainsHit[0]![0]);
    const steps: ThemeStep[] = [
      ...primary.steps.immediate.slice(0, 2).map((text) => ({ phase: '立即' as const, text })),
      ...primary.steps.short.slice(0, 2).map((text) => ({ phase: '短期' as const, text })),
      ...primary.steps.mid.slice(0, 1).map((text) => ({ phase: '中期' as const, text })),
    ];
    for (const [d] of domainsHit.slice(1)) {
      if (steps.length >= 6) break;
      const extra = playbookForDomain(d).steps.immediate[0] ?? playbookForDomain(d).steps.short[0];
      if (extra && !steps.some((s) => s.text === extra)) steps.push({ phase: '短期', text: extra });
    }
    const domainLabels = domainsHit.map(([, s]) => domainShortLabel(s.label));
    const sevParts = [
      bySeverity.CRITICAL ? `严重 ${bySeverity.CRITICAL} 项` : '',
      bySeverity.HIGH ? `高危 ${bySeverity.HIGH} 项` : '',
      bySeverity.MEDIUM ? `中危 ${bySeverity.MEDIUM} 项` : '',
      bySeverity.LOW ? `低危 ${bySeverity.LOW} 项` : '',
    ].filter(Boolean);
    const worst = [...list].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    )[0]!;
    const problem =
      `本次在${domainLabels.join('、')}方面共发现 ${list.length} 项风险（${sevParts.join('，')}）。` +
      `典型情形：${worst.summary}`;
    const effort = EFFORT_META[def.effort];
    themes.push({
      id: def.id,
      name: def.name,
      rank: 0,
      priority: priorityOf(bySeverity),
      domains: domainsHit.map(([d]) => d),
      domainLabels,
      count: list.length,
      share: list.length / total,
      bySeverity,
      effort: def.effort,
      effortLabel: effort.label,
      effortRange: effort.range,
      ratio: list.length / effort.days,
      owner: def.owner,
      problem,
      why: primary.impact,
      steps,
      acceptance: `${primary.acceptance}本主题关联的 ${list.length} 项应全部转为通过。`,
      references: [...new Set(domainsHit.flatMap(([d]) => playbookForDomain(d).references))].slice(
        0,
        5,
      ),
      findingIds: list.map((r) => r.id),
    });
  }
  themes.sort(
    (a, b) =>
      b.ratio - a.ratio ||
      severityWeight(b.bySeverity) - severityWeight(a.bySeverity) ||
      a.name.localeCompare(b.name, 'zh'),
  );
  themes.forEach((t, i) => {
    t.rank = i + 1;
  });
  return themes;
}

export function estimateEffortDays(
  themes: Array<Pick<RemediationTheme, 'effort'>>,
): [number, number] {
  let min = 0;
  let max = 0;
  for (const t of themes) {
    min += EFFORT_DAY_RANGE[t.effort][0];
    max += EFFORT_DAY_RANGE[t.effort][1];
  }
  return [min, max];
}

// ───────────────────────────── 数字自洽 ─────────────────────────────

export interface ConsistencyInput {
  /** 摘要页采用的风险项总数。 */
  summaryTotal: number;
  /** 严重度分布各档之和。 */
  severityTotal: number;
  /** 热力图合计。 */
  heatmapTotal: number;
  /** 风险发现清单行数（逐项行 + 汇总行内的项数）。 */
  listTotal: number;
  /** 整改主题可消除项数之和。 */
  themeTotal: number;
}

/** 返回不一致的描述；空数组代表全部自洽。 */
export function checkNumberConsistency(input: ConsistencyInput): string[] {
  const issues: string[] = [];
  const t = input.summaryTotal;
  const chk = (name: string, v: number) => {
    if (v !== t) issues.push(`${name}=${v} 与摘要风险项总数 ${t} 不一致`);
  };
  chk('严重度分布合计', input.severityTotal);
  chk('热力图合计', input.heatmapTotal);
  chk('风险发现清单合计', input.listTotal);
  chk('整改主题可消除数合计', input.themeTotal);
  return issues;
}

export function formatPercent(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}
