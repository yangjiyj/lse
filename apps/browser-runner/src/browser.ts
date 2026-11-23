import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
  type Request,
} from 'playwright';
import type { DoneReason, RunnerConfig, Selectors, TurnRequest, TurnResult } from './contracts.js';
import {
  buildPinnedUrl,
  type DnsResolver,
  SystemDnsResolver,
  validateAndPinUrl,
} from './ip-guard.js';
import {
  boundedPush,
  createTelemetry,
  makeEvidence,
  takeScreenshot,
  type PageTelemetry,
} from './evidence.js';
import {
  fillInput,
  heuristicLocate,
  resolveSelectors,
  sendPrompt,
  snapshotMessages,
  type ResolvedSelectors,
} from './locator.js';

interface RunnerSession {
  id: string;
  context: BrowserContext;
  page: Page;
  turnIndex: number;
  telemetry: PageTelemetry;
  createdAt: number;
  expiresTimer: NodeJS.Timeout;
}

const mainPages = new WeakSet<Page>();

export interface RouteTransportContext {
  originalUrl: string;
  pinnedUrl: string;
  hostHeader: string;
  request: Request;
}

export type RouteTransport = (route: Route, context: RouteTransportContext) => Promise<boolean>;

export interface GuardableWebSocket {
  url(): string;
  close(options?: { code?: number; reason?: string }): Promise<void>;
}

export class BrowserRunner {
  private browser: Browser | null = null;
  private sessions = new Map<string, RunnerSession>();
  private activeTurns = 0;

  constructor(
    private readonly config: RunnerConfig,
    private readonly resolver: DnsResolver = new SystemDnsResolver(),
    private readonly routeTransport?: RouteTransport,
  ) {}

