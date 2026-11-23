import { classifyEvalTask, type EvalTaskCategory } from './task-category.js';

/**
 * 检测类别：客户需求的五类（模型、数据、内容、应用与环境、保密）去掉保密，保密检测暂不做。
 * 工具中心的工具分类、检测任务分类、首页风险统计共用这一套口径。
 */
export const DETECT_CATEGORIES = ['model', 'data', 'content', 'app_env'] as const;

export type DetectCategory = (typeof DETECT_CATEGORIES)[number];

export const DETECT_CATEGORY_LABELS: Record<DetectCategory, string> = {
  model: '模型安全',
  data: '数据安全',
  content: '内容安全',
  app_env: '应用与环境安全',
};

/** 各类检测记录（按所在的表）归到哪一类；eval_task 再按任务类型细分，见 detectCategoryOfEvalTask。 */
export const DETECT_RECORD_KINDS = {
  eval_task: 'content',
  batch_evaluation: 'content',
  standard_run: 'content',
  rag_eval: 'content',
  model_file_scan: 'model',
  corpus_scan: 'data',
  asset_discovery: 'app_env',
  service_assurance: 'app_env',
  ai_component_scan: 'app_env',
  fleet_eval_job: 'app_env',
} as const satisfies Record<string, DetectCategory>;

export type DetectRecordKind = keyof typeof DETECT_RECORD_KINDS;

/** 智能体安全评测测的是应用本身，归应用与环境；其余评估任务都是内容安全。 */
const EVAL_TASK_DETECT_CATEGORY: Record<EvalTaskCategory, DetectCategory> = {
  redteam: 'content',
  content: 'content',
  standard: 'content',
  agent: 'app_env',
  comprehensive: 'content',
  gateway: 'content',
  assurance: 'content',
  regression: 'content',
};

export function detectCategoryOfEvalTask(task: {
  engines: readonly string[];
  dimensions: readonly string[];
}): DetectCategory {
  return EVAL_TASK_DETECT_CATEGORY[classifyEvalTask(task)];
}

export function isDetectCategory(value: unknown): value is DetectCategory {
  return typeof value === 'string' && (DETECT_CATEGORIES as readonly string[]).includes(value);
}
