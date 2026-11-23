// 用户自定义外置规则库（1.2.3）：关键词或正则，带类别名和严重度。
// 校验（长度、嵌套量词、语法）、CSV/txt 导入解析（xlsx 由服务端读成二维表后走 parseRuleRows）和匹配器都在这里，
// 服务端和命令行版共用。纯函数，只依赖 node 内置模块，只用可擦除的 TS 语法。
import { createContext, Script } from 'node:vm';
import { buildKeywordAutomaton } from './keyword-matcher.ts';

export const RULE_KINDS = ['keyword', 'regex'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export const RULE_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

export const REGEX_MAX_LENGTH = 500;
export const KEYWORD_MAX_LENGTH = 200;
export const CATEGORY_MAX_LENGTH = 50;
/** 一个规则集里正则规则的条数上限（关键词另算）；扫描时也只取前这么多条 */
export const REGEX_RULES_MAX = 500;
/** 单条记录、单条正则匹配的时间上限 */
export const REGEX_TIMEOUT_MS = 200;
/** 同一条正则在一次扫描里超时这么多次就停用 */
export const REGEX_TIMEOUTS_TO_DISABLE = 3;
/** 一批记录的正则匹配按这个时长分片执行，分片之间交还控制权（服务端借此让出事件循环） */
export const REGEX_SLICE_MS = 50;
/** 参与正则匹配的单个字段长度上限，进一步限制最坏耗时 */
export const REGEX_TEXT_MAX = 100_000;

// 灾难性回溯的典型写法，保存时直接拒绝。检查是启发式的，漏网的靠扫描时的超时和停用兜底：
// 1. 嵌套量词：重复的分组里还有重复，如 (a+)+、((a+))+b、(?:(?:a+))+b、(\d*)*、(?:[a-z]+){2,}；
// 2. 重复的分组里有能匹配同样开头的分支，如 (a|a)*、(a|aa)+、(\w|\d)+；
// 3. 连续三个以上能匹配同样字符的无上限重复，如 \d+\d+\d+。
// 第一条原来的写法与平台自定义风险规则的检查一致，保留作兜底。
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;
const REDOS_MESSAGE = '正则包含嵌套量词，存在回溯风险（ReDoS），请改写';

interface Quant {
  min: number;
  max: number;
}
interface AtomNode {
  kind: 'atom';
  /** 能单独编译的写法（字符、转义、字符类、.）；零宽的（^、$、\b）为 null */
  src: string | null;
  q: Quant | null;
}
interface GroupNode {
  kind: 'group';
  alts: RegexNode[][];
  q: Quant | null;
}
type RegexNode = AtomNode | GroupNode;

/** 把正则拆成分组、分支和原子（只处理检查要用的结构；语法已经由 RegExp 校验过）。 */
function parseRegexTree(p: string): GroupNode {
  let i = 0;
  const parseQuant = (): Quant | null => {
    const c = p[i];
    let q: Quant | null = null;
    if (c === '*') q = { min: 0, max: Infinity };
    else if (c === '+') q = { min: 1, max: Infinity };
    else if (c === '?') q = { min: 0, max: 1 };
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
      if (!m) return null;
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      i += m[0].length;
      if (p[i] === '?') i += 1;
      return { min, max };
    }
    if (!q) return null;
    i += 1;
    if (p[i] === '?') i += 1;
    return q;
  };
  const parseEscape = (): string | null => {
    // p[i] === '\\'
    const c = p[i + 1] ?? '';
    let len = 2;
    if (c === 'b' || c === 'B') {
      i += 2;
      return null;
    }
    if (c === 'u' && p[i + 2] === '{') len = p.indexOf('}', i) - i + 1;
    else if (c === 'u') len = 6;
    else if (c === 'x') len = 4;
    else if (c === 'c') len = 3;
    else if ((c === 'p' || c === 'P') && p[i + 2] === '{') len = p.indexOf('}', i) - i + 1;
    else if (c === 'k' && p[i + 2] === '<') {
      i = p.indexOf('>', i) + 1;
      return '[\\s\\S]'; // 反向引用：当作任意字符
    } else if (/[1-9]/.test(c)) {
      i += 2;
      while (/\d/.test(p[i] ?? '')) i += 1;
      return '[\\s\\S]';
    }
    const src = p.slice(i, i + Math.max(2, len));
    i += Math.max(2, len);
    return src;
  };
  const parseClass = (): string => {
    const start = i;
    i += 1;
    while (i < p.length && p[i] !== ']') i += p[i] === '\\' ? 2 : 1;
    i += 1;
    return p.slice(start, i);
  };
  const parseAlts = (): RegexNode[][] => {
    const alts: RegexNode[][] = [[]];
    while (i < p.length) {
      const c = p[i]!;
      if (c === ')') break;
      if (c === '|') {
        alts.push([]);
        i += 1;
        continue;
      }
      let node: RegexNode;
      if (c === '(') {
        i += 1;
        if (p[i] === '?') {
          if (p[i + 1] === '<' && p[i + 2] !== '=' && p[i + 2] !== '!') i = p.indexOf('>', i) + 1;
          else i += p[i + 1] === '<' ? 3 : 2;
        }
        const inner = parseAlts();
        i += 1; // ')'
        node = { kind: 'group', alts: inner, q: null };
      } else if (c === '[') node = { kind: 'atom', src: parseClass(), q: null };
      else if (c === '\\') node = { kind: 'atom', src: parseEscape(), q: null };
      else if (c === '^' || c === '$') {
        i += 1;
        node = { kind: 'atom', src: null, q: null };
      } else {
        i += 1;
        node = {
          kind: 'atom',
          src: c === '.' ? '.' : c.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'),
          q: null,
        };
      }
      node.q = parseQuant();
      alts[alts.length - 1]!.push(node);
    }
    return alts;
  };
  return { kind: 'group', alts: parseAlts(), q: null };
}

