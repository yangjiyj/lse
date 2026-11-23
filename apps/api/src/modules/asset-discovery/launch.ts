import type { AssetDiscoveryRun } from '@prisma/client';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { AppError, badRequest } from '../../lib/errors.js';
import {
  TargetFormatError,
  endpointText,
  expandScanTargets,
  parseScanTargets,
  type ParsedTargets,
} from './ranges.js';
import { executeRun, readScopeConfig, type ExecuteOptions } from './service.js';

export interface StartAssetDiscoveryContext {
  ip: string | null;
  execute?: ExecuteOptions;
  /** 测试用：拿到后台执行的 Promise 以便等待完成。 */
  onRunStarted?: (runId: string, done: Promise<void>) => void;
}

/**
 * 发起一次资产测绘（接口和组合任务的子任务共用）：解析目标、校验扫描范围（越界写拒绝审计并 403）、
 * 建记录，在调用者所在进程（API 或 worker）后台执行探测。body 的 confirm 由调用方校验。
 */
export async function startAssetDiscoveryRun(
  actor: { id: string; username: string },
  body: { targets: string[]; ports: number[] },
  ctx: StartAssetDiscoveryContext,
): Promise<AssetDiscoveryRun> {
  // 写法不对（含 010.0.0.5 这类非标准 IP）一律 400；写法对但越界才是 403。
  let targets: ParsedTargets;
  try {
    targets = parseScanTargets(body.targets);
  } catch (err) {
    throw badRequest((err as Error).message, 'ASSET_DISCOVERY_TARGET_INVALID');
  }
  if (!body.ports.length && targets.plain.length) {
    throw badRequest('请选择扫描端口', 'BAD_REQUEST');
  }
  // URL 与「主机:端口」目标解析后实际探测的端点，写进审计便于核对。
  const urlEndpoints = targets.urls.map((u) => ({
    target: u.target,
    endpoint: endpointText(u.endpoint),
  }));
  const cfg = await readScopeConfig();
  let plan;
  try {
    plan = expandScanTargets(body.targets, body.ports, cfg);
  } catch (err) {
    if (err instanceof TargetFormatError) {
      throw badRequest(err.message, 'ASSET_DISCOVERY_TARGET_INVALID');
    }
    await writeAudit({
      actorId: actor.id,
      actorName: actor.username,
      action: 'asset_discovery.run.rejected',
      targetType: 'asset_discovery_run',
      ip: ctx.ip,
      detail: {
        targets: body.targets,
        ports: body.ports,
        urlEndpoints,
        reason: (err as Error).message,
      },
    });
    throw new AppError(403, (err as Error).message, 'ASSET_DISCOVERY_OUT_OF_SCOPE');
  }
  const run = await prisma.assetDiscoveryRun.create({
    data: {
      targets: body.targets,
      ports: plan.ports,
      hostCount: plan.hosts.length,
      portCount: plan.ports.length,
      endpointCount: plan.endpoints.length,
      createdById: actor.id,
      createdByName: actor.username,
    },
  });
  await writeAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: 'asset_discovery.run.start',
    targetType: 'asset_discovery_run',
    targetId: run.id,
    ip: ctx.ip,
    detail: {
      targets: body.targets,
      ports: plan.ports,
      hostCount: plan.hosts.length,
      endpointCount: plan.endpoints.length,
      urlEndpoints,
    },
  });
  const done = executeRun(run.id, plan.endpoints, {
    ...ctx.execute,
    actor: { id: actor.id, name: actor.username, ...(ctx.ip ? { ip: ctx.ip } : {}) },
  }).catch((err: unknown) =>
    // 带 err 对象记日志，保留堆栈（worker 里没有请求日志）。
    console.error(`[asset-discovery] 测绘执行失败 runId=${run.id}:`, err),
  );
  ctx.onRunStarted?.(run.id, done);
  return run;
}
