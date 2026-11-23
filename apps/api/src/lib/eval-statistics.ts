/**
 * 评测可信度统计库（纯函数，无外部依赖）。
 *
 * 背景：自动判定器算出的失败率受样本量与判定器本身影响，单个百分比不足以支撑结论。
 * 这里提供：威尔逊置信区间、小样本警告、判定一致性（Cohen kappa）、
 * 二分类准确率/精确率/召回率，以及两组比例差异的保守显著性提示。
 */

/** 双侧 z 值：95% 与 99%。 */
const Z_BY_LEVEL = { 0.95: 1.959963984540054, 0.99: 2.5758293035489004 } as const;
export type ConfidenceLevel = keyof typeof Z_BY_LEVEL;

export interface ProportionInterval {
  /** 样本量 */
  n: number;
  /** 事件数 */
  successes: number;
  /** 点估计（0~1）；n=0 时为 null */
  proportion: number | null;
  /** 区间下限（0~1）；n=0 时为 null */
  lower: number | null;
  /** 区间上限（0~1）；n=0 时为 null */
  upper: number | null;
  level: ConfidenceLevel;
}

/** 小样本警告码。 */
export const SAMPLE_WARNING_CODES = ['NO_SAMPLE', 'TOO_FEW', 'FEW'] as const;
export type SampleWarningCode = (typeof SAMPLE_WARNING_CODES)[number];

export const SAMPLE_FEW_THRESHOLD = 30;
export const SAMPLE_TOO_FEW_THRESHOLD = 10;

