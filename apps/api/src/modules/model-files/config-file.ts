import { checkChatTemplate } from './gguf.js';
import { CONFIG_RULES } from './script-rules.js';
import type { ByteSource } from './source.js';
import type { FormatScan, ModelFinding } from './types.js';

/** 随模型分发、加载时会被读取的配置文件（含单独保存的 chat_template.jinja）。 */
export const CONFIG_FILE =
  /(?:^|[\\/])(?:(?:config|adapter_config|tokenizer_config|generation_config)\.json|chat_template\.jinja)$|\.ya?ml$/i;
/** 单个配置文件读取上限；超出部分不检查。 */
export const CONFIG_MAX_BYTES = 8 * 1024 * 1024;

export function isConfigFile(fileName: string): boolean {
  return CONFIG_FILE.test(fileName);
}

const YAML_FILE = /\.ya?ml$/i;
/** mergekit 合并配置（文件名）。 */
const MERGEKIT_FILE = /(?:^|[\\/])mergekit[\w.-]*\.ya?ml$/i;
/** 部署和 CI 用的 YAML：与模型加载无关，不看。 */
const DEPLOY_YAML = /(?:^|[\\/])\.github[\\/]|(?:^|[\\/])(?:docker-)?compose[\w.-]*\.ya?ml$/i;

/**
 * 目录和压缩包里的 YAML 只看 mergekit 配置，以及与权重文件同目录的（训练、推理配置）；
 * .github/ 下和 docker-compose 文件跳过。JSON 配置（config.json 等）不受此限。
 * weightDirs 为含权重文件的目录（相对路径，根目录为空串）。
 */
export function configInScope(path: string, weightDirs: ReadonlySet<string>): boolean {
  if (!YAML_FILE.test(path)) return true;
  if (DEPLOY_YAML.test(path)) return false;
  if (MERGEKIT_FILE.test(path)) return true;
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return weightDirs.has(i < 0 ? '' : path.slice(0, i));
}

const baseName = (p: string) => (p.split(/[\\/]/).pop() ?? p).toLowerCase();
const strOf = (v: unknown, max = 200) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
const numOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const strList = (v: unknown, max = 50) =>
  typeof v === 'string'
    ? [v.slice(0, 200)]
    : Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === 'string')
          .slice(0, max)
          .map((x) => x.slice(0, 200))
      : undefined;
const compact = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** config.json：架构、类型、精度、量化配置。 */
function modelConfigMeta(c: Record<string, unknown>) {
  const q = c.quantization_config;
  const quant =
    q && typeof q === 'object' && !Array.isArray(q)
      ? compact({
          method: strOf((q as Record<string, unknown>).quant_method, 50),
          bits: numOf((q as Record<string, unknown>).bits),
          loadIn4bit: (q as Record<string, unknown>).load_in_4bit === true || undefined,
          loadIn8bit: (q as Record<string, unknown>).load_in_8bit === true || undefined,
        })
      : undefined;
  return compact({
    architectures: strList(c.architectures, 5),
    modelType: strOf(c.model_type, 100),
    torchDtype: strOf(c.torch_dtype ?? c.dtype, 50),
    nameOrPath: strOf(c._name_or_path),
    quantization: quant && Object.keys(quant).length ? quant : undefined,
  });
}

/** adapter_config.json（PEFT）：适配器类型、秩、缩放、目标模块、基座。 */
function adapterConfigMeta(c: Record<string, unknown>) {
  return compact({
    peftType: strOf(c.peft_type, 50),
    r: numOf(c.r),
    loraAlpha: numOf(c.lora_alpha),
    targetModules: strList(c.target_modules),
    baseModel: strOf(c.base_model_name_or_path),
    taskType: strOf(c.task_type, 50),
  });
}

const ruleOf = (id: string) => CONFIG_RULES.find((r) => r.id === id)!;
function configFinding(id: string, detail: string, severity = ruleOf(id).severity): ModelFinding {
  const r = ruleOf(id);
  return { ruleId: r.id, severity, title: r.title, detail: detail.slice(0, 3900) };
}

/** 收集 JSON 里的字符串值（跳过 chat_template，模板另按模板规则查）。 */
function stringsOf(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20 || out.length > 20000) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsOf(x, out, depth + 1));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) if (k !== 'chat_template') stringsOf(x, out, depth + 1);
  return out;
}

