import os from 'node:os';
import { readFile, stat, statfs } from 'node:fs/promises';

export type DependencyState = 'ok' | 'error';

export interface SystemStatus {
  cpu: { cores: number; load1: number; load5: number; usagePercent: number };
  memory: { total: number; used: number };
  disks: Array<{ mount: string; total: number; used: number }>;
  uptimeSeconds: number;
  checkedAt: string;
  dependencies: { database: DependencyState; redis: DependencyState };
}

/** 主机读数。默认取 Node 和 cgroup 的值，测试里可以替换。 */
export interface HostProbe {
  totalmem: () => number;
  freemem: () => number;
  /** 容器内存上限；没有限制时为 0、取不到，或是一个远大于物理内存的值。 */
  constrainedMemory: () => number | undefined;
  /** 本进程还能用的内存（考虑容器上限）；取不到时按 freemem 算。 */
  availableMemory: () => number | undefined;
  cpuCount: () => number;
  /** cgroup v2 的 cpu.max 内容；读不到为 null。 */
  readCpuMax: () => Promise<string | null>;
  /** 平台进程已运行的秒数。 */
  processUptime: () => number;
}

const CGROUP_CPU_MAX = '/sys/fs/cgroup/cpu.max';

export const defaultHostProbe: HostProbe = {
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  constrainedMemory: () =>
    typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : undefined,
  availableMemory: () =>
    typeof process.availableMemory === 'function' ? process.availableMemory() : undefined,
  cpuCount: () => os.cpus().length,
  readCpuMax: async () => {
    try {
      return await readFile(CGROUP_CPU_MAX, 'utf8');
    } catch {
      return null;
    }
  },
  processUptime: () => process.uptime(),
};

export interface CollectOptions {
  checkDatabase: () => Promise<unknown>;
  checkRedis: () => Promise<unknown>;
  /** CPU 两次采样的间隔（毫秒）。 */
  sampleMs?: number;
  /** 单个依赖检查的超时（毫秒）。 */
  timeoutMs?: number;
  /** 要统计的挂载点；同一设备只算一次。 */
  diskPaths?: string[];
  /** 替换部分主机读数（测试用）。 */
  host?: Partial<HostProbe>;
}

const DEFAULT_SAMPLE_MS = 200;
/** 单个依赖检查的默认超时（毫秒）。 */
export const DEPENDENCY_TIMEOUT_MS = 2000;

/** 内存：容器有上限时按上限算总量，已用 = 总量 - 可用。 */
export function memoryOf(host: HostProbe): SystemStatus['memory'] {
  const physical = host.totalmem();
  const limit = host.constrainedMemory() ?? 0;
  const total = limit > 0 && limit < physical ? limit : physical;
  const available = host.availableMemory() ?? host.freemem();
  return { total, used: Math.min(total, Math.max(0, total - available)) };
}

/**
 * CPU 核数：cgroup v2 的 cpu.max 设了配额（如「200000 100000」）时按配额 / 周期向上取整，
 * 不超过 CPU 个数；不限（「max 100000」）或读不到时就是 CPU 个数。
 */
export function cpuCoresOf(cpuMax: string | null, cpuCount: number): number {
  const all = Math.max(1, cpuCount || 1);
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(cpuMax ?? '');
  if (!m) return all;
  const quota = Number(m[1]);
  const period = Number(m[2]);
  if (!(quota > 0 && period > 0)) return all;
  return Math.min(all, Math.max(1, Math.ceil(quota / period)));
}

/** 探测 Redis 用到的 ioredis 连接接口。 */
export interface RedisLike {
  status: string;
  ping(): Promise<unknown>;
  once(event: 'ready', listener: () => void): unknown;
  off(event: 'ready', listener: () => void): unknown;
}

/**
 * 连接 ready 时才发 ping：断线时 ioredis 会把命令塞进离线队列等重连，探测会挂住并越积越多。
 * 首次连接正在建立（connecting / connect）时最多等 timeoutMs 到 ready；其他状态直接判异常。
 */
export async function pingRedisWhenReady(redis: RedisLike, timeoutMs: number): Promise<unknown> {
  if (redis.status === 'connecting' || redis.status === 'connect') {
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        redis.off('ready', onReady);
        reject(new Error(`Redis 未就绪：${redis.status}`));
      }, timeoutMs);
      redis.once('ready', onReady);
    });
  }
  if (redis.status !== 'ready') throw new Error(`Redis 未就绪：${redis.status}`);
  return redis.ping();
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

async function cpuUsagePercent(sampleMs: number): Promise<number> {
  const a = cpuTimes();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const b = cpuTimes();
  const total = b.total - a.total;
  if (total <= 0) return 0;
  const busy = 1 - (b.idle - a.idle) / total;
  return Math.round(Math.min(1, Math.max(0, busy)) * 1000) / 10;
}

async function diskUsage(paths: string[]): Promise<SystemStatus['disks']> {
  const seen = new Set<string>();
  const disks: SystemStatus['disks'] = [];
  for (const mount of paths) {
    try {
      const dev = String((await stat(mount)).dev);
      if (seen.has(dev)) continue;
      seen.add(dev);
      const fs = await statfs(mount);
      const total = fs.blocks * fs.bsize;
      if (total <= 0) continue;
      disks.push({ mount, total, used: (fs.blocks - fs.bfree) * fs.bsize });
    } catch {
      // 目录不存在或无权读取：跳过，不影响其他项。
    }
  }
  return disks;
}

async function probe(check: () => Promise<unknown>, timeoutMs: number): Promise<DependencyState> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return 'ok';
  } catch {
    return 'error';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 默认统计根目录和模型上传暂存目录所在的磁盘。 */
export function defaultDiskPaths(): string[] {
  const upload = process.env.MODEL_SCAN_UPLOAD_DIR?.trim();
  return ['/', ...(upload ? [upload] : [])];
}

export async function collectSystemStatus(options: CollectOptions): Promise<SystemStatus> {
  const host: HostProbe = { ...defaultHostProbe, ...options.host };
  const timeoutMs = options.timeoutMs ?? DEPENDENCY_TIMEOUT_MS;
  const [usagePercent, disks, database, redis, cpuMax] = await Promise.all([
    cpuUsagePercent(options.sampleMs ?? DEFAULT_SAMPLE_MS),
    diskUsage(options.diskPaths ?? defaultDiskPaths()),
    probe(options.checkDatabase, timeoutMs),
    probe(options.checkRedis, timeoutMs),
    host.readCpuMax(),
  ]);
  const [load1 = 0, load5 = 0] = os.loadavg();
  return {
    cpu: { cores: cpuCoresOf(cpuMax, host.cpuCount()), load1, load5, usagePercent },
    memory: memoryOf(host),
    disks,
    // 平台进程的运行时长：容器里 os.uptime() 是宿主机开机时长。
    uptimeSeconds: Math.floor(host.processUptime()),
    checkedAt: new Date().toISOString(),
    dependencies: { database, redis },
  };
}
