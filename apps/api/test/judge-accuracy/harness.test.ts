import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EngineResult, JudgeInput } from '@lse/shared';
import type { PerQuestionEngine } from '../../src/modules/engines/types.js';
import type { GoldItem } from './gold-set.js';
import { goldItemToJudgeInput, toPredicted, runHarness } from './harness.js';

const ITEMS: GoldItem[] = [
  {
    id: 'g1',
    category: 'SHOULD_REFUSE',
    severity: 'HIGH',
    prompt: 'p1',
    response: 'r1',
    goldVerdict: 'FAIL',
    shouldRefuse: true,
    source: 'wrong_answer',
  },
  {
    id: 'g2',
    category: 'COMPLIANCE',
    severity: 'LOW',
    prompt: 'p2',
    response: 'r2',
    goldVerdict: 'PASS',
    shouldRefuse: false,
    source: 'finding:FALSE_POSITIVE',
  },
  {
    id: 'g3',
    category: 'GENERAL',
    severity: 'MEDIUM',
    prompt: 'p3',
    response: 'r3',
    goldVerdict: 'FAIL',
    shouldRefuse: false,
    source: 'finding:CONFIRMED',
  },
];

function fakeEngine(
  specs: Record<string, { verdict: EngineResult['verdict']; status?: EngineResult['status'] }>,
): PerQuestionEngine {
  return {
    engine: 'fake',
    async judge(input: JudgeInput): Promise<EngineResult> {
      const spec = specs[input.questionId] ?? { verdict: 'UNKNOWN' as const };
      return {
        engine: 'fake',
        taskId: input.taskId,
        questionId: input.questionId,
        status: spec.status ?? 'success',
        riskCategory: '',
        severity: 'INFO',
        score: null,
        verdict: spec.verdict,
        evidence: null,
        rawOutput: null,
        startedAt: '2026-06-16T00:00:00.000Z',
        endedAt: '2026-06-16T00:00:00.000Z',
      };
    },
  };
}

test('goldItemToJudgeInput：字段映射', () => {
  const input = goldItemToJudgeInput(ITEMS[0]);
  assert.equal(input.taskId, 'gold:g1');
  assert.equal(input.questionId, 'g1');
  assert.equal(input.questionType, 'SHOULD_REFUSE');
  assert.equal(input.prompt, 'p1');
  assert.equal(input.response, 'r1');
  assert.equal(input.shouldRefuse, true);
  assert.equal(input.severity, 'HIGH');
});

test('toPredicted：非 success → ERROR；success 透传 PASS/FAIL/UNKNOWN', () => {
  const base: EngineResult = {
    engine: 'fake',
    taskId: 't',
    questionId: 'q',
    status: 'failed',
    riskCategory: '',
    severity: 'INFO',
    score: null,
    verdict: 'PASS',
    evidence: null,
    rawOutput: null,
    startedAt: '',
    endedAt: '',
  };
  assert.equal(toPredicted(base), 'ERROR');
  assert.equal(toPredicted({ ...base, status: 'success', verdict: 'FAIL' }), 'FAIL');
  assert.equal(toPredicted({ ...base, status: 'success', verdict: 'PASS' }), 'PASS');
  assert.equal(toPredicted({ ...base, status: 'success', verdict: 'UNKNOWN' }), 'UNKNOWN');
});

test('runHarness：全对 → 一致率 1，无漏判误报', async () => {
  const engine = fakeEngine({
    g1: { verdict: 'FAIL' },
    g2: { verdict: 'PASS' },
    g3: { verdict: 'FAIL' },
  });
  const { predictions, metrics } = await runHarness(engine, ITEMS);
  assert.equal(predictions.length, 3);
  assert.equal(metrics.overall.total, 3);
  assert.equal(metrics.overall.agreement, 1);
  assert.equal(metrics.overall.fn, 0);
  assert.equal(metrics.overall.fp, 0);
});

test('runHarness：漏判 + 弃权各一', async () => {
  const engine = fakeEngine({
    g1: { verdict: 'PASS' }, // gold FAIL → 漏判 FN
    g2: { verdict: 'PASS' }, // gold PASS → 一致
    g3: { verdict: 'UNKNOWN' }, // gold FAIL → 弃权
  });
  const { metrics } = await runHarness(engine, ITEMS);
  assert.equal(metrics.overall.total, 3);
  assert.equal(metrics.overall.decided, 2);
  assert.equal(metrics.overall.abstained, 1);
  assert.equal(metrics.overall.fn, 1);
  assert.equal(metrics.overall.goldFail, 1); // g1 已判定；g3 弃权被排除
  assert.equal(metrics.overall.fnRate, 1);
  assert.equal(metrics.byCategory.SHOULD_REFUSE.fn, 1);
});
