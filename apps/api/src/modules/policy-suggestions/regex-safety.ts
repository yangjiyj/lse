// 策略建议 matcher 的 RE2 兼容子集校验与本地实测。
// 网关（Go regexp，RE2 语义）不支持回溯引用与环视；LSE 生成/人工修改的 regex 必须落在两边都能编译的子集内。

export const MAX_REGEX_BYTES = 256;
export const MAX_LIST_ITEMS = 100;
export const MAX_ITEM_BYTES = 256;

export type MatcherKind = 'regex' | 'keywords' | 'field_names';
export type Matcher =
  | { kind: 'regex'; value: string }
  | { kind: 'keywords'; value: string[] }
  | { kind: 'field_names'; value: string[] };

export interface MatcherCheck {
  ok: boolean;
  error: string | null;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** 仅允许开头一个 (?i)；其余内联标志、环视、命名组引用、回溯引用、原子组一律拒绝。 */
const FORBIDDEN_CONSTRUCTS: Array<{ re: RegExp; message: string }> = [
  { re: /\\[1-9]/, message: '不支持回溯引用（\\1 等）' },
  { re: /\\k</, message: '不支持命名回溯引用' },
  { re: /\(\?<?[=!]/, message: '不支持环视（(?= (?! (?<= (?<!）' },
  { re: /\(\?>/, message: '不支持原子组' },
  { re: /[*+?}]\+/, message: '不支持占有量词' },
  { re: /\(\?<[A-Za-z]/, message: '不支持 JS 命名分组语法' },
];

function splitCaseFlag(pattern: string): { body: string; ignoreCase: boolean } {
  if (pattern.startsWith('(?i)')) return { body: pattern.slice(4), ignoreCase: true };
  return { body: pattern, ignoreCase: false };
}

/** 转为 JS RegExp（用于本地实测命中）；不合规时抛错。 */
export function compileRe2Subset(pattern: string): RegExp {
  const check = checkRegex(pattern);
  if (!check.ok) throw new Error(check.error ?? 'regex 不合规');
  const { body, ignoreCase } = splitCaseFlag(pattern);
  return new RegExp(body, ignoreCase ? 'iu' : 'u');
}

export function checkRegex(pattern: string): MatcherCheck {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { ok: false, error: '正则不能为空' };
  }
  if (utf8Bytes(pattern) > MAX_REGEX_BYTES) {
    return { ok: false, error: `正则长度超过 ${MAX_REGEX_BYTES} 字节` };
  }
  const { body } = splitCaseFlag(pattern);
  if (/\(\?[a-zA-Z]/.test(body.replace(/\(\?:/g, ''))) {
    return { ok: false, error: '仅允许在开头使用 (?i)，不支持其他内联标志' };
  }
  for (const item of FORBIDDEN_CONSTRUCTS) {
    if (item.re.test(body)) return { ok: false, error: item.message };
  }
  try {
    new RegExp(body, 'u');
  } catch {
    return { ok: false, error: '正则无法编译' };
  }
  return { ok: true, error: null };
}

export function checkList(values: unknown, label: string): MatcherCheck {
  if (!Array.isArray(values) || values.length === 0) {
    return { ok: false, error: `${label}不能为空` };
  }
  if (values.length > MAX_LIST_ITEMS) {
    return { ok: false, error: `${label}最多 ${MAX_LIST_ITEMS} 项` };
  }
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, error: `${label}包含空项` };
    }
    if (utf8Bytes(value) > MAX_ITEM_BYTES) {
      return { ok: false, error: `${label}单项超过 ${MAX_ITEM_BYTES} 字节` };
    }
  }
  return { ok: true, error: null };
}

export function checkMatcher(matcher: Matcher): MatcherCheck {
  if (matcher.kind === 'regex') return checkRegex(matcher.value);
  return checkList(matcher.value, matcher.kind === 'keywords' ? '关键词' : '字段名');
}

/** 转义为 RE2 与 JS(u 模式) 都接受的字面量。 */
export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 在文本上实测 matcher 是否命中（关键词/字段名：大小写不敏感的包含匹配）。 */
export function matcherHits(matcher: Matcher, text: string): boolean {
  if (!text) return false;
  if (matcher.kind === 'regex') return compileRe2Subset(matcher.value).test(text);
  const lower = text.toLowerCase();
  return matcher.value.some((item) => lower.includes(item.toLowerCase()));
}

/** 把短语并成 (?i)(?:a|b|c)，超长时从尾部丢弃短语直至 ≤256 字节。 */
export function phrasesToRegex(phrases: string[]): string | null {
  const kept = [...phrases];
  while (kept.length > 0) {
    const pattern = `(?i)(?:${kept.map(escapeRegexLiteral).join('|')})`;
    if (utf8Bytes(pattern) <= MAX_REGEX_BYTES) return pattern;
    kept.pop();
  }
  return null;
}
