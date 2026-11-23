// AI 资产测绘：范围配置读写、异步扫描执行、结果与已登记评估对象比对。
import { Prisma } from '@prisma/client';
import { prisma, prismaUnscoped } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { normalizeScopeConfig, type ScanEndpoint, type ScopeConfig } from './ranges.js';
import { probeTarget, type ProbeHit, type ProbeOptions } from './probe.js';

export const SCOPE_SETTING_KEY = 'asset_discovery.scope';
export const MAX_CONCURRENCY = 8;
export const PER_HOST_INTERVAL_MS = 200;
/** 执行中每隔这么久刷一次 updatedAt 作心跳。 */
export const RUN_HEARTBEAT_MS = 30_000;
/** 心跳超过这么久没刷新就算执行进程没了（心跳间隔的 6 倍）。 */
export const RUN_STALE_MS = 3 * 60_000;

export async function readScopeConfig(): Promise<ScopeConfig> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SCOPE_SETTING_KEY } });
  return normalizeScopeConfig(row?.value ?? null);
}

export async function saveScopeConfig(cfg: ScopeConfig, userId: string): Promise<void> {
  const value = cfg as unknown as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({
    where: { key: SCOPE_SETTING_KEY },
    create: { key: SCOPE_SETTING_KEY, value, updatedById: userId },
    update: { value, updatedById: userId },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ExecuteOptions {
  probe?: ProbeOptions;
  hostIntervalMs?: number;
  actor?: { id: string; name: string; ip?: string };
  /** 心跳间隔，默认 RUN_HEARTBEAT_MS（测试调小） */
  heartbeatMs?: number;
}

/** 并发 ≤ MAX_CONCURRENCY 按主机展开；同一主机的各端点串行并间隔 hostIntervalMs。 */
export async function executeRun(
  runId: string,
  endpoints: ScanEndpoint[],
  opts: ExecuteOptions = {},
): Promise<void> {
  const byHost = new Map<string, ScanEndpoint[]>();
  for (const e of endpoints) byHost.set(e.host, [...(byHost.get(e.host) ?? []), e]);
  const groups = [...byHost.values()];
  const interval = opts.hostIntervalMs ?? PER_HOST_INTERVAL_MS;
  await prisma.assetDiscoveryRun.update({
    where: { id: runId },
    data: { status: 'RUNNING', startedAt: new Date() },
  });
  const hits: ProbeHit[] = [];
  let probed = 0;
  let cursor = 0;
  // 心跳：进程还在就定期刷 updatedAt（顺带写已探测数），收尾按心跳超时判断执行进程是否已经没了。
  const heartbeat = setInterval(() => {
    void prisma.assetDiscoveryRun
      .updateMany({
        where: { id: runId, status: 'RUNNING' },
        data: { probedCount: probed, updatedAt: new Date() },
      })
      .catch(() => undefined);
  }, opts.heartbeatMs ?? RUN_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    const worker = async () => {
      while (cursor < groups.length) {
        const group = groups[cursor++]!;
        for (let i = 0; i < group.length; i += 1) {
          if (i > 0 && interval > 0) await sleep(interval);
          const hit = await probeTarget(group[i]!, opts.probe);
          probed += 1;
          if (hit) hits.push(hit);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENCY, groups.length) }, () => worker()),
    );
    if (hits.length) {
      await prisma.assetDiscoveryHit.createMany({
        data: hits.map((h) => ({
          runId,
          host: h.host,
          port: h.port,
          baseUrl: h.baseUrl,
          serviceType: h.serviceType,
          models: h.models,
          modelDetails: h.modelDetails as unknown as Prisma.InputJsonValue,
          evidence: h.evidence,
        })),
      });
    }
    await prisma.assetDiscoveryRun.update({
      where: { id: runId },
      data: {
        status: 'COMPLETED',
        probedCount: probed,
        hitCount: hits.length,
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    await prisma.assetDiscoveryRun.update({
      where: { id: runId },
      data: {
        status: 'FAILED',
        probedCount: probed,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        finishedAt: new Date(),
      },
    });
  } finally {
    clearInterval(heartbeat);
  }
  const run = await prisma.assetDiscoveryRun.findUnique({ where: { id: runId } });
  await writeAudit({
    actorId: opts.actor?.id ?? null,
    actorName: opts.actor?.name ?? null,
    action: 'asset_discovery.run.finish',
    targetType: 'asset_discovery_run',
    targetId: runId,
    ip: opts.actor?.ip ?? null,
    detail: { status: run?.status, probedCount: run?.probedCount, hitCount: run?.hitCount },
  });
}

/**
 * 执行进程已经没了（服务、worker 重启）的未完成运行标记为失败，避免永久“执行中”：
 * 心跳（updatedAt）超过 RUN_STALE_MS 没刷新的算中断。API、worker 启动时和 worker 的 tick 都会调。
 * 不按租户：处理全部租户的运行。
 */
export async function failInterruptedRuns(staleMs = RUN_STALE_MS): Promise<number> {
  const r = await prismaUnscoped.assetDiscoveryRun.updateMany({
    where: {
      status: { in: ['PENDING', 'RUNNING'] },
      updatedAt: { lt: new Date(Date.now() - staleMs) },
    },
    data: { status: 'FAILED', error: '扫描进程中断（服务重启或超时）', finishedAt: new Date() },
  });
  return r.count;
}

export function originOf(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

export interface RegisteredTarget {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  /** 空 = 平台共享；四类风险统计在全部租户视角下按测绘所属租户比对 */
  tenantId?: string | null;
}

export async function loadRegisteredTargets(): Promise<RegisteredTarget[]> {
  return prisma.modelTarget.findMany({
    where: { targetType: { in: ['MODEL', 'JUDGE'] } },
    select: { id: true, name: true, baseUrl: true, model: true, tenantId: true },
  });
}

export interface HitModelRow {
  model: string | null;
  registered: boolean;
  targetId: string | null;
  targetName: string | null;
}

/** 以 origin(协议+主机+端口) + 模型名比对；无模型名时按 origin 比对。 */
export function matchHitModels(
  baseUrl: string,
  models: string[],
  targets: RegisteredTarget[],
): HitModelRow[] {
  const origin = originOf(baseUrl);
  const sameOrigin = targets.filter((t) => originOf(t.baseUrl) === origin);
  const list: Array<string | null> = models.length ? models : [null];
  return list.map((model) => {
    const t = model === null ? sameOrigin[0] : sameOrigin.find((x) => x.model.trim() === model);
    return { model, registered: !!t, targetId: t?.id ?? null, targetName: t?.name ?? null };
  });
}
