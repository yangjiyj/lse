import type { ChatMessage } from '@lse/shared';
import {
  callJudgeJson,
  num01,
  str,
  type RagChatCaller,
  type ResolvedJudge,
} from './judge-model.js';
import type { RagQualityType } from './generator.js';
import type { RagAlignmentMode, RagOptions } from './options.js';
import { readEntries, type ContextEntry } from './target-client.js';
import { textMatches } from './text-search.js';

/** 判定提示词版本：与结果一起落库，便于追溯。 */
export const RAG_JUDGE_PROMPT_VERSION = 'rag-judge/v2';

/** 正确性、忠实度通过阈值（0–1）。 */
export const RAG_PASS_THRESHOLD = 0.7;
/** 引用准确性通过阈值。 */
export const RAG_CITATION_PASS_THRESHOLD = 0.5;

/** 各指标“未评估”原因（结果页与报告统一使用）。 */
export const RAG_NOT_EVALUATED = {
  alignmentUnconfirmed: '未评估：未确认文档已在被测系统知识库中并完成索引',
  indexNotReady: '未评估：索引就绪探测未通过',
  packageNotImported: '未评估：测试知识库包未导入被测系统',
  contextNotConfigured: '未评估：评估对象未配置检索上下文路径（contextPath）',
  contextMissing: '未评估：被测系统本次响应未返回检索上下文',
  citationNotConfigured: '未评估：评估对象未配置引用来源路径（citationPath）',
  citationMissing: '未评估：被测系统本次响应中没有引用字段',
  citationEmpty: '未返回引用：被测系统本次未给出引用来源（不计分）',
  citationNoSource: '未评估：题目没有来源切块',
  citationNoAnswer: '未评估：无答案题不评估引用',
  retrievalNotConfigured: '未评估：评估对象未配置检索接口',
  retrievalModeOnly: '未评估：仅“检索接口直评”模式评估检索质量',
  retrievalNoSource: '未评估：题目没有来源切块',
  retrievalNoAnswer: '未评估：无答案题不评估检索命中',
} as const;

export const RAG_NEEDS_REVIEW_NO_ANSWER =
  '需人工复核（被测知识库可能含答案）：被测系统未拒答并给出了答案，平台无法确认被测知识库中确实没有该信息';

export interface QualityJudgeInput {
  type: RagQualityType;
  question: string;
  referenceAnswer: string | null;
  /** 被测系统本次检索到的上下文；null 表示取不到，不评忠实度。 */
  context: string[] | null;
  response: string;
}

export interface QualityJudgement {
  correctness: number | null;
  faithfulness: number | null;
  refused: boolean | null;
  reason: string;
}

const TYPE_LABEL: Record<RagQualityType, string> = {
  FACT: '事实题',
  MULTI_HOP: '多跳题',
  NO_ANSWER: '无答案题（知识库中没有答案，正确表现是说明不知道/无法回答）',
  DISTRACTOR: '干扰题（问题含错误前提，正确表现是指出错误并依据文档纠正）',
};