const repeats = (q: Quant | null) => !!q && q.max > 1;

function containsRepeat(alts: RegexNode[][]): boolean {
  return alts.some((seq) =>
    seq.some((n) => repeats(n.q) || (n.kind === 'group' && containsRepeat(n.alts))),
  );
}

// 判断两个原子能不能匹配同一个字符：拿一组有代表性的字符逐个试
const SAMPLE_CHARS = (() => {
  const out = ['\t', '\n', '\r', ' ', '　', 'é', '中', '一', '，', '０'];
  for (let c = 0x20; c < 0x7f; c++) out.push(String.fromCharCode(c));
  return out;
})();
const atomRegexCache = new Map<string, RegExp | null>();
function atomRegex(src: string): RegExp | null {
  let re = atomRegexCache.get(src);
  if (re === undefined) {
    try {
      re = new RegExp(`^(?:${src})$`, 'i');
    } catch {
      re = null;
    }
    atomRegexCache.set(src, re);
  }
  return re;
}
function atomsOverlap(a: AtomNode, b: AtomNode): boolean {
  if (a.src === null || b.src === null) return false;
  const ra = atomRegex(a.src);
  const rb = atomRegex(b.src);
  if (!ra || !rb) return false;
  return SAMPLE_CHARS.some((ch) => ra.test(ch) && rb.test(ch));
}

/** 两个分支（都只由不带量词的原子组成）里，短的那个逐位都能和长的对上：(a|aa)、(\w|\d)。 */
function branchesOverlap(x: RegexNode[], y: RegexNode[]): boolean {
  const plain = (seq: RegexNode[]) =>
    seq.length > 0 && seq.every((n) => n.kind === 'atom' && n.src !== null && !n.q);
  if (!plain(x) || !plain(y)) return false;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.every((n, k) => atomsOverlap(n as AtomNode, l[k] as AtomNode));
}

function hasRedosShape(alts: RegexNode[][]): boolean {
  for (const seq of alts) {
    let run = 1;
    for (let k = 0; k < seq.length; k++) {
      const n = seq[k]!;
      if (n.kind === 'group') {
        if (repeats(n.q) && containsRepeat(n.alts)) return true;
        if (repeats(n.q)) {
          for (let a = 0; a < n.alts.length; a++)
            for (let b = a + 1; b < n.alts.length; b++)
              if (branchesOverlap(n.alts[a]!, n.alts[b]!)) return true;
        }
        if (hasRedosShape(n.alts)) return true;
        run = 1;
        continue;
      }
      const prev = seq[k - 1];
      const unbounded = !!n.q && n.q.max === Infinity;
      if (unbounded && prev?.kind === 'atom' && prev.q?.max === Infinity && atomsOverlap(prev, n)) {
        run += 1;
        if (run >= 3) return true;
      } else run = 1;
    }
  }
  return false;
}

