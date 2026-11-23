/** 测试用最小 MCP 模拟服务（node:http，127.0.0.1 随机端口）。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockMode = 'json' | 'sse' | 'legacy-sse' | 'auth401' | 'html' | 'hang' | 'huge' | 'rpc-error';

export interface MockOptions {
  mode: MockMode;
  sessionId?: string;
  /** 每页工具数，>0 时启用分页。 */
  pageSize?: number;
  tools?: Array<{ name: string; description: string; inputSchema?: unknown }>;
  requireAuth?: string;
}

export interface MockServer {
  url: string;
  origin: string;
  seen: Array<{ method: string; rpc: string | null; headers: IncomingMessage['headers'] }>;
  close(): Promise<void>;
}

const defaultTools = [
  { name: 'read_file', description: '读取文件', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'search', description: 'Search the web', inputSchema: { type: 'object' } },
  { name: 'exec', description: 'Run command', inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } } },
];

async function body(req: IncomingMessage): Promise<string> {
  let data = '';
  for await (const chunk of req) data += chunk;
  return data;
}

function rpcResult(msg: { id?: number; method?: string; params?: { cursor?: string } }, opts: MockOptions): unknown {
  const tools = opts.tools ?? defaultTools;
  if (msg.method === 'initialize') {
    return { protocolVersion: '2025-06-18', capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'mock-mcp', version: '0.1.0' } };
  }
  if (msg.method === 'tools/list') {
    if (!opts.pageSize) return { tools };
    const start = Number(msg.params?.cursor ?? 0);
    const page = tools.slice(start, start + opts.pageSize);
    const nextStart = start + opts.pageSize;
    return { tools: page, ...(nextStart < tools.length ? { nextCursor: String(nextStart) } : {}) };
  }
  if (msg.method === 'prompts/list') return { prompts: [{ name: 'p1', description: 'prompt one' }] };
  return null;
}

export async function startMockMcp(opts: MockOptions): Promise<MockServer> {
  const seen: MockServer['seen'] = [];
  const sseClients: ServerResponse[] = [];
  const server: Server = createServer(async (req, res) => {
    const raw = req.method === 'POST' ? await body(req) : '';
    const msg = raw ? (JSON.parse(raw) as { id?: number; method?: string; params?: { cursor?: string } }) : {};
    seen.push({ method: req.method ?? '', rpc: msg.method ?? null, headers: req.headers });
    if (opts.mode === 'auth401' || (opts.requireAuth && req.headers.authorization !== opts.requireAuth)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    if (opts.mode === 'hang') return; // 永不响应
    if (opts.mode === 'html') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html>login</html>');
      return;
    }
    if (opts.mode === 'huge') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { pad: 'x'.repeat(64 * 1024) } }));
      return;
    }
    if (opts.mode === 'legacy-sse') {
      if (req.method === 'POST' && req.url === '/mcp') {
        res.writeHead(405).end();
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('event: endpoint\ndata: /messages?sessionId=abc\n\n');
        sseClients.push(res);
        return;
      }
      res.writeHead(202).end('Accepted');
      if (msg.id !== undefined) {
        const reply = { jsonrpc: '2.0', id: msg.id, result: rpcResult({ ...msg, method: msg.method }, opts) };
        const init = msg.method === 'initialize' ? { ...(reply.result as object), protocolVersion: '2024-11-05' } : reply.result;
        for (const client of sseClients) client.write(`event: message\ndata: ${JSON.stringify({ ...reply, result: init })}\n\n`);
      }
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end();
      return;
    }
    if (opts.sessionId && msg.method !== 'initialize' && req.headers['mcp-session-id'] !== opts.sessionId) {
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","error":{"code":-32000,"message":"bad session"}}');
      return;
    }
    const headers: Record<string, string> = opts.sessionId && msg.method === 'initialize' ? { 'mcp-session-id': opts.sessionId } : {};
    if (msg.id === undefined) {
      res.writeHead(202, headers).end();
      return;
    }
    const reply = opts.mode === 'rpc-error'
      ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }
      : { jsonrpc: '2.0', id: msg.id, result: rpcResult(msg, opts) };
    if (opts.mode === 'sse') {
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
      res.write(': keepalive\n\n');
      res.write(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n`);
      res.end(`id: 1\nevent: message\ndata: ${JSON.stringify(reply)}\n\n`);
      return;
    }
    res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: opts.mode === 'legacy-sse' ? `${origin}/mcp` : `${origin}/mcp`,
    origin,
    seen,
    close: async () => {
      for (const client of sseClients) client.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
