import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncSemaphore } from '../src/modules/red-team/async-semaphore.js';

// AsyncSemaphore：动态容量信号量，用于把 AdaptiveConcurrency 的有效并发
// 落到 executor pump 的真实并发上。
//   - acquire() 超过容量时挂起，有空位才放行。
//   - release() 归还一个许可；若有等待者且容量允许则唤醒。
//   - setCapacity(n)：动态调整容量；下调时新 acquire 会被挡，直到 inFlight 降到新容量以内。
//   - 在 try/finally 里 acquire/release，绝不泄漏许可。

test('容量内 acquire 立即放行，计数正确', async () => {
  const s = new AsyncSemaphore(2);
  await s.acquire();
  await s.acquire();
  assert.equal(s.inFlightCount, 2);
  s.release();
  assert.equal(s.inFlightCount, 1);
  s.release();
  assert.equal(s.inFlightCount, 0);
});

test('超容量 acquire 阻塞，直到 release 唤醒', async () => {
  const s = new AsyncSemaphore(1);
  await s.acquire();
  let entered = false;
  const p = (async () => {
    await s.acquire();
    entered = true;
  })();
  await new Promise((r) => setImmediate(r));
  assert.equal(entered, false); // 容量满，被挡住
  s.release();
  await p;
  assert.equal(entered, true);
  assert.equal(s.inFlightCount, 1);
  s.release();
});

test('setCapacity 下调：后续 acquire 被挡，直到 inFlight 降到新容量内', async () => {
  const s = new AsyncSemaphore(4);
  // 占满 2 个
  await s.acquire();
  await s.acquire();
  assert.equal(s.inFlightCount, 2);
  s.setCapacity(2); // 下调到 2，当前 inFlight=2 已等于容量
  let entered = false;
  const p = (async () => {
    await s.acquire();
    entered = true;
  })();
  await new Promise((r) => setImmediate(r));
  assert.equal(entered, false); // 容量=2，inFlight=2，新 acquire 被挡
  s.release(); // inFlight=1 < 2
  await p;
  assert.equal(entered, true);
  s.release();
  s.release();
});

test('setCapacity 上调：挂起的等待者立即被唤醒', async () => {
  const s = new AsyncSemaphore(1);
  await s.acquire();
  let entered = false;
  const p = (async () => {
    await s.acquire();
    entered = true;
  })();
  await new Promise((r) => setImmediate(r));
  assert.equal(entered, false);
  s.setCapacity(3); // 上调，有富余容量
  await p;
  assert.equal(entered, true);
  s.release();
  s.release();
});

test('release 过量（防御）：计数不出现负数', async () => {
  const s = new AsyncSemaphore(2);
  await s.acquire();
  s.release();
  s.release(); // 多 release 一次
  assert.equal(s.inFlightCount, 0);
});
