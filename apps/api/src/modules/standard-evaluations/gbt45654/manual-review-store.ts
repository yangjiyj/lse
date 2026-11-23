import type { PrismaClient } from '@prisma/client';
import { ANNEX_ITEM_CODES, JUDGMENT_SOURCE } from './constants.js';
import {
  MANUAL_STATUS_LABELS,
  REFUSAL_REVIEW_VERDICTS,
  SAFETY_REVIEW_VERDICTS,
  refusalReviewStats,
  resolveManualFinal,
  type ManualFinal,
  type ReviewVerdict,
  type ReviewRecord,
} from './manual-review.js';

/** 人工抽检的数据库读写：校验复核位、提交标注、列出抽检名单。 */

export class ManualReviewError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface SubmitReviewInput {
  runId: string;
  sampleId: string;
  reviewer: { id: string; name: string };
  /** 1 复核人，2 第二复核人，3 分歧裁定。 */
  slot: 1 | 2 | 3;
  verdict: ReviewVerdict;
  itemCode?: string | null;
  note?: string | null;
}

/** 分类模型打的标签，从判定证据里取。 */
export function classifierLabelOf(judgment: { evidence: string | null } | undefined): string | null {
  if (!judgment?.evidence) return null;
  try {
    const parsed: unknown = JSON.parse(judgment.evidence);
    if (parsed && typeof parsed === 'object' && 'label' in parsed) {
      const label = (parsed as { label: unknown }).label;
      return typeof label === 'string' ? label : null;
    }
  } catch {
    // 证据不是 JSON 就当没有标签
  }
  return null;
}

const REFUSAL_GROUPS = ['SHOULD_REFUSE', 'NON_REFUSAL'] as const;
const GROUP_LABELS: Record<string, string> = {
  MANUAL_SAFETY: '生成内容题',
  SHOULD_REFUSE: '应拒答题',
  NON_REFUSAL: '非拒答题',
};

function isRefusalGroup(group: string): boolean {
  return (REFUSAL_GROUPS as readonly string[]).includes(group);
}

export interface ModelRefusalJudgment {
  refused: boolean | null;
  by: 'judge' | 'rule' | null;
  reason: string | null;
}

/** 拒答判定（来源 REFUSAL）的最新一条：谁判的（裁判模型/规则）、结论与理由。 */
export function refusalPrejudgmentOf(
  judgment: { refusalOutcome: string | null; evidence: string | null; reason: string | null } | undefined,
): ModelRefusalJudgment {
  if (!judgment) return { refused: null, by: null, reason: null };
  const refused =
    judgment.refusalOutcome === 'REFUSED' ? true : judgment.refusalOutcome === 'NOT_REFUSED' ? false : null;
  let by: 'judge' | 'rule' | null = null;
  try {
    const parsed: unknown = judgment.evidence ? JSON.parse(judgment.evidence) : null;
    if (parsed && typeof parsed === 'object' && 'by' in parsed) {
      const v = (parsed as { by: unknown }).by;
      if (v === 'judge' || v === 'rule') by = v;
    }
  } catch {
    // 证据不是 JSON 就当不知道来源
  }
  return { refused, by, reason: judgment.reason };
}

/** 关键词判定 evidence 里命中的生效词（去重，最多 5 个）。 */
function keywordTermsOf(evidence: string | null): string[] {
  if (!evidence) return [];
  try {
    const hits = (JSON.parse(evidence) as { approvedHits?: Array<{ term?: unknown }> }).approvedHits ?? [];
    return [...new Set(hits.map((h) => h?.term).filter((t): t is string => typeof t === 'string' && t.length > 0))].slice(0, 5);
  } catch {
    return [];
  }
}

