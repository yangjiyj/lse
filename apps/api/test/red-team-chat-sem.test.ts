import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedTeamChat } from '../src/modules/red-team/red-team-chat.js';
import { AdaptiveConcurrency } from '../src/modules/red-team/adaptive-concurrency.js';
import { AsyncSemaphore } from '../src/modules/red-team/async-semaphore.js';
import type { ChatFn } from '../src/modules/red-team/types.js';

// P1：RedTeamChat 必须在每次真实模型调用前 acquire / finally release 信号量，
// 把 AIMD 的有效并发真正落到同时进行的网络请求数上。
// 信号量容量=controller.current()，由 onEvent 在降/升并发时 setCapacity 同步。

test('真实并发受限：semaphore cap=2，5 并发 call 的 maxInFlight<=2', async () => {
  const controller = new AdaptiveConcurrency(2);
  const sem = new AsyncSemaphore(controller.current());
  let inFlight = 0;
  let maxInFlight = 0;
  const chat: ChatFn = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
    return { status: 'SUCCESS', content: 'ok', finishReason: 'stop', httpStatus: 200 };
  };
  const rt = createRedTeamChat({
    chat,
    controller,
    semaphore: sem,
    sleep: () => Promise.resolve(),
  });
  await Promise.all(
    Array.from({ length: 5 }, () =>
      rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, { stage: 'target' }),
    ),
  );
  assert.ok(maxInFlight <= 2, `maxInFlight=${maxInFlight} 应 <=2`);
  assert.equal(maxInFlight, 2, 'cap=2 时应实际达到 2');
});

test('降并发后新请求受限：cap 从 4 降到 2，后续 maxInFlight<=2', async () => {
  const controller = new AdaptiveConcurrency(4);
  const sem = new AsyncSemaphore(controller.current());
  // 手动把 controller 降到 2（模拟两次 retryable 错误）
  controller.onError(); // 4->2
  controller.onError(); // 2->1
  sem.setCapacity(controller.current()); // cap=1
  let inFlight = 0;
  let maxInFlight = 0;
  const chat: ChatFn = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
    return { status: 'SUCCESS', content: 'ok', finishReason: 'stop', httpStatus: 200 };
  };
  const rt = createRedTeamChat({
    chat,
    controller,
    semaphore: sem,
    sleep: () => Promise.resolve(),
  });
  await Promise.all(
    Array.from({ length: 5 }, () =>
      rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, { stage: 'target' }),
    ),
  );
  assert.ok(maxInFlight <= 1, `降到 1 后 maxInFlight=${maxInFlight} 应 <=1`);
});

test('release 在失败/抛错时也执行（许可不泄漏）', async () => {
  const controller = new AdaptiveConcurrency(2);
  const sem = new AsyncSemaphore(controller.current());
  const chat: ChatFn = async () => {
    throw new Error('boom');
  };
  const rt = createRedTeamChat({
    chat,
    controller,
    semaphore: sem,
    sleep: () => Promise.resolve(),
    maxAttempts: 1,
  });
  // chat 抛错（非 ERROR 归一），RedTeamChat 应 finally release
  await assert.rejects(() =>
    rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, { stage: 'target' }),
  );
  assert.equal(sem.inFlightCount, 0, '出错后许可应全部释放');
});

test('AbortSignal 取消时立即从信号量等待中脱出', async () => {
  const controller = new AdaptiveConcurrency(1);
  const sem = new AsyncSemaphore(controller.current());
  const ac = new AbortController();
  // 占满容量
  const holder: ChatFn = async () => {
    await new Promise((r) => setTimeout(r, 200));
    return { status: 'SUCCESS', content: 'ok', finishReason: 'stop', httpStatus: 200 };
  };
  const rt = createRedTeamChat({
    chat: holder,
    controller,
    semaphore: sem,
    sleep: () => Promise.resolve(),
  });
  const holderP = rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, {
    stage: 'target',
  });
  await new Promise((r) => setTimeout(r, 10)); // 让 holder 拿到许可
  const t0 = Date.now();
  const waitP = assert.rejects(
    () =>
      rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, {
        stage: 'target',
        signal: ac.signal,
      }),
    (e: unknown) => (e as Error).name === 'AbortError',
  );
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  await waitP;
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `abort 后应立即脱出，实际 ${elapsed}ms`);
  await holderP;
});

