// 语料格式识别与流式解析（1.2.5）：jsonl / json 数组（Alpaca、ShareGPT、OpenAI messages、prompt/completion、
// chosen/rejected，认不出的按通用 JSON 取全部字符串）、csv（首行表头）、txt（按行）。
// 纯函数、无依赖，服务端 worker 和命令行版共用；只用可擦除的 TS 语法，node --experimental-strip-types 可直接运行。

export const CORPUS_FORMATS = [
  'auto',
  'alpaca',
  'sharegpt',
  'messages',
  'prompt_completion',
  'chosen_rejected',
  'csv',
  'txt',
] as const;
export type CorpusFormat = (typeof CORPUS_FORMATS)[number];

export type RecordSchema =
  | 'alpaca'
  | 'sharegpt'
  | 'messages'
  | 'prompt_completion'
  | 'chosen_rejected'
  | 'generic'
  | 'csv'
  | 'txt';

export type Container = 'jsonl' | 'json' | 'csv' | 'txt';

export const FORMAT_LABELS: Record<CorpusFormat | RecordSchema, string> = {
  auto: '自动识别',
  alpaca: 'Alpaca',
  sharegpt: 'ShareGPT',
  messages: 'OpenAI messages',
  prompt_completion: 'prompt/completion',
  chosen_rejected: 'chosen/rejected',
  generic: '通用 JSON',
  csv: 'CSV',
  txt: '纯文本',
};

export interface TextField {
  /** 字段路径，如 instruction、conversations[1].value、messages[0].content[0].text、CSV 列名 */
  path: string;
  text: string;
}

export type ParsedItem =
  | { kind: 'record'; index: number; line: number; schema: RecordSchema; fields: TextField[] }
  | { kind: 'invalid'; index: number; line: number; reason: string };

export interface ParserOptions {
  format?: CorpusFormat;
  fileName?: string;
  /** CSV 要检测的列（按表头名），不给就是全部列 */
  csvColumns?: string[];
  /** 单条记录的字符上限，超出记为非法，防止一行几百兆把内存吃光 */
  maxRecordChars?: number;
}

export interface CorpusParser {
  push(chunk: string): ParsedItem[];
  end(): ParsedItem[];
  container(): Container | null;
  csvHeader(): string[] | null;
  /** 识别出的格式：自动识别取第一条合法记录的格式，手动指定就是指定的格式 */
  detectedFormat(): RecordSchema | null;
}

export const DEFAULT_MAX_RECORD_CHARS = 8 * 1024 * 1024;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function extOf(fileName: string | undefined): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(fileName ?? '');
  return m ? m[1]!.toLowerCase() : '';
}

function firstSignificant(head: string): string {
  const s = head.replace(/^﻿/, '').trimStart();
  return s.charAt(0);
}

/** 按文件名和开头内容猜容器：.csv、.txt 以扩展名为准，其余看第一个非空字符（[ 为 json 数组，{ 为 jsonl）。 */
export function detectContainer(fileName: string | undefined, head: string): Container {
  const ext = extOf(fileName);
  if (ext === 'csv') return 'csv';
  if (ext === 'txt') return 'txt';
  const c = firstSignificant(head);
  if (c === '[') return 'json';
  if (c === '{' || ext === 'jsonl' || ext === 'json') return 'jsonl';
  return 'txt';
}

// ---------------------------------------------------------------------------
// 记录结构 → 文本字段
// ---------------------------------------------------------------------------

/** 认出一条 JSON 记录是哪种语料格式。 */
export function detectSchema(o: Obj): RecordSchema {
  if (Array.isArray(o.conversations)) return 'sharegpt';
  if (Array.isArray(o.messages)) return 'messages';
  if ('chosen' in o && 'rejected' in o) return 'chosen_rejected';
  if ('prompt' in o && 'completion' in o) return 'prompt_completion';
  if ('instruction' in o) return 'alpaca';
  return 'generic';
}

function pushText(out: TextField[], path: string, v: unknown): void {
  if (typeof v === 'string' && v.trim() !== '') out.push({ path, text: v });
}

