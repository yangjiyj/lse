// curl 命令导入：把「复制为 cURL」得到的命令解析为评估对象接入配置。
// 纯函数、无副作用：解析在浏览器本地完成，凭据不经过服务端、不写日志。

// shared 包 lib 仅含 ES2022；URL 在浏览器与 Node 中均为全局对象，这里只声明所需的最小形状。
declare const URL: {
  new (input: string): { protocol: string; origin: string; pathname: string; toString(): string };
};

export type CurlAuthType = 'bearer' | 'api_key' | 'none';

export interface CurlAuth {
  type: CurlAuthType;
  /** api_key 方式下承载凭据的请求头名称（如 X-API-Key、Authorization）。 */
  headerName: string | null;
  /** 凭据原值：仅用于填入密码框，界面展示请用 maskedValue。 */
  value: string;
  maskedValue: string;
  /** 凭据来源，如 “请求头 Authorization” 或 “-u 参数”。 */
  source: string;
}

export interface CurlOpenAiCompatible {
  baseUrl: string;
  model: string | null;
}

export interface ParsedCurl {
  url: string;
  method: string;
  /** 非认证类请求头（认证头已移入 auth）。 */
  headers: Record<string, string>;
  auth: CurlAuth;
  /** 原始请求体文本；无请求体时为 null。 */
  rawBody: string | null;
  /** 请求体是否为 JSON。 */
  bodyIsJson: boolean;
  /** 提示词字段被替换为 {{prompt}} 之后的请求模板；非 JSON 请求体为 null。 */
  requestTemplate: unknown;
  /** 识别到的提示词字段路径，如 messages[1].content；未识别为 null。 */
  promptPath: string | null;
  /** 识别到的原始提示词内容（用于向用户展示确认）。 */
  promptSample: string | null;
  /** URL 与请求体符合 OpenAI 兼容 /chat/completions 形态时给出的模型接入建议。 */
  openAiCompatible: CurlOpenAiCompatible | null;
  /** 请求体开启了流式（stream=true / response_mode=streaming）。 */
  streamRequested: boolean;
  /** 请求体中携带的会话字段路径（conversation_id 等）。 */
  sessionFieldPaths: string[];
  warnings: string[];
}

export class CurlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurlParseError';
  }
}

const MAX_CURL_LENGTH = 200_000;

const AUTH_HEADER_NAMES = new Set([
  'authorization',
  'api-key',
  'apikey',
  'x-api-key',
  'x-apikey',
  'x-auth-token',
  'x-access-token',
  'access-token',
  'x-token',
  'token',
]);

const DATA_OPTIONS = new Set([
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-ascii',
  '--data-urlencode',
  '--json',
]);

/** 需要跟一个取值、但与接入配置无关的选项：跳过其取值。 */
const IGNORED_VALUE_OPTIONS = new Set([
  '-o',
  '--output',
  '-m',
  '--max-time',
  '--connect-timeout',
  '--retry',
  '--retry-delay',
  '--retry-max-time',
  '-w',
  '--write-out',
  '-x',
  '--proxy',
  '--cacert',
  '--capath',
  '-E',
  '--cert',
  '--key',
  '--resolve',
  '--limit-rate',
  '-c',
  '--cookie-jar',
  '-T',
  '--upload-file',
  '--interface',
  '-r',
  '--range',
]);

const PROMPT_KEYS = [
  'query',
  'prompt',
  'input',
  'question',
  'content',
  'text',
  'message',
  'inputs',
];
const SESSION_KEYS = [
  'conversation_id',
  'conversationId',
  'session_id',
  'sessionId',
  'thread_id',
  'threadId',
  'chat_id',
  'chatId',
];

export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 按 POSIX shell 规则切分 curl 命令：支持反斜杠续行、单引号、双引号、
 * $'...'（ANSI-C 引号，Chrome「复制为 cURL」常用）与反斜杠转义。
 */
