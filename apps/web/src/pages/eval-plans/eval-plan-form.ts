import type { EvalPlanInput, EvalPlanItem, EvalPlanTemplate } from '@/lib/api';

/** 与后端 eval-plans 默认值一致：最小间隔默认 60 分钟，允许 5 分钟～31 天。 */
export const DEFAULT_MIN_INTERVAL_MINUTES = 60;
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 60 * 24 * 31;
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';
/** 规则判定与敏感信息为内置引擎，始终启用（与发起评估任务一致）。 */
export const REQUIRED_ENGINES = ['rule-judge', 'sensitive-info'];

export const CRON_PRESETS: Array<{ value: string; label: string }> = [
  { value: '0 2 * * *', label: '每天 02:00' },
  { value: '0 2 * * 1-5', label: '每个工作日 02:00' },
  { value: '0 3 * * 1', label: '每周一 03:00' },
  { value: '0 */6 * * *', label: '每 6 小时（第 0 分）' },
  { value: '0 4 1 * *', label: '每月 1 日 04:00' },
];

export interface PlanFormState {
  name: string;
  description: string;
  targetId: string;
  questionSetIds: string[];
  engines: string[];
  concurrency: string;
  sampleSize: string;
  cron: string;
  timezone: string;
  minIntervalMinutes: string;
  enabled: boolean;
}

export function planToForm(p?: EvalPlanItem | null): PlanFormState {
  const t: Partial<EvalPlanTemplate> = p?.templateParams ?? {};
  return {
    name: p?.name ?? '',
    description: p?.description ?? '',
    targetId: p?.targetId ?? '',
    questionSetIds: t.questionSetIds ?? [],
    engines: t.engines ?? [...REQUIRED_ENGINES],
    concurrency: String(t.concurrency ?? 4),
    sampleSize: t.sampleSize ? String(t.sampleSize) : '',
    cron: p?.cron ?? CRON_PRESETS[0]!.value,
    timezone: p?.timezone ?? DEFAULT_TIMEZONE,
    minIntervalMinutes: String(p?.minIntervalMinutes ?? DEFAULT_MIN_INTERVAL_MINUTES),
    enabled: p?.enabled ?? true,
  };
}

/**
 * 表单 → 接口入参；返回字符串表示校验失败（最终以后端校验为准）。
 * 编辑时保留原模板里表单未展示的字段（如抽样种子），保证同一计划各次运行抽到同一批题目。
 */
export function planFormToInput(
  f: PlanFormState,
  previous?: EvalPlanTemplate,
): EvalPlanInput | string {
  if (!f.name.trim()) return '请填写计划名称';
  if (!f.targetId) return '请选择评估对象';
  if (f.questionSetIds.length === 0) return '请至少选择一个样本库';
  if (f.cron.trim().split(/\s+/).length !== 5) return 'cron 表达式应为 5 段：分 时 日 月 周';
  const concurrency = Number(f.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    return '并发数应为 1–32 的整数';
  }
  const minInterval = Number(f.minIntervalMinutes);
  if (
    !Number.isInteger(minInterval) ||
    minInterval < MIN_INTERVAL_MINUTES ||
    minInterval > MAX_INTERVAL_MINUTES
  ) {
    return `最小间隔应为 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 分钟的整数`;
  }
  let sampleSize: number | undefined;
  if (f.sampleSize.trim()) {
    sampleSize = Number(f.sampleSize);
    if (!Number.isInteger(sampleSize) || sampleSize < 1) return '抽样题数应为正整数';
  }
  const templateParams: EvalPlanTemplate = {
    ...(previous ?? {}),
    questionSetIds: f.questionSetIds,
    engines: [...new Set([...REQUIRED_ENGINES, ...f.engines])],
    concurrency,
  };
  if (sampleSize) {
    // 抽样题数变了就换新种子（后端自动生成），没变沿用旧种子。
    if (previous?.sampleSize !== sampleSize) delete templateParams.sampleSeed;
    templateParams.sampleSize = sampleSize;
  } else {
    delete templateParams.sampleSize;
    delete templateParams.sampleSeed;
  }
  return {
    name: f.name.trim(),
    description: f.description.trim() || null,
    targetId: f.targetId,
    cron: f.cron.trim(),
    timezone: f.timezone.trim() || DEFAULT_TIMEZONE,
    minIntervalMinutes: minInterval,
    enabled: f.enabled,
    templateParams,
  };
}
