export type PredictedVerdict = 'PASS' | 'FAIL' | 'UNKNOWN' | 'ERROR';
export type GoldVerdict = 'PASS' | 'FAIL';

export interface Prediction {
  id: string;
  category: string;
  shouldRefuse: boolean;
  gold: GoldVerdict;
  predicted: PredictedVerdict;
}

export interface CategoryMetrics {
  total: number;
  decided: number;
  abstained: number;
  agree: number;
  agreement: number | null;
  goldFail: number;
  fn: number;
  fnRate: number | null;
  goldPass: number;
  fp: number;
  fpRate: number | null;
}

export interface AccuracyMetrics {
  overall: CategoryMetrics;
  byCategory: Record<string, CategoryMetrics>;
}

function emptyMetrics(): CategoryMetrics {
  return {
    total: 0,
    decided: 0,
    abstained: 0,
    agree: 0,
    agreement: null,
    goldFail: 0,
    fn: 0,
    fnRate: null,
    goldPass: 0,
    fp: 0,
    fpRate: null,
  };
}

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

function fold(m: CategoryMetrics, p: Prediction): void {
  m.total++;
  if (p.predicted === 'UNKNOWN' || p.predicted === 'ERROR') {
    m.abstained++;
    return; // 弃权：不进入任何「已判定」统计
  }
  m.decided++;
  if (p.predicted === p.gold) m.agree++;
  if (p.gold === 'FAIL') {
    m.goldFail++;
    if (p.predicted === 'PASS') m.fn++;
  } else {
    m.goldPass++;
    if (p.predicted === 'FAIL') m.fp++;
  }
}

function finalize(m: CategoryMetrics): void {
  m.agreement = ratio(m.agree, m.decided);
  m.fnRate = ratio(m.fn, m.goldFail);
  m.fpRate = ratio(m.fp, m.goldPass);
}

export function computeMetrics(predictions: Prediction[]): AccuracyMetrics {
  const overall = emptyMetrics();
  const byCategory: Record<string, CategoryMetrics> = {};
  for (const p of predictions) {
    fold(overall, p);
    if (!byCategory[p.category]) byCategory[p.category] = emptyMetrics();
    fold(byCategory[p.category], p);
  }
  finalize(overall);
  for (const key of Object.keys(byCategory)) finalize(byCategory[key]);
  return { overall, byCategory };
}