export function tokenizeShell(input: string): string[] {
  const src = input.replace(/\r\n?/g, '\n');
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let i = 0;
  const push = () => {
    if (inToken) tokens.push(current);
    current = '';
    inToken = false;
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === '\n') {
        i += 2; // 续行
        continue;
      }
      if (next === undefined) {
        i += 1;
        continue;
      }
      current += next;
      inToken = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) throw new CurlParseError('单引号未闭合，请检查 curl 命令是否完整');
      current += src.slice(i + 1, end);
      inToken = true;
      i = end + 1;
      continue;
    }
    if (ch === '$' && src[i + 1] === "'") {
      i += 2;
      let closed = false;
      while (i < src.length) {
        const c = src[i]!;
        if (c === "'") {
          closed = true;
          i += 1;
          break;
        }
        if (c === '\\' && i + 1 < src.length) {
          const e = src[i + 1]!;
          const map: Record<string, string> = {
            n: '\n',
            t: '\t',
            r: '\r',
            '\\': '\\',
            "'": "'",
            '"': '"',
          };
          if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
            current += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
            i += 6;
            continue;
          }
          if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 2, i + 4))) {
            current += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16));
            i += 4;
            continue;
          }
          current += map[e] ?? e;
          i += 2;
          continue;
        }
        current += c;
        i += 1;
      }
      if (!closed) throw new CurlParseError("$'…' 引号未闭合，请检查 curl 命令是否完整");
      inToken = true;
      continue;
    }
    if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < src.length) {
        const c = src[i]!;
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (c === '\\' && i + 1 < src.length) {
          const e = src[i + 1]!;
          if (e === '\n') {
            i += 2;
            continue;
          }
          if (e === '"' || e === '\\' || e === '$' || e === '`') {
            current += e;
            i += 2;
            continue;
          }
        }
        current += c;
        i += 1;
      }
      if (!closed) throw new CurlParseError('双引号未闭合，请检查 curl 命令是否完整');
      inToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      push();
      i += 1;
      continue;
    }
    current += ch;
    inToken = true;
    i += 1;
  }
  push();
  return tokens;
}

function splitHeader(raw: string): [string, string] | null {
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const name = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();
  if (!name) return null;
  return [name, value];
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function utf8Bytes(value: string): number[] {
  const out: number[] = [];
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return out;
}

/** 与运行时无关的 Base64 编码（shared 包不依赖 DOM/Node 全局）。 */
function base64(value: string): string {
  const bytes = utf8Bytes(value);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2]!;
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? '=' : B64[c & 63]!;
  }
  return out;
}

function formatPath(segments: Array<string | number>): string {
  let out = '';
  for (const seg of segments) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out;
}

interface PromptHit {
  segments: Array<string | number>;
  value: string;
}

function findMessagesPrompt(body: Record<string, unknown>): PromptHit | null {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (isRecord(m) && m.role === 'user') {
      index = i;
      break;
    }
  }
  if (index === -1) index = messages.length - 1;
  const msg = messages[index];
  if (!isRecord(msg)) return null;
  if (typeof msg.content === 'string') {
    return { segments: ['messages', index, 'content'], value: msg.content };
  }
  if (Array.isArray(msg.content)) {
    for (let j = 0; j < msg.content.length; j += 1) {
      const part = msg.content[j];
      if (isRecord(part) && typeof part.text === 'string') {
        return { segments: ['messages', index, 'content', j, 'text'], value: part.text };
      }
    }
  }
  return null;
}

function findKeyedPrompt(
  value: unknown,
  depth: number,
  prefix: Array<string | number>,
): PromptHit | null {
  if (!isRecord(value) || depth > 3) return null;
  for (const key of PROMPT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const item = value[key];
    if (typeof item === 'string') return { segments: [...prefix, key], value: item };
  }
  for (const [key, item] of Object.entries(value)) {
    if (isRecord(item)) {
      const hit = findKeyedPrompt(item, depth + 1, [...prefix, key]);
      if (hit) return hit;
    }
  }
  return null;
}