  async turn(sessionId: string, request: TurnRequest): Promise<TurnResult> {
    const startedAt = Date.now();
    if (this.activeTurns >= this.config.concurrency) {
      return this.emptyResult(sessionId, 0, request.prompt, startedAt, 'SKIPPED', 'runner_busy');
    }
    this.activeTurns += 1;
    try {
      return await this.withHardTimeout(
        this.runTurn(sessionId, request, startedAt),
        (request.options?.hardTimeoutMs ?? this.config.defaultHardTimeoutMs) + 10_000,
        sessionId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const session = this.sessions.get(sessionId);
      const turnIndex = session?.turnIndex ?? 0;
      const page = session?.page ?? null;
      const afterResponse = await takeScreenshot(
        page,
        this.config,
        sessionId,
        turnIndex,
        'error',
      ).catch(() => null);
      const evidence = makeEvidence(
        {
          sessionId,
          turnIndex,
          prompt: request.prompt,
          text: '',
          doneReason: null,
          truncated: false,
          afterSend: null,
          afterResponse,
          finalUrl: page?.url() ?? request.entryUrl,
          title: page ? await page.title().catch(() => '') : '',
          selectors: selectorsEvidence(configuredSelectors(request)),
          sentAt: null,
          respondedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          status: 'ERROR',
          skipReason: null,
          telemetry: session?.telemetry ?? createTelemetry(),
        },
        this.config.internalToken,
      );
      return {
        status: 'ERROR',
        text: '',
        doneReason: null,
        truncated: false,
        skipReason: null,
        evidence,
        latencyMs: Date.now() - startedAt,
        error: message,
      };
    } finally {
      this.activeTurns -= 1;
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (session) clearTimeout(session.expiresTimer);
    await session?.context.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.closeSession(sessionId)));
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  private async runTurn(
    sessionId: string,
    request: TurnRequest,
    startedAt: number,
  ): Promise<TurnResult> {
    const session = await this.getOrCreateSession(sessionId);
    if (Date.now() - session.createdAt > this.config.sessionMaxAgeMs) {
      await this.closeSession(sessionId);
      return await this.runTurn(sessionId, request, startedAt);
    }
    const turnIndex = session.turnIndex++;
    const stableMs = request.options?.stableMs ?? this.config.defaultStableMs;
    const maxResponseChars = request.options?.maxResponseChars ?? this.config.maxResponseChars;
    await session.page.goto(request.entryUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const explicitSelectors = configuredSelectors(request);
    const resolved = await resolveSelectors(session.page, request.entryUrl, explicitSelectors);
    const heuristic = explicitSelectors || resolved ? null : await heuristicLocate(session.page);
    const selectors = resolved ?? heuristic?.selectors ?? null;
    const candidates = selectors?.candidates ?? heuristic?.candidates ?? [];
    const failedSelectorEvidence = selectors
      ? selectorsEvidence(selectors, candidates)
      : explicitSelectors
        ? selectorsEvidence(explicitSelectors, candidates)
        : heuristicFailureEvidence(candidates);
    if (!selectors) {
      return await this.skippedLocateFailed(
        session,
        turnIndex,
        request,
        startedAt,
        null,
        failedSelectorEvidence,
      );
    }

    const input = session.page.locator(selectors.input).first();
    const send = selectors.send === 'Enter' ? null : session.page.locator(selectors.send).first();
    if ((await input.count()) === 0 || (send && (await send.count()) === 0)) {
      return await this.skippedLocateFailed(
        session,
        turnIndex,
        request,
        startedAt,
        null,
        failedSelectorEvidence,
      );
    }

    await fillInput(input, request.prompt);
    const beforeMessages = await snapshotMessages(session.page, selectors.input);
    const sendResult = await sendPrompt(session.page, selectors, beforeMessages, request.prompt);
    const afterSend = await takeScreenshot(
      session.page,
      this.config,
      sessionId,
      turnIndex,
      'after-send',
    );
    if (!sendResult.sent) {
      return await this.skippedLocateFailed(
        session,
        turnIndex,
        request,
        startedAt,
        afterSend,
        selectorsEvidence({ ...selectors, send: sendResult.send }, candidates),
      );
    }
    const sentAt = new Date().toISOString();
    const responseBubble = sendResult.bubble || selectors.bubble;
    const evidenceSelectors = { ...selectors, send: sendResult.send, bubble: responseBubble };

    const wait = await waitForDomIdle(
      session.page,
      responseBubble,
      stableMs,
      request.options?.hardTimeoutMs ?? this.config.defaultHardTimeoutMs,
      maxResponseChars,
      selectors.doneSignal,
    );
    const respondedAt = new Date().toISOString();
    const afterResponse = await takeScreenshot(
      session.page,
      this.config,
      sessionId,
      turnIndex,
      'after-response',
    );
    const title = await session.page.title().catch(() => '');
    const elapsedMs = Date.now() - startedAt;
    const text = wait.text.slice(0, maxResponseChars);
    const evidence = makeEvidence(
      {
        sessionId,
        turnIndex,
        prompt: request.prompt,
        text,
        doneReason: wait.doneReason,
        truncated: wait.truncated,
        afterSend,
        afterResponse,
        finalUrl: session.page.url(),
        title,
        selectors: selectorsEvidence(evidenceSelectors, candidates),
        sentAt,
        respondedAt,
        elapsedMs,
        status: 'OK',
        skipReason: null,
        telemetry: session.telemetry,
      },
      this.config.internalToken,
    );
    return {
      status: 'OK',
      text,
      doneReason: wait.doneReason,
      truncated: wait.truncated,
      skipReason: null,
      evidence,
      latencyMs: elapsedMs,
    };
  }

  private async getOrCreateSession(sessionId: string): Promise<RunnerSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const browser = await this.getBrowser();
    const context = await browser.newContext({
      acceptDownloads: false,
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
    });
    const telemetry = createTelemetry();
    await this.attachContextGuards(context, telemetry);
    const page = await context.newPage();
    mainPages.add(page);
    const expiresTimer = setTimeout(() => {
      void this.closeSession(sessionId);
    }, this.config.sessionMaxAgeMs);
    expiresTimer.unref();
    const session: RunnerSession = {
      id: sessionId,
      context,
      page,
      turnIndex: 0,
      telemetry,
      createdAt: Date.now(),
      expiresTimer,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    this.browser = await chromium.launch({
      headless: this.config.headless,
      chromiumSandbox: false,
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--disable-setuid-sandbox'],
    });
    return this.browser;
  }

  private async attachContextGuards(
    context: BrowserContext,
    telemetry: PageTelemetry,
  ): Promise<void> {
    const configurePage = async (page: Page) => {
      if (!mainPages.has(page) && context.pages().length > 1) {
        await page.close().catch(() => undefined);
        return;
      }
      page.on('console', (message) => {
        boundedPush(telemetry.consoleLogs, `${message.type()}: ${message.text()}`, this.config);
      });
      page.on('pageerror', (error) => {
        boundedPush(telemetry.pageErrors, error.message, this.config);
      });
      page.on('dialog', (dialog) => dialog.dismiss().catch(() => undefined));
      page.on('download', (download) => download.cancel().catch(() => undefined));
      page.on('popup', (popup) => popup.close().catch(() => undefined));
    };
    context.on('page', (page) => {
      void configurePage(page);
    });
    // esbuild/tsx 测试下会给传入 page.evaluate 的函数注入 __name 辅助；浏览器预置一个 identity 兼容（生产 tsc 产物不引用，零副作用）
    await context.addInitScript({
      content: 'globalThis.__name = globalThis.__name || ((f) => f);',
    });
    await context.route('**/*', async (route) => this.guardRoute(route, telemetry));
    await context.routeWebSocket(/.*/, async (ws) => this.guardWebSocket(ws, telemetry));
  }

  private async guardRoute(route: Route, telemetry: PageTelemetry): Promise<void> {
    const request = route.request();
    try {
      const decision = await validateAndPinUrl(request.url(), this.resolver);
      if (!decision.allowed || !decision.pinnedIp) {
        boundedPush(
          telemetry.networkBlocks,
          `blocked ${request.url()} ${decision.reason ?? 'unknown'}`,
          this.config,
        );
        await route.abort('blockedbyclient');
        return;
      }
      const pinned = buildPinnedUrl(request.url(), decision.pinnedIp);
      const headers = { ...request.headers(), host: pinned.hostHeader };
      if (
        this.routeTransport &&
        (await this.routeTransport(route, {
          originalUrl: request.url(),
          pinnedUrl: pinned.url,
          hostHeader: pinned.hostHeader,
          request,
        }))
      ) {
        return;
      }
      await route.continue({ url: pinned.url, headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      boundedPush(
        telemetry.networkBlocks,
        `blocked ${request.url()} guard_error:${message}`,
        this.config,
      );
      await route.abort('blockedbyclient');
    }
  }

  private async guardWebSocket(ws: GuardableWebSocket, telemetry: PageTelemetry): Promise<void> {
    await guardWebSocket(ws, telemetry, this.config, this.resolver);
  }

  private async skippedLocateFailed(
    session: RunnerSession,
    turnIndex: number,
    request: TurnRequest,
    startedAt: number,
    afterSend: string | null,
    selectorEvidence = selectorsEvidence(configuredSelectors(request)),
  ): Promise<TurnResult> {
    const afterResponse = await takeScreenshot(
      session.page,
      this.config,
      session.id,
      turnIndex,
      'locate-failed',
    );
    const elapsedMs = Date.now() - startedAt;
    const evidence = makeEvidence(
      {
        sessionId: session.id,
        turnIndex,
        prompt: request.prompt,
        text: '',
        doneReason: null,
        truncated: false,
        afterSend,
        afterResponse,
        finalUrl: session.page.url(),
        title: await session.page.title().catch(() => ''),
        selectors: selectorEvidence,
        sentAt: null,
        respondedAt: new Date().toISOString(),
        elapsedMs,
        status: 'SKIPPED',
        skipReason: 'locate_failed',
        telemetry: session.telemetry,
      },
      this.config.internalToken,
    );
    return {
      status: 'SKIPPED',
      text: '',
      doneReason: null,
      truncated: false,
      skipReason: 'locate_failed',
      evidence,
      latencyMs: elapsedMs,
    };
  }

  private emptyResult(
    sessionId: string,
    turnIndex: number,
    prompt: string,
    startedAt: number,
    status: 'SKIPPED',
    skipReason: 'runner_busy',
  ): TurnResult {
    const elapsedMs = Date.now() - startedAt;
    const telemetry = createTelemetry();
    const evidence = makeEvidence(
      {
        sessionId,
        turnIndex,
        prompt,
        text: '',
        doneReason: null,
        truncated: false,
        afterSend: null,
        afterResponse: null,
        finalUrl: '',
        title: '',
        selectors: selectorsEvidence(undefined),
        sentAt: null,
        respondedAt: new Date().toISOString(),
        elapsedMs,
        status,
        skipReason,
        telemetry,
      },
      this.config.internalToken,
    );
    return {
      status,
      text: '',
      doneReason: null,
      truncated: false,
      skipReason,
      evidence,
      latencyMs: elapsedMs,
    };
  }

  private async withHardTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    sessionId: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.closeSession(sessionId);
            reject(new Error(`turn timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export async function guardWebSocket(
  ws: GuardableWebSocket,
  telemetry: PageTelemetry,
  config: RunnerConfig,
  resolver: DnsResolver,
): Promise<void> {
  const url = ws.url();
  try {
    const decision = await validateAndPinUrl(webSocketUrlForValidation(url), resolver);
    if (!decision.allowed || !decision.pinnedIp) {
      boundedPush(
        telemetry.networkBlocks,
        `blocked websocket ${url} ${decision.reason ?? 'unknown'}`,
        config,
      );
    } else {
      boundedPush(
        telemetry.networkBlocks,
        `blocked websocket ${url} websocket_pin_unsupported`,
        config,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    boundedPush(telemetry.networkBlocks, `blocked websocket ${url} guard_error:${message}`, config);
  }
  await ws.close({ code: 1008, reason: 'blocked by browser-runner guard' }).catch(() => undefined);
}

function configuredSelectors(request: TurnRequest): Selectors | undefined {
  return request.accessConfig?.selectors ?? request.selectors;
}

function selectorsEvidence(
  selectors: Selectors | ResolvedSelectors | undefined,
  candidates: ResolvedSelectors['candidates'] = [],
) {
  const source =
    selectors && 'source' in selectors
      ? selectors.source
      : selectors
        ? ('config' as const)
        : ('hardcoded' as const);
  return {
    source,
    input: selectors?.input ?? '',
    send: selectors?.send ?? '',
    bubble: selectors?.bubble ?? '',
    candidates,
  };
}

function heuristicFailureEvidence(candidates: ResolvedSelectors['candidates']) {
  return {
    source: 'heuristic' as const,
    input: '',
    send: '',
    bubble: '',
    candidates,
  };
}

function webSocketUrlForValidation(urlText: string): string {
  const url = new URL(urlText);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  return url.toString();
}

async function waitForDomIdle(
  page: Page,
  bubbleSelector: string,
  stableMs: number,
  hardTimeoutMs: number,
  maxResponseChars: number,
  doneSignal?: string,
): Promise<{ text: string; doneReason: DoneReason; truncated: boolean }> {
  return await page.evaluate(
    async ({
      bubbleSelector,
      stableMs,
      hardTimeoutMs,
      maxResponseChars,
      doneSignal,
    }: {
      bubbleSelector: string;
      stableMs: number;
      hardTimeoutMs: number;
      maxResponseChars: number;
      doneSignal?: string;
    }) => {
      const readText = () => {
        const nodes = Array.from(document.querySelectorAll(bubbleSelector));
        const last = nodes.at(-1);
        return (last?.textContent ?? '').trim();
      };
      let lastText = readText();
      let lastMutationAt = Date.now();
      const startedAt = Date.now();
      let hasResponseText = lastText.length > 0;
      const observer = new MutationObserver(() => {
        const nextText = readText();
        if (nextText !== lastText) {
          lastText = nextText;
          if (nextText.length > 0) hasResponseText = true;
          lastMutationAt = Date.now();
        }
      });
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
      try {
        while (!hasResponseText || Date.now() - lastMutationAt < stableMs) {
          if (doneSignal && document.querySelector(doneSignal)) {
            const text = readText();
            return {
              text: text.slice(0, maxResponseChars),
              doneReason: 'stop_signal' as const,
              truncated: text.length > maxResponseChars,
            };
          }
          if (Date.now() - startedAt >= hardTimeoutMs) {
            const text = readText();
            return {
              text: text.slice(0, maxResponseChars),
              doneReason: 'timeout' as const,
              truncated: true,
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } finally {
        observer.disconnect();
      }
      const text = readText();
      return {
        text: text.slice(0, maxResponseChars),
        doneReason: 'dom_idle' as const,
        truncated: text.length > maxResponseChars,
      };
    },
    { bubbleSelector, stableMs, hardTimeoutMs, maxResponseChars, doneSignal },
  );
}
