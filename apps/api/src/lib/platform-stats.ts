import { prismaUnscoped } from '../db.js';
import { firstInWindow, warnPublicRedis } from './public-rate-limit.js';

// 登录页的访问量（2.1.2）和安装包下载量（2.1.3）：按北京时间切日，每天一行，平台级、不分租户。

/** 同一 IP 在这段时间内只计一次访问；同一 IP 下载同一个文件也只计一次。 */
const DEDUP_SECONDS = 30 * 60;

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 北京时间的日期（YYYY-MM-DD）。 */
function shanghaiDateString(now: Date): string {
  return dayFormatter.format(now);
}

/** 北京时间所在日期，表示成该日 UTC 零点（对应数据库的 date 列）。 */
export function shanghaiDay(now = new Date()): Date {
  return new Date(`${shanghaiDateString(now)}T00:00:00Z`);
}

async function increment(column: 'visits' | 'downloads'): Promise<void> {
  const day = shanghaiDateString(new Date());
  if (column === 'visits') {
    await prismaUnscoped.$executeRaw`
      INSERT INTO "platform_daily_stats" ("date", "visits", "downloads")
      VALUES (${day}::date, 1, 0)
      ON CONFLICT ("date") DO UPDATE SET "visits" = "platform_daily_stats"."visits" + 1`;
  } else {
    await prismaUnscoped.$executeRaw`
      INSERT INTO "platform_daily_stats" ("date", "visits", "downloads")
      VALUES (${day}::date, 0, 1)
      ON CONFLICT ("date") DO UPDATE SET "downloads" = "platform_daily_stats"."downloads" + 1`;
  }
}

/** 去重键在窗口内第一次出现才计；Redis 不可用时这次不计（不报错）。 */
async function firstTime(key: string): Promise<boolean> {
  try {
    return await firstInWindow(key, DEDUP_SECONDS);
  } catch (err) {
    warnPublicRedis(err);
    return false;
  }
}

/** 记一次登录页访问；同一 IP 30 分钟内只记一次。 */
export async function recordVisit(ip: string): Promise<void> {
  if (await firstTime(`visit:${ip}`)) await increment('visits');
}

/**
 * 记一次安装包下载。统计失败不影响下载本身。
 * 传了 dedupKey（如 `<ip>:<文件名>`）时，同一键 30 分钟内只记一次。
 * 返回这次是不是窗口内第一次（没给 dedupKey 时总是 true；Redis 不可用时为 false）。
 */
export async function recordDownload(dedupKey?: string): Promise<boolean> {
  let first = true;
  try {
    if (dedupKey) first = await firstTime(`download:${dedupKey}`);
    if (first) await increment('downloads');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[platform-stats] 记录下载量失败:', (err as Error).message);
  }
  return first;
}

export interface CountPair {
  today: number;
  total: number;
}

export async function loadLoginCounts(): Promise<{ visits: CountPair; downloads: CountPair }> {
  const [today, sum] = await Promise.all([
    prismaUnscoped.platformDailyStat.findUnique({ where: { date: shanghaiDay() } }),
    prismaUnscoped.platformDailyStat.aggregate({ _sum: { visits: true, downloads: true } }),
  ]);
  return {
    visits: { today: today?.visits ?? 0, total: sum._sum.visits ?? 0 },
    downloads: { today: today?.downloads ?? 0, total: sum._sum.downloads ?? 0 },
  };
}
