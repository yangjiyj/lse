import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RED_TEAM_DEFAULT_SAMPLE_COUNT,
  selectRedTeamQuestions,
} from '../src/modules/red-team/seed-sampler.js';

function buildQuestion(objectiveId: string, variant: string, index: number) {
  return {
    id: `${objectiveId}-${variant}-${index}`,
    content: `${objectiveId} / ${variant}`,
    metadata: {
      kind: 'red_team',
      redteam: {
        objectiveId,
        variant,
        seedPack: 'test:red-team',
      },
    },
  };
}

const objectives = ['obj-a', 'obj-b', 'obj-c', 'obj-d', 'obj-e', 'obj-f'];
const questions = objectives.flatMap((objectiveId, index) => [
  buildQuestion(objectiveId, 'direct', index),
  buildQuestion(objectiveId, 'stepwise', index),
]);

test('红队种子抽样：默认抽 4 个风险目标，并在目标内随机抽变体', () => {
  const first = selectRedTeamQuestions(questions, { seed: 'stable-redteam-seed' });
  const second = selectRedTeamQuestions(questions, { seed: 'stable-redteam-seed' });
  const another = selectRedTeamQuestions(questions, { seed: 'another-redteam-seed' });

  assert.equal(first.length, RED_TEAM_DEFAULT_SAMPLE_COUNT);
  assert.deepEqual(
    first.map((item) => item.question.id),
    second.map((item) => item.question.id),
    '同一 seed 应可复现，方便审计复盘',
  );
  assert.notDeepEqual(
    first.map((item) => item.question.id),
    another.map((item) => item.question.id),
    '不同 seed 应产生不同抽样，避免每次都是固定前 4 道',
  );

  const objectiveIds = new Set(first.map((item) => item.objectiveKey));
  assert.equal(objectiveIds.size, RED_TEAM_DEFAULT_SAMPLE_COUNT);
  const variants = new Set(first.map((item) => item.variant));
  assert.ok(variants.size > 1, `应覆盖多个攻击变体，实际为 ${[...variants].join(',')}`);
});

test('红队种子抽样：候选顺序变化时仍保证抽样覆盖多个显式变体', () => {
  const selected = selectRedTeamQuestions(questions, { seed: 'flaky-9' });
  assert.ok(
    new Set(selected.map((item) => item.variant)).size > 1,
    '同一 seed 不应因候选顺序漂移而退化为单一攻击变体',
  );
});

test('红队种子抽样：objectiveIds 白名单只在选定风险目标内抽样', () => {
  const selected = selectRedTeamQuestions(questions, {
    seed: 'dir-seed',
    sampleCount: 10,
    objectiveIds: ['obj-a', 'obj-b'],
  });
  assert.ok(selected.length > 0);
  assert.ok(
    selected.every((item) => ['obj-a', 'obj-b'].includes(item.objectiveKey)),
    `应只抽中白名单目标，实际 ${selected.map((i) => i.objectiveKey).join(',')}`,
  );
});

test('红队种子抽样：objectiveIds 无匹配时回落到全量，避免空结果', () => {
  const selected = selectRedTeamQuestions(questions, {
    seed: 'dir-seed',
    objectiveIds: ['nonexistent-objective'],
  });
  assert.equal(selected.length, RED_TEAM_DEFAULT_SAMPLE_COUNT);
});

test('红队种子抽样：preferVariants 优先选用方向链路里的攻击变体', () => {
  // 6 个目标，每个目标都有 direct/stepwise 两种变体；抽满 6 个目标时
  // 一目标一题的主抽样应全部命中 stepwise（不触发跨变体填充）。
  const selected = selectRedTeamQuestions(questions, {
    seed: 'prefer-seed',
    sampleCount: 6,
    preferVariants: ['stepwise'],
  });
  assert.equal(selected.length, 6);
  assert.ok(
    selected.every((item) => item.variant === 'stepwise'),
    `应优先选用 stepwise 变体，实际 ${selected.map((i) => i.variant).join(',')}`,
  );
});

test('红队种子抽样：没有内置变体的自定义种子也会分配随机变体', () => {
  const custom = Array.from({ length: 6 }, (_, index) => ({
    id: `custom-${index}`,
    content: `客户自定义红队种子 ${index}`,
    metadata: { kind: 'red_team', redteam: { objectiveId: `custom-${index}` } },
  }));

  const selected = selectRedTeamQuestions(custom, { seed: 'custom-seed' });

  assert.equal(selected.length, RED_TEAM_DEFAULT_SAMPLE_COUNT);
  assert.equal(
    selected.every((item) => Boolean(item.variant)),
    true,
  );
  assert.ok(new Set(selected.map((item) => item.variant)).size > 1);
});
