import { lex, lineAt, lineText } from './lexer.js';
import type { RuleHit } from './poisoning.js';
import type { SourceFile } from './code-rules.js';

/** 格式化凭据：前缀 + 固定形态，误报率低 */
const SECRET_FORMATS: Array<{ name: string; re: RegExp }> = [
  { name: 'AWS AccessKeyId', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { name: 'GitHub Token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { name: 'OpenAI Key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g },
  { name: 'Anthropic Key', re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g },
  { name: 'Slack Token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Stripe Key', re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{24,}\b/g },
  { name: '私钥', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { name: 'HuggingFace Token', re: /\bhf_[A-Za-z0-9]{34,}\b/g },
];

/** 赋值型：键名敏感 + 值高熵且不像占位符 */
const ASSIGN = /\b([A-Za-z_][\w-]*?(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?key|private[_-]?key|password|passwd|token|auth[_-]?token|client[_-]?secret|aws_secret_access_key))\b["']?\s*[:=]\s*["']([^"'\s]{12,200})["']/gi;
const ASSIGN_BARE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:API_KEY|SECRET|SECRET_KEY|ACCESS_KEY|PASSWORD|TOKEN|aws_secret_access_key))\s*=\s*([^\s#"']{12,200})\s*$/gim;
const PLACEHOLDER = /^(?:your|my|xxx|changeme|replace|example|sample|dummy|test|placeholder|todo|none|null|\*+|<.*>|\$\{.*\}|\{\{.*\}\}|%.*%)|(?:here|xxxx|example|placeholder|your[_-]?\w*|_here)$/i;

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return '<MASKED>';
  return `${value.slice(0, 4)}…<MASKED:${value.length}>`;
}

export function redactLine(line: string): string {
  let out = line;
  for (const f of SECRET_FORMATS) out = out.replace(new RegExp(f.re.source, 'g'), (m) => maskSecret(m));
  out = out.replace(
    /((?:api[_-]?key|secret|password|passwd|token|authorization|bearer|access[_-]?key)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)([^\s"',;]{8,})/gi,
    (_m, k: string, v: string) => k + maskSecret(v),
  );
  return out.slice(0, 500);
}

export function detectSecrets(files: SourceFile[]): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const f of files) {
    if (/(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock)$/i.test(f.path)) continue;
    // md 文本中的格式化密钥同样有效，赋值型密钥只在代码与配置中查
    for (const fmt of SECRET_FORMATS) {
      for (const m of f.content.matchAll(new RegExp(fmt.re.source, 'g'))) {
        const line = lineAt(f.content, m.index ?? 0);
        hits.push({ ruleId: 'code.hardcoded_secret', path: f.path, line, excerpt: `${fmt.name}：${redactLine(lineText(f.content, line).trim())}`, confidence: 0.92 });
      }
    }
    if (f.lang === 'md') continue;
    const view = f.lang === 'py' || f.lang === 'js' ? lex(f.content, f.lang).code : f.content;
    for (const re of [ASSIGN, ASSIGN_BARE]) {
      for (const m of view.matchAll(new RegExp(re.source, re.flags))) {
        const value = m[2]!;
        if (PLACEHOLDER.test(value) || /^[a-z]+$/.test(value) || /^(?:process\.env|os\.environ|env\.)/.test(value)) continue;
        if (shannonEntropy(value) < 3.5) continue;
        const line = lineAt(f.content, m.index ?? 0);
        if (hits.some((h) => h.path === f.path && h.line === line)) continue;
        hits.push({ ruleId: 'code.hardcoded_secret', path: f.path, line, excerpt: `${m[1]}：${redactLine(lineText(f.content, line).trim())}`, confidence: 0.75 });
      }
    }
  }
  return hits;
}

const LISTEN_ALL = /host\s*=\s*["']0\.0\.0\.0["']|\.listen\s*\(\s*[\w.]+\s*,\s*["']0\.0\.0\.0["']|--host[= ]0\.0\.0\.0|\bHOST\s*=\s*["']?0\.0\.0\.0|bind\s*[:=]\s*["']0\.0\.0\.0/;
const HTTP_SERVER = /FastMCP|mcp\.run\s*\([^)]*(?:sse|streamable|http)|uvicorn\.run|StreamableHTTPServerTransport|SSEServerTransport|express\s*\(|createServer\s*\(|FastAPI\s*\(|Starlette\s*\(/;
const AUTH = /\b(?:authorization|Authorization|bearer|Bearer|auth_token|api_key_header|verify_token|authenticate|requireAuth|OAuth|oauth|jwt|JWT|BearerAuth|auth_provider|AuthSettings|TokenVerifier|x-api-key)\b/;

export function detectUnauthenticatedListener(files: SourceFile[]): RuleHit[] {
  const code = files.filter((f) => f.lang === 'py' || f.lang === 'js');
  const anyAuth = code.some((f) => AUTH.test(lex(f.content, f.lang).code));
  if (anyAuth) return [];
  const hits: RuleHit[] = [];
  for (const f of [...code, ...files.filter((x) => x.lang === 'data' || x.lang === 'sh' || /dockerfile/i.test(x.path))]) {
    const view = f.lang === 'py' || f.lang === 'js' ? lex(f.content, f.lang).code : f.content;
    const m = LISTEN_ALL.exec(view);
    if (!m) continue;
    if (!code.some((c) => HTTP_SERVER.test(c.content))) continue;
    const line = lineAt(f.content, m.index);
    hits.push({ ruleId: 'code.unauthenticated_listener', path: f.path, line, excerpt: lineText(f.content, line).trim() });
  }
  return hits.slice(0, 5);
}

const PERMISSION_KEYS = /^(?:permissions?|allowed[-_]?tools|allowedTools|allowed[-_]?directories|allowedDirectories|scopes?|capabilities|roots|allow)$/i;
const OVERBROAD_VALUE = /^(?:\*|\*\*|\/|~|\/\*\*?|all|full|root|admin|write:all|read:all|repo|\*:\*|Bash|Bash\(\*\)|Bash\(.*\*\s*\)|filesystem:\*|network:\*|shell)$/i;

/** 只看清单/配置里“权限声明”键下的值，而不是见 * 就报 */
export function detectOverbroadPermissions(files: SourceFile[]): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const f of files) {
    if (/(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|pnpm-lock\.yaml|\.eslintrc[^/]*)$/i.test(f.path)) continue;
    const values: Array<{ key: string; value: string }> = [];
    if (/\.json$/i.test(f.path)) {
      try {
        const walk = (node: unknown, key: string, depth: number) => {
          if (depth > 10) return;
          if (Array.isArray(node)) node.forEach((x) => walk(x, key, depth + 1));
          else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, k, depth + 1);
          else if (typeof node === 'string' && PERMISSION_KEYS.test(key)) values.push({ key, value: node });
        };
        walk(JSON.parse(f.content), '', 0);
      } catch {
        continue;
      }
    } else if (f.lang === 'data' || (f.lang === 'md' && /(?:^|\/)skill\.md$/i.test(f.path))) {
      // YAML / frontmatter：`allowed-tools: Bash, Read` 或 `- "*"` 列表
      let current = '';
      for (const raw of f.content.split(/\r?\n/)) {
        const kv = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(raw);
        if (kv) {
          current = kv[1]!;
          if (PERMISSION_KEYS.test(current) && kv[2]) for (const v of kv[2].replace(/[[\]]/g, '').split(',')) values.push({ key: current, value: v.trim().replace(/^["']|["']$/g, '') });
          continue;
        }
        const item = /^\s*-\s*(.+)$/.exec(raw);
        if (item && PERMISSION_KEYS.test(current)) values.push({ key: current, value: item[1]!.trim().replace(/^["']|["']$/g, '') });
      }
    }
    for (const v of values) {
      if (!OVERBROAD_VALUE.test(v.value)) continue;
      const idx = f.content.indexOf(v.value === '/' ? `"/"` : v.value);
      const line = idx < 0 ? 1 : lineAt(f.content, idx);
      hits.push({ ruleId: 'manifest.overbroad_permission', path: f.path, line, excerpt: `${v.key}: ${v.value}` });
    }
  }
  return hits;
}