function hasTrueKey(v: unknown, key: string, depth = 0): boolean {
  if (depth > 20 || !v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((x) => hasTrueKey(x, key, depth + 1));
  return Object.entries(v).some(
    ([k, x]) => (k === key && (x === true || x === 'true')) || hasTrueKey(x, key, depth + 1),
  );
}

const URL_RE = /https?:\/\/[^\s"'<>\\|`]+/gi;
const SUSPICIOUS_HOST =
  /(?:^|\.)(?:pastebin\.com|paste\.ee|hastebin\.com|transfer\.sh|ngrok(?:-free)?\.(?:io|app|dev)|trycloudflare\.com|webhook\.site|requestbin\.(?:com|net)|pipedream\.net|interact\.sh|oast\.(?:fun|me|pro|live|site|online)|burpcollaborator\.net|dnslog\.cn|ceye\.io)$/i;
const EXEC_PATH = /\.(?:sh|ps1|bat|cmd|exe|dll|so|py|vbs|hta|scr|msi|jar|elf)$/i;
/** 本机和内网地址（10/8、172.16/12、192.168/16、127/8、localhost、IPv6 本机和 fc00::/7）：部署配置常见，不算可疑。 */
const PRIVATE_HOST =
  /^(?:127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|0\.0\.0\.0|::1|f[cd][0-9a-f]{2}:[0-9a-f:]*|(?:[\w-]+\.)*localhost)$/i;

/** 可疑链接：直接用公网 IP、指向脚本或可执行文件、临时托管与回连探测域名。 */
function suspiciousUrls(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    let u: URL;
    try {
      u = new URL(m[0]);
    } catch {
      continue;
    }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (PRIVATE_HOST.test(host)) continue;
    if (
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
      host.includes(':') ||
      SUSPICIOUS_HOST.test(host) ||
      EXEC_PATH.test(u.pathname)
    )
      out.add(m[0].slice(0, 200));
    if (out.size >= 10) break;
  }
  return [...out];
}

const COMMAND_FRAGMENT =
  /\b(?:curl|wget)\b[^\n"]{0,200}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\bbash\s+-c\b|\b(?:ba|z)?sh\s+-i\b|\/bin\/(?:ba|z)?sh\b|\b(?:powershell|pwsh)(?:\.exe)?\s+-|\bcmd(?:\.exe)?\s+\/[ck]\b|\bos\.(?:system|popen)\s*\(|\bsubprocess\.\w+\s*\(|\b__import__\s*\(|\brm\s+-rf\s+[/~]|\/dev\/tcp\//i;
const YAML_PYTHON_TAG = /!!python\/(?:object|name|module)\b[^\n]*/i;
const YAML_TRUST_REMOTE = /^\s*trust_remote_code\s*:\s*(?:true|yes|on)\b.*$/im;

/** auto_map 的取值：模块.类名，或 “其他仓库--模块.类名”（从其他仓库下载代码）。 */
function autoMapRefs(v: unknown) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  const refs: Array<{ key: string; value: string; module: string; remote: boolean }> = [];
  for (const [key, raw] of Object.entries(v)) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (typeof value !== 'string' || !value) continue;
      const remote = value.includes('--');
      const local = remote ? value.slice(value.indexOf('--') + 2) : value;
      const module = local.includes('.') ? local.slice(0, local.lastIndexOf('.')) : local;
      refs.push({
        key: key.slice(0, 100),
        value: value.slice(0, 200),
        module: module.slice(0, 200),
        remote,
      });
      if (refs.length >= 20) return refs;
    }
  }
  return refs;
}

/**
 * 配置规则：auto_map、trust_remote_code、chat_template、可疑链接、命令片段、YAML Python 标签。
 * YAML 多是训练、推理、部署配置，trust_remote_code、链接和命令很常见，只有 !!python/ 标签保持高危，其余降为低危。
 */
