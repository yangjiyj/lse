// Aho-Corasick 关键词自动机：国标关键词（1.2.1、1.2.4）和自定义关键词规则共用，一遍扫完一条文本，
// 重叠、包含的词都报。匹配前逐字归一化（全角 ASCII 转半角、英文转小写），长度不变，命中位置就是原文位置。
// 纯函数、无依赖，只用可擦除的 TS 语法。

export interface KeywordEntry {
  term: string;
  /** 国标条目编码（A.x.y）或自定义规则 ID */
  code: string;
}

export interface KeywordHit {
  start: number;
  end: number;
  /** 命中的关键词（词表里的写法） */
  keyword: string;
  /** 这个词登记在哪些条目下 */
  codes: string[];
}

export interface KeywordAutomaton {
  /** 去重后的关键词数 */
  readonly size: number;
  /**
   * 找出全部命中。给了 seen（已命中的关键词集合，调用方按记录新建、跨字段共用）时，同一个词只报第一次，
   * 之后的重复出现不再生成命中对象：一条记录里同一个词重复几百万次也只占一个对象。
   */
  search(text: string, seen?: Set<number>): KeywordHit[];
}

/** 单个 UTF-16 码元归一化：全角 ASCII → 半角，全角空格 → 空格，A-Z → a-z。 */
export function foldCode(c: number): number {
  if (c >= 0xff01 && c <= 0xff5e) c -= 0xfee0;
  else if (c === 0x3000) return 0x20;
  if (c >= 65 && c <= 90) return c + 32;
  return c;
}

export function foldText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(foldCode(s.charCodeAt(i)));
  return out;
}

interface Pattern {
  keyword: string;
  len: number;
  codes: string[];
}

export function buildKeywordAutomaton(
  entries: readonly KeywordEntry[],
  opts: { minLength?: number } = {},
): KeywordAutomaton {
  const minLength = Math.max(1, opts.minLength ?? 1);
  const next: Map<number, number>[] = [new Map()];
  const outPat: number[] = [-1];
  const patterns: Pattern[] = [];
  const byFolded = new Map<string, number>();

  for (const e of entries) {
    const term = (e.term ?? '').trim();
    if (term.length < minLength) continue;
    const folded = foldText(term);
    const known = byFolded.get(folded);
    if (known !== undefined) {
      const codes = patterns[known]!.codes;
      if (!codes.includes(e.code)) codes.push(e.code);
      continue;
    }
    let s = 0;
    for (let i = 0; i < folded.length; i++) {
      const c = folded.charCodeAt(i);
      let n = next[s]!.get(c);
      if (n === undefined) {
        n = next.length;
        next.push(new Map());
        outPat.push(-1);
        next[s]!.set(c, n);
      }
      s = n;
    }
    const idx = patterns.length;
    patterns.push({ keyword: term, len: folded.length, codes: [e.code] });
    byFolded.set(folded, idx);
    outPat[s] = idx;
  }

  // 失配链接和输出链接（最近的、带输出的后缀状态），按层 BFS 建
  const fail = new Int32Array(next.length);
  const dict = new Int32Array(next.length);
  const queue: number[] = [];
  for (const v of next[0]!.values()) queue.push(v);
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi]!;
    for (const [c, v] of next[u]!) {
      let f = fail[u]!;
      let target = 0;
      for (;;) {
        const g = next[f]!.get(c);
        if (g !== undefined && g !== v) {
          target = g;
          break;
        }
        if (f === 0) break;
        f = fail[f]!;
      }
      fail[v] = target;
      dict[v] = outPat[target]! >= 0 ? target : dict[target]!;
      queue.push(v);
    }
  }

  return {
    size: patterns.length,
    search(text: string, seen?: Set<number>): KeywordHit[] {
      const hits: KeywordHit[] = [];
      if (patterns.length === 0 || !text) return hits;
      if (seen && seen.size >= patterns.length) return hits;
      let s = 0;
      for (let i = 0; i < text.length; i++) {
        const c = foldCode(text.charCodeAt(i));
        for (;;) {
          const n = next[s]!.get(c);
          if (n !== undefined) {
            s = n;
            break;
          }
          if (s === 0) break;
          s = fail[s]!;
        }
        let t = outPat[s]! >= 0 ? s : dict[s]!;
        while (t !== 0) {
          const pi = outPat[t]!;
          t = dict[t]!;
          if (seen) {
            if (seen.has(pi)) continue;
            seen.add(pi);
          }
          const p = patterns[pi]!;
          hits.push({ start: i + 1 - p.len, end: i + 1, keyword: p.keyword, codes: p.codes });
        }
      }
      return hits;
    },
  };
}