/** 一段对话（messages 或 ShareGPT 写法）拆成字段；结构不对返回出错的轮次说明。 */
function dialogFields(arr: unknown[], base: string, out: TextField[]): string | null {
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i];
    const p = `${base}[${i}]`;
    if (typeof m === 'string') {
      pushText(out, p, m);
      continue;
    }
    if (!isObj(m)) return `${p} 不是对象`;
    if ('value' in m && !('content' in m)) {
      if (typeof m.value !== 'string') return `${p} 没有 value`;
      pushText(out, `${p}.value`, m.value);
      continue;
    }
    const content = m.content;
    if (typeof content === 'string') pushText(out, `${p}.content`, content);
    else if (Array.isArray(content)) {
      content.forEach((part, j) => {
        if (isObj(part) && typeof part.text === 'string')
          pushText(out, `${p}.content[${j}].text`, part.text);
      });
    } else if (content !== null && content !== undefined) return `${p}.content 不是文本`;
  }
  return null;
}

/** 字符串或对话数组，两种写法都接受（TRL 的对话式 prompt/chosen/rejected）。 */
function textOrDialog(o: Obj, key: string, out: TextField[]): string | null {
  const v = o[key];
  if (typeof v === 'string') {
    pushText(out, key, v);
    return null;
  }
  if (Array.isArray(v)) return dialogFields(v, key, out);
  return `${key} 不是文本或对话`;
}

function genericFields(v: unknown, path: string, out: TextField[], depth: number): void {
  if (depth > 32) return;
  if (typeof v === 'string') pushText(out, path || 'text', v);
  else if (Array.isArray(v)) v.forEach((x, i) => genericFields(x, `${path}[${i}]`, out, depth + 1));
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v))
      genericFields(x, path ? `${path}.${k}` : k, out, depth + 1);
  }
}

/** 按格式取出要检测的文本字段；结构不合法返回原因。 */
export function extractFields(
  schema: RecordSchema,
  o: Obj,
): { fields: TextField[] } | { error: string } {
  const out: TextField[] = [];
  switch (schema) {
    case 'alpaca': {
      if (typeof o.instruction !== 'string' || typeof o.output !== 'string') {
        return { error: 'Alpaca 记录缺少 instruction 或 output 字段' };
      }
      pushText(out, 'system', o.system);
      pushText(out, 'instruction', o.instruction);
      pushText(out, 'input', o.input);
      pushText(out, 'output', o.output);
      if (Array.isArray(o.history)) {
        o.history.forEach((turn, i) => {
          if (Array.isArray(turn)) turn.forEach((t, j) => pushText(out, `history[${i}][${j}]`, t));
        });
      }
      return { fields: out };
    }
    case 'sharegpt': {
      if (!Array.isArray(o.conversations) || o.conversations.length === 0) {
        return { error: 'ShareGPT 记录缺少 conversations' };
      }
      pushText(out, 'system', o.system);
      const err = dialogFields(o.conversations, 'conversations', out);
      return err ? { error: `ShareGPT 记录结构不对：${err}` } : { fields: out };
    }
    case 'messages': {
      if (!Array.isArray(o.messages) || o.messages.length === 0) {
        return { error: 'messages 记录缺少 messages 数组' };
      }
      const err = dialogFields(o.messages, 'messages', out);
      return err ? { error: `messages 记录结构不对：${err}` } : { fields: out };
    }
    case 'prompt_completion': {
      if (!('prompt' in o) || !('completion' in o)) {
        return { error: 'prompt/completion 记录缺少 prompt 或 completion 字段' };
      }
      const err = textOrDialog(o, 'prompt', out) ?? textOrDialog(o, 'completion', out);
      return err ? { error: err } : { fields: out };
    }
    case 'chosen_rejected': {
      if (!('chosen' in o) || !('rejected' in o)) {
        return { error: 'chosen/rejected 记录缺少 chosen 或 rejected 字段' };
      }
      const err =
        ('prompt' in o ? textOrDialog(o, 'prompt', out) : null) ??
        textOrDialog(o, 'chosen', out) ??
        textOrDialog(o, 'rejected', out);
      return err ? { error: err } : { fields: out };
    }
    default:
      genericFields(o, '', out, 0);
      return { fields: out };
  }
}

// ---------------------------------------------------------------------------
// json 数组的流式切分：扫描解析和打码副本共用同一个状态机，按元素切开，元素外的字符（括号、逗号、空白、
// 数组结束后的多余内容）单独交出，原样保留。
// ---------------------------------------------------------------------------

