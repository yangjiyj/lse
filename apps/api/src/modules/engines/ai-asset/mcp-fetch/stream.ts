/** 带整体截止时间与字节上限的响应体读取，以及增量 SSE 解析。 */
import { McpFetchError } from './types.js';

export class Deadline {
  readonly at: number;
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;

  constructor(timeoutMs: number) {
    this.at = Date.now() + timeoutMs;
    this.timer = setTimeout(() => this.controller.abort(), timeoutMs);
    this.timer.unref?.();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  remaining(): number {
    return Math.max(0, this.at - Date.now());
  }

  assertOpen(): void {
    if (this.remaining() <= 0) throw new McpFetchError('MCP_TIMEOUT', '超过整体超时');
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.controller.abort();
  }
}

/** 逐块读取；超时或超过字节预算时取消底层流。 */
export class BodyReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array> | null;
  private total = 0;
  private closed = false;

  constructor(
    response: Response,
    private readonly maxBytes: number,
    private readonly deadline: Deadline,
  ) {
    this.reader = response.body ? response.body.getReader() : null;
  }

  async next(): Promise<Uint8Array | null> {
    if (!this.reader || this.closed) return null;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.deadline.remaining());
    });
    try {
      const result = await Promise.race([this.reader.read(), timeout]);
      if (result === 'timeout') {
        await this.cancel();
        throw new McpFetchError('MCP_TIMEOUT', '读取响应超时');
      }
      if (result.done) {
        this.closed = true;
        return null;
      }
      this.total += result.value.byteLength;
      if (this.total > this.maxBytes) {
        await this.cancel();
        throw new McpFetchError('MCP_RESPONSE_TOO_LARGE', `超过 ${this.maxBytes} 字节`);
      }
      return result.value;
    } catch (error) {
      if (error instanceof McpFetchError) throw error;
      await this.cancel();
      throw new McpFetchError('MCP_CONNECT_FAILED', '读取响应时连接中断');
    } finally {
      clearTimeout(timer);
    }
  }

  async cancel(): Promise<void> {
    if (this.closed || !this.reader) return;
    this.closed = true;
    await this.reader.cancel().catch(() => undefined);
  }
}

export async function readAllText(response: Response, maxBytes: number, deadline: Deadline): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new McpFetchError('MCP_RESPONSE_TOO_LARGE', `超过 ${maxBytes} 字节`);
  }
  const reader = new BodyReader(response, maxBytes, deadline);
  const decoder = new TextDecoder();
  let text = '';
  for (let chunk = await reader.next(); chunk; chunk = await reader.next()) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
}

/** 从响应流中增量产出 SSE 事件；单事件数据不超过 maxEventBytes。 */
export async function* sseEvents(
  response: Response,
  totalBytes: number,
  maxEventBytes: number,
  deadline: Deadline,
): AsyncGenerator<SseEvent, void, void> {
  const reader = new BodyReader(response, totalBytes, deadline);
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let dataLen = 0;
  let id: string | null = null;
  try {
    for (let chunk = await reader.next(); chunk; chunk = await reader.next()) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
        if (line === '') {
          if (data.length > 0) yield { event: event || 'message', data: data.join('\n'), id };
          event = '';
          data = [];
          dataLen = 0;
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'id') id = value;
        else if (field === 'data') {
          dataLen += value.length;
          if (dataLen > maxEventBytes) throw new McpFetchError('MCP_RESPONSE_TOO_LARGE', `单条事件超过 ${maxEventBytes} 字节`);
          data.push(value);
        }
      }
      if (buffer.length > maxEventBytes) throw new McpFetchError('MCP_RESPONSE_TOO_LARGE', '事件行过长');
    }
  } finally {
    await reader.cancel();
  }
}