export async function submitManualReview(db: PrismaClient, input: SubmitReviewInput) {
  const sample = await db.standardSample.findFirst({
    where: { id: input.sampleId, standardRunId: input.runId },
    include: {
      judgments: {
        where: { source: { in: [JUDGMENT_SOURCE.classifier, JUDGMENT_SOURCE.refusal] } },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!sample) throw new ManualReviewError('抽检名单里没有这道题', 'MANUAL_REVIEW_SAMPLE_NOT_FOUND');
  const refusalKind = isRefusalGroup(sample.group);
  if (!refusalKind && sample.group !== 'MANUAL_SAFETY') {
    throw new ManualReviewError('这类样本不需要人工抽检', 'MANUAL_REVIEW_WRONG_GROUP');
  }
  if (refusalKind) {
    if (!(REFUSAL_REVIEW_VERDICTS as readonly string[]).includes(input.verdict)) {
      throw new ManualReviewError('这是拒答类题目，请标「拒答」或「未拒答」', 'MANUAL_REVIEW_VERDICT_INVALID');
    }
  } else {
    if (!(SAFETY_REVIEW_VERDICTS as readonly string[]).includes(input.verdict)) {
      throw new ManualReviewError('这是生成内容题，请标「合格」或「不合格」', 'MANUAL_REVIEW_VERDICT_INVALID');
    }
    if (input.verdict === 'FAIL' && (!input.itemCode || !ANNEX_ITEM_CODES.includes(input.itemCode))) {
      throw new ManualReviewError('标不合格时必须选择附录 A 的小项编号', 'MANUAL_REVIEW_ITEM_REQUIRED');
    }
  }
  let snapshotLabel: string | null;
  if (refusalKind) {
    const p = refusalPrejudgmentOf(sample.judgments.find((j) => j.source === JUDGMENT_SOURCE.refusal));
    snapshotLabel = p.refused === null ? null : `${p.refused ? '拒答' : '未拒答'}（${p.by === 'judge' ? '裁判模型' : '规则'}）`;
  } else {
    snapshotLabel = classifierLabelOf(sample.judgments.find((j) => j.source === JUDGMENT_SOURCE.classifier));
  }
  if (!sample.selectedResponse?.trim()) {
    throw new ManualReviewError('这道题还没有模型回答，不能复核', 'MANUAL_REVIEW_NO_RESPONSE');
  }

  const existing = await db.standardManualReview.findMany({ where: { sampleId: input.sampleId } });
  const bySlot = new Map(existing.map((r) => [r.slot, r]));
  const mine = existing.find((r) => r.reviewerId === input.reviewer.id);
  if (mine && mine.slot !== input.slot) {
    throw new ManualReviewError('同一位复核人不能在同一道题上占两个复核位', 'MANUAL_REVIEW_SAME_REVIEWER');
  }
  const first = bySlot.get(1);
  const second = bySlot.get(2);
  if (input.slot === 1) {
    if (first && first.reviewerId !== input.reviewer.id) {
      throw new ManualReviewError('这道题已有复核人', 'MANUAL_REVIEW_SLOT_TAKEN');
    }
  } else if (input.slot === 2) {
    if (!first) throw new ManualReviewError('需要先有第一位复核人', 'MANUAL_REVIEW_FIRST_REQUIRED');
    if (second && second.reviewerId !== input.reviewer.id) {
      throw new ManualReviewError('这道题已有第二复核人', 'MANUAL_REVIEW_SLOT_TAKEN');
    }
  } else {
    if (!first || !second) {
      throw new ManualReviewError('两位复核人都标注后才需要裁定', 'MANUAL_REVIEW_NOT_CONFLICT');
    }
    if (first.verdict === second.verdict) {
      throw new ManualReviewError('两位复核人结论一致，不需要裁定', 'MANUAL_REVIEW_NOT_CONFLICT');
    }
    const arbiter = bySlot.get(3);
    if (arbiter && arbiter.reviewerId !== input.reviewer.id) {
      throw new ManualReviewError('这道题已经裁定', 'MANUAL_REVIEW_SLOT_TAKEN');
    }
  }

  const data = {
    runId: input.runId,
    sampleId: input.sampleId,
    slot: input.slot,
    reviewerId: input.reviewer.id,
    reviewerName: input.reviewer.name,
    verdict: input.verdict,
    itemCode: !refusalKind && input.verdict === 'FAIL' ? (input.itemCode ?? null) : null,
    note: input.note?.trim() || null,
    classifierLabel: snapshotLabel,
  };
  return db.standardManualReview.upsert({
    where: { sampleId_slot: { sampleId: input.sampleId, slot: input.slot } },
    create: data,
    update: {
      verdict: data.verdict,
      itemCode: data.itemCode,
      note: data.note,
      classifierLabel: data.classifierLabel,
      reviewerName: data.reviewerName,
    },
  });
}

export type ReviewFilter = 'todo' | 'done' | 'conflict' | 'all';

export type ReviewKind = 'safety' | 'refusal';

export interface ReviewListItem {
  sampleId: string;
  sequence: number;
  /** 样本所属抽样组与中文名。 */
  group: string;
  groupLabel: string;
  question: string;
  response: string;
  /** 分类模型给的标签（项编号或「安全」）与理由。 */
  classifier: { label: string | null; reason: string | null; safe: boolean | null } | null;
  /** 题目所属小项（复核时的参照）。 */
  annexItem: string | null;
  /** 拒答类题目的模型预判（生成内容题为 null）。 */
  modelJudgment: ModelRefusalJudgment | null;
  /**
   * 重点复核：关键词命中、分类模型判合格的生成内容题。技术抽检以分类模型为准不计不合格，
   * 但关键词可能抓到了分类模型漏判的风险，排在名单最前面由人工下结论；terms 为命中的生效词。
   */
  priority: { terms: string[] } | null;
  mine: { verdict: string; itemCode: string | null; note: string | null; at: Date } | null;
  /** 只有裁定位能看到前两位复核人的标注；复核位之间互相不可见。 */
  others: Array<{ slot: number; reviewerName: string; verdict: string; itemCode: string | null }>;
  status: ManualFinal['status'];
  statusLabel: string;
}

/**
 * 抽检名单。复核位 1、2 只看到自己的标注，两位复核人独立打；裁定位（3）看到两人标注。
 * slot 2 名单里只包含已有第一位复核人且不是自己标的题；slot 3 只包含分歧题。
 */
export async function listManualReviewItems(
  db: PrismaClient,
  options: {
    runId: string;
    slot: 1 | 2 | 3;
    reviewerId: string;
    filter?: ReviewFilter;
    kind?: ReviewKind;
    page?: number;
    pageSize?: number;
  },
): Promise<{
  items: ReviewListItem[];
  total: number;
  page: number;
  pageSize: number;
  mineDone: number;
  /** 当前名单范围里的重点复核题数（关键词命中、分类模型判合格）。 */
  priorityCount: number;
  groups: { shouldRefuse: { total: number; decided: number }; nonRefusal: { total: number; decided: number } };
}> {
  const kind: ReviewKind = options.kind ?? 'safety';
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
  const samples = await db.standardSample.findMany({
    where: {
      standardRunId: options.runId,
      group: kind === 'refusal' ? { in: [...REFUSAL_GROUPS] } : 'MANUAL_SAFETY',
      selectedResponse: { not: null },
    },
    orderBy: { sequence: 'asc' },
    select: {
      id: true,
      sequence: true,
      group: true,
      inputSnapshot: true,
      selectedResponse: true,
      primaryCategory: true,
      judgments: {
        where:
          kind === 'refusal'
            ? { source: JUDGMENT_SOURCE.refusal }
            : { source: { in: [JUDGMENT_SOURCE.classifier, JUDGMENT_SOURCE.keyword] } },
        orderBy: { createdAt: 'desc' },
        select: { source: true, evidence: true, reason: true, safetyOutcome: true, refusalOutcome: true },
      },
    },
  });
  const reviews = await db.standardManualReview.findMany({ where: { runId: options.runId } });
  const bySample = new Map<string, typeof reviews>();
  for (const r of reviews) {
    const list = bySample.get(r.sampleId) ?? [];
    list.push(r);
    bySample.set(r.sampleId, list);
  }

  const rows = samples.flatMap((s): ReviewListItem[] => {
    const list = bySample.get(s.id) ?? [];
    const records: ReviewRecord[] = list.map((r) => ({
      sampleId: r.sampleId,
      slot: r.slot,
      reviewerId: r.reviewerId,
      verdict: r.verdict,
      itemCode: r.itemCode,
    }));
    const final = resolveManualFinal(records);
    const mineRow = list.find((r) => r.reviewerId === options.reviewerId && r.slot === options.slot);
    // 名单范围：已被别人占了的复核位，不出现在名单里。
    if (options.slot === 1) {
      const first = list.find((r) => r.slot === 1);
      if (first && first.reviewerId !== options.reviewerId) return [];
    }
    if (options.slot === 2) {
      const first = list.find((r) => r.slot === 1);
      if (!first || first.reviewerId === options.reviewerId) return [];
    }
    if (options.slot === 3 && final.status !== 'conflict' && final.status !== 'arbitrated') return [];
    const visibleStatus: ManualFinal['status'] =
      options.slot === 3 ? final.status : mineRow ? 'single' : 'pending';
    const cls =
      kind === 'refusal' ? s.judgments[0] : s.judgments.find((j) => j.source === JUDGMENT_SOURCE.classifier);
    const kw = kind === 'refusal' ? undefined : s.judgments.find((j) => j.source === JUDGMENT_SOURCE.keyword);
    const safe = cls?.safetyOutcome === 'SAFE' ? true : cls?.safetyOutcome === 'UNSAFE' ? false : null;
    const priority =
      kw?.safetyOutcome === 'UNSAFE' && cls?.safetyOutcome === 'SAFE' ? { terms: keywordTermsOf(kw.evidence) } : null;
    return [
      {
        sampleId: s.id,
        sequence: s.sequence,
        group: s.group,
        groupLabel: GROUP_LABELS[s.group] ?? s.group,
        question: s.inputSnapshot,
        response: s.selectedResponse ?? '',
        classifier:
          kind === 'refusal' || !cls
            ? null
            : { label: classifierLabelOf(cls) ?? (safe === true ? '安全' : null), reason: cls.reason, safe },
        annexItem: kind === 'refusal' ? null : s.primaryCategory,
        modelJudgment: kind === 'refusal' ? refusalPrejudgmentOf(cls) : null,
        priority,
        mine: mineRow
          ? { verdict: mineRow.verdict, itemCode: mineRow.itemCode, note: mineRow.note, at: mineRow.updatedAt }
          : null,
        others:
          options.slot === 3
            ? list
                .filter((r) => r.slot !== 3)
                .map((r) => ({ slot: r.slot, reviewerName: r.reviewerName, verdict: r.verdict, itemCode: r.itemCode }))
            : [],
        // 复核位之间互相不可见：复核人只看到自己有没有标过，不泄露对方的标注与是否分歧。
        status: visibleStatus,
        statusLabel: MANUAL_STATUS_LABELS[visibleStatus],
      },
    ];
  });

  // 重点复核的题排在最前面（同类内仍按题号）。
  rows.sort((a, b) => Number(Boolean(b.priority)) - Number(Boolean(a.priority)) || a.sequence - b.sequence);
  const priorityCount = rows.filter((r) => r.priority).length;
  const filter = options.filter ?? 'todo';
  const filtered = rows.filter((r) => {
    if (filter === 'all') return true;
    if (filter === 'done') return r.mine !== null;
    if (filter === 'conflict') return r.status === 'conflict';
    return r.mine === null;
  });
  // 拒答类两组的人工进度（只有 refusal 名单才有意义）。
  const groupStats = (group: string) => {
    const ids = samples.filter((s) => s.group === group).map((s) => s.id);
    const idSet = new Set(ids);
    const records: ReviewRecord[] = reviews
      .filter((r) => idSet.has(r.sampleId))
      .map((r) => ({
        sampleId: r.sampleId,
        slot: r.slot,
        reviewerId: r.reviewerId,
        verdict: r.verdict,
        itemCode: r.itemCode,
      }));
    const stats = refusalReviewStats(ids.length, records);
    return { total: stats.total, decided: stats.decided };
  };
  return {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    mineDone: rows.filter((r) => r.mine !== null).length,
    priorityCount,
    groups:
      kind === 'refusal'
        ? { shouldRefuse: groupStats('SHOULD_REFUSE'), nonRefusal: groupStats('NON_REFUSAL') }
        : { shouldRefuse: { total: 0, decided: 0 }, nonRefusal: { total: 0, decided: 0 } },
    page,
    pageSize,
  };
}

export interface BatchReviewInput {
  runId: string;
  slot: 1 | 2 | 3;
  reviewer: { id: string; name: string };
  items: Array<{ sampleId: string; verdict: ReviewVerdict; itemCode?: string | null; note?: string | null }>;
}

export interface BatchReviewResult {
  results: Array<{ sampleId: string; ok: boolean; code?: string; error?: string }>;
  succeeded: number;
  failed: number;
}

/** 批量提交：逐题复用 submitManualReview 的全部校验，互不影响，失败的题带中文原因。 */
export async function submitManualReviewBatch(
  db: PrismaClient,
  input: BatchReviewInput,
): Promise<BatchReviewResult> {
  const results: BatchReviewResult['results'] = [];
  for (const item of input.items) {
    try {
      await submitManualReview(db, {
        runId: input.runId,
        sampleId: item.sampleId,
        reviewer: input.reviewer,
        slot: input.slot,
        verdict: item.verdict,
        itemCode: item.itemCode ?? null,
        note: item.note ?? null,
      });
      results.push({ sampleId: item.sampleId, ok: true });
    } catch (error) {
      if (error instanceof ManualReviewError) {
        results.push({ sampleId: item.sampleId, ok: false, code: error.code, error: error.message });
      } else {
        throw error;
      }
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { results, succeeded, failed: results.length - succeeded };
}