export interface JsonArraySink {
  /** 元素外的字符 */
  outside(text: string): void;
  /** 一个元素开始（line 为元素第一个字符所在行） */
  elemStart(line: number): void;
  /** 元素里的一段字符（同一个元素可能分多段交出） */
  elem(text: string): void;
  elemEnd(): void;
  /** 结构错误：不是数组、数组没结束、结束后还有内容等 */
  error(line: number, reason: string): void;
}

export interface JsonArrayWalker {
  push(chunk: string): void;
  end(): void;
}

export function createJsonArrayWalker(sink: JsonArraySink): JsonArrayWalker {
  // phase：0 等 '['；1 等元素或 ']'；2 元素中；3 等 ',' 或 ']'；4 数组已结束
  let phase = 0;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let line = 1;
  let trailingReported = false;
  return {
    push(chunk: string) {
      let seg = 0;
      let inElem = phase === 2;
      const flush = (i: number) => {
        if (i > seg) {
          const text = chunk.slice(seg, i);
          if (inElem) sink.elem(text);
          else sink.outside(text);
        }
        seg = i;
      };
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk.charCodeAt(i);
        if (phase === 2) {
          if (inStr) {
            if (esc) esc = false;
            else if (c === 92) esc = true;
            else if (c === 34) inStr = false;
          } else if (c === 34) inStr = true;
          else if (c === 123 || c === 91) depth += 1;
          else if (c === 125 || c === 93) {
            if (depth === 0 && c === 93) {
              flush(i);
              inElem = false;
              sink.elemEnd();
              phase = 4;
            } else if (depth > 0) depth -= 1;
          } else if (c === 44 && depth === 0) {
            flush(i);
            inElem = false;
            sink.elemEnd();
            phase = 1;
          }
          if (c === 10) line += 1;
          continue;
        }
        if (c === 10) {
          line += 1;
          continue;
        }
        if (c === 32 || c === 9 || c === 13 || c === 0xfeff) continue;
        if (phase === 0) {
          if (c === 91) phase = 1;
          else {
            sink.error(line, '不是 JSON 数组');
            phase = 4;
            trailingReported = true;
          }
        } else if (phase === 1 || phase === 3) {
          if (c === 93) phase = 4;
          else if (phase === 3 && c === 44) phase = 1;
          else if (phase === 3) {
            sink.error(line, '数组元素之间缺少逗号');
            phase = 4;
            trailingReported = true;
          } else {
            flush(i);
            inElem = true;
            phase = 2;
            depth = 0;
            inStr = false;
            esc = false;
            sink.elemStart(line);
            i -= 1; // 让元素第一个字符按 phase 2 处理（开引号、括号）
          }
        } else if (phase === 4 && !trailingReported) {
          sink.error(line, '数组结束后还有多余内容');
          trailingReported = true;
        }
      }
      flush(chunk.length);
    },
    end() {
      if (phase === 2) {
        sink.elemEnd();
        sink.error(line, 'JSON 数组未结束');
      } else if (phase !== 0 && phase !== 4) sink.error(line, 'JSON 数组未结束');
      // phase 0：空文件，没有记录
    },
  };
}

// ---------------------------------------------------------------------------
// 流式解析
// ---------------------------------------------------------------------------

const JSON_SCHEMA_OF: Partial<Record<CorpusFormat, RecordSchema>> = {
  alpaca: 'alpaca',
  sharegpt: 'sharegpt',
  messages: 'messages',
  prompt_completion: 'prompt_completion',
  chosen_rejected: 'chosen_rejected',
};

