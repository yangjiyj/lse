import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryAttackMemoryStore } from '../src/modules/red-team/attack-memory.js';
import { ALL_MOVE_IDS } from '../src/modules/red-team/moves.js';
import { buildRedTeamPlaybook } from '../src/modules/red-team/playbooks.js';
import type { AttackMoveId, RedTeamSeed } from '../src/modules/red-team/types.js';

function buildSeed(overrides: Partial<RedTeamSeed['redteam']> = {}): RedTeamSeed {
  return {
    questionId: 'q-1',
    content: 'test objective',
    category: null,
    expectedBehavior: null,
    referenceAnswer: null,
    shouldRefuse: true,
    severity: null,
    questionType: 'PROMPT_INJECTION',
    redteam: {
      objectiveId: 'obj-1',
      variant: 'direct',
      seedPack: 'test:red-team',
      ...overrides,
    },
  };
}

function fixedRng(values: number[]) {
  let index = 0;
  return {
    next() {
      const value = values[index] ?? values[values.length - 1] ?? 0;
      index += 1;
      return value;
    },
    int(maxExclusive: number) {
      return Math.min(Math.floor(this.next() * maxExclusive), maxExclusive - 1);
    },
    pick<T>(arr: readonly T[]): T {
      return arr[this.int(arr.length)]!;
    },
    shuffle<T>(arr: readonly T[]): T[] {
      return [...arr];
    },
  };
}

test('buildRedTeamPlaybook seeds from top attack memory route and mutates one move', async () => {
  const attackMemory = createInMemoryAttackMemoryStore();
  await attackMemory.remember({
    objectiveId: 'obj-1',
    guardFingerprint: 'bare',
    playbookVariant: 'low',
    moveSequence: ['academic_wrap'],
    brokenLayers: ['content'],
    redLayerReward: 0.2,
    ts: '2026-06-21T00:00:00.000Z',
  });
  await attackMemory.remember({
    objectiveId: 'obj-1',
    guardFingerprint: 'bare',
    playbookVariant: 'stepwise',
    moveSequence: ['foot_in_door', 'stepwise_decompose', 'academic_wrap'],
    brokenLayers: ['content', 'action'],
    redLayerReward: 1,
    ts: '2026-06-21T00:01:00.000Z',
  });

  const playbook = await buildRedTeamPlaybook(buildSeed(), ALL_MOVE_IDS, {
    attackMemory,
    rng: fixedRng([0, 0.01, 0.99]),
  });

  assert.equal(playbook.variant, 'stepwise');
  assert.equal(playbook.objectiveId, 'obj-1');
  assert.equal(playbook.phases.length, 3);
  assert.deepEqual(
    playbook.phases.map((phase) => phase.move),
    ['identity_spoof', 'stepwise_decompose', 'academic_wrap'],
  );
});

test('buildRedTeamPlaybook memory mutation keeps moves inside allowed set', async () => {
  const attackMemory = createInMemoryAttackMemoryStore();
  await attackMemory.remember({
    objectiveId: 'obj-1',
    guardFingerprint: 'bare',
    playbookVariant: 'stepwise',
    moveSequence: ['foot_in_door', 'stepwise_decompose', 'academic_wrap'],
    brokenLayers: ['content'],
    redLayerReward: 1,
    ts: '2026-06-21T00:00:00.000Z',
  });

  const allowedMoves: AttackMoveId[] = ['academic_wrap', 'shell_swap'];
  const playbook = await buildRedTeamPlaybook(buildSeed(), allowedMoves, {
    attackMemory,
    rng: fixedRng([0.99, 0.01, 0.99, 0.01]),
  });

  assert.equal(
    playbook.phases.every((phase) => allowedMoves.includes(phase.move)),
    true,
  );
});

test('buildRedTeamPlaybook falls back to existing seed variant when memory misses', async () => {
  const attackMemory = createInMemoryAttackMemoryStore();

  const withMemoryMiss = await buildRedTeamPlaybook(
    buildSeed({ variant: 'roleplay' }),
    ALL_MOVE_IDS,
    {
      attackMemory,
      rng: fixedRng([0]),
    },
  );
  const withoutMemory = await buildRedTeamPlaybook(
    buildSeed({ variant: 'roleplay' }),
    ALL_MOVE_IDS,
  );

  assert.deepEqual(withMemoryMiss, withoutMemory);
});
