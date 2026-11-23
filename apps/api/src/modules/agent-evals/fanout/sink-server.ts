import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { FANOUT_CHANNELS, renderChannel, type FanoutChannel } from './channels.js';

export interface ExfilHit {
  at: number;
  runToken: string;
  canaryPresent: boolean;
  detail: string;
}

export interface FanoutRegistration {
  runToken: string;
  canary: string;
  exfilUrl: string;
  sinkUrl(channel: FanoutChannel): string;
}

interface RegState {
  canary: string;
  secretHint: string;
  publicBaseUrl?: string;
}

export class FanoutSinkServer {
  private server: Server | null = null;
  private baseUrlValue = '';
  private readonly regs = new Map<string, RegState>();
  private readonly hitLog = new Map<string, ExfilHit[]>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  get baseUrl(): string {
    return this.baseUrlValue;
  }

  async start(
    host = '127.0.0.1',
    port = 0,
  ): Promise<{ baseUrl: string; host: string; port: number }> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    const addr = this.server.address() as AddressInfo;
    this.baseUrlValue = `http://${host}:${addr.port}`;
    return { baseUrl: this.baseUrlValue, host, port: addr.port };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((err) => (err ? reject(err) : resolve())),
    );
    this.server = null;
  }

  register(runToken: string, canary: string, opts: { secretHint: string; publicBaseUrl?: string }): FanoutRegistration {
    const base = opts.publicBaseUrl?.replace(/\/+$/, '') || this.baseUrlValue;
    this.regs.set(runToken, { canary, secretHint: opts.secretHint, publicBaseUrl: base });
    this.hitLog.set(runToken, []);
    return {
      runToken,
      canary,
      exfilUrl: `${base}/exfil/${runToken}`,
      sinkUrl: (channel) => `${base}/sink/${runToken}/${channel}`,
    };
  }

  hits(runToken: string): ExfilHit[] {
    return this.hitLog.get(runToken) ?? [];
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    try {
      const url = new URL(req.url ?? '/', this.baseUrlValue);
      const parts = url.pathname.split('/').filter(Boolean); // ['sink', token, channel] | ['exfil', token]

      if (parts[0] === 'sink' && parts.length === 3) {
        const reg = this.regs.get(parts[1]!);
        const channel = parts[2] as FanoutChannel;
        if (!reg || !FANOUT_CHANNELS.includes(channel)) {
          res.writeHead(404).end('unknown sink');
          return;
        }
        const rendered = renderChannel(channel, {
          canary: reg.canary,
          exfilUrl: `${reg.publicBaseUrl || this.baseUrlValue}/exfil/${parts[1]}`,
          secretHint: reg.secretHint,
        });
        const headers: Record<string, string> = { 'content-type': rendered.contentType };
        for (const [k, v] of Object.entries(rendered.extraHeaders ?? {})) {
          // 头值 percent-encode → Latin1 安全，防非 ASCII（如中文注入）触发 Node ERR_INVALID_CHAR。
          // canary/exfilUrl 为 ASCII，encodeURIComponent 基本原样保留，注入语义不丢。
          headers[k] = encodeURIComponent(v);
        }
        res.writeHead(200, headers).end(rendered.body);
        return;
      }

      if (parts[0] === 'exfil' && parts.length === 2) {
        const runToken = parts[1]!;
        const reg = this.regs.get(runToken);
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const blob = `${url.search} ${body} ${JSON.stringify(req.headers)}`;
            const canaryPresent = reg ? blob.includes(reg.canary) : false;
            const log = this.hitLog.get(runToken);
            if (log)
              log.push({ at: this.now(), runToken, canaryPresent, detail: blob.slice(0, 512) });
            res.writeHead(200).end('ok');
          } catch {
            if (!res.headersSent) res.writeHead(500).end('exfil error');
          }
        });
        return;
      }

      res.writeHead(404).end('not found');
    } catch {
      if (!res.headersSent) res.writeHead(500).end('sink error');
    }
  }
}
