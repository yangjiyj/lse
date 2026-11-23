/**
 * AI-Infra-Guard 规则表达式的安全解析与求值（递归下降，不用 eval）。
 *
 * 语法：
 *   expr   := and ('||' and)*
 *   and    := unary ('&&' unary)*
 *   unary  := '(' expr ')' | cmp
 *   cmp    := IDENT OP STRING
 *   OP     := '<' | '<=' | '>' | '>=' | '==' | '=' | '!='
 * 左侧只接受 version；is_internal 等非版本规则解析为 kind='non_version'，不参与版本判定。
 * 求值为三值逻辑：true / false / null（无法判定，如版本号不可解析）。
 */
import { compareVersions } from './version.js';

export type CompareOp = '<' | '<=' | '>' | '>=' | '==' | '!=';

export type RuleAst =
  | { type: 'cmp'; op: CompareOp; value: string }
  | { type: 'and'; items: RuleAst[] }
  | { type: 'or'; items: RuleAst[] };

export type ParsedRule =
  | { kind: 'version'; ast: RuleAst }
  | { kind: 'empty' }
  | { kind: 'non_version'; field: string }
  | { kind: 'invalid'; error: string };

type Token =
  | { t: 'ident'; v: string }
  | { t: 'op'; v: CompareOp }
  | { t: 'str'; v: string }
  | { t: 'and' | 'or' | 'lp' | 'rp' };

const MAX_RULE_LENGTH = 4096;
const MAX_DEPTH = 32;

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] ?? '';
    if (/\s/.test(ch)) {
      i += 1;
    } else if (input.startsWith('&&', i)) {
      out.push({ t: 'and' });
      i += 2;
    } else if (input.startsWith('||', i)) {
      out.push({ t: 'or' });
      i += 2;
    } else if (ch === '(') {
      out.push({ t: 'lp' });
      i += 1;
    } else if (ch === ')') {
      out.push({ t: 'rp' });
      i += 1;
    } else if (/[<>=!]/.test(ch)) {
      const two = input.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '==' || two === '!=') {
        out.push({ t: 'op', v: two });
        i += 2;
      } else if (ch === '<' || ch === '>') {
        out.push({ t: 'op', v: ch });
        i += 1;
      } else if (ch === '=') {
        out.push({ t: 'op', v: '==' });
        i += 1;
      } else {
        throw new Error(`非法运算符：${ch}`);
      }
    } else if (ch === '"' || ch === "'") {
      const end = input.indexOf(ch, i + 1);
      if (end < 0) throw new Error('字符串未闭合');
      out.push({ t: 'str', v: input.slice(i + 1, end) });
      i = end + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i));
      const word = m?.[0] ?? ch;
      out.push({ t: 'ident', v: word });
      i += word.length;
    } else {
      throw new Error(`非法字符：${ch}`);
    }
  }
  return out;
}

class Parser {
  private pos = 0;
  readonly fields = new Set<string>();
  constructor(private readonly tokens: Token[]) {}

  parse(): RuleAst {
    const ast = this.expr(0);
    if (this.pos !== this.tokens.length) throw new Error('表达式末尾存在多余内容');
    return ast;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private expr(depth: number): RuleAst {
    if (depth > MAX_DEPTH) throw new Error('括号嵌套过深');
    const items = [this.and(depth)];
    while (this.peek()?.t === 'or') {
      this.pos += 1;
      items.push(this.and(depth));
    }
    return items.length === 1 ? (items[0] as RuleAst) : { type: 'or', items };
  }

  private and(depth: number): RuleAst {
    const items = [this.unary(depth)];
    while (this.peek()?.t === 'and') {
      this.pos += 1;
      items.push(this.unary(depth));
    }
    return items.length === 1 ? (items[0] as RuleAst) : { type: 'and', items };
  }

  private unary(depth: number): RuleAst {
    const tok = this.peek();
    if (tok?.t === 'lp') {
      this.pos += 1;
      const inner = this.expr(depth + 1);
      if (this.peek()?.t !== 'rp') throw new Error('缺少右括号');
      this.pos += 1;
      return inner;
    }
    const ident = this.tokens[this.pos];
    const op = this.tokens[this.pos + 1];
    const str = this.tokens[this.pos + 2];
    if (ident?.t !== 'ident' || op?.t !== 'op' || str?.t !== 'str') {
      throw new Error('比较式格式应为 version <运算符> "版本"');
    }
    this.pos += 3;
    this.fields.add(ident.v);
    return { type: 'cmp', op: op.v, value: str.v };
  }
}

export function parseRule(raw: unknown): ParsedRule {
  if (raw === null || raw === undefined) return { kind: 'empty' };
  if (typeof raw !== 'string') return { kind: 'invalid', error: '规则不是字符串' };
  const text = raw.trim();
  if (!text) return { kind: 'empty' };
  if (text.length > MAX_RULE_LENGTH) return { kind: 'invalid', error: '规则过长' };
  try {
    const parser = new Parser(tokenize(text));
    const ast = parser.parse();
    const others = [...parser.fields].filter((f) => f !== 'version');
    if (others.length > 0) return { kind: 'non_version', field: others.join(',') };
    return { kind: 'version', ast };
  } catch (error) {
    return { kind: 'invalid', error: (error as Error).message };
  }
}

/** 三值求值：true 受影响、false 不受影响、null 无法判定。 */
export function evaluateRule(ast: RuleAst, version: string): boolean | null {
  if (ast.type === 'cmp') {
    const diff = compareVersions(version, ast.value);
    if (diff === null) return null;
    switch (ast.op) {
      case '<':
        return diff < 0;
      case '<=':
        return diff <= 0;
      case '>':
        return diff > 0;
      case '>=':
        return diff >= 0;
      case '==':
        return diff === 0;
      case '!=':
        return diff !== 0;
    }
  }
  const results = ast.items.map((item) => evaluateRule(item, version));
  if (ast.type === 'and') {
    if (results.includes(false)) return false;
    return results.includes(null) ? null : true;
  }
  if (results.includes(true)) return true;
  return results.includes(null) ? null : false;
}

/** 便捷入口：解析 + 求值；非版本规则、空规则、非法规则一律返回 null（无法判定）。 */
export function evaluateRuleText(rule: string, version: string): boolean | null {
  const parsed = parseRule(rule);
  if (parsed.kind !== 'version') return null;
  return evaluateRule(parsed.ast, version);
}
