import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Browser, LaunchOptions } from 'puppeteer-core';

/**
 * HTML -> PDF（无头 Chromium + paged.js）。
 * - 复用单例浏览器，避免每次下载冷启动 chromium（~0.5s）。
 * - 关键：必须等 paged.js 分页稳定后再 page.pdf；Chrome 的 --print-to-pdf 会抢跑只出 1 页。
 * - puppeteer-core 动态导入：未安装/未配置 chromium 时由上层返回明确错误，禁止静默降级。
 */

const PAGED_JS_URL = new URL('./paged.polyfill.js', import.meta.url);

export interface HtmlToPdfOptions {
  executablePath?: string;
  timeoutMs?: number;
  /** Optional acceptance check on the completed paginated DOM, before printing. */
  verifyPageLayout?: (layout: {
    pageCount: number;
    firstPageText: string;
    lastPageText: string;
  }) => void | Promise<void>;
}

export class ChromiumUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'ChromiumUnavailableError';
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let browserPromise: Promise<Browser> | null = null;
let pagedJsCache: string | null = null;

async function loadPagedJs(): Promise<string> {
  if (pagedJsCache === null) {
    pagedJsCache = await readFile(fileURLToPath(PAGED_JS_URL), 'utf8');
  }
  return pagedJsCache;
}

/** Bound cold startup separately from page rendering; warm once and retry at most once. */
export async function launchChromiumWithWarmup(
  launch: (options: LaunchOptions) => Promise<Browser>,
  executablePath: string,
): Promise<Browser> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let browser: Browser | undefined;
    try {
      browser = await launch({
        executablePath,
        headless: true,
        timeout: 120_000,
        protocolTimeout: 120_000,
        args: [
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--font-render-hinting=none',
        ],
      });
      const warmup = await browser.newPage();
      try {
        await warmup.goto('about:blank', { waitUntil: 'load', timeout: 120_000 });
      } finally {
        await warmup.close();
      }
      return browser;
    } catch (error) {
      await browser?.close().catch(() => undefined);
      if (attempt === 1)
        throw new ChromiumUnavailableError('无法启动并预热 chromium（已重试一次）', error);
    }
  }
  throw new ChromiumUnavailableError('无法启动 chromium');
}

async function getBrowser(executablePath?: string): Promise<Browser> {
  if (browserPromise) {
    const previous = browserPromise;
    try {
      const browser = await previous;
      if (browser?.connected) return browser;
    } catch {
      /* failed startup is replaced below */
    }
    if (browserPromise === previous) browserPromise = null;
    if (browserPromise) return browserPromise;
  }
  // Assign before awaiting the dynamic import, so concurrent downloads share one cold launch.
  const pending = (async () => {
    let puppeteer: typeof import('puppeteer-core').default;
    try {
      puppeteer = (await import('puppeteer-core')).default;
    } catch (error) {
      throw new ChromiumUnavailableError('puppeteer-core 未安装，无法以 HTML 渲染器出 PDF', error);
    }
    const exe =
      executablePath || process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROMIUM_PATH;
    if (!exe)
      throw new ChromiumUnavailableError(
        '未配置 chromium 可执行路径（PUPPETEER_EXECUTABLE_PATH / CHROMIUM_PATH）',
      );
    return launchChromiumWithWarmup((options) => puppeteer.launch(options), exe);
  })();
  browserPromise = pending;
  void pending.catch(() => {
    if (browserPromise === pending) browserPromise = null;
  });
  return pending;
}

export async function renderHtmlToPdf(html: string, opts: HtmlToPdfOptions = {}): Promise<Buffer> {
  const timeout = opts.timeoutMs ?? 60_000;
  const pagedJs = await loadPagedJs();
  const browser = await getBrowser(opts.executablePath);
  const page = await browser.newPage();
  try {
    // 解析期就带上 paged.js（用 data: URL 的 <script src>，避免内联时源码中的 </script> 提前闭合标签，
    // 同时让 paged.js 在 DOMContentLoaded 前注册钩子并自动分页——addScriptTag 在 DCL 后注入会错过自动运行）。
    const pagedSrc =
      'data:text/javascript;base64,' + Buffer.from(pagedJs, 'utf8').toString('base64');
    const withPaged = html.includes('</body>')
      ? html.replace('</body>', `<script src="${pagedSrc}"></script></body>`)
      : `${html}<script src="${pagedSrc}"></script>`;
    await page.setContent(withPaged, { waitUntil: 'load', timeout });
    // 等分页容器出现
    await page.waitForFunction("!!document.querySelector('.pagedjs_pages')", { timeout });
    // 等页数稳定（连续两次相同视为分页完成）
    await page.waitForFunction(
      '(() => { const n = document.querySelectorAll(".pagedjs_page").length; const ok = window.__pn === n && n > 0; window.__pn = n; return ok; })()',
      { polling: 600, timeout },
    );
    if (opts.verifyPageLayout) {
      const layout = await page.evaluate(
        '(() => { const pages = Array.from(document.querySelectorAll(".pagedjs_page")); return { pageCount: pages.length, firstPageText: pages[0]?.textContent ?? "", lastPageText: pages.at(-1)?.textContent ?? "" }; })()',
      );
      await opts.verifyPageLayout(
        layout as Parameters<NonNullable<HtmlToPdfOptions['verifyPageLayout']>>[0],
      );
    }
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** 进程退出/测试清理时关闭浏览器。 */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch {
    // ignore
  } finally {
    browserPromise = null;
  }
}
