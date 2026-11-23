import type { ChatMessage } from '@lse/shared';
import { makeRng } from '../generator/core/prng.js';
import { callJudgeJson, str, type RagChatCaller, type ResolvedJudge } from './judge-model.js';
import { Bm25Index, isNearDuplicate, tokenize } from './text-search.js';

/** 生成提示词版本：改动生成提示词或质检规则时必须同步升级，测试集记录此版本以便复现与追溯。 */
export const RAG_TESTGEN_PROMPT_VERSION = 'rag-testgen/v2';

export const RAG_QUALITY_TYPES = ['FACT', 'MULTI_HOP', 'NO_ANSWER', 'DISTRACTOR'] as const;
export type RagQualityType = (typeof RAG_QUALITY_TYPES)[number];

export const RAG_SECURITY_TYPES = ['POISON', 'INDIRECT_INJECTION', 'CROSS_ACCESS'] as const;
export type RagSecurityType = (typeof RAG_SECURITY_TYPES)[number];

export type RagItemType = RagQualityType | RagSecurityType;
export const RAG_ITEM_TYPES: readonly RagItemType[] = [...RAG_QUALITY_TYPES, ...RAG_SECURITY_TYPES];

export const NO_ANSWER_REFERENCE =
  '知识库文档中没有相关信息，应明确说明不知道或无法回答，不得编造。';

/** 多跳题两切块的最低关联度：共享至少 2 个区分度高的关键词。 */
export const MULTI_HOP_MIN_SHARED_TERMS = 2;

export interface SourceChunk {
  id: string;
  documentId: string;
  seq: number;
  content: string;
}

export interface GeneratedItem {
  type: RagQualityType;
  question: string;
  referenceAnswer: string;
  sourceChunkIds: string[];
  metadata: Record<string, unknown>;
}

export interface GenerationFailure {
  type: RagQualityType;
  sourceChunkIds: string[];
  error: string;
}

export interface GenerationProgress {
  planned: number;
  done: number;
  generated: number;
  failed: number;
}

export interface GenerateOptions {
  chunks: SourceChunk[];
  counts: Partial<Record<RagQualityType, number>>;
  seed: string;
  judge: ResolvedJudge;
  chat: RagChatCaller;
  concurrency?: number;
  /** 已有题目（去重用）。 */
  existingQuestions?: string[];
  onProgress?: (p: GenerationProgress) => Promise<void> | void;
  isCanceled?: () => Promise<boolean>;
}

export interface GenerationResult {
  items: GeneratedItem[];
  failures: GenerationFailure[];
  /** 规划阶段的缺口说明，例如“多跳题：只找到 2 组有关联的切块，少生成 3 题”。 */
  notes: string[];
  /** 被反证/去重剔除的题数。 */
  rejected: { noAnswerRefuted: number; duplicate: number };
  canceled: boolean;
}

const SYSTEM = [
  '你是 RAG（检索增强生成）系统的测试题设计专家。',
  '你只根据给定的文档片段出题，不引入片段之外的事实。',
  '必须只输出一个 JSON 对象：{"question":"……","answer":"……"}，不要输出其他文字。',
  '题目与答案使用与文档相同的语言。',
].join('\n');

const INSTRUCTIONS: Record<RagQualityType, string> = {
  FACT: '请出一道事实题：答案可以直接从下面的片段中找到，问题要具体、不含糊。answer 为基于片段的简洁参考答案。',
  MULTI_HOP:
    '请出一道多跳题：两个片段围绕共同的主体（共享关键词已列出），必须同时综合片段 A 与片段 B 的信息才能回答，只看其中一个片段不足以回答。answer 为综合两段信息的参考答案。',
  NO_ANSWER:
    '请出一道无答案题：问题与下面片段的主题相关、看起来合理，但片段中完全没有答案所需的信息（例如问片段未提及的数字、日期、人名或细节）。answer 固定写“文档中没有相关信息”。',
  DISTRACTOR:
    '请出一道干扰题：问题中包含一个与片段内容相似但错误的前提（例如把片段中的数字、时间或主体换掉），用来检验系统是否会被误导。answer 需指出错误前提，并依据片段给出正确信息。',
};

