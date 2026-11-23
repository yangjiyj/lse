/**
 * 首页「安全态势」接口共用的时间窗口工具。
 * 时区口径与现有首页（routes.ts 的 periodStart / dayKey）一致：东八区（Asia/Shanghai）自然日、自然月。
 */
export type PostureRange = 'month' | '7d' | 'all';

const BJT_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** 某时刻对应的北京时间自然日 YYYY-MM-DD。 */
export function bjtDayKey(date: Date): string {
  return new Date(date.getTime() + BJT_OFFSET_MS).toISOString().slice(0, 10);
}

/** 北京时间某自然日 00:00 对应的 UTC 时刻。 */
export function bjtDayStart(key: string): Date {
  return new Date(`${key}T00:00:00+08:00`);
}

function bjtMonthStart(date: Date, monthOffset = 0): Date {
  const s = new Date(date.getTime() + BJT_OFFSET_MS);
  return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + monthOffset, 1) - BJT_OFFSET_MS);
}

export interface Window {
  start: Date | null; // null = 不设下界
  end: Date; // 开区间上界
}

export interface RangeWindows {
  current: Window;
  /** 上一等长周期；range=all 时为 null（无可比周期）。 */
  previous: Window | null;
}

/**
 * month：本月 1 日 00:00（北京时间）至今；上期 = 上月同起点、等长（月初至“上月的同一时刻”，不越过本月 1 日）。
 * 7d：最近 7×24 小时；上期 = 再往前 7×24 小时。
 * all：全部，无上期。
 */
export function resolveRange(range: PostureRange, now: Date): RangeWindows {
  if (range === 'all') return { current: { start: null, end: now }, previous: null };
  if (range === '7d') {
    const start = new Date(now.getTime() - 7 * DAY_MS);
    return {
      current: { start, end: now },
      previous: { start: new Date(start.getTime() - 7 * DAY_MS), end: start },
    };
  }
  const start = bjtMonthStart(now);
  const prevStart = bjtMonthStart(now, -1);
  const len = now.getTime() - start.getTime();
  const prevEnd = new Date(Math.min(prevStart.getTime() + len, start.getTime()));
  return {
    current: { start, end: now },
    previous: { start: prevStart, end: prevEnd },
  };
}

/** Prisma createdAt 过滤条件；start 为空时只限上界。 */
export function createdAtFilter(w: Window): { gte?: Date; lt: Date } {
  return w.start ? { gte: w.start, lt: w.end } : { lt: w.end };
}

/** 以今天（北京时间）为最后一天，向前 days 个自然日的日期键，升序。 */
export function lastDayKeys(days: number, now: Date): { keys: string[]; since: Date } {
  const todayStart = bjtDayStart(bjtDayKey(now));
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    keys.push(bjtDayKey(new Date(todayStart.getTime() - i * DAY_MS + 12 * 3600 * 1000)));
  }
  return { keys, since: new Date(todayStart.getTime() - (days - 1) * DAY_MS) };
}
