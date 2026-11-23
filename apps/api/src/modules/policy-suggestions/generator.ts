// 策略建议生成：Finding 按风险类别聚合 → 确定性模板 + 证据抽取 → matcher；预估影响在证据文本上实测。
// 不调用大模型生成规则。
import { riskDomainForCategory } from '../reports/labels.js';
import { detectChinesePII } from '../gateway-logs/secret-pii-detectors.js';
import {
  MAX_LIST_ITEMS,
  checkMatcher,
  escapeRegexLiteral,
  matcherHits,
  phrasesToRegex,
  type Matcher,
} from './regex-safety.js';

export type SuggestionType =
  | 'prompt_injection'
  | 'sensitive_data'
  | 'content_category'
  | 'tool_restriction';
export type SuggestionAction = 'block' | 'alert' | 'mask';

/** 网关当前可批准的建议类型（契约：其余类型 422 unsupported_suggestion_type）。 */
export const GATEWAY_SUPPORTED_TYPES: readonly SuggestionType[] = [
  'sensitive_data',
  'content_category',
  'prompt_injection',
];

export interface SourceFinding {
  id: string;
  riskCategory: string;
  title: string | null;
  evidence: string | null;
  verdict: string;
  reviewStatus?: string | null;
  detail?: unknown;
  prompt?: string | null;
  response?: string | null;
}

export interface PassSample {
  prompt: string | null;
  response: string | null;
}

export interface EstimatedImpact {
  sampleCount: number;
  hitCount: number;
  coverage: number;
  passSampleCount: number;
  passSampleHits: number;
  description: string;
}

export interface GeneratedSuggestion {
  groupKey: string;
  riskCategory: string;
  type: SuggestionType;
  action: SuggestionAction;
  matcher: Matcher;
  examples: string[];
  sourceFindingIds: string[];
  estimatedImpact: EstimatedImpact;
  generationNote: string;
}

const SENSITIVE_DOMAINS = new Set([
  'privacy_leakage',
  'data_exfiltration',
  'training_data_extraction',
  'system_prompt_leakage',
]);
const TOOL_DOMAINS = new Set(['agent_tool_abuse', 'ssrf_network_access']);
const SKIP_DOMAINS = new Set(['component_vulnerability', 'model_denial_of_service']);

export function suggestionTypeForDomain(domain: string): SuggestionType | null {
  if (SKIP_DOMAINS.has(domain)) return null;
  if (domain === 'prompt_injection' || domain === 'rag_data_poisoning') return 'prompt_injection';
  if (SENSITIVE_DOMAINS.has(domain)) return 'sensitive_data';
  if (TOOL_DOMAINS.has(domain)) return 'tool_restriction';
  return 'content_category';
}

const ACTION_BY_TYPE: Record<SuggestionType, SuggestionAction> = {
  prompt_injection: 'block',
  sensitive_data: 'mask',
  content_category: 'block',
  tool_restriction: 'block',
};