function nonNegInt(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 威尔逊区间：小样本、比例接近 0 或 1 时比正态近似可靠。 */
export function wilsonInterval(
  successes: number,
  n: number,
  level: ConfidenceLevel = 0.95,
): ProportionInterval {
  const total = nonNegInt(n);
  const hit = Math.min(nonNegInt(successes), total);
  if (total === 0) {
    return { n: 0, successes: 0, proportion: null, lower: null, upper: null, level };
  }
  const z = Z_BY_LEVEL[level] ?? Z_BY_LEVEL[0.95];
  const p = hit / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return {
    n: total,
    successes: hit,
    proportion: p,
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
    level,
  };
}

/** 样本量警告：n=0 无样本；n<10 仅供参考；n<30 区间较宽；否则无警告。 */
export function sampleSizeWarning(n: number): { code: SampleWarningCode; message: string } | null {
  const total = nonNegInt(n);
  if (total === 0) return { code: 'NO_SAMPLE', message: '暂无有效样本，无法给出比例。' };
  if (total < SAMPLE_TOO_FEW_THRESHOLD) {
    return { code: 'TOO_FEW', message: '样本过少，仅供参考，不宜据此下结论。' };
  }
  if (total < SAMPLE_FEW_THRESHOLD) {
    return { code: 'FEW', message: '样本偏少，置信区间较宽，结论请谨慎使用。' };
  }
  return null;
}

export interface TaskVerdictCounts {
  passed: number;
  failed: number;
  /** 未判定（UNKNOWN）：判定器无法给出结论，不计为通过 */
  unknown: number;
  /** 执行异常（ERROR）：未得到有效回答，不进入比例分母 */
  error?: number;
}

export interface TaskStatistics {
  /** 有效样本量 = 通过 + 发现风险 + 未判定（不含执行异常） */
  sampleSize: number;
  failedCount: number;
  unknownCount: number;
  errorCount: number;
  /** 发现风险比例（失败率，0~1） */
  failRate: number | null;
  failRateLower: number | null;
  failRateUpper: number | null;
  /** 未判定占比（0~1） */
  unknownRate: number | null;
  confidenceLevel: ConfidenceLevel;
  warningCodes: SampleWarningCode[];
  warnings: string[];
  /** 区间含义的一句话说明，供界面与报告引用 */
  note: string;
}

export const STATISTICS_NOTE =
  '失败率区间表示在当前样本量下，真实失败率有 95% 的把握落在该范围内；样本越少，区间越宽。未判定项不计为通过，按有风险口径单独列出。';

/** 由任务计数生成统计摘要；不改变任何既有计数，仅做派生展示。 */
export function summarizeTaskStatistics(
  counts: TaskVerdictCounts,
  level: ConfidenceLevel = 0.95,
): TaskStatistics {
  const failed = nonNegInt(counts.failed);
  const unknown = nonNegInt(counts.unknown);
  const passed = nonNegInt(counts.passed);
  const error = nonNegInt(counts.error ?? 0);
  const n = passed + failed + unknown;
  const interval = wilsonInterval(failed, n, level);
  const warning = sampleSizeWarning(n);
  const warnings: string[] = warning ? [warning.message] : [];
  const unknownRate = n > 0 ? unknown / n : null;
  if (unknownRate !== null && unknownRate >= 0.2) {
    warnings.push('未判定占比较高，判定器对较多回答无法给出结论，失败率可能被低估。');
  }
  return {
    sampleSize: n,
    failedCount: failed,
    unknownCount: unknown,
    errorCount: error,
    failRate: interval.proportion,
    failRateLower: interval.lower,
    failRateUpper: interval.upper,
    unknownRate,
    confidenceLevel: level,
    warningCodes: warning ? [warning.code] : [],
    warnings,
    note: STATISTICS_NOTE,
  };
}

/** 百分比格式化（0~1 → "12.3%"）。 */
export function formatPercent(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export interface ConfusionCounts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

/**
 * 二分类指标。约定：正类 = 有风险（失败）。
 * tp：判定失败且人工认为失败；fp：判定失败但人工认为通过（误报）；
 * fn：判定通过但人工认为失败（漏报）；tn：判定通过且人工认为通过。
 */
export function binaryMetrics(c: ConfusionCounts) {
  const tp = nonNegInt(c.tp);
  const fp = nonNegInt(c.fp);
  const fn = nonNegInt(c.fn);
  const tn = nonNegInt(c.tn);
  const total = tp + fp + fn + tn;
  return {
    total,
    accuracy: total > 0 ? (tp + tn) / total : null,
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
  };
}

/**
 * Cohen kappa：扣除"碰巧一致"后的一致性。
 * 当期望一致率为 1（双方全部给出同一类别）时无法定义，返回 null。
 */
export function cohensKappa(c: ConfusionCounts): number | null {
  const tp = nonNegInt(c.tp);
  const fp = nonNegInt(c.fp);
  const fn = nonNegInt(c.fn);
  const tn = nonNegInt(c.tn);
  const total = tp + fp + fn + tn;
  if (total === 0) return null;
  const observed = (tp + tn) / total;
  const judgePos = (tp + fp) / total;
  const humanPos = (tp + fn) / total;
  const expected = judgePos * humanPos + (1 - judgePos) * (1 - humanPos);
  if (expected >= 1) return null;
  return (observed - expected) / (1 - expected);
}

/** kappa 的白话分级（Landis & Koch 常用档位）。 */
export function kappaLevel(kappa: number | null): string {
  if (kappa === null || !Number.isFinite(kappa)) return '无法计算';
  if (kappa < 0) return '差（不如随机）';
  if (kappa <= 0.2) return '很弱';
  if (kappa <= 0.4) return '一般';
  if (kappa <= 0.6) return '中等';
  if (kappa <= 0.8) return '较强';
  return '几乎一致';
}

export type DifferenceVerdict = 'insufficient' | 'within_noise' | 'beyond_noise';

export interface DifferenceHint {
  verdict: DifferenceVerdict;
  /** 两组点估计之差（b - a，0~1）；任一侧无样本时为 null */
  delta: number | null;
  message: string;
}

/**
 * 两组比例差异的保守提示：两个 95% 威尔逊区间重叠 → 差异未超出统计波动；
 * 不重叠 → 差异大概率不是随机波动。区间重叠法偏保守，不等同于假设检验。
 */
export function compareProportions(
  a: { successes: number; n: number },
  b: { successes: number; n: number },
  level: ConfidenceLevel = 0.95,
): DifferenceHint {
  const ia = wilsonInterval(a.successes, a.n, level);
  const ib = wilsonInterval(b.successes, b.n, level);
  if (ia.proportion === null || ib.proportion === null) {
    return { verdict: 'insufficient', delta: null, message: '样本不足，无法判断差异是否可信。' };
  }
  const delta = ib.proportion - ia.proportion;
  const overlap = ia.lower! <= ib.upper! && ib.lower! <= ia.upper!;
  const tooFew = a.n < SAMPLE_TOO_FEW_THRESHOLD || b.n < SAMPLE_TOO_FEW_THRESHOLD;
  if (overlap) {
    return {
      verdict: 'within_noise',
      delta,
      message: tooFew
        ? '差异未超出统计波动，且样本过少，仅供参考。'
        : '差异未超出统计波动，暂不能认为两者有真实差别。',
    };
  }
  return {
    verdict: 'beyond_noise',
    delta,
    message: tooFew
      ? '区间未重叠，但样本过少，仍请谨慎解读。'
      : '差异超出统计波动，大概率是真实变化。',
  };
}

/** 带种子的伪随机数（mulberry32），用于可复现的随机抽检。 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串种子 → 32 位整数（FNV-1a）。 */
export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 可复现的无放回随机抽样（Fisher-Yates 部分洗牌）。 */
export function seededSample<T>(items: readonly T[], count: number, seed: string | number): T[] {
  const rnd = seededRandom(typeof seed === 'number' ? seed : hashSeed(seed));
  const arr = items.slice();
  const k = Math.min(Math.max(Math.floor(count), 0), arr.length);
  for (let i = 0; i < k; i += 1) {
    const j = i + Math.floor(rnd() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, k);
}

/** 一句话中文描述：失败率 + 区间 + 样本量（用于报告正文）。无样本时返回空串。 */
export function describeStatisticsZh(s: TaskStatistics | null | undefined): string {
  if (!s || s.sampleSize === 0 || s.failRate === null) return '';
  const pct = (v: number | null) => formatPercent(v);
  const parts = [
    `发现风险比例 ${pct(s.failRate)}（样本量 ${s.sampleSize}，95% 置信区间 ${pct(s.failRateLower)} ~ ${pct(s.failRateUpper)}），未判定 ${s.unknownCount} 条（占 ${pct(s.unknownRate)}，不计为通过）。`,
    '置信区间表示：在当前样本量下，真实的风险比例有 95% 的把握落在该范围内，样本越少区间越宽。',
  ];
  if (s.warnings.length > 0) parts.push(`提示：${s.warnings.join('')}`);
  return parts.join('');
}

/** 由任务行计数直接生成统计摘要（未判定 = 已处理 - 通过 - 失败 - 异常）。 */
export function statisticsFromTaskRow(t: {
  processedQuestions: number;
  passedCount: number;
  failedCount: number;
  errorCount: number;
}): TaskStatistics {
  return summarizeTaskStatistics({
    passed: t.passedCount,
    failed: t.failedCount,
    unknown: Math.max(t.processedQuestions - t.passedCount - t.failedCount - t.errorCount, 0),
    error: t.errorCount,
  });
}

/** 两个任务失败率变化是否可信（以 a 为基线）。 */
export function compareTaskFailRates(a: TaskStatistics, b: TaskStatistics): DifferenceHint {
  return compareProportions(
    { successes: a.failedCount, n: a.sampleSize },
    { successes: b.failedCount, n: b.sampleSize },
  );
}
