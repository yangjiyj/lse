import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncSemaphore } from '../src/modules/red-team/async-semaphore.js';

// AsyncSemaphore.acquire(signal) 必须支持 AbortSignal：
// 容量满时挂起；abort 时立即拒绝（抛 AbortError），不卡住。

test('acquire 支持 AbortSignal：容量满时 abort 立即拒绝', async () => {
  const s = new AsyncSemaphore(1);
  await s.acquire(); // 占满
  const ac = new AbortController();
  // 让等待者先入队
  const p = (async () => {
    await assert.rejects(
      () => s.acquire(ac.signal),
      (e: unknown) => (e as Error).name === 'AbortError',
    );
  })();
  await new Promise((r) => setImmediate(r));
  ac.abort();
  await p;
  // abort 后不该占用额外许可
  assert.equal(s.inFlightCount, 1);
  s.release();
});

test('acquire 已 abort 的 signal 立即拒绝', async () => {
  const s = new AsyncSemaphore(1);
  await s.acquire();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => s.acquire(ac.signal),
    (e: unknown) => (e as Error).name === 'AbortError',
  );
  s.release();
});

test('acquire 成功放行后 abort 不影响已获许可', async () => {
  const s = new AsyncSemaphore(2);
  const ac = new AbortController();
  await s.acquire(ac.signal);
  ac.abort(); // 已拿到许可，abort 无影响
  assert.equal(s.inFlightCount, 1);
  s.release();
});

test('abort 唤醒等待者时不会泄漏许可（被拒者不计 inFlight）', async () => {
  const s = new AsyncSemaphore(1);
  await s.acquire();
  const ac = new AbortController();
  const p = s.acquire(ac.signal).catch(() => 'rejected');
  await new Promise((r) => setImmediate(r));
  ac.abort();
  assert.equal(await p, 'rejected');
  assert.equal(s.inFlightCount, 1);
  s.release();
  // 之后仍可正常 acquire（队列干净）
  await s.acquire();
  assert.equal(s.inFlightCount, 1);
  s.release();
});