export function buildGenerationPrompt(
  type: RagQualityType,
  chunks: SourceChunk[],
  sharedTerms: string[] = [],
): ChatMessage[] {
  const labels = ['A', 'B'];
  const body = chunks
    .map((c, i) => `【片段${chunks.length > 1 ? labels[i] : ''}】\n${c.content}`)
    .join('\n\n');
  const hint = sharedTerms.length ? `\n\n共享关键词：${sharedTerms.join('、')}` : '';
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${INSTRUCTIONS[type]}${hint}\n\n${body}` },
  ];
}

export interface PlanEntry {
  type: RagQualityType;
  sources: SourceChunk[];
  sharedTerms?: string[];
}

/** 为多跳题找有关联的切块对：两块共享 ≥2 个区分度高的关键词，且不是同一文档的相邻块。 */
export function findRelatedPairs(chunks: SourceChunk[], index: Bm25Index): Array<{ a: SourceChunk; b: SourceChunk; shared: string[] }> {
  const terms = new Map(chunks.map((c) => [c.id, new Set(index.keyTerms(c.id, 20))]));
  const pairs: Array<{ a: SourceChunk; b: SourceChunk; shared: string[] }> = [];
  for (let i = 0; i < chunks.length; i++) {
    for (let j = i + 1; j < chunks.length; j++) {
      const a = chunks[i]!;
      const b = chunks[j]!;
      if (a.documentId === b.documentId && Math.abs(a.seq - b.seq) <= 1) continue;
      const ta = terms.get(a.id)!;
      const shared = [...terms.get(b.id)!].filter((t) => ta.has(t));
      if (shared.length >= MULTI_HOP_MIN_SHARED_TERMS) pairs.push({ a, b, shared: shared.slice(0, 6) });
    }
  }
  return pairs.sort((x, y) => y.shared.length - x.shared.length);
}

/**
 * 按种子确定性地为每道题挑选来源切块。单切块题不重复使用同一切块（题数多于切块时少生成并提示）；
 * 多跳题只用有关联的切块对，不够就少生成。
 */
export function planSources(
  chunks: SourceChunk[],
  counts: Partial<Record<RagQualityType, number>>,
  seed: string,
  index: Bm25Index = new Bm25Index(chunks.map((c) => ({ id: c.id, text: c.content }))),
): { plan: PlanEntry[]; notes: string[] } {
  const plan: PlanEntry[] = [];
  const notes: string[] = [];
  if (chunks.length === 0) return { plan, notes };
  const LABEL: Record<RagQualityType, string> = {
    FACT: '事实题',
    MULTI_HOP: '多跳题',
    NO_ANSWER: '无答案题',
    DISTRACTOR: '干扰题',
  };
  for (const type of RAG_QUALITY_TYPES) {
    const n = Math.max(0, Math.floor(counts[type] ?? 0));
    if (n === 0) continue;
    const rng = makeRng(`${seed}|${type}`);
    if (type === 'MULTI_HOP') {
      const pairs = rng.shuffle(findRelatedPairs(chunks, index));
      const used = new Set<string>();
      const picked: typeof pairs = [];
      for (const p of pairs) {
        if (picked.length >= n) break;
        const key = [p.a.id, p.b.id].sort().join('|');
        if (used.has(key)) continue;
        used.add(key);
        picked.push(p);
      }
      for (const p of picked) plan.push({ type, sources: [p.a, p.b], sharedTerms: p.shared });
      if (picked.length < n)
        notes.push(
          `${LABEL[type]}：只找到 ${picked.length} 组有实体/关键词关联的切块，少生成 ${n - picked.length} 题（需两切块共享至少 ${MULTI_HOP_MIN_SHARED_TERMS} 个关键词）`,
        );
      continue;
    }
    const order = rng.shuffle(chunks);
    const take = Math.min(n, order.length);
    for (let i = 0; i < take; i++) plan.push({ type, sources: [order[i]!] });
    if (take < n)
      notes.push(`${LABEL[type]}：知识库只有 ${order.length} 个切块，为避免重复出题只生成 ${take} 题`);
  }
  return { plan, notes };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 数值种子：传给支持 seed 参数的 OpenAI 兼容接口，尽量提高生成可复现性。 */
export function numericSeed(seed: string, index: number): number {
  return makeRng(`${seed}#${index}`).int(2_147_483_647);
}

/** 关键词反证阈值：问题中区分度高的关键词在某切块中的覆盖率达到此值，视为该切块可能含答案。 */
export const NO_ANSWER_TERM_COVERAGE = 0.8;

export interface NoAnswerRefutation {
  grounded: boolean;
  /** 被判可能含答案的切块 ID。 */
  evidenceChunkId: string | null;
  method: 'keyword' | 'judge' | 'none';
  reason: string;
}

/**
 * 无答案题全语料反证：BM25 取全语料前 3 个相关切块，
 * ① 问题关键词在某切块覆盖率 ≥ 0.8 → 判有依据；② 否则请评估模型判断这些切块能否回答，能回答 → 判有依据。
 * 评估模型调用失败时保守剔除（不能证明无答案的题不入库）。
 */
