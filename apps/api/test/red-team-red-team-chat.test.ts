import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRedTeamChat,
  ConfigError,
  RetryExhausted,
} from '../src/modules/red-team/red-team-chat.js';
import { AdaptiveConcurrency } from '../src/modules/red-team/adaptive-concurrency.js';
import type { ChatFn } from '../src/modules/red-team/types.js';

// createRedTeamChat：把底层 chat 包装成统一红队调用器。
//   - retryable（fetch/timeout/429/5xx/200空content）：原轮即时重试，退避 1s/3s，最多3次。
//   - non-retryable（4xx 配置错误/缺choices）：立即抛 ConfigError，不重试、不降并发轰击。
//   - retryable 耗尽：抛 RetryExhausted 供上层延后重排。
//   - 成败反馈给 AdaptiveConcurrency（onSuccess/onError），并发变更通过 onEvent 发日志。

function makeChatSequence(results: any[]): { chat: ChatFn; calls: any[] } {
  const calls: any[] = [];
  let i = 0;
  const chat: ChatFn = async (cfg, messages, opts) => {
    calls.push({ cfg, messages, opts });
    const r = results[Math.min(i, results.length - 1)];
    i++;
    return r;
  };
  return { chat, calls };
}

test('HTTP 200 空内容 → retryable，第二次有内容则成功（不抛）', async () => {
  const ctrl = new AdaptiveConcurrency(4);
  const sleeps: number[] = [];
  const { chat, calls } = makeChatSequence([
    { status: 'SUCCESS', content: '', finishReason: 'stop', httpStatus: 200, usage: {} },
    { status: 'SUCCESS', content: '正常回答', finishReason: 'stop', httpStatus: 200, usage: {} },
  ]);
  const rt = createRedTeamChat({
    chat,
    controller: ctrl,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  const r = await rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, {
    stage: 'target',
  });
  assert.equal(r.content, '正常回答');
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [1000]); // 第一次失败后等 1s 再试
});

test('401 配置错误 → 立即抛 ConfigError，不重试、不反复降并发', async () => {
  const ctrl = new AdaptiveConcurrency(4);
  let onErrorCount = 0;
  const { chat, calls } = makeChatSequence([
    { status: 'ERROR', content: '', httpStatus: 401, error: 'HTTP 401' },
  ]);
  const rt = createRedTeamChat({
    chat,
    controller: ctrl,
    sleep: () => Promise.resolve(),
    onEvent: (e) => {
      if (e.kind === 'decrease') onErrorCount++;
    },
  });
  await assert.rejects(
    () => rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, { stage: 'judge' }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError, '应为 ConfigError');
      assert.equal((err as ConfigError).stage, 'judge');
      assert.equal((err as ConfigError).reasonCode, 'HTTP_4XX');
      return true;
    },
  );
  assert.equal(calls.length, 1); // 没重试
  assert.equal(onErrorCount, 0); // 没降并发轰击
  assert.equal(ctrl.current(), 4); // 并发未动
});

test('403 配置错误 → ConfigError，stage=target', async () => {
  const { chat } = makeChatSequence([
    { status: 'ERROR', content: '', httpStatus: 403, error: 'HTTP 403' },
  ]);
  const rt = createRedTeamChat({
    chat,
    controller: new AdaptiveConcurrency(4),
    sleep: () => Promise.resolve(),
  });
  await assert.rejects(
    () => rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, { stage: 'target' }),
    (err: unknown) => err instanceof ConfigError && (err as ConfigError).stage === 'target',
  );
});

test('fetch failed 三次都失败 → 抛 RetryExhausted，controller 降并发3次', async () => {
  const ctrl = new AdaptiveConcurrency(4);
  const decreases: number[] = [];
  const { chat, calls } = makeChatSequence([
    { status: 'ERROR', content: '', httpStatus: null, error: '网络/连接错误：fetch failed' },
    { status: 'ERROR', content: '', httpStatus: null, error: '网络/连接错误：fetch failed' },
    { status: 'ERROR', content: '', httpStatus: null, error: '网络/连接错误：fetch failed' },
  ]);
  const rt = createRedTeamChat({
    chat,
    controller: ctrl,
    sleep: () => Promise.resolve(),
    onEvent: (e) => {
      if (e.kind === 'decrease') decreases.push(e.effectiveConcurrency);
    },
  });
  await assert.rejects(
    () =>
      rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, { stage: 'attacker' }),
    (err: unknown) => err instanceof RetryExhausted,
  );
  assert.equal(calls.length, 3); // 即时重试 3 次
  assert.equal(ctrl.current(), 1); // 4->2->1，三次错误后到 1
  assert.deepEqual(decreases, [2, 1, 1]); // 三次降并发事件
});

test('成功调用 → controller.onSuccess，emit success 事件', async () => {
  const ctrl = new AdaptiveConcurrency(2);
  let successEvent = 0;
  const { chat } = makeChatSequence([
    {
      status: 'SUCCESS',
      content: 'ok',
      finishReason: 'stop',
      httpStatus: 200,
      usage: { totalTokens: 5 },
    },
  ]);
  const rt = createRedTeamChat({
    chat,
    controller: ctrl,
    sleep: () => Promise.resolve(),
    onEvent: (e) => {
      if (e.kind === 'steady-success' || e.kind === 'increase') successEvent++;
    },
  });
  const r = await rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, {
    stage: 'attacker',
  });
  assert.equal(r.content, 'ok');
  assert.equal(successEvent, 1);
});

test('maxTokens 透传到底层 chat opts', async () => {
  const ctrl = new AdaptiveConcurrency(4);
  const { chat, calls } = makeChatSequence([
    { status: 'SUCCESS', content: 'ok', finishReason: 'stop', httpStatus: 200, usage: {} },
  ]);
  const rt = createRedTeamChat({ chat, controller: ctrl, sleep: () => Promise.resolve() });
  await rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, {
    stage: 'target',
    maxTokens: 1024,
  });
  assert.equal(calls[0].opts.maxTokens, 1024);
});

test('finish_reason=length 有正文 → 成功返回，保留 finishReason（资源消耗证据）', async () => {
  const { chat } = makeChatSequence([
    {
      status: 'SUCCESS',
      content: '被截断的长回答...',
      finishReason: 'length',
      httpStatus: 200,
      usage: {},
    },
  ]);
  const rt = createRedTeamChat({
    chat,
    controller: new AdaptiveConcurrency(4),
    sleep: () => Promise.resolve(),
  });
  const r = await rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, {
    stage: 'target',
  });
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.finishReason, 'length');
});

test('退避序列：1s 后 3s（注入 sleep 记录）', async () => {
  const sleeps: number[] = [];
  const { chat } = makeChatSequence([
    { status: 'ERROR', content: '', httpStatus: 503, error: 'HTTP 503' },
    { status: 'ERROR', content: '', httpStatus: 503, error: 'HTTP 503' },
    { status: 'SUCCESS', content: 'ok', finishReason: 'stop', httpStatus: 200, usage: {} },
  ]);
  const rt = createRedTeamChat({
    chat,
    controller: new AdaptiveConcurrency(4),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  await rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, { stage: 'target' });
  assert.deepEqual(sleeps, [1000, 3000]);
});
