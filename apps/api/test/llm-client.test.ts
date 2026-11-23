import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chatComplete } from '../src/lib/llm-client.js';
import type { LlmTargetConfig } from '@lse/shared';

const cfg: LlmTargetConfig = {
  baseUrl: 'http://127.0.0.1:18080/v1',
  apiKey: 'sk-test',
  model: 'gpt-x',
  extraHeaders: null,
  defaultParams: null,
};
const originalTargetAllowlist = process.env.LSE_TARGET_EGRESS_ALLOWLIST;
const originalAllowPrivate = process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;
process.env.LSE_TARGET_EGRESS_ALLOWLIST = 'http://127.0.0.1:18080';
process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = 'true';

after(() => {
  if (originalTargetAllowlist === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOWLIST;
  else process.env.LSE_TARGET_EGRESS_ALLOWLIST = originalTargetAllowlist;
  if (originalAllowPrivate === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;
  else process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = originalAllowPrivate;
});

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;
function setFetch(fn: FetchFn): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('成功响应被归一化为 SUCCESS', async () => {
  setFetch(async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:18080/v1/chat/completions');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer sk-test');
    const reqBody = JSON.parse(String(init?.body));
    assert.equal(reqBody.model, 'gpt-x');
    assert.equal(reqBody.messages[0].content, 'hi');
    return jsonResponse({
      model: 'gpt-x-0613',
      choices: [{ message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
  });
  try {
    const r = await chatComplete(cfg, [{ role: 'user', content: 'hi' }], {});
    assert.equal(r.status, 'SUCCESS');
    assert.equal(r.content, 'hello there');
    assert.equal(r.finishReason, 'stop');
    assert.equal(r.model, 'gpt-x-0613');
    assert.equal(r.usage.promptTokens, 5);
    assert.equal(r.usage.totalTokens, 7);
    assert.equal(r.httpStatus, 200);
    assert.equal(r.error, null);
    assert.ok(r.latencyMs >= 0);
  } finally {
    restoreFetch();
  }
});

test('HTTP 错误体被映射为 ERROR', async () => {
  setFetch(async () => jsonResponse({ error: { message: '无效的 API key' } }, 401));
  try {
    const r = await chatComplete(cfg, [{ role: 'user', content: 'hi' }], {});
    assert.equal(r.status, 'ERROR');
    assert.equal(r.httpStatus, 401);
    assert.match(r.error ?? '', /无效的 API key/);
    assert.equal(r.content, '');
  } finally {
    restoreFetch();
  }
});

test('网络故障被映射为 ERROR', async () => {
  setFetch(async () => {
    throw new TypeError('fetch failed');
  });
  try {
    const r = await chatComplete(cfg, [{ role: 'user', content: 'hi' }], {});
    assert.equal(r.status, 'ERROR');
    assert.equal(r.httpStatus, null);
    assert.match(r.error ?? '', /网络\/连接错误/);
  } finally {
    restoreFetch();
  }
});

test('超时被映射为 ERROR（不抛异常）', async () => {
  setFetch(
    (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        const timer = setTimeout(
          () => resolve(jsonResponse({ choices: [{ message: { content: 'late' } }] })),
          1000,
        );
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
  );
  try {
    const r = await chatComplete(cfg, [{ role: 'user', content: 'hi' }], { timeoutMs: 20 });
    assert.equal(r.status, 'ERROR');
    assert.match(r.error ?? '', /超时/);
  } finally {
    restoreFetch();
  }
});

test('调用方给的超时比出网层默认 30 秒长时，按调用方的算', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctl: { release?: () => void; aborted: boolean } = { aborted: false };
  setFetch(
    (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        ctl.release = () =>
          resolve(
            jsonResponse({
              choices: [{ message: { content: 'slow but ok' }, finish_reason: 'stop' }],
            }),
          );
        init?.signal?.addEventListener('abort', () => {
          ctl.aborted = true;
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
  );
  try {
    const pending = chatComplete(cfg, [{ role: 'user', content: 'hi' }], { timeoutMs: 120_000 });
    while (!ctl.release) await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(31_000);
    assert.equal(ctl.aborted, false, '31 秒时不应被出网层的默认超时掐断');
    ctl.release();
    const r = await pending;
    assert.equal(r.status, 'SUCCESS');
    assert.equal(r.content, 'slow but ok');
  } finally {
    restoreFetch();
  }
});

test('缺少 choices 字段被映射为 ERROR', async () => {
  setFetch(async () => jsonResponse({ id: 'x', usage: {} }, 200));
  try {
    const r = await chatComplete(cfg, [{ role: 'user', content: 'hi' }], {});
    assert.equal(r.status, 'ERROR');
    assert.match(r.error ?? '', /choices/);
  } finally {
    restoreFetch();
  }
});
