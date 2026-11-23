/**
 * 旧版 HTTP+SSE 传输（MCP 2024-11-05）：GET 建立 SSE 流 → 收到 endpoint 事件 →
 * 向该地址 POST JSON-RPC，响应经 SSE 流的 message 事件返回。
 * endpoint 必须与 SSE 地址同源（防止服务端把带鉴权头的请求引到第三方），且同样经出站策略校验。
 */
import { egressFetch } from './egress.js';
import { checkStatus, parseJson, pickResponse, userHeaders, type McpTransport, type TransportContext } from './rpc.js';
import { sseEvents, type SseEvent } from './stream.js';
import { McpFetchError } from './types.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class LegacySseTransport implements McpTransport {
  readonly kind = 'sse' as const;
  private nextId = 1;
  private endpoint: string | null = null;
  private events: AsyncGenerator<SseEvent, void, void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private failure: Error | null = null;

  constructor(
    private readonly url: string,
    private readonly ctx: TransportContext,
  ) {}

  setProtocolVersion(): void {
    // 旧版传输没有 MCP-Protocol-Version 头
  }

  async connect(): Promise<void> {
    const response = await egressFetch(
      this.url,
      { method: 'GET', headers: { ...userHeaders(this.ctx.headers), Accept: 'text/event-stream' } },
      this.ctx.egress,
      this.ctx.deadline,
    );
    checkStatus(response);
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpFetchError('MCP_NOT_MCP_RESPONSE', 'SSE 地址未返回 text/event-stream');
    }
    // SSE 流是长连接：总字节预算放宽到单响应上限的 16 倍，单事件仍受 maxResponseBytes 约束
    this.events = sseEvents(response, this.ctx.maxResponseBytes * 16, this.ctx.maxResponseBytes, this.ctx.deadline);
    for (;;) {
      const next = await this.events.next();
      if (next.done) throw new McpFetchError('MCP_NOT_MCP_RESPONSE', 'SSE 流未发送 endpoint 事件');
      if (next.value.event !== 'endpoint') continue;
      let target: URL;
      try {
        target = new URL(next.value.data.trim(), this.url);
      } catch {
        throw new McpFetchError('MCP_PROTOCOL_ERROR', 'endpoint 事件地址非法');
      }
      if (target.origin !== new URL(this.url).origin) {
        throw new McpFetchError('MCP_PROTOCOL_ERROR', 'endpoint 事件指向了不同源地址，已拒绝');
      }
      this.endpoint = target.toString();
      break;
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const next = await this.events!.next();
        if (next.done) throw new McpFetchError('MCP_PROTOCOL_ERROR', 'SSE 流提前结束');
        if (next.value.event !== 'message' || !next.value.data.trim()) continue;
        const payload = parseJson(next.value.data);
        for (const [id, waiter] of this.pending) {
          const picked = (() => {
            try {
              return pickResponse(payload, id);
            } catch (error) {
              waiter.reject(error as Error);
              this.pending.delete(id);
              return { found: false };
            }
          })();
          if (picked.found) {
            waiter.resolve(picked.result);
            this.pending.delete(id);
          }
        }
      }
    } catch (error) {
      this.failure = error as Error;
      for (const waiter of this.pending.values()) waiter.reject(this.failure);
      this.pending.clear();
    }
  }

  private async post(body: unknown): Promise<void> {
    if (!this.endpoint) throw new McpFetchError('MCP_PROTOCOL_ERROR', 'SSE 会话未建立');
    const response = await egressFetch(
      this.endpoint,
      {
        method: 'POST',
        headers: { ...userHeaders(this.ctx.headers), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      this.ctx.egress,
      this.ctx.deadline,
    );
    checkStatus(response);
    await response.body?.cancel().catch(() => undefined);
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    result.catch(() => undefined);
    try {
      await this.post({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return await result;
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, params });
  }

  async close(): Promise<void> {
    await this.events?.return(undefined).catch(() => undefined);
  }
}