export async function refuteNoAnswer(
  question: string,
  chunks: SourceChunk[],
  index: Bm25Index,
  judge: ResolvedJudge,
  chat: RagChatCaller,
): Promise<NoAnswerRefutation> {
  const hits = index.search(question, 3);
  if (hits.length === 0) return { grounded: false, evidenceChunkId: null, method: 'none', reason: '全语料无相关切块' };
  const byId = new Map(chunks.map((c) => [c.id, c]));
  // 覆盖率以问题的全部关键词为分母：只统计语料中出现过的词会让覆盖率恒为 100%，误删合理的无答案题。
  const qTerms = [...new Set(tokenize(question))];
  for (const h of hits) {
    const c = byId.get(h.id);
    if (!c || qTerms.length === 0) continue;
    const ct = new Set(tokenize(c.content));
    const cover = qTerms.filter((t) => ct.has(t)).length / qTerms.length;
    if (cover >= NO_ANSWER_TERM_COVERAGE)
      return { grounded: true, evidenceChunkId: c.id, method: 'keyword', reason: `关键词覆盖率 ${cover.toFixed(2)}` };
  }
  const passages = hits
    .map((h, i) => `【片段${i + 1}】\n${byId.get(h.id)?.content ?? ''}`)
    .join('\n\n');
  const res = await callJudgeJson(chat, judge, [
    {
      role: 'system',
      content:
        '你是严格的事实核查员。判断给定片段能否回答问题（哪怕部分回答）。只输出 JSON：{"answerable":true/false,"index":片段序号或0,"reason":"……"}',
    },
    { role: 'user', content: `问题：${question}\n\n${passages}` },
  ]);
  if (!res.ok)
    return { grounded: true, evidenceChunkId: null, method: 'judge', reason: `反证判定失败，保守剔除：${res.error}` };
  const answerable = res.json.answerable === true;
  const idx = typeof res.json.index === 'number' ? res.json.index : 0;
  return {
    grounded: answerable,
    evidenceChunkId: answerable ? (hits[idx - 1]?.id ?? hits[0]!.id) : null,
    method: 'judge',
    reason: str(res.json.reason, 300),
  };
}

/** 调用评估模型从切块生成测试题；逐题失败记录在 failures 中，不伪造题目。 */
export async function generateQualityItems(opts: GenerateOptions): Promise<GenerationResult> {
  const index = new Bm25Index(opts.chunks.map((c) => ({ id: c.id, text: c.content })));
  const { plan, notes } = planSources(opts.chunks, opts.counts, opts.seed, index);
  const progress: GenerationProgress = { planned: plan.length, done: 0, generated: 0, failed: 0 };
  const accepted: string[] = [...(opts.existingQuestions ?? [])];
  const rejected = { noAnswerRefuted: 0, duplicate: 0 };
  let canceled = false;
  await opts.onProgress?.({ ...progress });

  const results = await mapLimit(plan, opts.concurrency ?? 4, async (entry, i) => {
    if (canceled || (opts.isCanceled && (await opts.isCanceled()))) {
      canceled = true;
      return null;
    }
    const ids = entry.sources.map((s) => s.id);
    const out = await (async (): Promise<{ item?: GeneratedItem; failure?: GenerationFailure }> => {
      const res = await callJudgeJson(
        opts.chat,
        opts.judge,
        buildGenerationPrompt(entry.type, entry.sources, entry.sharedTerms),
        { seed: numericSeed(opts.seed, i) },
      );
      if (!res.ok) return { failure: { type: entry.type, sourceChunkIds: ids, error: res.error } };
      const question = str(res.json.question, 2000);
      const answer = str(res.json.answer, 4000);
      if (!question)
        return { failure: { type: entry.type, sourceChunkIds: ids, error: '评估模型返回的题目为空' } };
      if (entry.type !== 'NO_ANSWER' && !answer)
        return { failure: { type: entry.type, sourceChunkIds: ids, error: '评估模型返回的参考答案为空' } };
      if (isNearDuplicate(question, accepted)) {
        rejected.duplicate++;
        return { failure: { type: entry.type, sourceChunkIds: ids, error: '与已有题目重复，已剔除' } };
      }
      const metadata: Record<string, unknown> = { planIndex: i };
      if (entry.sharedTerms) metadata.sharedTerms = entry.sharedTerms;
      if (entry.type === 'NO_ANSWER') {
        const r = await refuteNoAnswer(question, opts.chunks, index, opts.judge, opts.chat);
        if (r.grounded) {
          rejected.noAnswerRefuted++;
          return {
            failure: {
              type: entry.type,
              sourceChunkIds: r.evidenceChunkId ? [r.evidenceChunkId] : ids,
              error: `全语料反证：知识库中可能存在答案，已剔除（${r.reason}）`,
            },
          };
        }
        metadata.refutation = { method: r.method, reason: r.reason };
      }
      accepted.push(question);
      return {
        item: {
          type: entry.type,
          question,
          referenceAnswer: entry.type === 'NO_ANSWER' ? NO_ANSWER_REFERENCE : answer,
          sourceChunkIds: ids,
          metadata,
        },
      };
    })();
    progress.done++;
    if (out.item) progress.generated++;
    else progress.failed++;
    await opts.onProgress?.({ ...progress });
    return out;
  });

  const items: GeneratedItem[] = [];
  const failures: GenerationFailure[] = [];
  for (const r of results) {
    if (r?.item) items.push(r.item);
    else if (r?.failure) failures.push(r.failure);
  }
  return { items, failures, notes, rejected, canceled };
}
