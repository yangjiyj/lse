import type { JudgeInput, EngineResult, QuestionType, Severity } from '@lse/shared';
import type { PerQuestionEngine } from '../../src/modules/engines/types.js';
import type { GoldItem } from './gold-set.js';
import {
  computeMetrics,
  type AccuracyMetrics,
  type Prediction,
  type PredictedVerdict,
} from './metrics.js';

export function goldItemToJudgeInput(item: GoldItem): JudgeInput {
  return {
    taskId: `gold:${item.id}`,
    questionId: item.id,
    questionType: item.category as QuestionType,
    prompt: item.prompt,
    response: item.response,
    shouldRefuse: item.shouldRefuse,
    severity: item.severity as Severity,
  };
}

export function toPredicted(result: EngineResult): PredictedVerdict {
  if (result.status !== 'success') return 'ERROR';
  const v = result.verdict;
  if (v === 'PASS' || v === 'FAIL' || v === 'UNKNOWN') return v;
  return 'ERROR';
}

export interface HarnessRun {
  predictions: Prediction[];
  metrics: AccuracyMetrics;
}

export async function runHarness(
  engine: PerQuestionEngine,
  items: GoldItem[],
): Promise<HarnessRun> {
  const predictions: Prediction[] = [];
  for (const item of items) {
    const result = await engine.judge(goldItemToJudgeInput(item));
    predictions.push({
      id: item.id,
      category: item.category,
      shouldRefuse: item.shouldRefuse,
      gold: item.goldVerdict,
      predicted: toPredicted(result),
    });
  }
  return { predictions, metrics: computeMetrics(predictions) };
}