export function createCorpusParser(opts: ParserOptions = {}): CorpusParser {
  const format: CorpusFormat = opts.format ?? 'auto';
  const maxChars = opts.maxRecordChars ?? DEFAULT_MAX_RECORD_CHARS;
  const forcedSchema = JSON_SCHEMA_OF[format] ?? null;

  let container: Container | null = format === 'csv' ? 'csv' : format === 'txt' ? 'txt' : null;
  if (!container && format === 'auto') {
    const ext = extOf(opts.fileName);
    if (ext === 'csv') container = 'csv';
    else if (ext === 'txt') container = 'txt';
  }
  let started = false;
  let pending = '';
  let detected: RecordSchema | null =
    container === 'csv' ? 'csv' : container === 'txt' ? 'txt' : null;
  let index = 0;

  const out: ParsedItem[] = [];
  const invalid = (line: number, reason: string) => {
    index += 1;
    out.push({ kind: 'invalid', index, line, reason });
  };
  const record = (line: number, schema: RecordSchema, fields: TextField[]) => {
    index += 1;
    if (!detected) detected = schema;
    out.push({ kind: 'record', index, line, schema, fields });
  };

  /** 一条 JSON 文本 → 记录或非法项 */
  const jsonUnit = (text: string, line: number) => {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      return invalid(line, '不是合法的 JSON');
    }
    if (!isObj(v)) return invalid(line, '记录不是 JSON 对象');
    const schema = forcedSchema ?? detectSchema(v);
    const r = extractFields(schema, v);
    if ('error' in r) return invalid(line, r.error);
    record(line, schema, r.fields);
  };

  // ---- 按行（jsonl、txt） ----
  let lineBuf = '';
  let lineNo = 1;
  let skippingLine = false;
  const lineUnit = (raw: string, line: number) => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (text.trim() === '') return;
    if (container === 'txt') record(line, 'txt', [{ path: 'text', text }]);
    else jsonUnit(text, line);
  };
  const pushLines = (chunk: string) => {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf('\n', start);
      if (nl < 0) break;
      if (skippingLine) skippingLine = false;
      else lineUnit(lineBuf + chunk.slice(start, nl), lineNo);
      lineBuf = '';
      lineNo += 1;
      start = nl + 1;
    }
    if (skippingLine) return;
    lineBuf += chunk.slice(start);
    if (lineBuf.length > maxChars) {
      invalid(lineNo, `记录超过 ${maxChars} 字符，已跳过`);
      lineBuf = '';
      skippingLine = true;
    }
  };
  const endLines = () => {
    if (!skippingLine && lineBuf !== '') lineUnit(lineBuf, lineNo);
    lineBuf = '';
  };

  // ---- json 数组 ----
  let elem = '';
  let elemLine = 0;
  let elemOverflow = false;
  let skippedLines = 0; // 自动识别时丢掉的开头空行数，按容器补到行号上
  const jsonWalker = createJsonArrayWalker({
    outside: () => undefined,
    elemStart: (line) => {
      elemLine = line + skippedLines;
      elem = '';
      elemOverflow = false;
    },
    elem: (text) => {
      if (elemOverflow) return;
      elem += text;
      if (elem.length > maxChars) {
        elemOverflow = true;
        elem = '';
      }
    },
    elemEnd: () => {
      if (elemOverflow) invalid(elemLine, `记录超过 ${maxChars} 字符，已跳过`);
      else jsonUnit(elem, elemLine);
      elem = '';
      elemOverflow = false;
    },
    error: (line, reason) => invalid(line + skippedLines, reason),
  });

  // ---- csv ----
  let header: string[] | null = null;
  let picked: number[] = [];
  let row: string[] = [];
  let field = '';
  let csvInQuotes = false;
  let csvQuoteSeen = false; // 刚遇到引号（可能是 "" 转义或引号结束）
  // 字段里已经有字符（含引号）：只有字段开头的 " 才开启引号，字段中间的裸引号（5"3）当普通字符，与打码副本一致
  let fieldStarted = false;
  let rowLine = 1;
  let csvLine = 1;
  let rowChars = 0;
  let rowOverflow = false;
  let atRowStart = true;
  const csvRowDone = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
    const cells = row;
    row = [];
    const line = rowLine;
    const overflow = rowOverflow;
    rowOverflow = false;
    rowChars = 0;
    atRowStart = true;
    if (overflow) return invalid(line, `记录超过 ${maxChars} 字符，已跳过`);
    if (cells.length === 1 && cells[0]!.trim() === '') return; // 空行
    if (!header) {
      header = cells.map((h, i) => (i === 0 ? h.replace(/^﻿/, '') : h).trim());
      const want = opts.csvColumns?.map((c) => c.trim()).filter(Boolean) ?? [];
      if (want.length === 0) picked = header.map((_, i) => i);
      else {
        picked = header.map((h, i) => (want.includes(h) ? i : -1)).filter((i) => i >= 0);
        const missing = want.filter((w) => !header!.includes(w));
        if (missing.length > 0) invalid(line, `表头里没有这些列：${missing.join('、')}`);
      }
      return;
    }
    if (cells.length > header.length) {
      return invalid(line, `列数多于表头（表头 ${header.length} 列，本行 ${cells.length} 列）`);
    }
    const fields: TextField[] = [];
    for (const i of picked) pushText(fields, header[i]!, cells[i]);
    record(line, 'csv', fields);
  };
  const pushCsv = (chunk: string) => {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      if (atRowStart) {
        rowLine = csvLine;
        atRowStart = false;
      }
      if (ch === '\n') csvLine += 1;
      if (!rowOverflow && ++rowChars > maxChars) {
        rowOverflow = true;
        field = '';
        row = [];
      }
      if (csvInQuotes) {
        if (csvQuoteSeen) {
          csvQuoteSeen = false;
          if (ch === '"') {
            if (!rowOverflow) field += '"';
            continue;
          }
          csvInQuotes = false; // 引号结束，当前字符按引号外处理
        } else if (ch === '"') {
          csvQuoteSeen = true;
          continue;
        } else {
          if (!rowOverflow) field += ch;
          continue;
        }
      }
      if (ch === '"' && !fieldStarted) {
        csvInQuotes = true;
        csvQuoteSeen = false;
        fieldStarted = true;
      } else if (ch === ',') {
        if (!rowOverflow) row.push(field);
        field = '';
        fieldStarted = false;
      } else if (ch === '\n') csvRowDone();
      else if (ch !== '\r') {
        fieldStarted = true;
        if (!rowOverflow) field += ch;
      }
    }
  };
  const endCsv = () => {
    if (csvInQuotes && !csvQuoteSeen) {
      invalid(rowLine, '引号未闭合');
      return;
    }
    if (!atRowStart) csvRowDone();
  };

  const feed = (chunk: string) => {
    if (container === 'csv') pushCsv(chunk);
    else if (container === 'json') jsonWalker.push(chunk);
    else pushLines(chunk);
  };

  const decide = (force: boolean): boolean => {
    if (container) return true;
    const sig = firstSignificant(pending);
    if (!sig && !force) return false;
    if (forcedSchema) container = sig === '[' ? 'json' : 'jsonl';
    else container = detectContainer(opts.fileName, pending);
    if (container === 'txt') detected = 'txt';
    lineNo += skippedLines;
    csvLine += skippedLines;
    return true;
  };

  /**
   * 自动识别前只留最后一个换行之后的空白（丢掉的换行计进行号），新块单独判断有没有非空字符，
   * 开头几十兆空白也不会反复拼接、反复 trimStart。
   */
  const holdBlank = (chunk: string) => {
    const nl = chunk.lastIndexOf('\n');
    if (nl >= 0) {
      for (let i = 0; i <= nl; i++) if (chunk.charCodeAt(i) === 10) skippedLines += 1;
      pending = chunk.slice(nl + 1);
    } else pending += chunk;
    // 一行全是空白且超过单条上限：这行本来就不是有效记录，直接丢掉
    if (pending.length > maxChars) pending = '';
  };

  const take = () => {
    const items = out.splice(0, out.length);
    return items;
  };

  return {
    push(chunk: string) {
      if (!started) {
        started = true;
        chunk = chunk.replace(/^﻿/, '');
      }
      if (!container) {
        if (!firstSignificant(chunk)) {
          holdBlank(chunk);
          return take();
        }
        pending += chunk;
        decide(false);
        chunk = pending;
        pending = '';
      }
      feed(chunk);
      return take();
    },
    end() {
      if (!container) {
        decide(true);
        const rest = pending;
        pending = '';
        if (rest) feed(rest);
      }
      if (container === 'csv') endCsv();
      else if (container === 'json') jsonWalker.end();
      else endLines();
      return take();
    },
    container: () => container,
    csvHeader: () => header,
    detectedFormat: () => forcedSchema ?? detected,
  };
}

/** 一次性解析整段文本（测试和小文件用）。 */
export function parseCorpusText(
  text: string,
  opts: ParserOptions = {},
): {
  container: Container | null;
  detectedFormat: RecordSchema | null;
  csvHeader: string[] | null;
  items: ParsedItem[];
} {
  const p = createCorpusParser(opts);
  const items = [...p.push(text), ...p.end()];
  return {
    container: p.container(),
    detectedFormat: p.detectedFormat(),
    csvHeader: p.csvHeader(),
    items,
  };
}
