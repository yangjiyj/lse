/**
 * 首页下钻链接（2.2.4），只用目标页面已经支持的 URL 参数。
 * 风险处置台：severity（等级）、domain（风险类别）、since/until（按任务创建时间，与首页统计周期同口径）；
 * reviewStatus 取除误报外的全部状态，与首页计数（dashboard/posture.ts 的 ACTIVE_FINDING）一致。
 */
export const ACTIVE_REVIEW_STATUSES = 'UNREVIEWED,NEEDS_REVIEW,CONFIRMED,ACCEPTED_RISK';

export function riskListHref(
  filter: { severity?: string; domain?: string; since?: string | null; until?: string | null } = {},
): string {
  const q = new URLSearchParams();
  if (filter.severity) q.set('severity', filter.severity);
  if (filter.domain) q.set('domain', filter.domain);
  if (filter.since) q.set('since', filter.since);
  if (filter.until) q.set('until', filter.until);
  q.set('reviewStatus', ACTIVE_REVIEW_STATUSES);
  return `/wrong-answers?${q.toString()}`;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * 趋势图某一天下钻到风险处置台：当天北京时间 0 点到次日 0 点（与 /dashboard/trend 的自然日同口径，
 * 东八区没有夏令时，加 24 小时即次日 0 点）。
 * 注意：趋势按风险回复产生的日期统计，处置台按任务创建时间过滤；跨零点运行的任务两边可能差几条。
 */
export function dayRiskHref(date: string): string {
  const since = new Date(`${date}T00:00:00+08:00`);
  const until = new Date(since.getTime() + DAY_MS);
  return riskListHref({ since: since.toISOString(), until: until.toISOString() });
}

/** 「评估任务」统计数字下钻到任务列表（任务列表页还不读 URL 里的日期，先不带）。 */
export function taskListHref(): string {
  return '/eval-tasks';
}

/**
 * 下钻到检测结果页（2.2.2、2.5.3）：首页「四类风险」带 since（统计周期起点，「全部」不带），
 * 与卡片计数同一时间窗口；点来源再带 source；画像页带 profile，按该平台的画像范围看。
 */
export function detectResultsHref(filter: {
  category: string;
  source?: string;
  since?: string | null;
  profile?: string;
}): string {
  const q = new URLSearchParams({ category: filter.category });
  if (filter.since) q.set('since', filter.since);
  if (filter.source) q.set('source', filter.source);
  if (filter.profile) q.set('profile', filter.profile);
  return `/analysis/results?${q.toString()}`;
}