/** 在 JSON 请求体中定位提示词字段：优先 messages 最后一条用户消息，其次 query/prompt/input/question 等。 */
export function detectPromptField(body: unknown): { path: string; value: string } | null {
  if (!isRecord(body)) return null;
  const hit = findMessagesPrompt(body) ?? findKeyedPrompt(body, 0, []);
  return hit ? { path: formatPath(hit.segments), value: hit.value } : null;
}

function setAtSegments(root: unknown, segments: Array<string | number>, value: unknown): unknown {
  const clone = JSON.parse(JSON.stringify(root)) as unknown;
  let cursor: unknown = clone;
  for (let i = 0; i < segments.length - 1; i += 1) {
    cursor = (cursor as Record<string | number, unknown>)[segments[i]!];
  }
  (cursor as Record<string | number, unknown>)[segments[segments.length - 1]!] = value;
  return clone;
}

function parsePathSegments(path: string): Array<string | number> {
  const segments: Array<string | number> = [];
  for (const part of path
    .replace(/\[(-?\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)) {
    segments.push(/^-?\d+$/.test(part) ? Number(part) : part);
  }
  return segments;
}

function findSessionFields(value: unknown, depth: number, prefix: string[]): string[] {
  if (!isRecord(value) || depth > 2) return [];
  const found: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (SESSION_KEYS.includes(key)) found.push([...prefix, key].join('.'));
    else if (isRecord(item)) found.push(...findSessionFields(item, depth + 1, [...prefix, key]));
  }
  return found;
}

function detectOpenAiCompatible(url: string, body: unknown): CurlOpenAiCompatible | null {
  let parsed: InstanceType<typeof URL>;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = parsed.pathname.match(/^(.*)\/chat\/completions\/?$/);
  if (!match) return null;
  if (!isRecord(body) || !Array.isArray(body.messages)) return null;
  const baseUrl = `${parsed.origin}${match[1] ?? ''}`;
  return { baseUrl, model: typeof body.model === 'string' ? body.model : null };
}

/**
 * 解析 curl 命令。支持 -X/--request、-H/--header、-d/--data/--data-raw/--data-binary/--json、
 * -u/--user、--url、-A、-b、-e，以及反斜杠续行与单双引号。
 */
export function parseCurlCommand(input: string): ParsedCurl {
  if (typeof input !== 'string' || !input.trim()) throw new CurlParseError('请粘贴 curl 命令');
  if (input.length > MAX_CURL_LENGTH) throw new CurlParseError('curl 命令过长（上限 200000 字符）');
  const tokens = tokenizeShell(input.trim());
  if (tokens.length === 0) throw new CurlParseError('请粘贴 curl 命令');
  let start = 0;
  if (tokens[0]!.toLowerCase() === 'curl' || tokens[0]!.toLowerCase().endsWith('/curl')) start = 1;

  const warnings: string[] = [];
  let method: string | null = null;
  let url: string | null = null;
  const headerList: Array<[string, string]> = [];
  const dataParts: string[] = [];
  let jsonFlag = false;
  let userCred: string | null = null;
  let getFlag = false;

  const takeValue = (i: number, opt: string): string => {
    const value = tokens[i + 1];
    if (value === undefined) throw new CurlParseError(`选项 ${opt} 缺少取值`);
    return value;
  };

  for (let i = start; i < tokens.length; i += 1) {
    let tok = tokens[i]!;
    let attached: string | null = null;
    if (tok.startsWith('--') && tok.includes('=')) {
      const eq = tok.indexOf('=');
      attached = tok.slice(eq + 1);
      tok = tok.slice(0, eq);
    } else if (/^-[XHdubAeo]./.test(tok)) {
      attached = tok.slice(2);
      tok = tok.slice(0, 2);
    }
    const value = (): string => {
      if (attached !== null) return attached;
      const v = takeValue(i, tok);
      i += 1;
      return v;
    };

    if (tok === '-X' || tok === '--request') {
      method = value().toUpperCase();
    } else if (tok === '-H' || tok === '--header') {
      const h = splitHeader(value());
      if (h) headerList.push(h);
      else warnings.push('存在无法识别的请求头，已忽略');
    } else if (DATA_OPTIONS.has(tok)) {
      const v = value();
      if (tok === '--json') jsonFlag = true;
      if (v.startsWith('@') && tok !== '--data-raw') {
        warnings.push(`请求体引用了本地文件 ${v}，无法导入，请改为直接粘贴请求体内容`);
      } else {
        dataParts.push(v);
      }
    } else if (tok === '-u' || tok === '--user') {
      userCred = value();
    } else if (tok === '--url') {
      url = value();
    } else if (tok === '-A' || tok === '--user-agent') {
      headerList.push(['User-Agent', value()]);
    } else if (tok === '-b' || tok === '--cookie') {
      headerList.push(['Cookie', value()]);
    } else if (tok === '-e' || tok === '--referer') {
      headerList.push(['Referer', value()]);
    } else if (tok === '-G' || tok === '--get') {
      getFlag = true;
    } else if (tok === '-F' || tok === '--form') {
      value();
      warnings.push('检测到 multipart 表单（-F），暂不支持导入表单字段');
    } else if (IGNORED_VALUE_OPTIONS.has(tok)) {
      value();
    } else if (tok.startsWith('-') && tok.length > 1) {
      // 无取值开关（-s、-k、-L、-i、--compressed 等）不影响接入配置。
    } else if (url === null) {
      url = tok;
    } else {
      warnings.push(`多余的参数 “${tok.slice(0, 40)}” 已忽略`);
    }
  }

  if (!url) throw new CurlParseError('未识别到请求 URL');
  let parsedUrl: InstanceType<typeof URL>;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new CurlParseError(`请求 URL 格式无效：${url.slice(0, 120)}`);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new CurlParseError('请求 URL 仅支持 http 或 https');
  }

  const rawBody = dataParts.length > 0 ? dataParts.join('&') : null;
  if (getFlag && rawBody !== null) {
    warnings.push('命令使用了 -G，请求体参数会拼接到 URL 查询串；平台按 POST 请求体导入，请核对');
  }
  const finalMethod = method ?? (rawBody !== null ? 'POST' : 'GET');

  // 认证字段：第一个识别到的凭据进入认证配置，其余保留在请求头并提示。
  let auth: CurlAuth = { type: 'none', headerName: null, value: '', maskedValue: '', source: '' };
  const headers: Record<string, string> = {};
  for (const [name, value] of headerList) {
    const lower = name.toLowerCase();
    if (AUTH_HEADER_NAMES.has(lower) && auth.type === 'none') {
      const bearer = lower === 'authorization' ? value.match(/^Bearer\s+(.+)$/i) : null;
      auth = bearer
        ? {
            type: 'bearer',
            headerName: null,
            value: bearer[1]!.trim(),
            maskedValue: maskSecret(bearer[1]!.trim()),
            source: `请求头 ${name}`,
          }
        : {
            type: 'api_key',
            headerName: name,
            value,
            maskedValue: maskSecret(value),
            source: `请求头 ${name}`,
          };
      continue;
    }
    if (AUTH_HEADER_NAMES.has(lower)) {
      warnings.push(`存在多个认证请求头，${name} 仍保留在自定义请求头中`);
    }
    if (lower === 'cookie') {
      warnings.push('请求头包含 Cookie，可能是登录会话凭据，请确认是否需要保留');
    }
    if (lower === 'content-length' || lower === 'host') continue;
    headers[name] = value;
  }
  if (userCred !== null) {
    const encoded = `Basic ${base64(userCred)}`;
    if (auth.type === 'none') {
      auth = {
        type: 'api_key',
        headerName: 'Authorization',
        value: encoded,
        maskedValue: maskSecret(encoded),
        source: '-u 参数（Basic 认证）',
      };
    } else {
      warnings.push('同时存在 -u 与认证请求头，已采用认证请求头，-u 被忽略');
    }
  }
  if (jsonFlag) {
    const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
    if (!hasContentType) headers['Content-Type'] = 'application/json';
  }

  let body: unknown = null;
  let bodyIsJson = false;
  if (rawBody !== null) {
    try {
      body = JSON.parse(rawBody);
      bodyIsJson = true;
    } catch {
      warnings.push('请求体不是 JSON，平台当前以 JSON 模板发送请求，请手工改写请求模板');
    }
  }

  let requestTemplate: unknown = null;
  let promptPath: string | null = null;
  let promptSample: string | null = null;
  let streamRequested = false;
  let sessionFieldPaths: string[] = [];
  if (bodyIsJson) {
    const prompt = detectPromptField(body);
    if (prompt) {
      promptPath = prompt.path;
      promptSample = prompt.value;
      requestTemplate = setAtSegments(body, parsePathSegments(prompt.path), '{{prompt}}');
    } else {
      requestTemplate = body;
      warnings.push('未识别到提示词字段，请在请求模板中手工把提问内容替换为 {{prompt}}');
    }
    if (isRecord(body)) {
      streamRequested = body.stream === true || body.response_mode === 'streaming';
      sessionFieldPaths = findSessionFields(body, 0, []);
    }
  } else if (rawBody === null) {
    warnings.push('命令没有请求体，平台将使用默认模板 {"input": "{{prompt}}"}，请核对');
  }

  return {
    url: parsedUrl.toString(),
    method: finalMethod,
    headers,
    auth,
    rawBody,
    bodyIsJson,
    requestTemplate,
    promptPath,
    promptSample,
    openAiCompatible: detectOpenAiCompatible(parsedUrl.toString(), body),
    streamRequested,
    sessionFieldPaths,
    warnings,
  };
}

