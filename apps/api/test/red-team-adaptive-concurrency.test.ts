import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveConcurrency } from '../src/modules/red-team/adaptive-concurrency.js';

// AdaptiveConcurrency：任务级 AIMD 并发控制器。
//   - 初始有效并发 = 用户配置上限 maxConcurrency。
//   - retryable 错误 onError() 立即减半，最低 1：4->2->1，3->1。
//   - 连续 SUCCESS_THRESHOLD(8) 次成功 onSuccess() 后 +1，封顶 maxConcurrency。
//   - current() 读当前有效并发；onError/onSuccess 返回 {previous,effective,reason} 供日志。

test('初始有效并发等于配置上限', () => {
  const c = new AdaptiveConcurrency(4);
  assert.equal(c.current(), 4);
});

test('并发 4 遇 retryable 错误降到 2，再遇降到 1', () => {
  const c = new AdaptiveConcurrency(4);
  const r1 = c.onError();
  assert.equal(c.current(), 2);
  assert.equal(r1.previous, 4);
  assert.equal(r1.effective, 2);
  const r2 = c.onError();
  assert.equal(c.current(), 1);
  assert.equal(r2.previous, 2);
  assert.equal(r2.effective, 1);
});

test('并发降到 1 后再遇错误保持 1（最低不低于 1）', () => {
  const c = new AdaptiveConcurrency(4);
  c.onError(); // 2
  c.onError(); // 1
  const r = c.onError(); // 仍 1
  assert.equal(c.current(), 1);
  assert.equal(r.effective, 1);
});

test('并发 3 遇错误直接降到 1（3/2 向下取整=1）', () => {
  const c = new AdaptiveConcurrency(3);
  c.onError();
  assert.equal(c.current(), 1);
});

test('连续 8 次成功后并发从 1 升到 2，但不超过配置上限', () => {
  const c = new AdaptiveConcurrency(4);
  c.onError(); // 4 -> 2
  c.onError(); // 2 -> 1
  for (let i = 0; i < 7; i++) {
    const r = c.onSuccess();
    assert.equal(r.recovered, false); // 前 7 次未达阈值
  }
  const r8 = c.onSuccess(); // 第 8 次：触发 +1
  assert.equal(c.current(), 2);
  assert.equal(r8.recovered, true);
  assert.equal(r8.effective, 2);
});

test('升并发封顶不超过 maxConcurrency', () => {
  const c = new AdaptiveConcurrency(2);
  // 不降并发，直接连续成功尝试越界
  for (let i = 0; i < 30; i++) c.onSuccess();
  assert.equal(c.current(), 2); // 永不超过 2
});

test('成功但未连续满 8 次时被打断（中间一次错误），计数清零', () => {
  const c = new AdaptiveConcurrency(4);
  c.onError(); // -> 2
  for (let i = 0; i < 5; i++) c.onSuccess(); // 连续 5 次
  c.onError(); // 打断，重新清零，且 2 -> 1
  assert.equal(c.current(), 1);
  for (let i = 0; i < 7; i++) c.onSuccess(); // 再连续 7 次（<8）
  assert.equal(c.current(), 1); // 未升
  c.onSuccess(); // 第 8 次
  assert.equal(c.current(), 2);
});

test('maxConcurrency 下限钳制为 1', () => {
  const c = new AdaptiveConcurrency(0);
  assert.equal(c.current(), 1);
  const c2 = new AdaptiveConcurrency(-3);
  assert.equal(c2.current(), 1);
});

test('onError 返回 reason=decrease，onSuccess 恢复时 reason=increase 否则 steady', () => {
  const c = new AdaptiveConcurrency(4);
  assert.equal(c.onError().reason, 'decrease');
  // 在 1 上继续成功
  let recovered = null;
  for (let i = 0; i < 8 && !recovered; i++) {
    const r = c.onSuccess();
    if (r.recovered) recovered = r;
  }
  assert.ok(recovered);
  assert.equal(recovered!.reason, 'increase');
});
