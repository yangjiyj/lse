/**
 * 轻量文本检索工具（无外部依赖）：中英文混合分词（CJK 字符二元组 + 英文/数字词）、BM25、
 * 关键词重叠与问题去重。用于无答案题全语料反证、多跳题关联切块挑选、检索命中判定。
 */

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'from', 'what', 'which', 'how',
  '什么', '哪些', '多少', '是否', '如何', '怎么', '请问', '以及', '或者', '我们', '你们', '他们',
  '这个', '那个', '可以', '需要', '进行', '根据', '文档', '其中', '一个', '没有',
]);

export function normalizeText(s: string): string {
  return s.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

/** 分词：CJK 连续段切成字符二元组，其它按字母数字词切分；去停用词。 */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  const lower = s.toLowerCase();
  for (const m of lower.matchAll(/[\p{Script=Han}]+|[a-z0-9][a-z0-9_-]*/gu)) {
    const seg = m[0];
    if (/^[\p{Script=Han}]+$/u.test(seg)) {
      if (seg.length === 1) continue;
      for (let i = 0; i < seg.length - 1; i++) {
        const g = seg.slice(i, i + 2);
        if (!STOP.has(g)) out.push(g);
      }
    } else if (seg.length >= 2 && !STOP.has(seg)) {
      out.push(seg);
    }
  }
  return out;
}

export interface Bm25Doc {
  id: string;
  text: string;
}

export class Bm25Index {
  private readonly docs: Array<{ id: string; tf: Map<string, number>; len: number }>;
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(docs: readonly Bm25Doc[], private readonly k1 = 1.2, private readonly b = 0.75) {
    this.docs = docs.map((d) => {
      const tf = new Map<string, number>();
      const toks = tokenize(d.text);
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { id: d.id, tf, len: toks.length };
    });
    this.avgLen = this.docs.reduce((a, d) => a + d.len, 0) / Math.max(1, this.docs.length);
  }

  get size(): number {
    return this.docs.length;
  }

  idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** 文档频率占比（0–1），用于挑选“区分度高”的关键词。 */
  dfRatio(term: string): number {
    return (this.df.get(term) ?? 0) / Math.max(1, this.docs.length);
  }

  search(query: string, topK = 5): Array<{ id: string; score: number }> {
    const q = [...new Set(tokenize(query))];
    const scored = this.docs.map((d) => {
      let s = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        s +=
          (this.idf(t) * f * (this.k1 + 1)) /
          (f + this.k1 * (1 - this.b + (this.b * d.len) / Math.max(1, this.avgLen)));
      }
      return { id: d.id, score: s };
    });
    return scored
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * 某文档中区分度高的关键词，按 tf·idf 取前 n。文档频率上限取 max(2, maxDfRatio·N)：
   * 小语料里两块共享的词必然占较高比例，不能因此排除（否则多跳题永远配不出对）。
   */
  keyTerms(id: string, n = 12, maxDfRatio = 0.34): string[] {
    const d = this.docs.find((x) => x.id === id);
    if (!d) return [];
    const maxDf = Math.max(2, Math.floor(maxDfRatio * this.docs.length));
    return [...d.tf.entries()]
      .filter(([t]) => (this.df.get(t) ?? 0) <= maxDf)
      .map(([t, f]) => ({ t, w: f * this.idf(t) }))
      .sort((a, b) => b.w - a.w)
      .slice(0, n)
      .map((x) => x.t);
  }
}

function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 字符二元组覆盖率：a 的二元组有多少出现在 b 中。 */
export function bigramOverlap(a: string, b: string): number {
  const ga = bigrams(a);
  if (ga.size === 0) return 0;
  const gb = bigrams(b);
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / ga.size;
}

export function bigramJaccard(a: string, b: string): number {
  const ga = bigrams(normalizeText(a));
  const gb = bigrams(normalizeText(b));
  if (ga.size === 0 && gb.size === 0) return 1;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter || 1);
}

/** 两段文本是否“同源”：规范化后互相包含，或二元组覆盖率 ≥ 阈值。 */
export function textMatches(fragment: string, source: string, threshold = 0.6): boolean {
  const t = normalizeText(fragment);
  const s = normalizeText(source);
  if (!t || !s) return false;
  return s.includes(t) || t.includes(s) || bigramOverlap(t, s) >= threshold;
}

/** 问题近似重复判定（字符二元组 Jaccard ≥ 0.8 或规范化后相同）。 */
export function isNearDuplicate(q: string, existing: readonly string[], threshold = 0.8): boolean {
  const nq = normalizeText(q);
  return existing.some((e) => normalizeText(e) === nq || bigramJaccard(q, e) >= threshold);
}