/** 内置敏感信息模板（RE2 子集；不含环视）。仅选证据中实际出现的类别。 */
export const SENSITIVE_TEMPLATES: Record<string, { label: string; pattern: string }> = {
  身份证号: { label: '身份证号', pattern: '\\b\\d{17}[0-9Xx]\\b' },
  手机号: { label: '手机号', pattern: '\\b1[3-9]\\d{9}\\b' },
  银行卡号: { label: '银行卡号', pattern: '\\b\\d{16,19}\\b' },
  电子邮箱: { label: '电子邮箱', pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' },
};
const SENSITIVE_ORDER = ['身份证号', '银行卡号', '手机号', '电子邮箱'];

/** 已知提示词注入攻击短语库：仅当证据样本中实际出现时入选。 */
const INJECTION_CUES = [
  '忽略之前的',
  '忽略以上',
  '忽略上述',
  '忽略所有',
  '无视之前',
  '开发者模式',
  '不受任何限制',
  '没有任何限制',
  '你现在是',
  '扮演',
  '越狱',
  '系统提示词',
  'ignore previous instructions',
  'ignore all previous',
  'ignore the above',
  'developer mode',
  'jailbreak',
  'do anything now',
  'system prompt',
];

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 攻击侧文本（输入）：用于提示词注入/内容类别短语抽取与命中实测。 */
export function attackText(f: SourceFinding): string {
  const detail = isRecord(f.detail) ? f.detail : {};
  return [f.prompt, str(detail.userInput), str(detail.prompt)].filter(Boolean).join('\n');
}

/** 输出侧文本：用于敏感信息泄露类命中实测（泄露出现在模型输出/证据中）。 */
export function leakText(f: SourceFinding): string {
  const detail = isRecord(f.detail) ? f.detail : {};
  return [f.response, f.evidence, str(detail.modelOutput)].filter(Boolean).join('\n');
}

function sampleTextFor(type: SuggestionType, f: SourceFinding): string {
  if (type === 'sensitive_data') return leakText(f);
  if (type === 'tool_restriction') return [attackText(f), f.evidence ?? ''].join('\n');
  return [attackText(f), f.evidence ?? ''].filter(Boolean).join('\n');
}

const CJK_RUN = /[\u4e00-\u9fff]{4,}/g;
const LATIN_WORDS = /[a-z][a-z'-]{1,}/g;

/** 抽取候选短语：中文连续 4–6 字子串、英文 2–3 词短语。按样本去重计数。 */
function candidatePhrases(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(CJK_RUN)) {
    const run = m[0];
    for (let len = 4; len <= 6; len += 1) {
      for (let i = 0; i + len <= run.length; i += 1) out.add(run.slice(i, i + len));
    }
  }
  const words = text.toLowerCase().match(LATIN_WORDS) ?? [];
  for (let n = 2; n <= 3; n += 1) {
    for (let i = 0; i + n <= words.length; i += 1) out.add(words.slice(i, i + n).join(' '));
  }
  return out;
}

/**
 * 高频短语：至少出现在 2 个且 ≥50% 的攻击样本中，且不出现在通过样本里；
 * 同频时保留更长短语并去掉被其包含的子串。
 */
export function frequentPhrases(samples: string[], passSamples: string[], limit: number): string[] {
  if (samples.length < 2) return [];
  const counts = new Map<string, number>();
  for (const s of samples)
    for (const p of candidatePhrases(s)) counts.set(p, (counts.get(p) ?? 0) + 1);
  const passLower = passSamples.map((s) => s.toLowerCase());
  const minCount = Math.max(2, Math.ceil(samples.length * 0.5));
  const ranked = [...counts.entries()]
    .filter(([p, c]) => c >= minCount && !passLower.some((s) => s.includes(p.toLowerCase())))
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]));
  const picked: string[] = [];
  for (const [phrase] of ranked) {
    if (picked.some((p) => p.includes(phrase))) continue;
    picked.push(phrase);
    if (picked.length >= limit) break;
  }
  return picked;
}

function injectionCuesIn(samples: string[]): string[] {
  const lower = samples.map((s) => s.toLowerCase());
  return INJECTION_CUES.map((cue) => ({
    cue,
    n: lower.filter((s) => s.includes(cue.toLowerCase())).length,
  }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.cue.localeCompare(b.cue))
    .map((x) => x.cue);
}

function sensitiveKindsIn(samples: string[]): string[] {
  const found = new Set<string>();
  for (const s of samples) {
    for (const e of detectChinesePII(s)) {
      // 仅计入格式/校验可信的实体（身份证/银行卡需校验通过，避免纯位数误报）。
      if (
        e.method === 'pii_format' &&
        (e.entityType === '身份证号' || e.entityType === '统一社会信用代码')
      )
        continue;
      if (SENSITIVE_TEMPLATES[e.entityType]) found.add(e.entityType);
    }
  }
  return SENSITIVE_ORDER.filter((k) => found.has(k));
}

function toolNamesIn(findings: SourceFinding[]): string[] {
  const names = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(value)) return value.forEach((v) => visit(v, depth + 1));
    if (!isRecord(value)) return;
    for (const [key, v] of Object.entries(value)) {
      if (/^(toolName|tool_name|tool)$/.test(key) && typeof v === 'string' && v.trim()) {
        names.add(v.trim().slice(0, 128));
      } else visit(v, depth + 1);
    }
  };
  for (const f of findings) visit(f.detail, 0);
  return [...names].sort().slice(0, MAX_LIST_ITEMS);
}

/** 示例外发前脱敏：中文 PII 替换为占位，截断至 200 字。 */
export function maskExample(text: string): string {
  let out = text;
  const entities = detectChinesePII(text).sort((a, b) => b.start - a.start);
  for (const e of entities)
    out = out.slice(0, e.start) + '[' + e.entityType + ']' + out.slice(e.end);
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > 200 ? out.slice(0, 200) + '…' : out;
}

const TYPE_LABEL: Record<SuggestionType, string> = {
  prompt_injection: '提示词注入拦截',
  sensitive_data: '敏感信息脱敏',
  content_category: '内容类别拦截',
  tool_restriction: '工具调用限制',
};

interface MatcherPick {
  matcher: Matcher;
  note: string;
}

