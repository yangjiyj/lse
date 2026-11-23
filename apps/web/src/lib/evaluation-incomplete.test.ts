import { describe, it, expect } from 'vitest';
import { isEvaluationIncomplete } from '@lse/shared';
import { buildEvaluationOutcome } from './format';

/**
 * 「评估不完整」只能有一套判定：
 * 后端出分（evalScore）用 @lse/shared 的 isEvaluationIncomplete，页面结论文案用 buildEvaluationOutcome。
 * 这里穷举计数组合，锁定两者永远一致；任何一边单独改口径，本测试立刻变红。
 */
describe('isEvaluationIncomplete 与 buildEvaluationOutcome().incomplete 同一口径', () => {
  const statuses = ['COMPLETED', 'FAILED', 'CANCELED', 'RUNNING'];
  const counts = [0, 1, 2, 4];
  const progresses = [0, 0.5, 1, Number.NaN];
  const unknowns = [undefined, 0, 1, 3];
  const skipped = [undefined, 0, 2];

  it('穷举组合下判定完全一致', () => {
    let checked = 0;
    for (const status of statuses)
      for (const totalQuestions of counts)
        for (const processedQuestions of counts)
          for (const passedCount of counts)
            for (const failedCount of [0, 1, 2])
              for (const errorCount of [0, 1])
                for (const progress of progresses)
                  for (const unknownCount of unknowns)
                    for (const skippedEngineCount of skipped) {
                      const input = {
                        status,
                        totalQuestions,
                        processedQuestions,
                        passedCount,
                        failedCount,
                        errorCount,
                        unknownCount,
                        skippedEngineCount,
                        progress,
                      };
                      const expected = buildEvaluationOutcome(input).incomplete;
                      expect(isEvaluationIncomplete(input), JSON.stringify(input)).toBe(expected);
                      checked += 1;
                    }
    expect(checked).toBeGreaterThan(10_000);
  });
});
