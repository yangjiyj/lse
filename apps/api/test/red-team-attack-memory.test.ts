import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInMemoryAttackMemoryStore,
  shouldRememberAttack,
} from '../src/modules/red-team/attack-memory.js';

test('attack memory stores trusted broke attacks sorted by redLayerReward desc', async () => {
  const store = createInMemoryAttackMemoryStore();

  await store.remember({
    objectiveId: 'obj-1',
    guardFingerprint: 'bare',
    playbookVariant: 'low',
    moveSequence: ['academic_wrap'],
    brokenLayers: ['content'],
    redLayerReward: 0.5,
    ts: '2026-06-21T00:00:00.000Z',
  });
  await store.remember({
    objectiveId: 'obj-1',
    guardFingerprint: 'bare',
    playbookVariant: 'high',
    moveSequence: ['foot_in_door', 'shell_swap'],
    brokenLayers: ['content', 'action'],
    redLayerReward: 1,
    ts: '2026-06-21T00:01:00.000Z',
  });

  const rows = await store.byObjective('obj-1', { guardFingerprint: 'bare' });
  assert.deepEqual(
    rows.map((row) => row.playbookVariant),
    ['high', 'low'],
  );
  assert.deepEqual(
    rows.map((row) => row.redLayerReward),
    [1, 0.5],
  );
});

test('attack memory byObjective returns top-K in reward order', async () => {
  const store = createInMemoryAttackMemoryStore();
  for (const [playbookVariant, redLayerReward] of [
    ['third', 0.25],
    ['first', 1],
    ['second', 0.5],
  ] as const) {
    await store.remember({
      objectiveId: 'obj-1',
      guardFingerprint: 'gw:target-1',
      playbookVariant,
      moveSequence: ['academic_wrap'],
      brokenLayers: ['content'],
      redLayerReward,
      ts: `2026-06-21T00:00:0${redLayerReward * 4}.000Z`,
    });
  }

  const rows = await store.byObjective('obj-1', {
    guardFingerprint: 'gw:target-1',
    limit: 2,
  });
  assert.deepEqual(
    rows.map((row) => row.playbookVariant),
    ['first', 'second'],
  );
});

test('shouldRememberAttack rejects UNKNOWN, non-broke, null reward, and execution-noise cases', () => {
  assert.equal(
    shouldRememberAttack({
      broke: true,
      verdict: 'FAIL',
      redLayerReward: 1,
      executionNoise: false,
      objectiveId: 'obj-1',
    }),
    true,
  );
  assert.equal(
    shouldRememberAttack({
      broke: true,
      verdict: 'UNKNOWN',
      redLayerReward: 1,
      executionNoise: false,
      objectiveId: 'obj-1',
    }),
    false,
  );
  assert.equal(
    shouldRememberAttack({
      broke: false,
      verdict: 'FAIL',
      redLayerReward: 1,
      executionNoise: false,
      objectiveId: 'obj-1',
    }),
    false,
  );
  assert.equal(
    shouldRememberAttack({
      broke: true,
      verdict: 'FAIL',
      redLayerReward: null,
      executionNoise: false,
      objectiveId: 'obj-1',
    }),
    false,
  );
  assert.equal(
    shouldRememberAttack({
      broke: true,
      verdict: 'FAIL',
      redLayerReward: 1,
      executionNoise: true,
      objectiveId: 'obj-1',
    }),
    false,
  );
});

test('attack memory deduplicates same key by keeping the highest reward and latest timestamp', async () => {
  const store = createInMemoryAttackMemoryStore();
  const base = {
    objectiveId: 'obj-1',
    guardFingerprint: 'bare',
    playbookVariant: 'same',
    moveSequence: ['academic_wrap', 'foot_in_door'] as const,
    brokenLayers: ['content'] as const,
  };

  await store.remember({
    ...base,
    redLayerReward: 0.6,
    ts: '2026-06-21T00:00:00.000Z',
  });
  await store.remember({
    ...base,
    redLayerReward: 0.4,
    ts: '2026-06-21T00:01:00.000Z',
  });
  await store.remember({
    ...base,
    brokenLayers: ['content', 'action'],
    redLayerReward: 1,
    ts: '2026-06-21T00:02:00.000Z',
  });

  const rows = await store.byObjective('obj-1', { guardFingerprint: 'bare' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.redLayerReward, 1);
  assert.equal(rows[0]?.ts, '2026-06-21T00:02:00.000Z');
  assert.deepEqual(rows[0]?.brokenLayers, ['content', 'action']);
});
