import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { HARD_MAX_HOSTS_PER_RUN, HARD_MAX_PORTS, parseScopeEntry } from './ranges.js';
import { startAssetDiscoveryRun } from './launch.js';
import {
  failInterruptedRuns,
  loadRegisteredTargets,
  matchHitModels,
  readScopeConfig,
  saveScopeConfig,
  type ExecuteOptions,
} from './service.js';
import { collectGatewayClues, type GatewayClueDeps } from './gateway-clues.js';

export interface AssetDiscoveryRouteOptions {
  execute?: ExecuteOptions;
  gateway?: GatewayClueDeps;
  /** 测试用：拿到后台执行的 Promise 以便等待完成。 */
  onRunStarted?: (runId: string, done: Promise<void>) => void;
}

const portSchema = z.number().int().min(1).max(65535);
const scopeBody = z
  .object({
    entries: z.array(z.string().trim().min(1).max(253)).max(64),
    ports: z.array(portSchema).max(HARD_MAX_PORTS),
    maxHostsPerRun: z.number().int().min(1).max(HARD_MAX_HOSTS_PER_RUN),
  })
  .strict();
const runBody = z
  .object({
    targets: z.array(z.string().trim().min(1).max(512)).min(1).max(64),
    // 只填 URL 或「主机:端口」目标时可不填端口（端口取自目标）。
    ports: z.array(portSchema).max(HARD_MAX_PORTS).default([]),
    confirm: z.literal(true),
  })
  .strict();
const idParams = z.object({ id: z.string().uuid() });

const READ = ['engine:scan', 'platform_setting:read'];

export async function assetDiscoveryRoutes(
  app: FastifyInstance,
  options: AssetDiscoveryRouteOptions = {},
): Promise<void> {
  app.addHook('preHandler', authenticate);
  await failInterruptedRuns().catch(() => undefined);

  app.get('/scope', { preHandler: [requirePermission(...READ)] }, async () => readScopeConfig());

  app.put('/scope', { preHandler: [requirePermission('platform_setting:update')] }, async (req) => {
    const body = scopeBody.parse(req.body);
    const entries: string[] = [];
    for (const raw of body.entries) {
      try {
        entries.push(parseScopeEntry(raw).text);
      } catch (err) {
        throw badRequest((err as Error).message, 'ASSET_DISCOVERY_SCOPE_INVALID');
      }
    }
    const cfg = {
      entries: [...new Set(entries)],
      ports: [...new Set(body.ports)],
      maxHostsPerRun: body.maxHostsPerRun,
    };
    await saveScopeConfig(cfg, req.currentUser!.id);
    await writeAudit({
      actorId: req.currentUser!.id,
      actorName: req.currentUser!.username,
      action: 'asset_discovery.scope.update',
      targetType: 'system_setting',
      targetId: 'asset_discovery.scope',
      ip: req.ip,
      detail: cfg,
    });
    return cfg;
  });

  app.post('/runs', { preHandler: [requirePermission('engine:scan')] }, async (req, reply) => {
    const parsed = runBody.safeParse(req.body);
    if (!parsed.success) {
      const confirmMissing = parsed.error.issues.some((i) => i.path[0] === 'confirm');
      throw badRequest(
        confirmMissing ? '发起主动探测前必须确认（confirm: true）' : '扫描参数不合法',
        confirmMissing ? 'ASSET_DISCOVERY_CONFIRM_REQUIRED' : 'BAD_REQUEST',
      );
    }
    const run = await startAssetDiscoveryRun(req.currentUser!, parsed.data, {
      ip: req.ip,
      execute: options.execute,
      onRunStarted: options.onRunStarted,
    });
    reply.code(202);
    return run;
  });

  app.get('/runs', { preHandler: [requirePermission(...READ)] }, async () =>
    prisma.assetDiscoveryRun.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
  );

  app.get('/runs/:id', { preHandler: [requirePermission(...READ)] }, async (req) => {
    const { id } = idParams.parse(req.params);
    const run = await prisma.assetDiscoveryRun.findUnique({
      where: { id },
      include: { hits: { orderBy: [{ host: 'asc' }, { port: 'asc' }] } },
    });
    if (!run) throw notFound('扫描记录不存在');
    const targets = await loadRegisteredTargets();
    return {
      ...run,
      hits: run.hits.map((h) => ({ ...h, matches: matchHitModels(h.baseUrl, h.models, targets) })),
    };
  });

  app.get('/gateway-clues', { preHandler: [requirePermission('gateway_log:analyze')] }, async (request) => {
    // 网关审计线索来自全平台共用的网关：只给平台租户，其他租户按「未接入」处理。
    if (!request.currentUser!.tenantIsPlatform) {
      return { status: 'NOT_CONNECTED' as const, message: '网关未接入，无法获取审计线索', clues: [] };
    }
    return collectGatewayClues(options.gateway);
  });
}