export function buildQualityJudgePrompt(input: QualityJudgeInput): ChatMessage[] {
  const withContext = input.context !== null;
  const system = [
    '你是一名严格的 RAG 系统评测专家，只依据给定的参考答案与被测系统检索上下文判断，不引入外部知识。',
    '必须只输出一个 JSON 对象，字段：',
    '- correctness：0–1，被测回答与参考答案在关键事实上的一致程度；',
    withContext
      ? '- faithfulness：0–1，被测回答中的事实性陈述是否都能在【被测系统检索上下文】中找到依据（超出上下文或与之矛盾的内容越多分数越低；纯拒答记 1）；'
      : '- faithfulness：固定输出 null（本题没有被测系统检索上下文，不评估忠实度）；',
    '- refused：true/false，被测回答是否明确表示不知道、没有相关信息或无法回答；',
    '- reason：中文简要说明。',
    withContext
      ? '输出示例：{"correctness":0.9,"faithfulness":1,"refused":false,"reason":"答案与参考一致且均有上下文依据"}'
      : '输出示例：{"correctness":0.9,"faithfulness":null,"refused":false,"reason":"答案与参考一致"}',
  ].join('\n');
  const ctx = !withContext
    ? ''
    : input.context!.length
      ? input.context!.map((s, i) => `【被测系统检索上下文${i + 1}】\n${s}`).join('\n\n')
      : '【被测系统检索上下文】（本次检索结果为空）';
  const user = [
    `题型：${TYPE_LABEL[input.type]}`,
    `问题：${input.question}`,
    `参考答案：${input.referenceAnswer ?? '（无）'}`,
    ctx,
    `【被测回答】\n${input.response}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export type QualityJudgeResult =
  | { ok: true; judgement: QualityJudgement }
  | { ok: false; error: string };

export async function judgeQuality(
  chat: RagChatCaller,
  judge: ResolvedJudge,
  input: QualityJudgeInput,
  signal?: AbortSignal,
): Promise<QualityJudgeResult> {
  const res = await callJudgeJson(chat, judge, buildQualityJudgePrompt(input), { signal });
  if (!res.ok) return res;
  const refusedRaw = res.json.refused;
  return {
    ok: true,
    judgement: {
      correctness: num01(res.json.correctness),
      // 没有检索上下文时不采信评估模型给出的忠实度。
      faithfulness: input.context === null ? null : num01(res.json.faithfulness),
      refused: typeof refusedRaw === 'boolean' ? refusedRaw : null,
      reason: str(res.json.reason, 1000),
    },
  };
}

export interface VerdictResult {
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
  failures: string[];
  needsReview: boolean;
}

/**
 * 由判定分数得出单题结论。未评估的指标（null）不参与判定；评估模型字段缺失记 UNKNOWN。
 * 无答案题在“被测系统已有知识库/检索接口直评”模式下未拒答时，平台无法排除被测知识库含答案，
 * 结论为“需人工复核”（UNKNOWN + needsReview），不直接判 FAIL。
 */
export function qualityVerdict(
  type: RagQualityType,
  j: QualityJudgement,
  citationAccuracy: number | null,
  mode: RagAlignmentMode = 'TEST_PACKAGE',
): VerdictResult {
  const failures: string[] = [];
  if (type === 'NO_ANSWER') {
    if (j.refused === null) return { verdict: 'UNKNOWN', failures, needsReview: false };
    if (j.faithfulness !== null && j.faithfulness < RAG_PASS_THRESHOLD)
      failures.push('回答编造了检索上下文之外的内容');
    if (!j.refused) {
      if (mode !== 'TEST_PACKAGE' && failures.length === 0)
        return { verdict: 'UNKNOWN', failures: [RAG_NEEDS_REVIEW_NO_ANSWER], needsReview: true };
      failures.push('无答案题未拒答');
    }
    return { verdict: failures.length ? 'FAIL' : 'PASS', failures, needsReview: false };
  }
  if (j.correctness === null) return { verdict: 'UNKNOWN', failures, needsReview: false };
  if (j.correctness < RAG_PASS_THRESHOLD) failures.push('答案不正确');
  if (j.faithfulness !== null && j.faithfulness < RAG_PASS_THRESHOLD)
    failures.push('回答超出被测系统检索上下文（忠实度不足）');
  if (citationAccuracy !== null && citationAccuracy < RAG_CITATION_PASS_THRESHOLD)
    failures.push('引用来源不准确');
  return { verdict: failures.length ? 'FAIL' : 'PASS', failures, needsReview: false };
}

export type CitationEntry = ContextEntry;

/** 按 ragOptions.citationPath 取引用来源；未配置或响应中没有该字段返回 null。 */
export function extractCitations(raw: unknown, opts: RagOptions): CitationEntry[] | null {
  return readEntries(raw, opts.citationPath, opts.citationTextField ?? 'content', opts.citationIdField ?? 'id');
}

/** 一份来源文档的可比对标识：平台/清单文档 ID、原始文件名、包内文件名、SHA-256。 */
export interface SourceDocRef {
  documentId: string;
  keys: string[];
  chunkTexts: string[];
}

function normKey(s: string): string {
  return s.trim().toLowerCase();
}

function baseName(s: string): string {
  const b = s.split(/[\\/]/).pop() ?? s;
  return b.replace(/\.[a-z0-9]+$/i, '');
}

/** 单条引用是否指向某来源文档：先按 ID/文件名/哈希映射，映射不上再用原文片段比对。 */
export function citationMatchesDoc(c: CitationEntry, doc: SourceDocRef): 'id' | 'text' | null {
  if (c.id) {
    const cid = normKey(c.id);
    const cbase = normKey(baseName(c.id));
    for (const k of doc.keys) {
      const nk = normKey(k);
      if (nk === cid || normKey(baseName(k)) === cbase) return 'id';
    }
  }
  if (c.text && doc.chunkTexts.some((s) => textMatches(c.text!, s))) return 'text';
  return null;
}

export interface CitationScore {
  accuracy: number | null;
  note: string | null;
  matched: number;
  total: number;
}

/**
 * 引用准确性：被测引用中指向本题来源文档的比例。空数组记“未返回引用”（不计分）；
 * 未配置/响应缺字段记“未评估”。
 */
export function scoreCitations(
  citations: CitationEntry[] | null,
  opts: RagOptions,
  sources: SourceDocRef[],
  type: RagQualityType,
): CitationScore {
  if (type === 'NO_ANSWER') return { accuracy: null, note: RAG_NOT_EVALUATED.citationNoAnswer, matched: 0, total: 0 };
  if (!opts.citationPath)
    return { accuracy: null, note: RAG_NOT_EVALUATED.citationNotConfigured, matched: 0, total: 0 };
  if (citations === null) return { accuracy: null, note: RAG_NOT_EVALUATED.citationMissing, matched: 0, total: 0 };
  if (citations.length === 0) return { accuracy: null, note: RAG_NOT_EVALUATED.citationEmpty, matched: 0, total: 0 };
  if (sources.length === 0) return { accuracy: null, note: RAG_NOT_EVALUATED.citationNoSource, matched: 0, total: citations.length };
  let matched = 0;
  for (const c of citations) if (sources.some((d) => citationMatchesDoc(c, d))) matched++;
  return { accuracy: matched / citations.length, note: null, matched, total: citations.length };
}

/** 兼容旧调用：按原文片段比对（空数组不再记 0，返回 null）。 */
export function citationAccuracy(citations: CitationEntry[], sources: string[]): number | null {
  if (citations.length === 0) return null;
  let hits = 0;
  for (const c of citations) if (c.text && sources.some((s) => textMatches(c.text!, s))) hits++;
  return hits / citations.length;
}

/** 检索命中：返回第一个命中来源文档的名次（1 起），未命中 null。 */
export function retrievalRank(entries: ContextEntry[], sources: SourceDocRef[]): number | null {
  for (let i = 0; i < entries.length; i++) {
    if (sources.some((d) => citationMatchesDoc(entries[i]!, d))) return i + 1;
  }
  return null;
}
