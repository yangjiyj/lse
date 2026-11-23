import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScenarioScheduler, ScheduleOutcome } from '../src/modules/red-team/scenario-scheduler.js';

// ScenarioScheduler：红队场景调度队列（替代 cursor 线性认领 + 递归 sleep）。
//   - next(now)：取下一个 ready 的场景；冷却未到的跳过（但不阻塞，返回 busy 让 worker 去做别的或退出）。
//   - markDone(id)：场景完成，移除。
//   - rescheduleOnce(id, readyAt)：RetryExhausted 时把场景放回（仅一次；第二次返回 false）。
//   - 支持取消（abort 清空）。
// worker 协议：next() 返回 {outcome:'ready', question} / {outcome:'pending', readyAt}（还有冷却中的）/ {outcome:'done'}。

test('初始有 N 个 ready 场景，next 依次取出', () => {
  const now = 1000;
  const s = new ScenarioScheduler([{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }] as any, () => now);
  const r1 = s.next();
  assert.equal(r1.outcome, 'ready');
  assert.equal((r1 as any).question.id, 'q1');
  const r2 = s.next();
  assert.equal(r2.outcome, 'ready');
  assert.equal((r2 as any).question.id, 'q2');
});

test('rescheduleOnce：RetryExhausted 放回队列，仅允许一次', () => {
  const s = new ScenarioScheduler([{ id: 'q1' }] as any, () => 1000);
  const n = s.next();
  assert.equal(n.outcome, 'ready');
  // 第一次延后：成功
  const ok = s.rescheduleOnce('q1', 1000 + 15000);
  assert.equal(ok, true);
  // 第二次延后：拒绝
  const ok2 = s.rescheduleOnce('q1', 1000 + 30000);
  assert.equal(ok2, false);
});

test('延后场景冷却未到：next 返回 pending（worker 不空等）', () => {
  let now = 1000;
  const s = new ScenarioScheduler([{ id: 'q1' }] as any, () => now);
  s.next(); // 取出 q1
  s.rescheduleOnce('q1', 1000 + 15000); // readyAt=16000
  now = 5000; // 冷却未到
  const r = s.next();
  assert.equal(r.outcome, 'pending');
  assert.equal((r as any).readyAt, 16000);
});

test('冷却到期：next 再次返回 ready，且是全新执行（不复用状态）', () => {
  let now = 1000;
  const s = new ScenarioScheduler([{ id: 'q1' }] as any, () => now);
  s.next();
  s.rescheduleOnce('q1', 16000);
  now = 16000;
  const r = s.next();
  assert.equal(r.outcome, 'ready');
  assert.equal((r as any).question.id, 'q1');
});

test('所有场景完成：next 返回 done', () => {
  const s = new ScenarioScheduler([{ id: 'q1' }, { id: 'q2' }] as any, () => 0);
  s.next();
  s.markDone('q1');
  s.next();
  s.markDone('q2');
  assert.equal(s.next().outcome, 'done');
});

test('延后场景未冷却完时，其他 ready 场景仍可被取（不互相阻塞）', () => {
  let now = 1000;
  const s = new ScenarioScheduler([{ id: 'q1' }, { id: 'q2' }] as any, () => now);
  s.next(); // q1
  s.rescheduleOnce('q1', 16000);
  now = 5000;
  // q1 冷却中，但 q2 ready
  const r = s.next();
  assert.equal(r.outcome, 'ready');
  assert.equal((r as any).question.id, 'q2');
});

test('abort：清空队列，next 返回 done', () => {
  const s = new ScenarioScheduler([{ id: 'q1' }] as any, () => 0);
  s.abort();
  assert.equal(s.next().outcome, 'done');
});

test('延后场景仍在队列时，done 不提前返回（要等冷却或 abort）', () => {
  let now = 1000;
  const s = new ScenarioScheduler([{ id: 'q1' }] as any, () => now);
  s.next();
  s.rescheduleOnce('q1', 16000);
  now = 5000;
  // 只剩 q1 在冷却，没别的可做，但还没 done（要等 q1 冷却）
  assert.equal(s.next().outcome, 'pending');
});