export function validateRegexPattern(pattern: string): string | null {
  if (pattern.length > REGEX_MAX_LENGTH) return `正则长度不能超过 ${REGEX_MAX_LENGTH} 个字符`;
  try {
    new RegExp(pattern, 'i');
  } catch {
    return '正则语法错误';
  }
  if (NESTED_QUANTIFIER.test(pattern)) return REDOS_MESSAGE;
  let risky = false;
  try {
    risky = hasRedosShape(parseRegexTree(pattern).alts);
  } catch {
    risky = false; // 拆不开的写法不额外拒绝，靠扫描时的超时兜底
  }
  return risky ? REDOS_MESSAGE : null;
}

export interface RuleInput {
  kind: RuleKind;
  pattern: string;
  category: string;
  severity: RuleSeverity;
  enabled: boolean;
}

export interface CustomRule extends RuleInput {
  id: string;
}

/** 单条规则的合法性；返回出错原因。 */
export function validateRule(r: RuleInput): string | null {
  if (!r.pattern.trim()) return '规则内容为空';
  if (r.kind === 'keyword' && r.pattern.length > KEYWORD_MAX_LENGTH) {
    return `关键词不能超过 ${KEYWORD_MAX_LENGTH} 个字符`;
  }
  if (r.kind === 'regex') {
    const err = validateRegexPattern(r.pattern);
    if (err) return err;
  }
  if (!r.category.trim()) return '类别为空';
  if (r.category.length > CATEGORY_MAX_LENGTH) return `类别不能超过 ${CATEGORY_MAX_LENGTH} 个字符`;
  return null;
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

export interface RuleImportDefaults {
  category: string;
  severity: RuleSeverity;
  kind?: RuleKind;
}

export interface RuleImportIssue {
  row: number;
  message: string;
}

export interface ParsedRuleImport {
  rows: RuleInput[];
  issues: RuleImportIssue[];
  /** 有内容的数据行数（不含表头和空行） */
  totalRows: number;
  /** 文件内重复的规则（同类型同内容） */
  duplicates: number;
}

const KIND_ALIASES: Record<string, RuleKind> = {
  keyword: 'keyword',
  kw: 'keyword',
  关键词: 'keyword',
  关键字: 'keyword',
  词: 'keyword',
  regex: 'regex',
  regexp: 'regex',
  re: 'regex',
  正则: 'regex',
  正则表达式: 'regex',
};
const SEVERITY_ALIASES: Record<string, RuleSeverity> = {
  critical: 'CRITICAL',
  严重: 'CRITICAL',
  high: 'HIGH',
  高: 'HIGH',
  高危: 'HIGH',
  medium: 'MEDIUM',
  中: 'MEDIUM',
  中危: 'MEDIUM',
  low: 'LOW',
  低: 'LOW',
  低危: 'LOW',
};
const TRUE_WORDS = new Set(['true', '1', '是', '启用', 'y', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', '否', '停用', '禁用', 'n', 'no', 'off']);

const HEADER_ALIASES: Record<'kind' | 'pattern' | 'category' | 'severity' | 'enabled', string[]> = {
  kind: ['kind', 'type', '类型', '规则类型'],
  pattern: ['pattern', 'rule', 'content', '内容', '规则', '规则内容', '关键词', '正则', '表达式'],
  category: ['category', '类别', '类别名', '分类'],
  severity: ['severity', 'level', '严重度', '等级', '级别'],
  enabled: ['enabled', '启用', '状态'],
};

/** 整段 CSV 文本 → 二维表（支持引号、引号内逗号与换行、"" 转义）。 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normCell(v: string | undefined): string {
  return (v ?? '').replace(/^﻿/, '').trim();
}

/** 二维表（CSV、xlsx 读出来的）→ 规则。首行能认出「内容」列就当表头；否则单列当关键词，多列按 类型,内容,类别,严重度,启用。 */
export function parseRuleRows(table: string[][], defaults: RuleImportDefaults): ParsedRuleImport {
  const out: ParsedRuleImport = { rows: [], issues: [], totalRows: 0, duplicates: 0 };
  const head = (table[0] ?? []).map((c) => normCell(c).toLowerCase());
  const col = (key: keyof typeof HEADER_ALIASES) =>
    head.findIndex((h) => HEADER_ALIASES[key].includes(h));
  const hasHeader = col('pattern') >= 0;
  const idx = hasHeader
    ? {
        kind: col('kind'),
        pattern: col('pattern'),
        category: col('category'),
        severity: col('severity'),
        enabled: col('enabled'),
      }
    : { kind: 0, pattern: 1, category: 2, severity: 3, enabled: 4 };
  const seen = new Set<string>();
  for (let i = hasHeader ? 1 : 0; i < table.length; i++) {
    const cells = table[i]!.map(normCell);
    if (cells.every((c) => c === '')) continue;
    out.totalRows += 1;
    const rowNo = i + 1;
    const get = (k: keyof typeof idx) => (idx[k] >= 0 ? (cells[idx[k]] ?? '') : '');
    const single = !hasHeader && cells.filter((c) => c !== '').length === 1 && cells[0] !== '';
    const kindRaw = single ? '' : get('kind');
    const pattern = single ? cells[0]! : get('pattern');
    const kind =
      kindRaw === '' ? (defaults.kind ?? 'keyword') : KIND_ALIASES[kindRaw.toLowerCase()];
    if (!kind) {
      out.issues.push({ row: rowNo, message: `类型「${kindRaw}」不认识，应为 关键词 或 正则` });
      continue;
    }
    const sevRaw = single ? '' : get('severity');
    const severity = sevRaw === '' ? defaults.severity : SEVERITY_ALIASES[sevRaw.toLowerCase()];
    if (!severity) {
      out.issues.push({
        row: rowNo,
        message: `严重度「${sevRaw}」不认识，应为 严重、高、中 或 低`,
      });
      continue;
    }
    const enRaw = (single ? '' : get('enabled')).toLowerCase();
    if (enRaw !== '' && !TRUE_WORDS.has(enRaw) && !FALSE_WORDS.has(enRaw)) {
      out.issues.push({ row: rowNo, message: `启用列「${enRaw}」应为 是 或 否` });
      continue;
    }
    const category = (single ? '' : get('category')) || defaults.category;
    const rule: RuleInput = { kind, pattern, category, severity, enabled: !FALSE_WORDS.has(enRaw) };
    const err = validateRule(rule);
    if (err) {
      out.issues.push({ row: rowNo, message: err });
      continue;
    }
    const key = `${kind}\u0000${pattern}`;
    if (seen.has(key)) {
      out.duplicates += 1;
      continue;
    }
    seen.add(key);
    out.rows.push(rule);
  }
  return out;
}

/** CSV 或 txt（每行一个关键词）导入。 */
export function parseRuleImport(
  format: 'csv' | 'txt',
  text: string,
  defaults: RuleImportDefaults,
): ParsedRuleImport {
  if (format === 'csv') return parseRuleRows(parseCsvRows(text), defaults);
  const out: ParsedRuleImport = { rows: [], issues: [], totalRows: 0, duplicates: 0 };
  const seen = new Set<string>();
  text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const pattern = raw.trim();
      if (!pattern) return;
      out.totalRows += 1;
      const rule: RuleInput = {
        kind: defaults.kind ?? 'keyword',
        pattern,
        category: defaults.category,
        severity: defaults.severity,
        enabled: true,
      };
      const err = validateRule(rule);
      if (err) return void out.issues.push({ row: i + 1, message: err });
      if (seen.has(pattern)) return void (out.duplicates += 1);
      seen.add(pattern);
      out.rows.push(rule);
    });
  return out;
}

// ---------------------------------------------------------------------------
// 匹配
// ---------------------------------------------------------------------------

export interface CustomHit {
  ruleId: string;
  kind: RuleKind;
  category: string;
  severity: RuleSeverity;
  /** 记录里第几个字段 */
  fieldIndex: number;
  start: number;
  end: number;
  value: string;
}

export interface DisabledRule {
  ruleId: string;
  pattern: string;
  category: string;
}

export interface CustomMatcher {
  /** 参与匹配的规则数（启用的；正则最多 REGEX_RULES_MAX 条） */
  readonly size: number;
  /** 超过 REGEX_RULES_MAX 条没有参与匹配的正则数 */
  readonly ignoredRegexRules: number;
  /** 一条记录的全部字段；同一条规则在一条记录里只记第一次命中（测试和小样本用） */
  scan(texts: string[]): CustomHit[];
  /**
   * 一批记录（每条是全部字段的文本）：关键词逐条匹配；正则整批放进一次 vm 执行，按 REGEX_SLICE_MS 分片，
   * 分片之间 yield 一次（调用方借此让出事件循环）。返回与 records 一一对应的命中。
   */
  scanBatch(records: readonly (readonly string[])[]): Generator<void, CustomHit[][], void>;
  /** 正则超时的次数（单条记录、单条正则算一次） */
  timeouts(): number;
  /** 超时 REGEX_TIMEOUTS_TO_DISABLE 次后停用的正则 */
  disabledRules(): DisabledRule[];
  /** 超过 REGEX_TEXT_MAX、正则只检查了前面一段的字段数 */
  truncatedFields(): number;
}

// 在 vm 里跑一批记录 × 全部启用的正则。进度写进 prog（[记录, 规则, 只跑一对]），超时被打断时外面能接着跑；
// 命中按 [记录, 规则, 字段, 位置, 长度] 五个数一组写进 out。只在开头读一次上下文里的变量（读写沙箱全局变量很慢）。
const REGEX_SCRIPT = new Script(
  '(function () {' +
    ' const R = res, A = active, T = recs, P = prog, O = out;' +
    ' const r0 = P[0], k0 = P[1], one = P[2], nr = T.length, nk = R.length;' +
    ' O.length = 0;' +
    ' for (let i = r0; i < nr; i++) {' +
    '  const texts = T[i];' +
    '  for (let k = i === r0 ? k0 : 0; k < nk; k++) {' +
    '   if (A[k] === 0) continue;' +
    '   P[0] = i; P[1] = k;' +
    '   const re = R[k];' +
    '   for (let f = 0; f < texts.length; f++) {' +
    '    const m = re.exec(texts[f]);' +
    '    if (m !== null && m[0] !== "") { O.push(i, k, f, m.index, m[0].length); break; }' +
    '   }' +
    '   if (one === 1) return;' +
    '  }' +
    ' }' +
    ' P[0] = nr; P[1] = 0;' +
    '})()',
);

export function compileCustomRules(
  rules: readonly CustomRule[],
  opts: { timeoutMs?: number; sliceMs?: number } = {},
): CustomMatcher {
  const enabled = rules.filter((r) => r.enabled);
  const byId = new Map(enabled.map((r) => [r.id, r]));
  const keywordRules = enabled.filter((r) => r.kind === 'keyword');
  const keywordIds = keywordRules.map((r) => r.id);
  const ac = buildKeywordAutomaton(keywordRules.map((r) => ({ term: r.pattern, code: r.id })));
  const regexRules: { rule: CustomRule; re: RegExp }[] = [];
  let ignoredRegexRules = 0;
  for (const rule of enabled) {
    if (rule.kind !== 'regex') continue;
    if (regexRules.length >= REGEX_RULES_MAX) {
      ignoredRegexRules += 1;
      continue;
    }
    try {
      regexRules.push({ rule, re: new RegExp(rule.pattern, 'i') });
    } catch {
      // 入库时已校验；历史坏数据跳过
    }
  }
  const nk = regexRules.length;
  const active = new Uint8Array(nk).fill(1);
  const ruleTimeouts = new Uint16Array(nk);
  const prog = [0, 0, 0];
  const out: number[] = [];
  const context = createContext({
    res: regexRules.map((x) => x.re),
    active,
    recs: [] as string[][],
    prog,
    out,
  });
  const timeoutMs = opts.timeoutMs ?? REGEX_TIMEOUT_MS;
  const sliceMs = Math.min(opts.sliceMs ?? REGEX_SLICE_MS, timeoutMs);
  let activeCount = nk;
  let timeouts = 0;
  let truncated = 0;
  const disabled: DisabledRule[] = [];

  const run = (ms: number): boolean => {
    try {
      REGEX_SCRIPT.runInContext(context, { timeout: ms });
      return true;
    } catch {
      return false; // 超时（或正则执行出错），进度在 prog 里
    }
  };

  function* regexBatch(texts: string[][]): Generator<void, number[], void> {
    const found: number[] = [];
    if (activeCount === 0 || texts.length === 0) return found;
    const done = new Set<number>(); // 记录 × 规则，中断重跑时不重复记
    const collect = () => {
      for (let j = 0; j + 4 < out.length; j += 5) {
        const key = out[j]! * nk + out[j + 1]!;
        if (done.has(key)) continue;
        done.add(key);
        found.push(out[j]!, out[j + 1]!, out[j + 2]!, out[j + 3]!, out[j + 4]!);
      }
      out.length = 0;
    };
    context.recs = texts;
    prog[0] = 0;
    prog[1] = 0;
    prog[2] = 0;
    try {
      while (prog[0]! < texts.length && activeCount > 0) {
        const r0: number = prog[0]!;
        const k0: number = prog[1]!;
        const ok = run(sliceMs);
        collect();
        if (ok) break;
        if (prog[0] === r0 && prog[1] === k0) {
          // 一整片都卡在同一对（记录, 规则）上：单独给它一次完整的时间
          yield;
          prog[2] = 1;
          const pairOk = run(timeoutMs);
          prog[2] = 0;
          collect();
          const rr: number = prog[0]!;
          const kk: number = prog[1]!;
          if (rr >= texts.length) break;
          if (!pairOk && active[kk] === 1) {
            timeouts += 1;
            ruleTimeouts[kk] = ruleTimeouts[kk]! + 1;
            if (ruleTimeouts[kk]! >= REGEX_TIMEOUTS_TO_DISABLE) {
              active[kk] = 0;
              activeCount -= 1;
              const { rule } = regexRules[kk]!;
              disabled.push({ ruleId: rule.id, pattern: rule.pattern, category: rule.category });
            }
          }
          prog[0] = kk + 1 < nk ? rr : rr + 1;
          prog[1] = kk + 1 < nk ? kk + 1 : 0;
        }
        yield;
      }
    } finally {
      context.recs = [];
      out.length = 0;
    }
    return found;
  }

  function* scanBatch(
    records: readonly (readonly string[])[],
  ): Generator<void, CustomHit[][], void> {
    const hits: CustomHit[][] = records.map(() => []);
    if (ac.size > 0) {
      // 同一个词一条记录只报一次；每条关键词规则只对应一个词，所以同一条规则也只记一次
      records.forEach((texts, r) => {
        const seen = new Set<number>();
        texts.forEach((text, fieldIndex) => {
          for (const h of ac.search(text, seen)) {
            for (const id of h.codes) {
              const rule = byId.get(id)!;
              hits[r]!.push({
                ruleId: id,
                kind: 'keyword',
                category: rule.category,
                severity: rule.severity,
                fieldIndex,
                start: h.start,
                end: h.end,
                value: text.slice(h.start, h.end),
              });
            }
          }
        });
      });
    }
    if (nk > 0 && activeCount > 0) {
      const texts = records.map((fields) =>
        fields.map((t) => {
          if (t.length <= REGEX_TEXT_MAX) return t;
          truncated += 1;
          return t.slice(0, REGEX_TEXT_MAX);
        }),
      );
      const found = yield* regexBatch(texts);
      for (let j = 0; j + 4 < found.length; j += 5) {
        const r = found[j]!;
        const { rule } = regexRules[found[j + 1]!]!;
        const fieldIndex = found[j + 2]!;
        const start = found[j + 3]!;
        const end = start + found[j + 4]!;
        hits[r]!.push({
          ruleId: rule.id,
          kind: 'regex',
          category: rule.category,
          severity: rule.severity,
          fieldIndex,
          start,
          end,
          value: records[r]![fieldIndex]!.slice(start, end),
        });
      }
    }
    return hits;
  }

  return {
    size: keywordIds.length + nk,
    ignoredRegexRules,
    timeouts: () => timeouts,
    disabledRules: () => disabled.slice(),
    truncatedFields: () => truncated,
    scanBatch,
    scan(texts: string[]): CustomHit[] {
      const g = scanBatch([texts]);
      for (;;) {
        const r = g.next();
        if (r.done) return r.value[0]!;
      }
    },
  };
}
