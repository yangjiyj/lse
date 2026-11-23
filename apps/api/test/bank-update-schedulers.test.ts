import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Queue } from 'bullmq';
import { config } from '../src/config.js';
import {
  BANK_UPDATE_SCHEDULER_IDS,
  processBankUpdateJob,
  syncBankUpdateSchedulers,
  type BankUpdateJobData,
} from '../src/modules/question-sets/bank-updates/queue.js';

function fakeQueue() {
  const upserted: string[] = [];
  const removed: string[] = [];
  const q = {
    upsertJobScheduler: async (id: string) => void upserted.push(id),
    removeJobScheduler: async (id: string) => {
      removed.push(id);
      return true;
    },
  } as unknown as Queue<BankUpdateJobData>;
  return { q, upserted, removed };
}

test('自动更新默认关闭（题库随产品版本发布）', () => {
  assert.equal(config.BANK_AUTO_UPDATE_ENABLED, false);
});

test('关闭时不注册定时，并清掉以前注册过的每月出题、每周补词定时', async () => {
  const f = fakeQueue();
  assert.equal(await syncBankUpdateSchedulers(false, f.q), 'removed');
  assert.deepEqual(f.upserted, []);
  assert.deepEqual(f.removed.sort(), [BANK_UPDATE_SCHEDULER_IDS.keywords, BANK_UPDATE_SCHEDULER_IDS.questions].sort());
});

test('开启时照常注册两个定时', async () => {
  const f = fakeQueue();
  assert.equal(await syncBankUpdateSchedulers(true, f.q), 'registered');
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.upserted.sort(), [BANK_UPDATE_SCHEDULER_IDS.keywords, BANK_UPDATE_SCHEDULER_IDS.questions].sort());
});

test('关闭时队列里残留的定时任务不执行、不碰库', async () => {
  const neverDb = new Proxy({}, {
    get() {
      throw new Error('关闭时不应访问数据库');
    },
  }) as never;
  for (const kind of ['questions', 'keywords'] as const) {
    const r = await processBankUpdateJob(neverDb, { kind, trigger: 'schedule' }, { autoUpdateEnabled: false });
    assert.deepEqual(r, { status: 'skipped', reason: '自动更新未开启' });
  }
});