function configRuleFindings(
  name: string,
  text: string,
  parsed: Record<string, unknown> | null,
  meta: Record<string, unknown>,
): ModelFinding[] {
  const out: ModelFinding[] = [];
  if (name.endsWith('.jinja')) return checkChatTemplate(name, text);
  const yamlSev = YAML_FILE.test(name) ? ('LOW' as const) : undefined;
  if (parsed) {
    const refs = autoMapRefs(parsed.auto_map);
    if (refs.length) {
      meta.autoMap = refs;
      const remote = refs.filter((r) => r.remote);
      out.push(
        configFinding(
          'config.auto_map',
          `${name} auto_map：${refs.map((r) => `${r.key} → ${r.value}`).join('、')}` +
            (remote.length ? `；其中 ${remote.length} 项从其他仓库加载代码` : ''),
          remote.length ? 'HIGH' : undefined,
        ),
      );
    }
    if (hasTrueKey(parsed, 'trust_remote_code'))
      out.push(configFinding('config.trust_remote_code', `${name} 中 trust_remote_code 为 true`));
    const tpl = parsed.chat_template;
    const templates: Array<[string, string]> =
      typeof tpl === 'string'
        ? [['chat_template', tpl]]
        : Array.isArray(tpl)
          ? tpl.flatMap((t) =>
              t &&
              typeof t === 'object' &&
              typeof (t as { template?: unknown }).template === 'string'
                ? [
                    [
                      `chat_template.${String((t as { name?: unknown }).name ?? '')}`,
                      (t as { template: string }).template,
                    ] as [string, string],
                  ]
                : [],
            )
          : [];
    for (const [key, t] of templates) out.push(...checkChatTemplate(`${name} ${key}`, t));
  } else {
    const m = YAML_TRUST_REMOTE.exec(text);
    if (m)
      out.push(
        configFinding('config.trust_remote_code', `${name}：${m[0].trim().slice(0, 200)}`, yamlSev),
      );
  }
  const body = parsed ? stringsOf(parsed).join('\n') : text;
  const urls = suspiciousUrls(body);
  if (urls.length)
    out.push(configFinding('config.suspicious_url', `${name}：${urls.join('、')}`, yamlSev));
  const cmd = COMMAND_FRAGMENT.exec(body);
  if (cmd) {
    const at = cmd.index;
    out.push(
      configFinding(
        'config.command_fragment',
        `${name} 含 “${body
          .slice(Math.max(0, at - 40), at + cmd[0].length + 60)
          .replace(/\s+/g, ' ')
          .trim()}”`,
        yamlSev,
      ),
    );
  }
  const tag = parsed ? null : YAML_PYTHON_TAG.exec(text);
  if (tag)
    out.push(configFinding('config.yaml_python_tag', `${name}：${tag[0].trim().slice(0, 200)}`));
  return out;
}

/** 读取配置文件，提取识别要用的字段并按配置规则检查；YAML 只按行看，不做完整解析。 */
export async function scanConfigFile(fileName: string, src: ByteSource): Promise<FormatScan> {
  const name = baseName(fileName);
  const findings: ModelFinding[] = [];
  const meta: Record<string, unknown> = { configFile: name };
  const text = (await src.read(0, Math.min(src.size, CONFIG_MAX_BYTES))).toString('utf8');
  if (src.size > CONFIG_MAX_BYTES)
    findings.push({
      ruleId: 'CONFIG_TRUNCATED',
      severity: 'LOW',
      title: '配置文件过大，仅检查了开头部分',
      detail: `${name} 超过 ${CONFIG_MAX_BYTES / 1024 / 1024} MiB`,
    });
  let obj: Record<string, unknown> | null = null;
  if (name.endsWith('.json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      findings.push({
        ruleId: 'CONFIG_INVALID_JSON',
        severity: 'LOW',
        title: '配置文件不是合法 JSON',
        detail: `${name} 无法按 JSON 解析`,
      });
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const c = parsed as Record<string, unknown>;
      obj = c;
      if (name === 'config.json') meta.modelConfig = modelConfigMeta(c);
      else if (name === 'adapter_config.json') meta.adapterConfig = adapterConfigMeta(c);
    }
  } else if (
    name === 'mergekit_config.yml' ||
    name === 'mergekit_config.yaml' ||
    /^\s*merge_method\s*:/m.test(text)
  ) {
    meta.mergekit = true;
  }
  findings.push(...configRuleFindings(name, text, obj, meta));
  return { format: 'config', findings, meta };
}
