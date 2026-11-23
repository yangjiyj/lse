import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  launchChromiumWithWarmup,
  ChromiumUnavailableError,
  renderHtmlToPdf,
  closeBrowser,
} from '../src/modules/reports/html/chromium.js';
function browser(failWarmup = false) {
  const calls = { warmed: 0, pageClosed: 0, browserClosed: 0 };
  return {
    calls,
    newPage: async () => ({
      goto: async (_url: string, opts: any) => {
        calls.warmed++;
        assert.equal(opts.timeout, 120000);
        if (failWarmup) throw new Error('cold start');
      },
      close: async () => {
        calls.pageClosed++;
      },
    }),
    close: async () => {
      calls.browserClosed++;
    },
  };
}
test('首次启动留足真实启动余量，失败只重试一次，预热后返回', async () => {
  let attempts = 0;
  const b = browser();
  const actual = await launchChromiumWithWarmup(async (options) => {
    attempts++;
    assert.equal(options.timeout, 120000);
    assert.equal(options.protocolTimeout, 120000);
    if (attempts === 1) throw new Error('cold start');
    return b as any;
  }, '/synthetic/chrome');
  assert.equal(actual, b);
  assert.equal(attempts, 2);
  assert.equal(b.calls.warmed, 1);
  assert.equal(b.calls.pageClosed, 1);
});
test('预热失败关闭废弃浏览器，再启动一次；健康首次启动不重试', async () => {
  let attempts = 0;
  const first = browser(true),
    second = browser();
  await launchChromiumWithWarmup(
    async () => (++attempts === 1 ? (first as any) : (second as any)),
    '/synthetic/chrome',
  );
  assert.equal(first.calls.browserClosed, 1);
  assert.equal(first.calls.pageClosed, 1);
  assert.equal(attempts, 2);
  attempts = 0;
  await launchChromiumWithWarmup(async () => {
    attempts++;
    return browser() as any;
  }, '/synthetic/chrome');
  assert.equal(attempts, 1);
});
test('连续两次启动失败保留明确错误，不无限重试', async () => {
  let attempts = 0;
  await assert.rejects(
    launchChromiumWithWarmup(async () => {
      attempts++;
      throw new Error('synthetic startup failure');
    }, '/synthetic/chrome'),
    ChromiumUnavailableError,
  );
  assert.equal(attempts, 2);
});
test(
  '真实Chromium冷启动预热后完成PDF冒烟',
  { skip: !process.env.PUPPETEER_EXECUTABLE_PATH },
  async () => {
    await closeBrowser();
    try {
      const pdf = await renderHtmlToPdf(
        '<!doctype html><html><body><h1>合成冷启动测试</h1><p>本地检测器验证</p></body></html>',
      );
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
      assert.ok(pdf.length > 100);
      const cached = await renderHtmlToPdf(
        '<!doctype html><html><body><p>合成缓存复用测试</p></body></html>',
      );
      assert.equal(cached.subarray(0, 5).toString(), '%PDF-');
    } finally {
      await closeBrowser();
    }
  },
);
