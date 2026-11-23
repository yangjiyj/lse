// 流式响应聚合：把 SSE（text/event-stream）与 NDJSON（application/x-ndjson）
// 响应解析为事件序列，并把增量文本拼接为完整回答。纯函数，供调用器与接口诊断共用。
import { readJsonPath } from '@lse/shared';

export type StreamFormat = 'sse' | 'ndjson';

export interface StreamEvent {
  /** SSE 的 event: 名称；NDJSON 为 null。 */
  event: string | null;
  /** data 解析后的 JSON；非 JSON 时为原始字符串。 */
  data: unknown;
}

export interface AggregatedStream {
  format: StreamFormat;
  events: StreamEvent[];
  /** 拼接后的完整回答；没有任何文本增量时为 null。 */
  text: string | null;
  /** 命中增量文本的字段路径（首个命中）。 */
  textPath: string | null;
  /** 最后一个 JSON 事件，用于识别会话/异步等字段。 */
  lastJsonEvent: unknown;
}

/** 常见流式增量字段：OpenAI、Dify、Ollama、通用 answer/content/text。 */
const DELTA_PATHS = [
  'choices[0].delta.content',
  'choices[0].text',
  'answer',
  'data.answer',
  'message.content',
  'response',
  'delta',
  'data.delta',
  'content',
  'data.content',
  'text',
  'data.text',
  'output',
  'data.outputs.answer',
];

/** 结束类事件（如 Dify workflow_finished）常携带完整回答，与已拼接文本相同时不重复追加。 */
const TERMINAL_EVENT_RE = /(finish|end|done|complete)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeSse(text: string): boolean {
  return /^(data|event|id|retry):/m.test(text.trimStart().slice(0, 2000));
}

function looksLikeNdjson(text: string): boolean {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return false;
  return lines.every((line) => line.startsWith('{') && line.endsWith('}'));
}

/** 按 Content-Type 与正文形态判断是否为流式响应；普通 JSON 返回 null。 */
export function detectStreamFormat(contentType: string | null, text: string): StreamFormat | null {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('text/event-stream')) return 'sse';
  if (ct.includes('ndjson') || ct.includes('jsonlines') || ct.includes('json-seq')) return 'ndjson';
  if (ct.includes('application/json')) {
    // 部分服务流式输出仍标 application/json：整体不是合法 JSON 时再按形态判断。
    try {
      JSON.parse(text);
      return null;
    } catch {
      // fall through
    }
  }
  if (looksLikeSse(text)) return 'sse';
  if (looksLikeNdjson(text)) return 'ndjson';
  return null;
}

function parseData(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function parseStreamEvents(text: string, format: StreamFormat): StreamEvent[] {
  const src = text.replace(/\r\n?/g, '\n');
  const events: StreamEvent[] = [];
  if (format === 'ndjson') {
    for (const line of src.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      events.push({ event: null, data: parseData(trimmed) });
    }
    return events;
  }
  for (const block of src.split(/\n\n+/)) {
    let eventName: string | null = null;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? '' : line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join('\n');
    if (data.trim() === '[DONE]') continue;
    events.push({ event: eventName, data: parseData(data) });
  }
  return events;
}

function pieceOf(data: unknown, paths: string[]): { piece: string; path: string } | null {
  if (typeof data === 'string') return data ? { piece: data, path: '(text)' } : null;
  if (!isRecord(data)) return null;
  for (const path of paths) {
    const value = readJsonPath(data, path);
    if (typeof value === 'string') return { piece: value, path };
  }
  return null;
}

/**
 * 解析并聚合流式响应。增量片段逐个拼接；若某片段以已拼接文本开头（累计式推送，
 * 如 Dify workflow_finished 或部分服务每次推全文），则以该片段替换。
 */
export function aggregateStream(
  text: string,
  format: StreamFormat,
  configuredPath?: string | null,
): AggregatedStream {
  const events = parseStreamEvents(text, format);
  const paths = configuredPath?.trim() ? [configuredPath.trim(), ...DELTA_PATHS] : DELTA_PATHS;
  let acc = '';
  let hit = false;
  let textPath: string | null = null;
  let lastJsonEvent: unknown = null;
  for (const ev of events) {
    if (isRecord(ev.data)) lastJsonEvent = ev.data;
    const found = pieceOf(ev.data, paths);
    if (!found) continue;
    hit = true;
    textPath ??= found.path;
    const eventName = ev.event ?? (isRecord(ev.data) ? ev.data.event : null);
    const terminal = typeof eventName === 'string' && TERMINAL_EVENT_RE.test(eventName);
    if (acc && found.piece.length > acc.length && found.piece.startsWith(acc)) acc = found.piece;
    else if (terminal && acc && found.piece === acc) continue;
    else acc += found.piece;
  }
  return { format, events, text: hit && acc ? acc : null, textPath, lastJsonEvent };
}
