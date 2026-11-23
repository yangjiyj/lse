/**
 * 轻量词法：为 py / js / ts / sh 生成两种“行号不变”的视图。
 * - code：注释替换为空格，字符串保留（用于看参数、拼接）。
 * - bare：注释与字符串内容都替换为空格，仅保留引号（用于匹配调用名，避免文档/注释误报）。
 * 所有替换保留换行，因此偏移量与行号与原文一一对应。
 */
export type CodeLang = 'py' | 'js' | 'sh' | 'md' | 'data' | 'other';

export function langOf(path: string): CodeLang {
  const p = path.toLowerCase();
  if (/\.(py|pyw)$/.test(p)) return 'py';
  if (/\.(js|mjs|cjs|jsx|ts|mts|cts|tsx)$/.test(p)) return 'js';
  if (/\.(sh|bash|zsh|ps1)$/.test(p)) return 'sh';
  if (/\.(md|mdx|markdown|txt|rst)$/.test(p)) return 'md';
  if (/\.(json|ya?ml|toml|ini|cfg|env|lock)$/.test(p) || /(^|\/)\.env(\.|$)/.test(p)) return 'data';
  return 'other';
}

export interface LexViews {
  code: string;
  bare: string;
  /** 字符串字面量：起止偏移与内容，供提取工具定义/检测拼接 */
  strings: Array<{ start: number; end: number; value: string; prefix: string }>;
}

function blank(s: string): string {
  return s.replace(/[^\n]/g, ' ');
}

export function lex(content: string, lang: CodeLang): LexViews {
  if (lang !== 'py' && lang !== 'js' && lang !== 'sh') {
    return { code: content, bare: content, strings: [] };
  }
  const code: string[] = [];
  const bare: string[] = [];
  const strings: LexViews['strings'] = [];
  let i = 0;
  const n = content.length;
  const push = (text: string, codeText: string, bareText: string) => {
    void text;
    code.push(codeText);
    bare.push(bareText);
  };
  while (i < n) {
    const ch = content[i]!;
    const next = content[i + 1];
    // 注释
    if ((lang === 'py' || lang === 'sh') && ch === '#') {
      const end = content.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      const seg = content.slice(i, stop);
      push(seg, blank(seg), blank(seg));
      i = stop;
      continue;
    }
    if (lang === 'js' && ch === '/' && next === '/') {
      const end = content.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      const seg = content.slice(i, stop);
      push(seg, blank(seg), blank(seg));
      i = stop;
      continue;
    }
    if (lang === 'js' && ch === '/' && next === '*') {
      const end = content.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      const seg = content.slice(i, stop);
      push(seg, blank(seg), blank(seg));
      i = stop;
      continue;
    }
    // 字符串
    const isQuote = ch === '"' || ch === "'" || (lang === 'js' && ch === '`');
    if (isQuote) {
      let prefix = '';
      if (lang === 'py') {
        const m = /([rRbBuUfF]{1,2})$/.exec(content.slice(Math.max(0, i - 2), i));
        if (m && !/[A-Za-z0-9_]/.test(content[i - m[1]!.length - 1] ?? '')) prefix = m[1]!.toLowerCase();
      }
      const triple = lang === 'py' && content.startsWith(ch.repeat(3), i);
      const delim = triple ? ch.repeat(3) : ch;
      let j = i + delim.length;
      while (j < n) {
        if (content[j] === '\\') {
          j += 2;
          continue;
        }
        if (content.startsWith(delim, j)) break;
        if (!triple && ch !== '`' && content[j] === '\n') break; // 未闭合的单行字符串
        j++;
      }
      const stop = Math.min(n, j + delim.length);
      const seg = content.slice(i, stop);
      const inner = content.slice(i + delim.length, Math.min(j, n));
      strings.push({ start: i, end: stop, value: inner, prefix: ch === '`' ? 'template' : prefix });
      // bare 中保留引号与模板插值标记，便于识别拼接
      const innerBare =
        ch === '`' ? inner.replace(/\$\{[^}]*\}/g, (m) => '${' + blank(m.slice(2))) : blank(inner);
      push(seg, seg, delim + innerBare + content.slice(i + delim.length + inner.length, stop));
      i = stop;
      continue;
    }
    push(ch, ch, ch);
    i++;
  }
  const out = { code: code.join(''), bare: bare.join(''), strings };
  // 长度自检：视图必须与原文等长，否则行号会错位
  if (out.code.length !== n || out.bare.length !== n) {
    return { code: content, bare: content, strings };
  }
  return out;
}

export interface LineIndex {
  /** 偏移 → 1 起始行号 */
  lineAt(offset: number): number;
  /** 1 起始行号 → 该行文本（不含行尾的 \r\n） */
  lineText(line: number): string;
}

/** 行首偏移表：每段文本只算一次，行号二分查找（逐条命中都从头数换行会退化成平方级）。 */
export function lineIndex(content: string): LineIndex {
  const starts = [0];
  for (let k = content.indexOf('\n'); k >= 0; k = content.indexOf('\n', k + 1)) starts.push(k + 1);
  return {
    lineAt(offset) {
      const o = Math.min(Math.max(offset, 0), content.length);
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= o) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    },
    lineText(line) {
      if (line < 1 || line > starts.length) return '';
      if (line === starts.length) return content.slice(starts[line - 1]!);
      const text = content.slice(starts[line - 1]!, starts[line]! - 1);
      return text.endsWith('\r') ? text.slice(0, -1) : text;
    },
  };
}

/** 最近一次建的行号表：同一段文本连续查询时复用（组件扫描逐条命中查行号）。 */
let lastIndex: { content: string; index: LineIndex } | null = null;
function cachedIndex(content: string): LineIndex {
  if (lastIndex?.content !== content) lastIndex = { content, index: lineIndex(content) };
  return lastIndex.index;
}

/** 偏移 → 1 起始行号 */
export function lineAt(content: string, offset: number): number {
  return cachedIndex(content).lineAt(offset);
}

export function lineText(content: string, line: number): string {
  return cachedIndex(content).lineText(line);
}
