import { BANK_UPDATE_TZ } from './constants.js';

/** 按上海时区取 YYYY-MM-DD。 */
export function shanghaiDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BANK_UPDATE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** 题库版本号 YYYY.MM.n 拆成数字；格式不对返回 null。 */
export function parseVersion(v: string | null | undefined): number[] | null {
  if (!v) return null;
  const parts = v.trim().split('.');
  if (parts.length < 2 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.map(Number);
}

/** 按数字逐段比较版本号（2026.11.10 大于 2026.11.9）；缺的段按 0；无法解析的排在最前。 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function maxVersion(list: ReadonlyArray<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of list) {
    if (!parseVersion(v)) continue;
    if (best === null || compareVersions(v, best) > 0) best = v!;
  }
  return best;
}

/**
 * 下一个题库版本号：本月（上海时区）第一版是 YYYY.MM.1；同月已有版本时 n 递增。
 * 已有版本比本月还新（时钟回拨或手工导入）时，在已有最大版本上递增，保证版本只增不减。
 */
export function nextQuestionVersion(existing: ReadonlyArray<string | null | undefined>, now: Date): string {
  const [y, m] = shanghaiDate(now).split('-');
  const candidate = `${y}.${m}.1`;
  const max = maxVersion(existing);
  if (!max || compareVersions(candidate, max) > 0) return candidate;
  const p = parseVersion(max)!;
  const yy = String(p[0]);
  const mm = String(p[1] ?? 1).padStart(2, '0');
  return `${yy}.${mm}.${(p[2] ?? 0) + 1}`;
}

/** 关键词补充版本：当天日期。 */
export function keywordVersion(now: Date): string {
  return shanghaiDate(now);
}
