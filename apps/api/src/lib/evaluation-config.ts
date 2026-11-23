import { z } from 'zod';
import {
  DEFAULT_EVAL_WEIGHTS,
  EVAL_SCORE_COMPONENTS,
  EVAL_WEIGHT_DIMENSIONS,
  isWeightSum100,
} from '@lse/shared';

/** 配置管理（systemSetting key = 'evaluation'）：评测维度权重占比、单次评测题数、评测分数权重占比。 */
export const EVALUATION_SETTING_KEY = 'evaluation';
export const DEFAULT_QUESTION_COUNT = 80;

const pct = z.coerce.number().min(0).max(100);

const dimensionWeightsSchema = z
  .object(
    Object.fromEntries(EVAL_WEIGHT_DIMENSIONS.map((d) => [d, pct])) as Record<
      (typeof EVAL_WEIGHT_DIMENSIONS)[number],
      typeof pct
    >,
  )
  .refine(isWeightSum100, { message: '评测维度权重占比合计必须为 100%' });

const scoreWeightsSchema = z
  .object(
    Object.fromEntries(EVAL_SCORE_COMPONENTS.map((c) => [c, pct])) as Record<
      (typeof EVAL_SCORE_COMPONENTS)[number],
      typeof pct
    >,
  )
  .refine(isWeightSum100, { message: '评测分数权重占比合计必须为 100%' });

export const evaluationSchema = z.object({
  dimensionWeights: dimensionWeightsSchema,
  /** 单次评测题数：发起内容安全评估（标准评估）时的默认样本数。 */
  questionCount: z.coerce.number().int().min(1).max(2000),
  scoreWeights: scoreWeightsSchema,
});

export type EvaluationSettings = z.infer<typeof evaluationSchema>;

export const DEFAULT_EVALUATION_SETTINGS: EvaluationSettings = {
  dimensionWeights: { ...DEFAULT_EVAL_WEIGHTS.dimensionWeights },
  questionCount: DEFAULT_QUESTION_COUNT,
  scoreWeights: { ...DEFAULT_EVAL_WEIGHTS.scoreWeights },
};

export function parseStoredEvaluation(value: unknown): EvaluationSettings {
  const stored =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<EvaluationSettings>)
      : {};
  const parsed = evaluationSchema.safeParse({ ...DEFAULT_EVALUATION_SETTINGS, ...stored });
  return parsed.success ? parsed.data : DEFAULT_EVALUATION_SETTINGS;
}

/** PATCH 时整体合并后校验（权重必须整组提交合计 100%）。 */
export function mergeEvaluation(
  current: EvaluationSettings,
  patch: Partial<EvaluationSettings>,
): EvaluationSettings {
  return evaluationSchema.parse({ ...current, ...patch });
}
