/** MCP Streamable HTTP 传输（规范 2025-03-26 / 2025-06-18）。 */
import { egressFetch } from './egress.js';
import {
  checkStatus,
  readRpcResponse,
  userHeaders,
  type McpTransport,
  type TransportContext,
} from './rpc.js';

export class StreamableHttpTransport implements McpTransport {
  readonly kind = 'streamable-http' as const;
  private nextId = 1;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;

  constructor(
    private readonly url: string,
    private readonly ctx: TransportContext,
  ) {}

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  private headers(): Record<string, string> {
    return {
      ...userHeaders(this.ctx.headers),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      ...(this.protocolVersion ? { 'MCP-Protocol-Version': this.protocolVersion } : {}),
    };
  }

  private async post(body: unknown): Promise<Response> {
    const response = await egressFetch(
      this.url,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      this.ctx.egress,
      this.ctx.deadline,
    );
    checkStatus(response);
    const sid = response.headers.get('mcp-session-id');
    // 规范要求会话 ID 只含可见 ASCII
    if (sid && /^[\x21-\x7e]{1,256}$/.test(sid)) this.sessionId = sid;
    return response;
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: '2.0', id, method, params });
    return await readRpcResponse(response, id, this.ctx);
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const response = await this.post({ jsonrpc: '2.0', method, params });
    await response.body?.cancel().catch(() => undefined);
  }

  /** 有会话时尽力发 DELETE 结束会话；失败忽略。 */
  async close(): Promise<void> {
    if (!this.sessionId || this.ctx.deadline.remaining() <= 0) return;
    await egressFetch(this.url, { method: 'DELETE', headers: this.headers() }, this.ctx.egress, this.ctx.deadline)
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
  }
}