const RESPONSE_CANDIDATE_PATHS = [
  'choices[0].message.content',
  'choices[0].text',
  'choices[0].delta.content',
  'data.answer',
  'answer',
  'output',
  'result',
  'data.output',
  'data.result',
  'data.content',
  'data.text',
  'output.text',
  'data.outputs.text',
  'content',
  'message',
  'text',
  'response',
  'reply',
];

const NON_ANSWER_KEYS = /(^|_)(id|status|code|type|event|model|object|role|created|time|token)s?$/i;

/** 读取 a.b[0].c 形式的路径；负数下标从数组末尾计数；拒绝原型链字段。 */
export function readJsonPath(value: unknown, path: string): unknown {
  let current = value;
  for (const seg of parsePathSegments(path)) {
    if (typeof seg === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[seg < 0 ? current.length + seg : seg];
      continue;
    }
    if (seg === '__proto__' || seg === 'prototype' || seg === 'constructor') return undefined;
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, seg)) return undefined;
    current = current[seg];
  }
  return current;
}

function collectStringLeaves(
  value: unknown,
  prefix: Array<string | number>,
  depth: number,
  out: Array<{ path: string; length: number }>,
): void {
  if (depth > 5 || out.length > 50) return;
  if (typeof value === 'string') {
    const last = prefix[prefix.length - 1];
    if (typeof last === 'string' && NON_ANSWER_KEYS.test(last)) return;
    if (value.trim()) out.push({ path: formatPath(prefix), length: value.length });
    return;
  }
  if (Array.isArray(value)) {
    value
      .slice(0, 5)
      .forEach((item, idx) => collectStringLeaves(item, [...prefix, idx], depth + 1, out));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      collectStringLeaves(item, [...prefix, key], depth + 1, out);
    }
  }
}

/** 根据一次真实响应推断“响应字段”候选路径：已知路径优先，其余字符串字段按长度排序。 */
export function detectResponseTextPaths(json: unknown, limit = 6): string[] {
  const out: string[] = [];
  for (const path of RESPONSE_CANDIDATE_PATHS) {
    const v = readJsonPath(json, path);
    if (typeof v === 'string' && v.trim()) out.push(path);
  }
  const leaves: Array<{ path: string; length: number }> = [];
  collectStringLeaves(json, [], 0, leaves);
  leaves.sort((a, b) => b.length - a.length);
  for (const leaf of leaves) {
    if (!out.includes(leaf.path)) out.push(leaf.path);
  }
  return out.slice(0, limit);
}
