import { lex, lineAt, lineText, type CodeLang } from './lexer.js';
import { SENSITIVE_PATH, type RuleHit } from './poisoning.js';

export interface SourceFile {
  path: string;
  content: string;
  lang: CodeLang;
}

interface CodeRule {
  ruleId: string;
  langs: CodeLang[];
  /** 在 bare 视图（剥离注释与字符串内容）上匹配调用名 */
  bare?: RegExp;
  /** 在 code 视图（仅剥离注释）上匹配，需要看字符串参数时使用 */
  code?: RegExp;
  confidence?: number;
  /** 命中位置附近（同一调用）需再满足的条件，在 code 视图上检查 */
  near?: RegExp;
  /** 文件级前提（code 视图），如 JS 需确实引入了 child_process */
  requires?: RegExp;
}

const CODE_RULES: CodeRule[] = [
  // —— 命令执行（经由 Shell）
  { ruleId: 'code.command_execution', langs: ['py'], bare: /\bos\s*\.\s*(?:system|popen)\s*\(|\bcommands\s*\.\s*getoutput\s*\(|\bpty\s*\.\s*spawn\s*\(/g },
  { ruleId: 'code.command_execution', langs: ['py'], bare: /\bsubprocess\s*\.\s*(?:run|call|Popen|check_output|check_call|getoutput|getstatusoutput)\s*\(/g, near: /shell\s*=\s*True|getoutput|getstatusoutput/ },
  { ruleId: 'code.command_execution', langs: ['py'], bare: /\basyncio\s*\.\s*create_subprocess_shell\s*\(/g },
  { ruleId: 'code.command_execution', langs: ['js'], bare: /\b(?:child_process|cp|childProcess)\s*\.\s*(?:exec|execSync)\s*\(|(?<![.\w])(?:exec|execSync)\s*\(/g, requires: /child_process|['"]execa['"]|['"]shelljs['"]/ },
  { ruleId: 'code.command_execution', langs: ['js'], bare: /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/g, near: /shell\s*:\s*true/, requires: /child_process/ },
  // —— 远程脚本直接执行（在 code 视图，字符串内的命令也算）
  { ruleId: 'code.remote_code_execution', langs: ['py', 'js', 'sh', 'md', 'other'], code: /(?:curl|wget|Invoke-WebRequest|iwr)\b[^\n|]{0,300}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|perl|ruby|node|iex|Invoke-Expression)\b/gi, confidence: 0.9 },
  // —— 动态执行
  { ruleId: 'code.dynamic_execution', langs: ['py'], bare: /(?<![.\w])(?:eval|exec)\s*\(/g },
  { ruleId: 'code.dynamic_execution', langs: ['js'], bare: /(?<![.\w])eval\s*\(|\bnew\s+Function\s*\(|\bvm\s*\.\s*(?:runInNewContext|runInThisContext|runInContext|Script)\b/g },
  // —— 混淆执行
  { ruleId: 'code.obfuscated_execution', langs: ['py'], code: /\b(?:exec|eval)\s*\(\s*(?:base64\s*\.\s*b(?:64|32|16)decode|codecs\s*\.\s*decode|zlib\s*\.\s*decompress|marshal\s*\.\s*loads|bytes\.fromhex|__import__\s*\(\s*['"](?:base64|zlib|codecs|marshal)['"]\s*\))/g, confidence: 0.92 },
  { ruleId: 'code.obfuscated_execution', langs: ['py'], code: /__import__\s*\(\s*['"](?:os|subprocess|pty|socket)['"]\s*\)\s*\.\s*(?:system|popen|spawn|Popen|run|call|check_output)/g, confidence: 0.92 },
  { ruleId: 'code.obfuscated_execution', langs: ['py'], code: /\bmarshal\s*\.\s*loads\s*\(|\bgetattr\s*\(\s*__builtins__/g, confidence: 0.85 },
  { ruleId: 'code.obfuscated_execution', langs: ['js'], code: /\beval\s*\(\s*(?:atob|Buffer\s*\.\s*from)\s*\(|Function\s*\(\s*(?:atob|Buffer\s*\.\s*from)\s*\(|\beval\s*\(\s*String\s*\.\s*fromCharCode/g, confidence: 0.92 },
  { ruleId: 'code.obfuscated_execution', langs: ['sh'], code: /base64\s+(?:-d|--decode)[^\n|]*\|\s*(?:sh|bash|zsh)\b/g, confidence: 0.92 },
  // —— SSRF：元数据地址
  { ruleId: 'code.ssrf', langs: ['py', 'js', 'sh', 'data', 'other'], code: /169\.254\.169\.254|\bmetadata\.google\.internal\b|\bmetadata\.azure\.com\b|100\.100\.100\.200|fd00:ec2::254/g, confidence: 0.85 },
];

/** 同一调用的参数片段（从命中处往后找到括号闭合，至多 400 字符） */
function callSpan(code: string, index: number): string {
  const open = code.indexOf('(', index);
  if (open < 0) return code.slice(index, index + 200);
  let depth = 0;
  for (let k = open; k < Math.min(code.length, open + 400); k++) {
    if (code[k] === '(') depth++;
    else if (code[k] === ')' && --depth === 0) return code.slice(index, k + 1);
  }
  return code.slice(index, open + 400);
}

/** 命令串是否拼接了变量：f-string/format/%/+/模板插值 */
const CONCAT_IN_CALL = /\(\s*(?:f['"]|[rb]?f['"])|['"]\s*(?:%|\+)\s*[A-Za-z_(]|\+\s*[A-Za-z_]|\.format\s*\(|`[^`]*\$\{/;

/**
 * 首个参数是否为“纯字符串字面量”（无拼接/格式化/变量/插值），后面只能跟 `,` 或 `)`。
 * Python 允许 r/b/u 前缀（不含 f）；JS 允许不含 ${ 的模板字符串。
 */
const LITERAL_FIRST_ARG = /^\(\s*(?:[rRbBuU]{0,2}(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")|`[^`$]*`)\s*[,)]/;
/** 字面量本身就是危险命令时不降级：下载执行、反弹 Shell、交互 Shell、破坏性删除/格式化 */
const DANGEROUS_LITERAL = /\b(?:curl|wget|nc|ncat|netcat|socat|mkfs|dd\s+if=|base64)\b|\/dev\/(?:tcp|udp)\/|\brm\s+-[a-z]*[rf]|\bchmod\s+(?:-R\s+)?[0-7]*7[0-7]{2}\b|[|;&]\s*(?:sh|bash|zsh)\b|^\(\s*[rRbBuU]{0,2}['"`]\s*(?:\/bin\/)?(?:ba|z)?sh(?:\s+-i)?\s*['"`]/;

/** 命令参数是否为无害的常量命令（此时降为 LOW：仍可见，但不再与可注入的调用同级） */
function isBenignLiteralCommand(matched: string, span: string): boolean {
  if (/\bpty\b/.test(matched)) return false; // pty.spawn 本身就是开交互 Shell
  const args = span.slice(span.indexOf('('));
  return LITERAL_FIRST_ARG.test(args) && !DANGEROUS_LITERAL.test(args) && !CONCAT_IN_CALL.test(span);
}

export interface DetectOptions {
  /** 每个文件每条规则最多记录的命中数，到了就不再往下找（模型文件扫描传 50，组件扫描不限） */
  maxHitsPerRule?: number;
}

export function detectCodeRisks(files: SourceFile[], opts: DetectOptions = {}): RuleHit[] {
  const hits: RuleHit[] = [];
  const cap = opts.maxHitsPerRule ?? Infinity;
  for (const f of files) {
    const views = lex(f.content, f.lang);
    for (const rule of CODE_RULES) {
      if (!rule.langs.includes(f.lang)) continue;
      if (rule.requires && !rule.requires.test(views.code)) continue;
      const view = rule.bare ? views.bare : views.code;
      const re = new RegExp((rule.bare ?? rule.code)!.source, (rule.bare ?? rule.code)!.flags);
      let found = 0;
      for (const m of view.matchAll(re)) {
        if (found >= cap) break;
        const idx = m.index ?? 0;
        const span = callSpan(views.code, idx);
        if (rule.near && !rule.near.test(span)) continue;
        const line = lineAt(f.content, idx);
        found++;
        if (rule.ruleId === 'code.command_execution' && isBenignLiteralCommand(m[0], span)) {
          hits.push({ ruleId: rule.ruleId, path: f.path, line, excerpt: lineText(f.content, line).trim(), confidence: 0.5, severity: 'LOW', meta: { argumentKind: 'literal' } });
          continue;
        }
        hits.push({ ruleId: rule.ruleId, path: f.path, line, excerpt: lineText(f.content, line).trim(), confidence: rule.confidence });
        if (rule.ruleId === 'code.command_execution' && CONCAT_IN_CALL.test(span)) {
          hits.push({ ruleId: 'code.command_injection', path: f.path, line, excerpt: lineText(f.content, line).trim() });
        }
      }
    }
    if (f.lang === 'py' || f.lang === 'js') {
      hits.push(...detectExfiltration(f, views.code, views.bare));
      hits.push(...detectPathTraversal(f, views.code));
      hits.push(...detectUrlSsrf(f, views.code));
    }
  }
  return hits;
}

const OUTBOUND = /\b(?:requests|httpx|aiohttp|urllib\.request|urllib3|session)\s*\.\s*(?:post|put|get|request|urlopen|patch)\s*\(|\bfetch\s*\(|\baxios(?:\s*\.\s*(?:post|put|get|request))?\s*\(|\bhttps?\s*\.\s*request\s*\(|\bgot\s*\.\s*post\s*\(|\bsmtplib\b|\bsocket\s*\.\s*(?:connect|send)/g;
const SECRET_READ = /\bos\s*\.\s*environ\b(?!\s*(?:\.get\s*\(|\[))|\bdict\s*\(\s*os\s*\.\s*environ\s*\)|\bprocess\s*\.\s*env\b(?!\s*[.[])|JSON\s*\.\s*stringify\s*\(\s*process\s*\.\s*env\s*\)/;

function detectExfiltration(f: SourceFile, code: string, bare: string): RuleHit[] {
  const sensitiveRead = SENSITIVE_PATH.exec(code);
  const envDump = SECRET_READ.exec(code);
  const read = sensitiveRead ?? envDump;
  if (!read) return [];
  const out: RuleHit[] = [];
  const readLine = lineAt(f.content, read.index);
  const outbound = [...bare.matchAll(OUTBOUND)][0];
  if (sensitiveRead) {
    out.push({ ruleId: 'code.sensitive_file_access', path: f.path, line: readLine, excerpt: lineText(f.content, readLine).trim() });
  }
  if (outbound) {
    const line = lineAt(f.content, outbound.index ?? 0);
    out.push({
      ruleId: 'code.data_exfiltration',
      path: f.path,
      line,
      excerpt: `第 ${readLine} 行读取敏感数据：${lineText(f.content, readLine).trim().slice(0, 120)}；第 ${line} 行外发：${lineText(f.content, line).trim().slice(0, 120)}`,
    });
  }
  return out;
}

const FILE_OPEN = /\b(?:open|Path)\s*\(\s*([A-Za-z_][\w.]*)\s*[,)]|\bfs\s*\.\s*(?:readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|unlink|rm)\s*\(\s*([A-Za-z_][\w.]*)\s*[,)]|\bos\s*\.\s*path\s*\.\s*join\s*\([^)]*?,\s*([A-Za-z_]\w*)\s*\)/g;
const PATH_GUARD = /\b(?:realpath|abspath|resolve|normpath|is_relative_to|relative_to|commonpath|startsWith|startswith|safe_join|secure_filename|normalize)\b/;

function detectPathTraversal(f: SourceFile, code: string): RuleHit[] {
  // 只在“看得到工具定义”的文件中报：参数来自工具调用方
  if (!/@\s*[\w.]+\.tool\b|\.tool\s*\(|registerTool|CallToolRequestSchema|inputSchema|@tool\b/.test(code)) return [];
  const out: RuleHit[] = [];
  for (const m of code.matchAll(FILE_OPEN)) {
    const variable = m[1] ?? m[2] ?? m[3] ?? '';
    if (!variable || /^(?:__file__|__dirname|self|this|os|sys)$/.test(variable)) continue;
    const idx = m.index ?? 0;
    const around = code.slice(Math.max(0, idx - 800), idx + 200);
    if (PATH_GUARD.test(around)) continue;
    const isParam = new RegExp(`\\b(?:def\\s+\\w+\\s*\\([^)]*\\b${variable.split('.')[0]}\\b|args\\.${variable}|arguments\\.${variable}|params\\.${variable}|\\{[^}]*\\b${variable}\\b[^}]*\\}\\s*=\\s*(?:args|arguments|params|request))`).test(around) || /^(?:args|arguments|params|request)\./.test(variable);
    if (!isParam) continue;
    const line = lineAt(f.content, idx);
    out.push({ ruleId: 'code.path_traversal', path: f.path, line, excerpt: lineText(f.content, line).trim() });
  }
  return out;
}

const URL_FETCH_VAR = /\b(?:requests\s*\.\s*(?:get|post|request)|httpx\s*\.\s*(?:get|post|request)|urllib\s*\.\s*request\s*\.\s*urlopen|urlopen|fetch|axios\s*\.\s*(?:get|post)|axios)\s*\(\s*([A-Za-z_][\w.]*)\s*[,)]/g;
const URL_GUARD = /\b(?:allowlist|whitelist|allowed_hosts|ALLOWED_|is_private|ipaddress|isPrivate|assert\w*Url|validate\w*url|urlparse\([^)]*\)\.hostname\s+(?:not\s+)?in)\b/i;

function detectUrlSsrf(f: SourceFile, code: string): RuleHit[] {
  if (!/@\s*[\w.]+\.tool\b|\.tool\s*\(|registerTool|CallToolRequestSchema|inputSchema|@tool\b/.test(code)) return [];
  if (URL_GUARD.test(code)) return [];
  const out: RuleHit[] = [];
  for (const m of code.matchAll(URL_FETCH_VAR)) {
    const v = m[1]!;
    if (!/url|uri|endpoint|link|href|target|address|host/i.test(v)) continue;
    const line = lineAt(f.content, m.index ?? 0);
    out.push({ ruleId: 'code.ssrf', path: f.path, line, excerpt: lineText(f.content, line).trim(), confidence: 0.65 });
  }
  return out;
}