test('retryable 失败进入退避前释放许可，不阻塞其他健康调用', async () => {
  const controller = new AdaptiveConcurrency(1);
  const sem = new AsyncSemaphore(1);
  let attempts = 0;
  const chat: ChatFn = async () => {
    attempts += 1;
    if (attempts === 1) {
      return { status: 'ERROR', content: '', finishReason: null, httpStatus: 503 } as any;
    }
    return { status: 'SUCCESS', content: 'ok', finishReason: 'stop', httpStatus: 200 } as any;
  };
  const rt = createRedTeamChat({
    chat,
    controller,
    semaphore: sem,
    sleep: async () => {
      assert.equal(sem.inFlightCount, 0, '退避等待不应占用模型调用许可');
    },
    maxAttempts: 2,
  });

  await rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, { stage: 'target' });
  assert.equal(attempts, 2);
});

test('AbortSignal 可立即中断 retry backoff', async () => {
  const controller = new AdaptiveConcurrency(1);
  const ac = new AbortController();
  let sleepStarted!: () => void;
  const enteredSleep = new Promise<void>((resolve) => {
    sleepStarted = resolve;
  });
  const chat: ChatFn = async () =>
    ({ status: 'ERROR', content: '', finishReason: null, httpStatus: 503 }) as any;
  const rt = createRedTeamChat({
    chat,
    controller,
    backoffMs: [10_000],
    maxAttempts: 2,
    sleep: async (_ms, signal) => {
      sleepStarted();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  });

  const pending = rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, {
    stage: 'target',
    signal: ac.signal,
  });
  await enteredSleep;
  const startedAt = Date.now();
  ac.abort();
  await assert.rejects(pending, (e: unknown) => (e as Error).name === 'AbortError');
  assert.ok(Date.now() - startedAt < 500, '取消应立即中断退避');
});

test('length 空正文逐次提升输出预算且不降低并发', async () => {
  const controller = new AdaptiveConcurrency(4);
  const maxTokensSeen: Array<number | undefined> = [];
  const events: Array<{
    kind: string;
    reasonCode: string;
    previousMaxTokens?: number;
    effectiveMaxTokens?: number;
    finishReason?: string | null;
  }> = [];
  let attempts = 0;
  const chat: ChatFn = async (_cfg, _messages, opts) => {
    attempts += 1;
    maxTokensSeen.push(opts?.maxTokens);
    if (attempts < 3) {
      return {
        status: 'SUCCESS',
        content: '',
        finishReason: 'length',
        httpStatus: 200,
      } as any;
    }
    return {
      status: 'SUCCESS',
      content: '{"move":"shell_swap","message":"ok","rationale":"ok"}',
      finishReason: 'stop',
      httpStatus: 200,
    } as any;
  };
  const rt = createRedTeamChat({
    chat,
    controller,
    sleep: () => Promise.resolve(),
    maxAttempts: 3,
    onEvent: (event) => events.push(event),
  });

  const result = await rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, {
    stage: 'attacker',
    maxTokens: 512,
  });

  assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(maxTokensSeen, [512, 1024, 2048]);
  assert.equal(controller.current(), 4, '输出预算耗尽不应被当成并发拥塞');
  const budgetRetries = events.filter((event) => event.reasonCode === 'TOKEN_BUDGET_EXHAUSTED');
  assert.equal(budgetRetries.length, 2);
  assert.deepEqual(
    budgetRetries.map((event) => [
      event.previousMaxTokens,
      event.effectiveMaxTokens,
      event.finishReason,
    ]),
    [
      [512, 1024, 'length'],
      [1024, 2048, 'length'],
    ],
  );
});

test('非 length 空正文仍按瞬时错误降低并发', async () => {
  const controller = new AdaptiveConcurrency(4);
  let attempts = 0;
  const chat: ChatFn = async () =>
    ++attempts === 1
      ? ({ status: 'SUCCESS', content: '', finishReason: 'stop', httpStatus: 200 } as any)
      : ({ status: 'SUCCESS', content: 'ok', finishReason: 'stop', httpStatus: 200 } as any);
  const rt = createRedTeamChat({
    chat,
    controller,
    sleep: () => Promise.resolve(),
    maxAttempts: 2,
  });
  await rt.call({ baseUrl: 'u', apiKey: 'k', model: 'm' } as any, [] as any, {
    stage: 'target',
  });
  assert.equal(controller.current(), 2);
});
