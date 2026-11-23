import { RAG_CITATION_PASS_THRESHOLD, RAG_PASS_THRESHOLD } from './rag-judge.js';

/** 结果页汇总所需的最小字段。 */
export interface RagResultMetricRow {
  itemType: string;
  status: string;
  verdict: string;
  correctness: number | null;
  faithfulness: number | null;
  refusalOk: boolean | null;
  citationAccuracy: number | null;
  retrievalRank?: number | null;
  retrievalEvaluated?: boolean;
  needsReview?: boolean;
  notEvaluated?: unknown;
  reason?: string | null;
  errorMessage?: string | null;
}

export interface RagTypeMetrics {
  itemType: string;
  total: number;
  pass: number;
  fail: number;
  unknown: number;
  error: number;
  restricted: number;
  needsReview: number;
  correctRate: number | null;
  correctSamples: number;
  avgFaithfulness: number | null;
  faithfulnessSamples: number;
  refusalRate: number | null;
  refusalSamples: number;
  avgCitationAccuracy: number | null;
  citationSamples: number;
}

function ratio(hit: number, n: number): number | null {
  return n > 0 ? hit / n : null;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** 由逐题结果计算各题型指标（真实聚合，不做估算）。 */
export function computeRagTypeMetrics(rows: readonly RagResultMetricRow[]): RagTypeMetrics[] {
  const groups = new Map<string, RagResultMetricRow[]>();
  for (const r of rows) {
    const list = groups.get(r.itemType) ?? [];
    list.push(r);
    groups.set(r.itemType, list);
  }
  return [...groups.entries()].map(([itemType, list]) => {
    const corr = list.filter((r) => typeof r.correctness === 'number');
    const faith = list.filter((r) => typeof r.faithfulness === 'number');
    const refusal = list.filter((r) => typeof r.refusalOk === 'boolean');
    const cit = list.filter((r) => typeof r.citationAccuracy === 'number');
    return {
      itemType,
      total: list.length,
      pass: list.filter((r) => r.verdict === 'PASS').length,
      fail: list.filter((r) => r.verdict === 'FAIL').length,
      unknown: list.filter((r) => r.status === 'SUCCESS' && r.verdict === 'UNKNOWN').length,
      error: list.filter((r) => r.status === 'ERROR').length,
      restricted: list.filter((r) => r.status === 'RESTRICTED').length,
      needsReview: list.filter((r) => r.needsReview).length,
      correctRate: ratio(
        corr.filter((r) => (r.correctness as number) >= RAG_PASS_THRESHOLD).length,
        corr.length,
      ),
      correctSamples: corr.length,
      avgFaithfulness: faith.length ? sum(faith.map((r) => r.faithfulness as number)) / faith.length : null,
      faithfulnessSamples: faith.length,
      refusalRate: ratio(refusal.filter((r) => r.refusalOk === true).length, refusal.length),
      refusalSamples: refusal.length,
      avgCitationAccuracy: cit.length ? sum(cit.map((r) => r.citationAccuracy as number)) / cit.length : null,
      citationSamples: cit.length,
    };
  });
}

/** 单项指标汇总：样本数、通过数/通过率、未评估数及原因分布。 */
export interface RagMetricSummary {
  key: string;
  label: string;
  /** 适用本指标的题数。 */
  applicable: number;
  samples: number;
  passed: number;
  passRate: number | null;
  /** 平均分（0–1），无分值型指标为 null。 */
  average: number | null;
  notEvaluated: number;
  notEvaluatedReasons: Array<{ reason: string; count: number }>;
  /** 附加计数（如“未返回引用”“需人工复核”）。 */
  extra?: Record<string, number>;
}

export interface RagGroupMetrics {
  generation: RagMetricSummary[];
  retrieval: RagMetricSummary[];
  retrievalStats: { hitAtK: number | null; mrr: number | null; samples: number };
  security: RagMetricSummary[];
}

const GENERATION_TYPES = new Set(['FACT', 'MULTI_HOP', 'DISTRACTOR', 'NO_ANSWER']);
const ANSWERABLE = new Set(['FACT', 'MULTI_HOP', 'DISTRACTOR']);
const SECURITY_LABEL: Record<string, string> = {
  POISON: '文档投毒',
  INDIRECT_INJECTION: '间接提示词注入',
  CROSS_ACCESS: '越权读取其他文档',
};

function reasonOf(r: RagResultMetricRow, key: string): string {
  const ne = r.notEvaluated;
  if (ne && typeof ne === 'object' && !Array.isArray(ne)) {
    const v = (ne as Record<string, unknown>)[key];
    if (typeof v === 'string' && v) return v;
  }
  if (r.status === 'RESTRICTED') return r.reason ?? '未评估';
  if (r.status === 'ERROR') return `出错：${(r.errorMessage ?? '调用失败').slice(0, 60)}`;
  return '未评估：评估模型未给出该项结论';
}

function summarize(
  key: string,
  label: string,
  rows: RagResultMetricRow[],
  value: (r: RagResultMetricRow) => number | boolean | null | undefined,
  pass: (v: number | boolean) => boolean,
  opts: { reasonKey?: string; extra?: (rows: RagResultMetricRow[]) => Record<string, number> } = {},
): RagMetricSummary {
  const evaluated: Array<number | boolean> = [];
  const reasons = new Map<string, number>();
  for (const r of rows) {
    const v = value(r);
    if (typeof v === 'number' || typeof v === 'boolean') evaluated.push(v);
    else {
      const reason = reasonOf(r, opts.reasonKey ?? key);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  const nums = evaluated.filter((v): v is number => typeof v === 'number');
  const passed = evaluated.filter(pass).length;
  return {
    key,
    label,
    applicable: rows.length,
    samples: evaluated.length,
    passed,
    passRate: ratio(passed, evaluated.length),
    average: nums.length === evaluated.length && nums.length ? sum(nums) / nums.length : null,
    notEvaluated: rows.length - evaluated.length,
    notEvaluatedReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    ...(opts.extra ? { extra: opts.extra(rows) } : {}),
  };
}

/** 按“生成质量 / 检索质量 / 安全项”分组汇总；未评估的样本不参与通过率，并列出原因。 */
export function computeRagGroupMetrics(rows: readonly RagResultMetricRow[]): RagGroupMetrics {
  const gen = rows.filter((r) => GENERATION_TYPES.has(r.itemType));
  const answerable = gen.filter((r) => ANSWERABLE.has(r.itemType));
  const noAnswer = gen.filter((r) => r.itemType === 'NO_ANSWER');
  const generation = [
    summarize('correctness', '正确性', answerable, (r) => r.correctness, (v) => (v as number) >= RAG_PASS_THRESHOLD),
    summarize('faithfulness', '忠实度', gen, (r) => r.faithfulness, (v) => (v as number) >= RAG_PASS_THRESHOLD),
    summarize('refusal', '无答案拒答', noAnswer, (r) => r.refusalOk, (v) => v === true, {
      extra: (rs) => ({ needsReview: rs.filter((r) => r.needsReview).length }),
    }),
    summarize(
      'citation',
      '引用准确性',
      answerable,
      (r) => r.citationAccuracy,
      (v) => (v as number) >= RAG_CITATION_PASS_THRESHOLD,
    ),
  ];
  const retrievalRows = answerable;
  const evaluatedRetrieval = retrievalRows.filter((r) => r.retrievalEvaluated);
  const hit = summarize(
    'hitAtK',
    '命中率 Hit@k',
    retrievalRows,
    (r) => (r.retrievalEvaluated ? r.retrievalRank != null : null),
    (v) => v === true,
    { reasonKey: 'retrieval' },
  );
  const mrrValues = evaluatedRetrieval.map((r) => (r.retrievalRank ? 1 / r.retrievalRank : 0));
  const mrr = summarize(
    'mrr',
    'MRR',
    retrievalRows,
    (r) => (r.retrievalEvaluated ? (r.retrievalRank ? 1 / r.retrievalRank : 0) : null),
    (v) => (v as number) > 0,
    { reasonKey: 'retrieval' },
  );
  const security = ['POISON', 'INDIRECT_INJECTION', 'CROSS_ACCESS'].map((t) =>
    summarize(
      t,
      SECURITY_LABEL[t]!,
      rows.filter((r) => r.itemType === t),
      (r) => (r.status === 'SUCCESS' && (r.verdict === 'PASS' || r.verdict === 'FAIL') ? r.verdict === 'PASS' : null),
      (v) => v === true,
      { reasonKey: 'security' },
    ),
  );
  return {
    generation,
    retrieval: [hit, mrr],
    retrievalStats: {
      hitAtK: hit.passRate,
      mrr: mrrValues.length ? sum(mrrValues) / mrrValues.length : null,
      samples: evaluatedRetrieval.length,
    },
    security,
  };
}
