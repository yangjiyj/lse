import { Redis } from 'ioredis';
import { config } from '../config.js';
import { AppError } from './errors.js';

// 免登录接口的限流与计数：放在 Redis 里，多副本部署时共用一份计数。
// 用单独的连接，不复用 BullMQ 的那条（那条不限重试、断开时命令会一直排队）：
// 这里命令超时就失败，Redis 不可用时由调用方决定跳过还是报错，请求不会挂住。

/** 公开接口：同一 IP 每分钟最多请求次数（默认值）。 */
export const PUBLIC_REQUESTS_PER_MINUTE = 30;

const KEY_PREFIX = 'lse:public';
/** 单条命令最长等待时间。 */
const COMMAND_TIMEOUT_MS = 500;
/** 还没连上时最多等这么久，等不到就当 Redis 不可用。 */
const READY_WAIT_MS = 500;

let client: Redis | null = null;
let redisUrl: string | null = null;
let readyWait: Promise<void> | null = null;
let lastWarnAt = 0;

export function tooManyRequests(message = '请求过于频繁，请稍后再试'): AppError {
  return new AppError(429, message, 'RATE_LIMITED');
}

function fullKey(key: string): string {
  return `${KEY_PREFIX}:${key}`;
}

/** 第一次用时才建连接；断开后由 ioredis 在后台重连。 */
function connection(): Redis {
  if (!client) {
    const redis = new Redis(redisUrl ?? config.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      commandTimeout: COMMAND_TIMEOUT_MS,
      connectTimeout: 1000,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    // 不监听 error 会让连接失败变成未处理异常；失败由各次命令的报错体现。
    redis.on('error', () => undefined);
    client = redis;
  }
  return client;
}

/** 等连接就绪（并发的请求共用一次等待），超时抛错。 */
function waitReady(redis: Redis): Promise<void> {
  if (!readyWait) {
    readyWait = new Promise<void>((resolve, reject) => {
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        redis.off('ready', onReady);
        reject(new Error('公开接口的 Redis 连接不可用'));
      }, READY_WAIT_MS);
      redis.once('ready', onReady);
    }).finally(() => {
      readyWait = null;
    });
  }
  return readyWait;
}

async function readyConnection(): Promise<Redis> {
  const redis = connection();
  if (redis.status === 'ready') return redis;
  if (redis.status === 'wait') redis.connect().catch(() => undefined);
  await waitReady(redis);
  return redis;
}

/** Redis 不可用时打一条日志，一分钟最多一条。 */
export function warnPublicRedis(err: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  // eslint-disable-next-line no-console
  console.warn('[public-rate-limit] Redis 不可用，公开接口跳过限流或计数:', (err as Error).message);
}

/** 关掉连接；传 url 时下次改连这个地址（测试用），不传则回到配置里的地址。 */
export async function resetPublicRedis(url?: string): Promise<void> {
  const old = client;
  client = null;
  readyWait = null;
  redisUrl = url ?? null;
  if (old) old.disconnect();
}

/** 固定窗口计数加 1，返回本窗口内的累计次数；窗口从第一次计数开始。Redis 不可用时抛错。 */
export async function incrementWindow(key: string, windowSeconds: number): Promise<number> {
  const k = fullKey(key);
  const res = await (await readyConnection())
    .multi()
    .set(k, '0', 'EX', windowSeconds, 'NX')
    .incr(k)
    .exec();
  const incr = res?.[1];
  if (!incr || incr[0]) throw incr?.[0] ?? new Error('限流计数失败');
  return Number(incr[1]);
}

/** 同一键在窗口内只算一次：首次返回 true。Redis 不可用时抛错。 */
export async function firstInWindow(key: string, windowSeconds: number): Promise<boolean> {
  const redis = await readyConnection();
  const ok = await redis.set(fullKey(key), '1', 'EX', windowSeconds, 'NX');
  return ok === 'OK';
}

/** 存一个带过期时间（毫秒）的临时值。Redis 不可用时抛错。 */
export async function putEphemeral(key: string, value: string, ttlMs: number): Promise<void> {
  await (await readyConnection()).set(fullKey(key), value, 'PX', ttlMs);
}

/** 取出并删除一个临时值（原子操作，只能取到一次）；不存在或已过期返回 null。Redis 不可用时抛错。 */
export async function takeEphemeral(key: string): Promise<string | null> {
  return (await readyConnection()).getdel(fullKey(key));
}

export interface PublicRateLimitOptions {
  /** 同一 IP 每分钟最多请求次数，默认 30。 */
  perMinute?: number;
}

/**
 * 公开接口的通用限流：同一 IP 在某个接口上每分钟最多 perMinute 次，超出抛 429。
 * Redis 不可用时跳过限流、照常放行（只记日志），不让公开页面跟着 Redis 一起挂。
 */
export async function enforcePublicRateLimit(
  name: string,
  ip: string,
  { perMinute = PUBLIC_REQUESTS_PER_MINUTE }: PublicRateLimitOptions = {},
): Promise<void> {
  let count: number;
  try {
    count = await incrementWindow(`rl:${name}:${ip}`, 60);
  } catch (err) {
    warnPublicRedis(err);
    return;
  }
  if (count > perMinute) throw tooManyRequests();
}