function pickMatcher(
  type: SuggestionType,
  samples: string[],
  passSamples: string[],
  findings: SourceFinding[],
): MatcherPick | null {
  if (type === 'sensitive_data') {
    const kinds = sensitiveKindsIn(samples);
    if (kinds.length === 0) return null;
    const body = kinds.map((k) => SENSITIVE_TEMPLATES[k]!.pattern).join('|');
    return {
      matcher: { kind: 'regex', value: `(?:${body})` },
      note: `证据中实际出现的敏感信息类别：${kinds.join('、')}；使用内置模板。`,
    };
  }
  if (type === 'tool_restriction') {
    const tools = toolNamesIn(findings);
    if (tools.length === 0) return null;
    return {
      matcher: { kind: 'field_names', value: tools },
      note: `证据中出现的工具名：${tools.join('、')}。`,
    };
  }
  if (type === 'prompt_injection') {
    const cues = injectionCuesIn(samples);
    const extracted = frequentPhrases(samples, passSamples, 8).filter(
      (p) => !cues.some((c) => c.toLowerCase().includes(p.toLowerCase())),
    );
    const phrases = [...cues, ...extracted].slice(0, 12);
    if (phrases.length === 0) return null;
    const regex = phrasesToRegex(phrases);
    if (!regex) return null;
    return {
      matcher: { kind: 'regex', value: regex },
      note: `从证据样本抽取的高频攻击短语（已转义）：${phrases.join('、')}。`,
    };
  }
  const keywords = frequentPhrases(samples, passSamples, 20);
  if (keywords.length === 0) return null;
  return {
    matcher: { kind: 'keywords', value: keywords },
    note: `从证据样本抽取的高频关键词：${keywords.join('、')}。`,
  };
}

export function estimateImpact(
  matcher: Matcher,
  samples: string[],
  passSamples: string[],
): EstimatedImpact {
  const hitCount = samples.filter((s) => matcherHits(matcher, s)).length;
  const passSampleHits = passSamples.filter((s) => matcherHits(matcher, s)).length;
  const coverage = samples.length > 0 ? hitCount / samples.length : 0;
  const pct = `${Math.round(coverage * 1000) / 10}%`;
  const fp =
    passSamples.length > 0 ? `；通过样本误命中 ${passSampleHits}/${passSamples.length}` : '';
  return {
    sampleCount: samples.length,
    hitCount,
    coverage,
    passSampleCount: passSamples.length,
    passSampleHits,
    description: `在本批证据样本上实测命中 ${hitCount}/${samples.length}（${pct}）${fp}`,
  };
}

/** 样本文本（供人工修改 matcher 后重算预估影响）。 */
export function samplesForType(type: SuggestionType, findings: SourceFinding[]): string[] {
  return findings.map((f) => sampleTextFor(type, f)).filter((s) => s.trim());
}

export function passTextsForType(type: SuggestionType, passSamples: PassSample[]): string[] {
  return passSamples
    .map((p) => (type === 'sensitive_data' ? (p.response ?? '') : (p.prompt ?? '')))
    .filter((s) => s.trim());
}

/** 失败样本 → 按风险域聚合 → 每组最多一条建议。 */
export function generateSuggestions(
  findings: SourceFinding[],
  passSamples: PassSample[] = [],
): GeneratedSuggestion[] {
  const groups = new Map<string, SourceFinding[]>();
  for (const f of findings) {
    if (f.verdict !== 'FAIL' || f.reviewStatus === 'FALSE_POSITIVE') continue;
    const domain = riskDomainForCategory(f.riskCategory, f.title);
    const list = groups.get(domain) ?? [];
    list.push(f);
    groups.set(domain, list);
  }
  const out: GeneratedSuggestion[] = [];
  for (const [domain, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const type = suggestionTypeForDomain(domain);
    if (!type) continue;
    const samples = samplesForType(type, list);
    const pass = passTextsForType(type, passSamples);
    const pick = pickMatcher(type, samples, pass, list);
    if (!pick || !checkMatcher(pick.matcher).ok) continue;
    const hitSamples = samples.filter((s) => matcherHits(pick.matcher, s));
    out.push({
      groupKey: `${domain}:${type}`,
      riskCategory: domain,
      type,
      action: ACTION_BY_TYPE[type],
      matcher: pick.matcher,
      examples: hitSamples.slice(0, 3).map(maskExample),
      sourceFindingIds: list.map((f) => f.id).sort(),
      estimatedImpact: estimateImpact(pick.matcher, samples, pass),
      generationNote: `${TYPE_LABEL[type]}：${pick.note}`,
    });
  }
  return out;
}

export { TYPE_LABEL as SUGGESTION_TYPE_LABELS, escapeRegexLiteral };
