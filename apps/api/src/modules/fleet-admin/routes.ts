// 独立探针（自管终端）管理接口：/api/fleet/*，登录 JWT + RBAC。
// 协议端点 /agent/v1/* 在 fleet-agent 车道，二者共用 FLEET_AGENT_ENABLED 开关。
import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma, type FleetEndpoint, type FleetEvalJob, type FleetJobStatus, type User } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { tenantFilterWhere } from '../../lib/all-tenants.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { conflict, forbidden, notFound, badRequest } from '../../lib/errors.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import { writeAudit } from '../../lib/audit.js';
import { PRODUCT_NAME } from '../../lib/product-name.js';
import {
  LIVE_EVAL_BLOCKED_REASONS,
  type FleetLiveProduct,
} from '../../../../../packages/shared/src/fleet-live-eval.js';
import { redactJson } from '../../lib/redact.js';
import { endpointProductSchema } from '../endpoint-evals/config.js';
import { AgentShieldClient } from '../endpoint-evals/agentshield-client.js';
import { fleetAgentDisplayName } from '../../../../../packages/shared/src/fleet-agent-display.js';
import { mergePlatformEndpoints } from './platform-agents.js';
import { scriptedSupported } from './agents.js';
import {
  assertRuntimeV2Capability,
  buildRuntimeJob,
  isRuntimeSuite,
  parseFleetEvalJobRequest,
  planTierOf,
  runtimeJobName,
  type FleetEvalJobBody,
} from './runtime-job.js';
import { MAX_PAYLOAD_CANONICAL_BYTES } from '../fleet-agent/config.js';
import { buildEndpointPack, buildScriptedPack, type EndpointPack } from '../endpoint-evals/pack.js';
import {
  createQuestions,
  ENDPOINT_ENGINE,
  JOB_LOG,
  json,
  type JobBinding,
} from '../endpoint-evals/service.js';
import {
  CANCELLABLE_JOB_STATUSES,
  DEFAULT_JOB_DEADLINE_MS,
  EVAL_OFFLINE_LIMIT_MS,
  fleetAgentEnabled,
  ONLINE_WINDOW_MS,
  OPEN_JOB_STATUSES,
  PERM_CREATE_TASK,
  PERM_MANAGE,
  PERM_READ,
} from './config.js';
import { createReadStream } from 'node:fs';
import { deploymentInfo } from './deployment.js';
import { CHECK_CATALOG } from './check-catalog.js';
import { buildOneclick } from './install-script.js';
import {
  buildInstallerTail,
  checkInstallerTarget,
  INSTALLER_FILE_PREFIX,
  installerAvailability,
  isInstallerTarget,
  streamInstaller,
} from './installer.js';
import { INSTALLER_TARGETS, loadKitCatalog, resolveKitFile } from './kits.js';
import {
  buildJobPayload,
  FleetPayloadError,
  validateScenarioPack,
} from '../fleet-agent/checksum.js';
import { endpointAgents } from './agents.js';
import { buildEndpointOverview, jobSampleCount } from './overview.js';
import { judgeProbeReport, mcpAllowlist, summarizeReport } from './posture.js';
import { latestReportOrConflict, lockEndpoint, runEndpointPostureEval } from './posture-launch.js';
import {
  failInterruptedRemoteDeploys,
  markScriptFetched,
  remoteDeployRoutes,
  sweepRemoteDeploys,
  type RemoteDeployRoutesOptions,
} from './remote-deploy/routes.js';
import { endpointHardware } from './hardware.js';
import { agentEvalPlanSchema, estimateAgentJobs } from './estimate.js';
import { batchEstimateSeconds, chunkPack, splitScenarioIds } from './runtime-batches.js';
import { loadEndpointSummary } from '../eval-tasks/endpoint-summary-data.js';
import { loadSampleCatalog, type CatalogEntry } from '../agent-samples/catalog.js';
import type { RuntimeSample } from '../../../../../packages/shared/src/runtime-eval.js';
import type { EndpointScenarioDefinition } from '../endpoint-evals/pack.js';
import {
  ensureFleetTarget,
  expireStaleJobs,
  type FleetJobErrorLog,
  FLEET_STATUS_LABELS,
  FLEET_TARGET_PROVIDER,
  jobResultDueAt,
  newJobPublicId,
  overdueJobWhere,
  publicBaseUrl,
  sha256Hex,
  syncFleetJobTaskTx,
} from './service.js';
import { recordDownload } from '../../lib/platform-stats.js';
import { actorOf, recordProbeDownload } from '../tools/downloads.js';

/** 管理员发起测评时没写备注，记这一句。 */
const DEFAULT_JOB_REASON = '管理员发起';

const page = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
const idParams = z.object({ id: z.string().uuid() });
const isOnline = (lastSeenAt: Date | null, now = Date.now()) =>
  Boolean(lastSeenAt && now - lastSeenAt.getTime() <= ONLINE_WINDOW_MS);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

type UserRef = Pick<User, 'id' | 'username' | 'displayName'> | null;
const userRef = (u: UserRef) =>
  u ? { id: u.id, username: u.username, displayName: u.displayName } : null;
const userSelect = { select: { id: true, username: true, displayName: true } } as const;

const JOB_STATUS_KEY: Record<FleetJobStatus, string> = {
  PENDING_APPROVAL: 'pending_approval',
  QUEUED: 'queued',
  DELIVERED: 'delivered',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
};

/** 心跳 health 里采集器上报的智能体（当前采集器尚未上报时为空数组，不做推断）。 */
function healthAgents(health: unknown) {
  const h = rec(health);
  const runner = rec(h.capabilities).eval_runner;
  return endpointAgents(null, health, typeof runner === 'string' ? runner : null);
}

function currentEndpointAgents(report: unknown, health: unknown, runner: string | null) {
  const h = rec(health);
  const hasCurrentInventory = Array.isArray(h.agents) || Array.isArray(rec(h.collector).agents);
  return endpointAgents(hasCurrentInventory ? null : report, health, runner);
}

/** 脱敏后的 health 摘要：只挑白名单字段，不回显原始 health。 */
function healthSummary(health: unknown) {
  if (health == null) return null;
  const h = rec(health);
  const c = rec(h.collector);
  const pick = (o: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(
      keys
        .filter((k) => k in o && (typeof o[k] !== 'object' || o[k] === null))
        .map((k) => [k, o[k]]),
    );
  return redactJson({
    ...pick(h, ['queue_events', 'queue_bytes', 'dropped_events', 'last_upload_error']),
    capabilities: Object.fromEntries(
      Object.entries(rec(h.capabilities))
        .filter(([, v]) => typeof v === 'string')
        .slice(0, 32),
    ),
    collector: pick(c, [
      'last_error',
      'last_eval_job_error',
      'last_eval_job_id',
      'last_scan_at',
      'assets_observed',
      'source_revision',
      'coverage',
      'last_credential_delivery_error',
      'last_managed_config_error',
      'last_audit_error',
    ]),
  });
}

type LatestReport = {
  endpointId: string;
  reportId: string;
  scannedAt: Date;
  status: string;
  assetCount: number;
  body?: unknown;
};
/** 终端责任人；没设姓名视为未设置。 */
function endpointOwner(e: Pick<FleetEndpoint, 'ownerName' | 'ownerDepartment' | 'ownerUserId' | 'ownerUpdatedAt'>) {
  return e.ownerName
    ? { name: e.ownerName, department: e.ownerDepartment, userId: e.ownerUserId, updatedAt: iso(e.ownerUpdatedAt) }
    : null;
}

function serializeEndpoint(
  e: FleetEndpoint & { enrollmentCode?: { id: string; label: string; codePrefix: string } | null },
  latest: LatestReport | undefined,
  now = Date.now(),
  activeJob: { id: string; status: string } | null = null,
) {
  return {
    id: e.id,
    tenantId: e.tenantId ?? null,
    publicId: e.publicId,
    platform: 'jiandun' as const,
    hostname: e.hostname,
    os: e.os,
    osVersion: e.osVersion,
    arch: e.arch,
    osUser: e.osUser,
    agentVersion: e.agentVersion,
    capabilities: e.capabilities,
    status: e.status,
    online: e.status === 'ACTIVE' && isOnline(e.lastSeenAt, now),
    lastSeenAt: iso(e.lastSeenAt),
    evalRunner: e.evalRunner,
    agents: currentEndpointAgents(latest?.body, e.lastHealth, e.evalRunner),
    registeredAt: iso(e.registeredAt),
    revokedAt: iso(e.revokedAt),
    owner: endpointOwner(e),
    enrollmentCode: e.enrollmentCode
      ? {
          id: e.enrollmentCode.id,
          label: e.enrollmentCode.label,
          codePrefix: e.enrollmentCode.codePrefix,
        }
      : null,
    activeJob,
    latestReport: latest
      ? {
          reportId: latest.reportId,
          scannedAt: iso(latest.scannedAt),
          status: latest.status,
          assetCount: latest.assetCount,
        }
      : null,
  };
}

type JobRow = FleetEvalJob & {
  endpoint?: Pick<FleetEndpoint, 'id' | 'publicId' | 'hostname'> | null;
  requestedBy?: UserRef;
  approvedBy?: UserRef;
};

/**
 * 读接口不得改库：待审批/排队中且已过 deadline、但后台清扫还没把它落库为 EXPIRED 的任务，
 * 响应里按「已过期」口径返回（与过期处理后一致；finishedAt 取 deadline），库里状态等清扫或写操作路径再改。
 */
const EXPIRABLE_JOB_STATUSES: FleetJobStatus[] = ['PENDING_APPROVAL', 'QUEUED'];
/** 已下发/执行中且回传期限已过、清扫还没落库的任务，同样按落库后的口径返回：失败（result_overdue）。 */
const IN_FLIGHT_JOB_STATUSES: FleetJobStatus[] = ['DELIVERED', 'RUNNING'];
function effectiveJobStatus(
  job: { status: FleetJobStatus; deadline: Date; deliveredAt?: Date | null },
  now = Date.now(),
): FleetJobStatus {
  if (EXPIRABLE_JOB_STATUSES.includes(job.status) && job.deadline.getTime() <= now) return 'EXPIRED';
  if (IN_FLIGHT_JOB_STATUSES.includes(job.status) && jobResultDueAt(job).getTime() <= now) return 'FAILED';
  return job.status;
}
function asLazilyExpired(j: JobRow, now = Date.now()): JobRow {
  const status = effectiveJobStatus(j, now);
  if (status === j.status) return j;
  return status === 'EXPIRED'
    ? { ...j, status, finishedAt: j.deadline, errorCode: 'expired' }
    : { ...j, status, finishedAt: jobResultDueAt(j), errorCode: 'result_overdue' };
}
/** 列表筛选按「已过期口径」的状态：未落库的过期任务算 EXPIRED，不算原状态。 */
function effectiveStatusWhere(
  statuses: FleetJobStatus[],
  now: Date,
): Prisma.FleetEvalJobWhereInput {
  const stale: Prisma.FleetEvalJobWhereInput = {
    status: { in: EXPIRABLE_JOB_STATUSES },
    deadline: { lte: now },
  };
  const overdue = overdueJobWhere(now);
  return {
    OR: [
      { status: { in: statuses }, NOT: [stale, overdue] },
      ...(statuses.includes('EXPIRED') ? [stale] : []),
      ...(statuses.includes('FAILED') ? [overdue] : []),
    ],
  };
}

function serializeJob(raw: JobRow) {
  const j = asLazilyExpired(raw);
  let suite: 'classic' | 'runtime_v2' | null = null;
  try {
    const packId = rec(rec(JSON.parse(j.payloadCanonical)).scenario_pack).pack_id;
    suite = packId === 'endpoint-agent-v1' ? 'classic' : packId === 'endpoint-agent-v2' ? 'runtime_v2' : null;
  } catch { /* 历史载荷损坏时保持未知 */ }
  return {
    id: j.id,
    tenantId: j.tenantId ?? null,
    publicId: j.publicId,
    endpointId: j.endpointId,
    endpoint: j.endpoint
      ? { id: j.endpoint.id, publicId: j.endpoint.publicId, hostname: j.endpoint.hostname }
      : null,
    evalTaskId: j.evalTaskId,
    product: j.product,
    checksum: j.checksum,
    scenarioCount: j.scenarioCount,
    sampleCount: jobSampleCount(j.payloadCanonical), suite,
    status: j.status,
    statusLabel: FLEET_STATUS_LABELS[JOB_STATUS_KEY[j.status]] ?? j.status,
    reason: j.reason,
    rejectReason: j.rejectReason,
    errorCode: j.errorCode,
    errorReason: j.errorCode
      ? (LIVE_EVAL_BLOCKED_REASONS[j.errorCode] ?? '终端未完成检查，请查看场景执行原因。')
      : null,
    requestedBy: userRef(j.requestedBy ?? null),
    approvedBy: userRef(j.approvedBy ?? null),
    approvedAt: iso(j.approvedAt),
    deadline: iso(j.deadline),
    deliveredAt: iso(j.deliveredAt),
    startedAt: iso(j.startedAt),
    finishedAt: iso(j.finishedAt),
    createdAt: iso(j.createdAt),
    updatedAt: iso(j.updatedAt),
  };
}
const jobInclude = {
  endpoint: { select: { id: true, publicId: true, hostname: true } },
  requestedBy: userSelect,
  approvedBy: userSelect,
} as const;

/** 详情：给审批人看要在终端上执行什么（场景标题、提示词、夹具路径），不含诱饵值与落点令牌。 */
function jobScenarios(canonical: string) {
  try {
    const payload = JSON.parse(canonical) as {
      scenario_pack?: { pack_id?: string; scenarios?: unknown[] };
    };
    return {
      packId: payload.scenario_pack?.pack_id ?? null,
      scenarios: (payload.scenario_pack?.scenarios ?? []).map((s) => {
        const r = rec(s);
        return {
          scenarioId: r.scenario_id,
          title: r.title,
          prompt: r.prompt,
          fixturePaths: (Array.isArray(r.fixtures) ? r.fixtures : []).map((f) => rec(f).path),
          maxTurns: r.max_turns,
          timeoutSec: r.timeout_sec,
        };
      }),
    };
  } catch {
    return { packId: null, scenarios: [] };
  }
}

function codeStatus(
  c: { status: string; expiresAt: Date; usedCount: number; maxUses: number },
  now = Date.now(),
) {
  if (c.status === 'REVOKED') return 'REVOKED';
  if (c.status === 'EXPIRED' || c.expiresAt.getTime() <= now) return 'EXPIRED';
  if (c.usedCount >= c.maxUses) return 'EXHAUSTED';
  return 'ACTIVE';
}

function audit(
  request: FastifyRequest,
  action: string,
  targetType: string,
  targetId: string,
  detail?: unknown,
) {
  return writeAudit({
    actorId: request.currentUser!.id,
    actorName: request.currentUser!.username,
    action,
    targetType,
    targetId,
    ip: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    detail,
  });
}

type AgentGroupRow = {
  groupKey: string; endpointId: string; endpointName: string; user: string | null; os: string; source: 'jiandun' | 'agentshield';
  agentName: string; assets?: { skills: number; mcp: number } | null;
};

/**
 * 资产台账的终端分组：责任人、资产汇总（智能体/Skill/MCP/平台）、风险数，与终端详情页同一口径（buildEndpointOverview）；
 * 顺带给每个智能体行写上它自己的 Skill/MCP 数。智能体安全平台来源的终端只有平台上报的使用人，没有资产与风险。
 */
function buildAgentGroups(
  items: AgentGroupRow[],
  endpoints: FleetEndpoint[],
  reports: Map<string, LatestReport>,
  platformOnline: Map<string, boolean> = new Map(),
) {
  const byId = new Map(endpoints.map((e) => [e.id, e]));
  const groups = new Map<string, {
    key: string; endpointId: string; source: 'jiandun' | 'agentshield'; name: string; os: string; osUser: string | null;
    online: boolean | null; owner: ReturnType<typeof endpointOwner> | { name: string; department: null; userId: null; updatedAt: null };
    ownerSource: 'manual' | 'reported' | null;
    assets: { agents: number; skills: number; mcp: number; platforms: number } | null;
    risks: { open: number; high: number } | null;
  }>();
  for (const row of items) {
    const key = row.groupKey;
    if (row.source === 'agentshield') {
      if (!groups.has(key)) groups.set(key, {
        key, endpointId: row.endpointId, source: 'agentshield', name: row.endpointName, os: row.os, osUser: null,
        online: platformOnline.get(key) ?? null,
        owner: row.user ? { name: row.user, department: null, userId: null, updatedAt: null } : null,
        ownerSource: row.user ? 'reported' : null, assets: null, risks: null,
      });
      // 同一台机器的多条登记里，使用人可能只有其中一条上报。
      const group = groups.get(key)!;
      if (!group.owner && row.user) {
        group.owner = { name: row.user, department: null, userId: null, updatedAt: null };
        group.ownerSource = 'reported';
      }
      row.assets = null;
      continue;
    }
    const endpoint = byId.get(row.endpointId);
    if (!endpoint) continue;
    if (!groups.has(key)) {
      const report = reports.get(endpoint.id);
      let assets = null, risks = null;
      let perAgent = new Map<string, { skills: number; mcp: number }>();
      if (report) {
        const overview = buildEndpointOverview(report, endpoint, [], mcpAllowlist());
        assets = { agents: overview.counts.agentKinds, skills: overview.counts.skills, mcp: overview.counts.mcpServers,
          platforms: overview.counts.platformKinds ?? overview.platforms.length };
        risks = { open: overview.counts.openRisks, high: overview.counts.highRisks };
        perAgent = new Map();
        const bump = (agent: string, field: 'skills' | 'mcp') => {
          const cur = perAgent.get(agent) ?? { skills: 0, mcp: 0 };
          cur[field] += 1;
          perAgent.set(agent, cur);
        };
        for (const skill of overview.skills) for (const agent of new Set(skill.installedIn)) bump(agent, 'skills');
        for (const mcp of overview.mcp) for (const agent of new Set(mcp.installedIn)) bump(agent, 'mcp');
      }
      groups.set(key, {
        key, endpointId: endpoint.id, source: 'jiandun', name: endpoint.hostname, os: endpoint.os, osUser: endpoint.osUser || null,
        online: endpoint.status === 'ACTIVE' && isOnline(endpoint.lastSeenAt),
        owner: endpointOwner(endpoint), ownerSource: endpoint.ownerName ? 'manual' : null, assets, risks,
      });
      (groups.get(key) as unknown as { perAgent: typeof perAgent }).perAgent = perAgent;
    }
    const perAgent = (groups.get(key) as unknown as { perAgent?: Map<string, { skills: number; mcp: number }> }).perAgent;
    row.assets = perAgent ? (perAgent.get(row.agentName) ?? { skills: 0, mcp: 0 }) : null;
  }
  return [...groups.values()].map((group) => {
    const { perAgent: _perAgent, ...rest } = group as typeof group & { perAgent?: unknown };
    return rest;
  });
}

async function latestReports(endpointIds: string[]): Promise<Map<string, LatestReport>> {
  if (!endpointIds.length) return new Map();
  const heads = await prisma.fleetProbeReport.findMany({
    where: { endpointId: { in: endpointIds } },
    orderBy: [{ endpointId: 'asc' }, { scannedAt: 'desc' }, { id: 'desc' }],
    distinct: ['endpointId'],
    select: { id: true, endpointId: true },
  });
  const rows = await prisma.fleetProbeReport.findMany({
    where: { id: { in: heads.map((head) => head.id) } },
    select: { endpointId: true, reportId: true, scannedAt: true, status: true, assetCount: true, body: true },
  });
  return new Map(rows.map((r) => [r.endpointId, r]));
}

const lockJob = (tx: Prisma.TransactionClient, id: string) =>
  tx.$queryRaw`SELECT id FROM fleet_eval_jobs WHERE id = ${id} FOR UPDATE`;

/** 终端实际访问本平台所用的地址（trustProxy 已开启，取反代传来的协议与主机）。 */
function requestOrigin(request: FastifyRequest): string | null {
  const host = request.headers.host;
  if (!host || !/^[A-Za-z0-9.\-:\[\]]+$/.test(host)) return null;
  return `${request.protocol}://${host}`;
}

/** 创建测评任务所需的、与场景包种类（classic / runtime_v2）无关的参数。pack 已构建好。 */
interface FleetEvalJobPlan {
  endpointId: string;
  body: FleetEvalJobBody;
  reason: string;
  sink: string;
  runToken: string;
  pack: EndpointPack;
  /** 在终端行锁内、离线检查之后执行的能力检查；不满足时抛 409。 */
  checkCapability?: (health: unknown) => void;
  /** 未指定 name 时的任务名（不含重测后缀）。 */
  defaultName: (hostname: string) => string;
  /** 下发 payload 的 canonical 原文字节数上限；缺省不检查。 */
  maxPayloadBytes?: number;
  requireCurrentReadiness?: boolean;
  queueDelayMs?: number;
  createdAt?: Date;
  sampleVersions?: Array<{ id: string; version: number; digest: string }>;
  pinnedSampleIds?: string[];
}

function snapshotVersions(pack: EndpointPack, catalog: CatalogEntry[]) {
  const ids = new Set(pack.scenarios.map((scenario) => scenario.sample_id ?? scenario.scenario_id));
  return catalog.filter((entry) => ids.has(entry.id) || ids.has(`${entry.id}.py`) || ids.has(`${entry.id}.node`))
    .map(({ id, version, digest }) => ({ id, version, digest }));
}

/**
 * 经典测评与运行态测评共用的创建流程：校验场景包、固化 payload、在终端行锁内做各项检查并写入
 * EvalTask / 题目 / 绑定记录 / FleetEvalJob，最后记审计。auditExtra 并入审计 detail（经典测评为空）。
 */
async function createFleetEvalJob(
  request: FastifyRequest,
  plan: FleetEvalJobPlan,
  auditExtra: Record<string, unknown> = {},
  transaction?: Prisma.TransactionClient,
  allowQueued = false,
) {
  const { endpointId: id, body, reason, sink, runToken, pack } = plan;
  const user = request.currentUser!;
  const packError = validateScenarioPack(pack);
  if (packError) throw badRequest(`场景包不合法：${packError}`);
  let payload: { canonical: string; checksum: string };
  try {
    payload = buildJobPayload(body.product, pack, sink);
  } catch (error) {
    // 运行态测评：载荷总量超限用专门的错误码，前端据此显示"缩小范围"的提示；其余载荷错误沿用通用码。
    if (error instanceof FleetPayloadError && plan.maxPayloadBytes !== undefined && /超过 \d+ 字节（1 MiB）上限/.test(error.message))
      throw badRequest(`下发内容超过上限 ${plan.maxPayloadBytes} 字节：${error.message}`, 'FLEET_RUNTIME_TOO_LARGE');
    if (error instanceof FleetPayloadError) throw badRequest(`测评任务不合法：${error.message}`);
    throw error;
  }
  if (plan.maxPayloadBytes !== undefined) {
    const bytes = Buffer.byteLength(payload.canonical, 'utf8');
    if (bytes > plan.maxPayloadBytes)
      throw badRequest(
        `下发内容 ${bytes} 字节超过上限 ${plan.maxPayloadBytes} 字节，请缩小范围：减少攻击类别、重复次数、项目模板或防护臂`,
        'FLEET_RUNTIME_TOO_LARGE',
      );
  }
  const publicId = newJobPublicId();
  const persist = async (tx: Prisma.TransactionClient) => {
      await lockEndpoint(tx, id);
      if (plan.sampleVersions?.length) {
        const ids = plan.sampleVersions.map((entry) => entry.id).sort();
        await tx.$queryRaw`SELECT id FROM agent_samples WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR SHARE`;
        const current = await tx.agentSample.findMany({ where: { id: { in: ids } }, select: { id: true, enabled: true, currentVersion: true } });
        if (current.length !== ids.length || plan.sampleVersions.some((entry) => !current.some((item) =>
          item.id === entry.id && item.enabled && (plan.pinnedSampleIds?.includes(entry.id) || item.currentVersion === entry.version))))
          throw conflict('样本状态或版本已变化，请刷新后重新发起');
        const versions = await tx.agentSampleVersion.findMany({ where: { OR: plan.sampleVersions.map((entry) => ({ sampleId: entry.id, version: entry.version })) },
          select: { sampleId: true, version: true, digest: true } });
        if (plan.sampleVersions.some((entry) => !versions.some((item) => item.sampleId === entry.id && item.version === entry.version && item.digest === entry.digest)))
          throw conflict('样本版本已变化，请刷新后重新发起');
      }
      const e = await tx.fleetEndpoint.findUnique({ where: { id } });
      if (!e) throw notFound('终端不存在');
      if (e.status !== 'ACTIVE')
        throw conflict('终端已吊销，不能发起测评', 'FLEET_ENDPOINT_REVOKED');
      if (!e.evalRunner)
        throw conflict(
          '该终端未开启真机测评能力（心跳未上报测评运行器），仅可做配置体检',
          'FLEET_EVAL_RUNNER_UNAVAILABLE',
        );
      if (!e.lastSeenAt || Date.now() - e.lastSeenAt.getTime() > EVAL_OFFLINE_LIMIT_MS)
        throw conflict(
          '终端离线已超过 24 小时，请确认采集器在运行后再发起',
          'FLEET_ENDPOINT_OFFLINE',
        );
      if (plan.requireCurrentReadiness && !isOnline(e.lastSeenAt))
        throw conflict('终端当前离线，请等待终端重新上线后再发起', 'FLEET_ENDPOINT_OFFLINE');
      plan.checkCapability?.(e.lastHealth);
      if (body.retestOfTaskId) {
        const previous = await tx.fleetEvalJob.findFirst({
          where: { endpointId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { evalTaskId: true },
        });
        if (!previous || previous.evalTaskId !== body.retestOfTaskId)
          throw badRequest('重测来源必须是同一终端的上一个测评任务');
      }
      const agents = healthAgents(e.lastHealth);
      if (agents.length && !agents.some((a) => a.product === body.product))
        throw conflict('该终端未上报安装此智能体，无法发起测评', 'FLEET_PRODUCT_UNAVAILABLE');
      if (plan.requireCurrentReadiness) {
        const report = await tx.fleetProbeReport.findFirst({ where: { endpointId: id }, orderBy: { scannedAt: 'desc' } });
        const agent = currentEndpointAgents(report?.body, e.lastHealth, e.evalRunner).find((item) => item.product === body.product);
        if (!agent || !agent.liveEvalSupported || !agent.liveEvalRegistered || agent.liveEvalBlockedReason)
          throw conflict(agent?.liveEvalBlockedReason ?? '终端尚未上报该智能体的可测状态', 'FLEET_AGENT_NOT_READY');
      }
      const open = await tx.fleetEvalJob.findFirst({
        where: { endpointId: id, status: { in: [...OPEN_JOB_STATUSES] } },
        select: { publicId: true, status: true },
      });
      if (open && !allowQueued)
        throw conflict(
          '该终端已有未结束的测评任务，请等待其结束或取消后再发起',
          'FLEET_JOB_IN_PROGRESS',
        );
      const target = await ensureFleetTarget(tx, e, user.id);
      const task = await tx.evalTask.create({
        data: {
          name: `${body.name ?? plan.defaultName(e.hostname)}${body.retestOfTaskId ? ' 重测' : ''}`,
          description: FLEET_STATUS_LABELS.queued,
          modelTargetId: target.id,
          createdById: user.id,
          engines: [ENDPOINT_ENGINE],
          dimensions: ['agent_tool_call'],
          totalQuestions: pack.scenarios.length,
        },
      });
      await createQuestions(
        tx,
        task,
        pack.scenarios.map((s) => ({ id: s.scenario_id, title: s.title, prompt: s.prompt })),
      );
      // jobId 留空：AgentShield 轮询/回调只认 jobId，不会误触自管终端任务；自管终端按 fleetJobId 绑定。
      const binding: JobBinding = {
        jobId: '',
        product: body.product,
        runToken,
        pack,
        source: 'fleet',
        fleetJobId: publicId,
        ...(plan.sampleVersions ? { sampleVersions: plan.sampleVersions } : {}),
        ...(body.retestOfTaskId ? { retestOfTaskId: body.retestOfTaskId } : {}),
      };
      await tx.evalTaskLog.create({
        data: { taskId: task.id, message: JOB_LOG, context: json(binding) },
      });
      return tx.fleetEvalJob.create({
        data: {
          publicId,
          endpointId: id,
          evalTaskId: task.id,
          product: body.product,
          payloadCanonical: payload.canonical,
          checksum: payload.checksum,
          scenarioCount: pack.scenarios.length,
          // 创建即进入待终端领取；发起人同时记为批准人（兼容仍按审批字段展示的旧界面与审计）。
          status: 'QUEUED',
          requestedById: user.id,
          approvedById: user.id,
          approvedAt: new Date(),
          reason,
          deadline: new Date(Date.now() + DEFAULT_JOB_DEADLINE_MS + (plan.queueDelayMs ?? 0)),
          ...(plan.createdAt ? { createdAt: plan.createdAt } : {}),
        },
        include: jobInclude,
      });
    };
  const created = transaction ? await persist(transaction) : await prisma.$transaction(persist, { timeout: 30_000 });
  if (!transaction) await audit(request, 'fleet.eval_job.create', 'fleet_eval_job', created.id, {
    endpointId: id,
    jobId: created.publicId,
    taskId: created.evalTaskId,
    product: created.product,
    checksum: created.checksum,
    reason: created.reason,
    ...auditExtra,
  });
  return created;
}

export interface FleetAdminRoutesOptions {
  /** 远程部署（2.4.8）：测试注入假的 SSH 实现 */
  remoteDeploy?: RemoteDeployRoutesOptions;
}

export async function fleetAdminRoutes(
  app: FastifyInstance,
  options: FleetAdminRoutesOptions = {},
): Promise<void> {
  app.addHook('onRequest', async (request) => {
    if (!fleetAgentEnabled() && !request.url.split('?')[0]!.endsWith('/fleet/config'))
      throw notFound('终端接入未启用');
  });
  // 清扫里单个任务处理失败：带任务编号记到服务日志，不影响其余任务。
  const logJobError: FleetJobErrorLog = (message, jobId, error) =>
    app.log.error({ jobId, err: { message: (error as Error)?.message } }, `终端测评${message}`);
  // 过期任务的落库放到后台清扫（以及发起/审批/取消等写操作路径）：GET 接口只读，不再改库。
  let sweeping = false;
  const sweepTimer = setInterval(async () => {
    if (sweeping || !fleetAgentEnabled()) return;
    sweeping = true;
    try {
      await expireStaleJobs({}, logJobError);
    } catch (error) {
      app.log.warn({ err: error }, '终端测评过期清扫失败');
    }
    // 远程部署：执行进程已没了的置为部署中断，过期没执行的一次性命令置为已过期。
    try {
      await sweepRemoteDeploys();
    } catch (error) {
      app.log.warn({ err: error }, '远程部署清扫失败');
    } finally {
      sweeping = false;
    }
  }, 60_000);
  sweepTimer.unref();
  app.addHook('onClose', async () => clearInterval(sweepTimer));
  const read = [authenticate, requirePermission(PERM_READ)];
  const manage = [authenticate, requirePermission(PERM_MANAGE)];
  // 发起体检/测评：管理权限 + 创建评估任务权限（两者同时具备，AND）。
  const createTask = [
    authenticate,
    requirePermission(PERM_MANAGE),
    requirePermission(PERM_CREATE_TASK),
    requireLicensedFeature('web_ai'),
  ];

  // ───────────────────────────── 远程部署（2.4.8） ─────────────────────────────
  // 启动时把被重启打断的部署置为失败、过期的一次性命令置为已过期，清理上次留下的临时目录。
  await failInterruptedRemoteDeploys().catch((err: unknown) =>
    app.log.warn({ err }, '远程部署启动清理失败'),
  );
  await app.register(remoteDeployRoutes, { prefix: '/remote-deploys', ...options.remoteDeploy });

  // ───────────────────────────── 接入码 ─────────────────────────────
  app.post('/enrollment-codes', { preHandler: manage }, async (request, reply) => {
    const body = z
      .object({
        label: z.string().trim().min(1).max(200),
        expiresInHours: z.number().int().min(1).max(168).default(24),
        maxUses: z.number().int().min(1).max(1000).default(1),
      })
      .parse(request.body ?? {});
    const code = `jdc_${randomBytes(32).toString('base64url')}`;
    const row = await prisma.fleetEnrollmentCode.create({
      data: {
        label: body.label,
        codeHash: sha256Hex(code),
        codePrefix: code.slice(0, 8),
        maxUses: body.maxUses,
        expiresAt: new Date(Date.now() + body.expiresInHours * 3600_000),
        createdById: request.currentUser!.id,
      },
      include: { createdBy: userSelect },
    });
    await audit(request, 'fleet.enrollment_code.create', 'fleet_enrollment_code', row.id, {
      label: row.label,
      codePrefix: row.codePrefix,
      maxUses: row.maxUses,
      expiresAt: row.expiresAt.toISOString(),
    });
    return reply.code(201).send({
      code,
      notice: '接入码明文只显示这一次，请立即复制保存',
      item: serializeCode({ ...row, _count: { endpoints: 0 } }),
    });
  });

  function serializeCode(
    c: Prisma.FleetEnrollmentCodeGetPayload<{ include: { createdBy: typeof userSelect } }> & {
      _count: { endpoints: number };
    },
  ) {
    return {
      id: c.id,
      label: c.label,
      codePrefix: c.codePrefix,
      maxUses: c.maxUses,
      usedCount: c.usedCount,
      remainingUses: Math.max(0, c.maxUses - c.usedCount),
      endpointCount: c._count.endpoints,
      status: codeStatus(c),
      expiresAt: iso(c.expiresAt),
      createdAt: iso(c.createdAt),
      revokedAt: iso(c.revokedAt),
      createdBy: userRef(c.createdBy),
    };
  }

  app.get('/enrollment-codes', { preHandler: manage }, async (request) => {
    const q = z
      .object({ ...page, status: z.enum(['ACTIVE', 'EXPIRED', 'REVOKED', 'EXHAUSTED']).optional() })
      .parse(request.query);
    const now = new Date();
    const where: Prisma.FleetEnrollmentCodeWhereInput =
      q.status === 'REVOKED'
        ? { status: 'REVOKED' }
        : q.status === 'EXPIRED'
          ? { OR: [{ status: 'EXPIRED' }, { status: 'ACTIVE', expiresAt: { lte: now } }] }
          : q.status === 'ACTIVE' || q.status === 'EXHAUSTED'
            ? { status: 'ACTIVE', expiresAt: { gt: now } }
            : {};
    // 「可用/已用尽」需要比较两列，数据量小，内存过滤后再分页。
    const needsUsageFilter = q.status === 'ACTIVE' || q.status === 'EXHAUSTED';
    const include = { createdBy: userSelect, _count: { select: { endpoints: true } } } as const;
    if (needsUsageFilter) {
      const all = (
        await prisma.fleetEnrollmentCode.findMany({
          where,
          include,
          orderBy: { createdAt: 'desc' },
        })
      ).filter((c) => codeStatus(c) === q.status);
      return {
        items: all.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map(serializeCode),
        total: all.length,
        page: q.page,
        pageSize: q.pageSize,
      };
    }
    const [rows, total] = await Promise.all([
      prisma.fleetEnrollmentCode.findMany({
        where,
        include,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.fleetEnrollmentCode.count({ where }),
    ]);
    return { items: rows.map(serializeCode), total, page: q.page, pageSize: q.pageSize };
  });

  app.post('/enrollment-codes/:id/revoke', { preHandler: manage }, async (request) => {
    const { id } = idParams.parse(request.params);
    const row = await prisma.fleetEnrollmentCode.findUnique({ where: { id } });
    if (!row) throw notFound('接入码不存在');
    if (row.status !== 'REVOKED') {
      await prisma.fleetEnrollmentCode.update({
        where: { id },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      await audit(request, 'fleet.enrollment_code.revoke', 'fleet_enrollment_code', id, {
        label: row.label,
        codePrefix: row.codePrefix,
      });
    }
    const updated = await prisma.fleetEnrollmentCode.findUniqueOrThrow({
      where: { id },
      include: { createdBy: userSelect, _count: { select: { endpoints: true } } },
    });
    return serializeCode(updated);
  });

  // 开关状态：登录用户可读；开关关闭时也返回 200，供前端决定是否展示入口。
  app.get('/config', { preHandler: [authenticate] }, async () => ({
    enabled: fleetAgentEnabled(),
  }));

  // ───────────────────────────── 终端清单 ─────────────────────────────
  app.get('/check-catalog', { preHandler: read }, async () => CHECK_CATALOG);

  // 终端责任人（资产台账）。姓名留空 = 清除；可关联本租户的平台用户。
  app.patch('/endpoints/:id/owner', { preHandler: manage }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({
      name: z.string().trim().max(64, '责任人姓名不超过 64 字'),
      department: z.string().trim().max(64, '部门不超过 64 字').optional(),
      userId: z.string().uuid().nullable().optional(),
    }).parse(request.body ?? {});
    const endpoint = await prisma.fleetEndpoint.findUnique({ where: { id } });
    if (!endpoint || endpoint.removedAt) throw notFound('终端不存在');
    let userId: string | null = null;
    if (body.name && body.userId) {
      const user = await prisma.user.findFirst({
        where: { id: body.userId, tenantId: request.currentUser!.tenantId },
        select: { id: true },
      });
      if (!user) throw badRequest('所选用户不存在');
      userId = user.id;
    }
    const updated = await prisma.fleetEndpoint.update({
      where: { id },
      data: body.name
        ? { ownerName: body.name, ownerDepartment: body.department || null, ownerUserId: userId, ownerUpdatedAt: new Date() }
        : { ownerName: null, ownerDepartment: null, ownerUserId: null, ownerUpdatedAt: new Date() },
    });
    await audit(request, 'fleet.endpoint.owner', 'fleet_endpoint', id, {
      hostname: endpoint.hostname,
      before: endpointOwner(endpoint)?.name ?? null,
      after: endpointOwner(updated)?.name ?? null,
    });
    return { id, owner: endpointOwner(updated) };
  });

  app.get('/agents', { preHandler: read }, async (request) => {
    const q = z.object({ ...page, q: z.string().trim().max(200).optional(), endpointId: z.string().min(1).max(200).optional(),
      tenantId: z.string().uuid().optional(), groupBy: z.enum(['endpoint']).optional() }).parse(request.query);
    const endpoints = await prisma.fleetEndpoint.findMany({
      where: { status: 'ACTIVE', removedAt: null, ...(q.endpointId ? { id: q.endpointId } : {}),
        ...tenantFilterWhere(request) }, orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { registeredAt: 'desc' }],
    });
    const ids = endpoints.map((endpoint) => endpoint.id);
    const [reportByEndpoint, jobs] = ids.length ? await Promise.all([
      latestReports(ids),
      prisma.fleetEvalJob.findMany({ where: { endpointId: { in: ids } },
        orderBy: [{ endpointId: 'asc' }, { product: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
        distinct: ['endpointId', 'product'], select: { id: true, endpointId: true, evalTaskId: true,
          product: true, status: true, deadline: true, deliveredAt: true, createdAt: true } }),
    ]) : [new Map<string, LatestReport>(), []];
    const jobByAgent = new Map(jobs.map((job) => [`${job.endpointId}\0${job.product}`, job]));
    type AgentListRow = { tenantId: string | null; groupKey: string; endpointId: string; endpointName: string; user: string | null; os: string;
      source: 'jiandun' | 'agentshield'; agentKey: string; agentName: string; version: string | null;
      status: 'offline' | 'unsupported' | 'needs_attention' | 'ready' | 'platform_managed'; reason: string | null;
      /** 仅智能体安全平台来源：该登记上报的测评执行器版本。 */
      evalRunnerVersion?: string | null;
      scope: 'all' | 'classic_only'; runtimeV2: boolean;
      latest: { jobId: string; taskId: string | null; status: FleetJobStatus; createdAt: string; conclusion: string | null } | null;
      ownerText?: string; assets?: { skills: number; mcp: number } | null };
    const rows: AgentListRow[] = endpoints.flatMap((endpoint) => {
      const report = reportByEndpoint.get(endpoint.id);
      const inventory = currentEndpointAgents(report?.body, endpoint.lastHealth, endpoint.evalRunner).map((agent) => ({
        key: agent.product, name: agent.displayName, version: agent.version, supported: agent.liveEvalSupported,
        registered: agent.liveEvalRegistered, reason: agent.liveEvalBlockedReason ?? null, runtimeV2: agent.runtimeV2,
      }));
      const unique = [...new Map(inventory.map((agent) => [agent.key, agent])).values()];
      return unique.map((agent) => {
        const online = isOnline(endpoint.lastSeenAt);
        const status = !online ? 'offline' : !agent.supported ? 'unsupported' : !agent.registered || agent.reason ? 'needs_attention' : 'ready';
        const job = jobByAgent.get(`${endpoint.id}\0${agent.key}`);
        return {
          tenantId: endpoint.tenantId ?? null, groupKey: `jiandun\0${endpoint.id}`,
          endpointId: endpoint.id, endpointName: endpoint.hostname, user: endpoint.osUser || null, os: endpoint.os,
          source: 'jiandun' as const, agentKey: agent.key, agentName: agent.name, version: agent.version,
          ownerText: [endpoint.ownerName, endpoint.ownerDepartment].filter(Boolean).join(' '),
          status, reason: !online ? '终端离线' : agent.reason ?? null,
          scope: agent.runtimeV2 ? 'all' : 'classic_only', runtimeV2: agent.runtimeV2,
          latest: job ? { jobId: job.id, taskId: job.evalTaskId, status: effectiveJobStatus(job),
            createdAt: job.createdAt.toISOString(), conclusion: null as string | null } : null,
        };
      });
    });
    let connectorStatus: 'available' | 'unavailable' | 'not_configured' | 'permission_required' = 'not_configured';
    const connectorAllowed = request.currentUser!.permissions.has('model_target:create') || request.currentUser!.permissions.has('eval_task:create');
    // 平台来源的机器是否在线：任一登记在线即在线。
    const platformOnline = new Map<string, boolean>();
    // AgentShield 连接器的终端清单全平台共用：只给平台租户并入本租户的终端列表。
    if (!q.endpointId && process.env.LSE_AGENTSHIELD_BASE_URL && request.currentUser!.tenantIsPlatform) {
      if (!connectorAllowed) connectorStatus = 'permission_required';
      else try {
        const remote = await new AgentShieldClient().endpoints();
        if (!Array.isArray(remote)) throw new Error('连接器清单格式不正确');
        connectorStatus = 'available';
        // 平台是「每个智能体一条登记」：按机器合并，同一产品只留一行。
        const inventory = mergePlatformEndpoints(remote);
        for (const [key, lastSeenAt] of inventory.machineLastSeenAt) platformOnline.set(key, isOnline(lastSeenAt));
        for (const entry of inventory.entries) {
          // 从没发过心跳的登记和心跳超过在线窗口的一样，都是离线。
          const offline = !isOnline(entry.lastSeenAt);
          rows.push({ tenantId: null, groupKey: entry.groupKey, endpointId: entry.endpointId, endpointName: entry.endpointName,
            user: entry.user, os: entry.os, source: 'agentshield', agentKey: entry.product,
            agentName: fleetAgentDisplayName(entry.product), version: entry.version,
            // 平台来源的测评登记不归本平台管：在线的行只标「平台管理」，不再标成本平台处理不了的「需处理」。
            status: offline ? 'offline' : 'platform_managed', reason: offline ? '终端离线' : null,
            evalRunnerVersion: entry.evalRunnerVersion, scope: 'classic_only', runtimeV2: false, latest: null });
        }
      } catch (error) {
        connectorStatus = 'unavailable';
        request.log.warn({ err: error }, '读取智能体安全平台终端失败');
      }
    }
    const filteredRows = rows.filter((row) => !q.q || [row.agentName, row.endpointName, row.user ?? '', row.version ?? '', row.ownerText ?? '']
      .some((value) => value.toLowerCase().includes(q.q!.toLowerCase())));
    // 按终端分组（资产台账视图）：分页单位是终端，一台终端的智能体不会被拆到两页。
    const groupKey = (row: AgentListRow) => row.groupKey;
    const groupKeys = [...new Set(filteredRows.map(groupKey))];
    const pageKeys = new Set(groupKeys.slice((q.page - 1) * q.pageSize, q.page * q.pageSize));
    const items = q.groupBy === 'endpoint'
      ? filteredRows.filter((row) => pageKeys.has(groupKey(row)))
      : filteredRows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    const endpointTenants = new Map(endpoints.map((e) => [e.id, e.tenantId ?? null]));
    const groups = q.groupBy === 'endpoint'
      ? buildAgentGroups(items, endpoints, reportByEndpoint, platformOnline).map((g) => ({
          ...g,
          tenantId: g.source === 'agentshield' ? null : endpointTenants.get(g.endpointId) ?? null,
        }))
      : undefined;
    const taskIds = items.flatMap((item) => item.latest?.taskId && ['COMPLETED', 'FAILED'].includes(item.latest.status) ? [item.latest.taskId] : []);
    const existing = new Set((await prisma.evalTask.findMany({ where: { id: { in: taskIds } }, select: { id: true } })).map((task) => task.id));
    for (let offset = 0; offset < items.length; offset += 5) await Promise.all(items.slice(offset, offset + 5).map(async (item) => {
      if (!item.latest?.taskId || !existing.has(item.latest.taskId) || !['COMPLETED', 'FAILED'].includes(item.latest.status)) return;
      try { item.latest.conclusion = (await loadEndpointSummary(prisma, item.latest.taskId)).verdictLine; }
      catch (error) { request.log.warn({ err: error, taskId: item.latest.taskId }, '读取智能体最近测评结论失败'); }
    }));
    for (const item of items) delete item.ownerText;
    return { items, total: q.groupBy === 'endpoint' ? groupKeys.length : filteredRows.length, page: q.page, pageSize: q.pageSize,
      connectorStatus, ...(groups ? { groups } : {}) };
  });

  app.get('/endpoints', { preHandler: read }, async (request) => {
    const q = z
      .object({
        ...page,
        q: z.string().trim().max(200).optional(),
        os: z.string().trim().max(50).optional(),
        online: z.enum(['online', 'offline']).optional(),
        status: z.enum(['ACTIVE', 'REVOKED']).optional(),
        evalRunner: z.enum(['yes', 'no']).optional(),
        tenantId: z.string().uuid().optional(),
      })
      .parse(request.query);
    const since = new Date(Date.now() - ONLINE_WINDOW_MS);
    const and: Prisma.FleetEndpointWhereInput[] = [{ removedAt: null }];
    if (q.q)
      and.push({
        OR: [
          { hostname: { contains: q.q, mode: 'insensitive' } },
          { osUser: { contains: q.q, mode: 'insensitive' } },
          { publicId: { contains: q.q, mode: 'insensitive' } },
        ],
      });
    if (q.os) and.push({ os: { equals: q.os, mode: 'insensitive' } });
    if (q.status) and.push({ status: q.status });
    if (q.online === 'online') and.push({ status: 'ACTIVE', lastSeenAt: { gte: since } });
    if (q.online === 'offline')
      and.push({
        OR: [{ status: 'REVOKED' }, { lastSeenAt: null }, { lastSeenAt: { lt: since } }],
      });
    if (q.evalRunner === 'yes') and.push({ evalRunner: { not: null } });
    if (q.evalRunner === 'no') and.push({ evalRunner: null });
    const where: Prisma.FleetEndpointWhereInput = {
      ...(and.length ? { AND: and } : {}),
      ...tenantFilterWhere(request),
    };
    const [rows, total] = await Promise.all([
      prisma.fleetEndpoint.findMany({
        where,
        include: { enrollmentCode: { select: { id: true, label: true, codePrefix: true } } },
        orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { registeredAt: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.fleetEndpoint.count({ where }),
    ]);
    const latest = await latestReports(rows.map((r) => r.id));
    const activeJobs = await prisma.fleetEvalJob.findMany({
      where: {
        endpointId: { in: rows.map((r) => r.id) },
        status: { in: ['PENDING_APPROVAL', 'QUEUED', 'DELIVERED', 'RUNNING'] },
      },
      select: { id: true, status: true, endpointId: true },
    });
    const activeByEndpoint = new Map(
      activeJobs.map((j) => [j.endpointId, { id: j.id, status: j.status }]),
    );
    const now = Date.now();
    return {
      items: rows.map((r) =>
        serializeEndpoint(r, latest.get(r.id), now, activeByEndpoint.get(r.id) ?? null),
      ),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  });

  app.get('/endpoints/:id', { preHandler: read }, async (request) => {
    const { id } = idParams.parse(request.params);
    const e = await prisma.fleetEndpoint.findUnique({
      where: { id },
      include: { enrollmentCode: { select: { id: true, label: true, codePrefix: true } } },
    });
    if (!e) throw notFound('终端不存在');
    const report = await prisma.fleetProbeReport.findFirst({
      where: { endpointId: id },
      orderBy: { scannedAt: 'desc' },
    });
    const jobs = await prisma.fleetEvalJob.findMany({
      where: { endpointId: id },
      include: jobInclude,
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    return {
      ...serializeEndpoint(e, report ?? undefined),
      agents: currentEndpointAgents(report?.body, e.lastHealth, e.evalRunner),
      machineId: e.machineId,
      installationId: e.installationId,
      health: healthSummary(e.lastHealth),
      hardware: endpointHardware(report?.body),
      latestReportSummary: report
        ? {
            reportId: report.reportId,
            scannedAt: iso(report.scannedAt),
            status: report.status,
            assetCount: report.assetCount,
            ...summarizeReport(report.body),
          }
        : null,
      recentJobs: jobs.map(serializeJob),
    };
  });

  app.post('/endpoints/:id/revoke', { preHandler: manage }, async (request) => {
    const { id } = idParams.parse(request.params);
    const outcome = await prisma.$transaction(
      async (tx) => {
        await lockEndpoint(tx, id);
        const e = await tx.fleetEndpoint.findUnique({ where: { id } });
        if (!e) throw notFound('终端不存在');
        if (e.status === 'REVOKED') return { already: true, cancelled: 0, failed: 0 };
        // 令牌立即失效：状态置 REVOKED，同时把 tokenHash 换成不可还原的随机值（旧令牌再也匹配不上）。
        await tx.fleetEndpoint.update({
          where: { id },
          data: {
            status: 'REVOKED',
            revokedAt: new Date(),
            tokenHash: `revoked:${sha256Hex(randomBytes(32).toString('hex'))}`,
          },
        });
        const open = await tx.fleetEvalJob.findMany({
          where: { endpointId: id, status: { in: [...OPEN_JOB_STATUSES] } },
        });
        let cancelled = 0;
        let failed = 0;
        for (const job of open) {
          // 待审批/排队中 → 取消；已下发/执行中的结果再也无法回传（令牌已失效）→ 记为失败。
          const pending = (CANCELLABLE_JOB_STATUSES as readonly string[]).includes(job.status);
          const updated = await tx.fleetEvalJob.update({
            where: { id: job.id },
            data: pending
              ? { status: 'CANCELLED', finishedAt: new Date(), errorCode: 'endpoint_revoked' }
              : { status: 'FAILED', finishedAt: new Date(), errorCode: 'endpoint_revoked' },
          });
          if (pending) cancelled++;
          else failed++;
          await syncFleetJobTaskTx(tx, updated);
        }
        return { already: false, cancelled, failed };
      },
      { timeout: 30_000 },
    );
    if (!outcome.already)
      await audit(request, 'fleet.endpoint.revoke', 'fleet_endpoint', id, {
        cancelledJobs: outcome.cancelled,
        failedJobs: outcome.failed,
      });
    return { id, status: 'REVOKED', cancelledJobs: outcome.cancelled, failedJobs: outcome.failed };
  });

  app.delete('/endpoints/:id', { preHandler: manage }, async (request) => {
    const { id } = idParams.parse(request.params);
    const changed = await prisma.$transaction(async (tx) => {
      await lockEndpoint(tx, id);
      const endpoint = await tx.fleetEndpoint.findUnique({ where: { id } });
      if (!endpoint) throw notFound('终端不存在');
      if (endpoint.status !== 'REVOKED') throw conflict('请先吊销终端，再删除终端');
      if (endpoint.removedAt) return false;
      await tx.fleetEndpoint.update({ where: { id }, data: { removedAt: new Date() } });
      return true;
    });
    if (changed) await audit(request, 'fleet.endpoint.remove', 'fleet_endpoint', id, {});
    return { id, removed: true };
  });

  // ───────────────────────────── 配置体检 ─────────────────────────────
  app.get('/endpoints/:id/posture', { preHandler: read }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { report } = await latestReportOrConflict(id);
    return {
      report: {
        reportId: report.reportId,
        scannedAt: iso(report.scannedAt),
        status: report.status,
        assetCount: report.assetCount,
      },
      summary: summarizeReport(report.body),
      findings: judgeProbeReport(report.body, mcpAllowlist()),
    };
  });

  app.get('/endpoints/:id/overview', { preHandler: read }, async (request) => {
    const { id } = idParams.parse(request.params);
    const endpoint = await prisma.fleetEndpoint.findUnique({ where: { id } });
    if (!endpoint) throw notFound('终端不存在');
    const [report, tasks] = await Promise.all([
      prisma.fleetProbeReport.findFirst({
        where: { endpointId: id },
        orderBy: { scannedAt: 'desc' },
      }),
      prisma.evalTask.findMany({
        where: {
          modelTarget: {
            provider: FLEET_TARGET_PROVIDER,
            accessConfig: { path: ['fleetEndpointId'], equals: id },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { logs: { where: { message: '终端测评任务绑定' }, select: { id: true } } },
      }),
    ]);
    const fleetJobs = await prisma.fleetEvalJob.findMany({
      where: { endpointId: id, evalTaskId: { in: tasks.map((task) => task.id) } },
      orderBy: { createdAt: 'desc' },
      select: { evalTaskId: true, status: true, deadline: true, deliveredAt: true, product: true, payloadCanonical: true },
    });
    const jobByTask = new Map<string, (typeof fleetJobs)[number]>();
    for (const job of fleetJobs) if (job.evalTaskId && !jobByTask.has(job.evalTaskId)) jobByTask.set(job.evalTaskId, job);
    const history = await Promise.all(tasks.map(async (task) => {
      const rawJob = jobByTask.get(task.id);
      const fleetEvalJob = rawJob ? { ...rawJob, status: effectiveJobStatus(rawJob) } : undefined;
      let fleetSummaryLine: string | null = null;
      if (fleetEvalJob?.status === 'COMPLETED') {
        try { fleetSummaryLine = (await loadEndpointSummary(prisma, task.id)).verdictLine; }
        catch (error) { request.log.warn({ err: error, taskId: task.id }, '读取终端测评结论失败'); }
      }
      return { ...task, fleetEvalJob, fleetSummaryLine };
    }));
    return buildEndpointOverview(report, endpoint, history, mcpAllowlist());
  });

  app.post('/endpoints/:id/posture-eval', { preHandler: createTask }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({ name: z.string().trim().min(1).max(200).optional(), items: z.unknown().optional() })
      .parse(request.body ?? {});
    // 判断与落库在 posture-launch.ts，和组合任务的子任务、远程部署后的自动体检共用。
    const result = await runEndpointPostureEval(request.currentUser!, id, body, {
      ip: request.ip,
      userAgent:
        typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    });
    return reply.code(201).send(result);
  });

  // ───────────────────────────── 真机测评任务 ─────────────────────────────
  app.post('/endpoints/:id/eval-jobs', { preHandler: createTask }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = parseFleetEvalJobRequest(request.body);
    const reason = body.reason || DEFAULT_JOB_REASON;
    await expireStaleJobs({ endpointId: id }, logJobError);
    const base = publicBaseUrl();
    const runToken = randomBytes(24).toString('hex');
    const sink = `${base}/sink/${runToken}`;
    const catalog = (await loadSampleCatalog()).filter((entry) => entry.enabled);
    const runtimeSamples = catalog.filter((entry) => entry.suite === 'runtime_v2').map((entry) => entry.content as RuntimeSample);
    const classicSamples = catalog.filter((entry) => entry.suite === 'classic').map((entry) => entry.content as EndpointScenarioDefinition);
    if (isRuntimeSuite(body)) {
      // 运行态测评（suite=runtime_v2）：先估算规模并生成场景包；能力检查在终端行锁内做。
      const plan = await buildRuntimeJob(body, sink, undefined, runtimeSamples, { split: true });
      const batches = splitScenarioIds(plan.pack.scenarios);
      if (batches.length > 1) {
        // 终端对一个任务有整批 6 小时上限，超时整批作废：大任务按整样本拆成多个任务依次排队。
        const start = Date.now();
        let queueDelayMs = 0;
        const plans: FleetEvalJobPlan[] = [];
        for (const [index, ids] of batches.entries()) {
          const token = index === 0 ? runToken : randomBytes(24).toString('hex');
          const batchSink = index === 0 ? sink : `${base}/sink/${token}`;
          const whole = index === 0 ? plan : await buildRuntimeJob(body, batchSink, undefined, runtimeSamples, { split: true });
          const pack = chunkPack(whole.pack, ids);
          const batch = { index: index + 1, total: batches.length };
          plans.push({
            endpointId: id, body, reason, sink: batchSink, runToken: token, pack,
            sampleVersions: snapshotVersions(pack, catalog),
            checkCapability: assertRuntimeV2Capability,
            defaultName: (hostname) => runtimeJobName(hostname, body.product, plan.tier, batch),
            maxPayloadBytes: MAX_PAYLOAD_CANONICAL_BYTES,
            queueDelayMs, createdAt: new Date(start + index),
          });
          queueDelayMs += batchEstimateSeconds(ids.length) * 1000;
        }
        const jobs = await prisma.$transaction(async (tx) => {
          const made = [];
          for (const [index, one] of plans.entries()) made.push(await createFleetEvalJob(request, one, {}, tx, index > 0));
          return made;
        }, { timeout: 60_000 });
        for (const job of jobs) await audit(request, 'fleet.eval_job.create', 'fleet_eval_job', job.id, {
          endpointId: id, jobId: job.publicId, taskId: job.evalTaskId, product: job.product,
          checksum: job.checksum, reason: job.reason, suite: 'runtime_v2', tier: plan.tier, batchTotal: jobs.length,
        });
        return reply.code(201).send({
          ...serializeJob(jobs[0]!),
          taskId: jobs[0]!.evalTaskId,
          suite: 'runtime_v2',
          tier: plan.tier,
          scenarioCount: plan.scenarioCount,
          estimate_seconds: plan.estimateSeconds,
          batchCount: jobs.length,
          jobs: jobs.map((job) => ({ ...serializeJob(job), taskId: job.evalTaskId })),
        });
      }
      const created = await createFleetEvalJob(
        request,
        {
          endpointId: id,
          body,
          reason,
          sink,
          runToken,
          pack: plan.pack,
          sampleVersions: snapshotVersions(plan.pack, catalog),
          checkCapability: assertRuntimeV2Capability,
          defaultName: (hostname) => runtimeJobName(hostname, body.product, plan.tier),
          maxPayloadBytes: MAX_PAYLOAD_CANONICAL_BYTES,
        },
        {
          suite: 'runtime_v2',
          tier: plan.tier,
          scenarioCount: plan.scenarioCount,
          estimateSeconds: plan.estimateSeconds,
          arms: plan.arms,
          repeat: plan.repeat,
          templates: plan.templates,
        },
      );
      return reply.code(201).send({
        ...serializeJob(created),
        taskId: created.evalTaskId,
        suite: 'runtime_v2',
        tier: plan.tier,
        scenarioCount: plan.scenarioCount,
        estimate_seconds: plan.estimateSeconds,
      });
    }
    let pack: EndpointPack;
    try {
      pack = body.mode === 'scripted'
        ? buildScriptedPack(sink, body.riskTypes, body.scenarioIds)
        : buildEndpointPack(sink, body.riskTypes, body.scenarioIds, classicSamples);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : '场景选择不合法');
    }
    const created = await createFleetEvalJob(request, {
      endpointId: id,
      body,
      reason,
      sink,
      runToken,
      pack,
      sampleVersions: snapshotVersions(pack, catalog),
      checkCapability: (health) => {
        if (body.mode === 'scripted' && !scriptedSupported(health))
          throw conflict(
            '终端的测评执行器版本过旧，不支持确定性管控验证，请升级探针',
            'FLEET_SCRIPTED_UNSUPPORTED',
          );
      },
      defaultName: (hostname) =>
        `${hostname} ${body.mode === 'scripted' ? '确定性管控验证' : '真机测评'}（${body.product}）`,
    });
    const { suite: _suite, ...classicJob } = serializeJob(created);
    return reply.code(201).send({ ...classicJob, taskId: created.evalTaskId });
  });

  app.post('/endpoints/:id/eval-jobs/batch', { preHandler: createTask }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { acknowledged: _acknowledged, ...input } = agentEvalPlanSchema.extend({ acknowledged: z.literal(true) }).parse(request.body);
    const catalog = (await loadSampleCatalog(input.sampleVersions)).filter((entry) => entry.enabled);
    const estimate = await estimateAgentJobs(input, catalog);
    const runtimeSamples = catalog.filter((entry) => entry.suite === 'runtime_v2').map((entry) => entry.content as RuntimeSample);
    const classicSamples = catalog.filter((entry) => entry.suite === 'classic').map((entry) => entry.content as EndpointScenarioDefinition);
    await expireStaleJobs({ endpointId: id }, logJobError);
    const base = publicBaseUrl();
    const classicIds = [...new Set(estimate.jobs.filter((job) => job.suite === 'classic').flatMap((job) => job.scenarios.map((scenario) => scenario.sampleId)))];
    const runtimeIds = input.sampleIds.filter((sampleId) => !classicIds.includes(sampleId));
    // 任务名里的档位按所选样本对应的内置方案写（方案里已停用的样本不算），向导里改过样本就是 custom
    const enabledIds = new Set(catalog.map((entry) => entry.id));
    const planTier = planTierOf(input.sampleIds, (await prisma.agentSamplePlan.findMany()).map((plan) => ({
      id: plan.id,
      sampleIds: (Array.isArray(plan.samples) ? plan.samples : []).flatMap((sample) =>
        sample && typeof sample === 'object' && !Array.isArray(sample) && typeof sample.id === 'string' && enabledIds.has(sample.id)
          ? [sample.id] : []),
    })));
    const plans: FleetEvalJobPlan[] = [];
    let queueDelayMs = 0;
    const start = Date.now();
    for (const job of estimate.jobs) {
      const runToken = randomBytes(24).toString('hex');
      const sink = `${base}/sink/${runToken}`;
      const product = job.product as FleetLiveProduct;
      const body = job.suite === 'classic'
        ? parseFleetEvalJobRequest({ product, suite: 'classic', scenarioIds: classicIds })
        : parseFleetEvalJobRequest({ product, suite: 'runtime_v2', tier: 'full', sampleIds: runtimeIds,
          arms: input.arms, repeat: input.repeat, templates: input.templates });
      const runtime = job.suite === 'runtime_v2' ? await buildRuntimeJob(body, sink, undefined, runtimeSamples, { split: true }) : null;
      // 运行态任务按估算里的批次截取场景包：每批有自己的接收地址，场景只属于一批。
      const pack = runtime
        ? (job.batch ? chunkPack(runtime.pack, job.scenarios.map((scenario) => scenario.scenarioId)) : runtime.pack)
        : buildEndpointPack(sink, undefined, classicIds, classicSamples);
      plans.push({ endpointId: id, body, reason: DEFAULT_JOB_REASON, sink, runToken, pack,
        sampleVersions: snapshotVersions(pack, catalog),
        pinnedSampleIds: input.sampleVersions?.map((entry) => entry.id),
        requireCurrentReadiness: true,
        ...(runtime ? { checkCapability: assertRuntimeV2Capability, maxPayloadBytes: MAX_PAYLOAD_CANONICAL_BYTES } : {}),
        defaultName: (hostname) => runtime ? runtimeJobName(hostname, product, planTier, job.batch) : `${hostname} 真机测评（${product}）`,
        queueDelayMs, createdAt: new Date(start + plans.length),
      });
      queueDelayMs += job.estimateSeconds * 1000;
    }
    const created = await prisma.$transaction(async (tx) => {
      const jobs = [];
      for (const [index, plan] of plans.entries()) {
        const job = await createFleetEvalJob(request, plan, {}, tx, index > 0);
        if (input.trial) {
          const sample = plan.sampleVersions?.[0];
          if (!sample || !job.evalTaskId || plan.sampleVersions?.length !== 1) throw badRequest('试运行样本版本不可用');
          await tx.agentSampleTrial.create({ data: { sampleId: sample.id, version: sample.version,
            taskId: job.evalTaskId, createdById: request.currentUser!.id } });
        }
        jobs.push(job);
      }
      return jobs;
    }, { timeout: 60_000 });
    for (const job of created) await audit(request, 'fleet.eval_job.create', 'fleet_eval_job', job.id, {
      endpointId: id, jobId: job.publicId, taskId: job.evalTaskId, product: job.product,
      checksum: job.checksum, reason: job.reason,
    });
    return reply.code(201).send({ jobs: created.map((job) => ({ ...serializeJob(job), taskId: job.evalTaskId })),
      scenarioCount: estimate.scenarioCount, estimateSeconds: estimate.estimateSeconds });
  });

  app.post('/eval-jobs/estimate', { preHandler: createTask }, async (request) => estimateAgentJobs(request.body));

  app.get('/eval-jobs', { preHandler: read }, async (request) => {
    const q = z
      .object({
        ...page,
        view: z.enum(['pending', 'active', 'history']).optional(),
        status: z
          .enum([
            'PENDING_APPROVAL',
            'QUEUED',
            'DELIVERED',
            'RUNNING',
            'COMPLETED',
            'FAILED',
            'REJECTED',
            'EXPIRED',
            'CANCELLED',
          ])
          .optional(),
        endpointId: z.string().uuid().optional(),
        tenantId: z.string().uuid().optional(),
        product: endpointProductSchema.optional(),
      })
      .parse(request.query);
    const viewStatuses: Record<string, FleetJobStatus[]> = {
      pending: ['PENDING_APPROVAL'],
      active: ['QUEUED', 'DELIVERED', 'RUNNING'],
      history: ['COMPLETED', 'FAILED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
    };
    const where: Prisma.FleetEvalJobWhereInput = {
      ...tenantFilterWhere(request),
      ...(q.endpointId ? { endpointId: q.endpointId } : {}),
      ...(q.product ? { product: q.product } : {}),
      ...(q.status
        ? effectiveStatusWhere([q.status], new Date())
        : q.view
          ? effectiveStatusWhere(viewStatuses[q.view]!, new Date())
          : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.fleetEvalJob.findMany({
        where,
        include: jobInclude,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.fleetEvalJob.count({ where }),
    ]);
    return { items: rows.map(serializeJob), total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/eval-jobs/:id', { preHandler: read }, async (request) => {
    const { id } = idParams.parse(request.params);
    const job = await prisma.fleetEvalJob.findUnique({ where: { id }, include: jobInclude });
    if (!job) throw notFound('测评任务不存在');
    return { ...serializeJob(job), ...jobScenarios(job.payloadCanonical) };
  });

  /**
   * 状态流转：锁行 → 校验 → 更新 → 同步 EvalTask，全部同一事务。
   * onSyncError：同步 EvalTask 抛错时先通知调用方（事务照常回滚、错误照常抛出），由调用方决定要不要退一步处理。
   */
  async function transition(
    id: string,
    check: (job: FleetEvalJob) => void,
    data: (job: FleetEvalJob) => Prisma.FleetEvalJobUpdateInput,
    onSyncError?: (error: unknown) => void,
  ) {
    await expireStaleJobs({ id }, logJobError);
    return prisma.$transaction(
      async (tx) => {
        await lockJob(tx, id);
        const job = await tx.fleetEvalJob.findUnique({ where: { id } });
        if (!job) throw notFound('测评任务不存在');
        check(job);
        await tx.fleetEvalJob.update({ where: { id }, data: data(job) });
        const updated = await tx.fleetEvalJob.findUniqueOrThrow({
          where: { id },
          include: jobInclude,
        });
        try {
          await syncFleetJobTaskTx(tx, updated);
        } catch (error) {
          onSyncError?.(error);
          throw error;
        }
        return updated;
      },
      { timeout: 30_000 },
    );
  }
  const notPending = (job: FleetEvalJob, verb: string) => {
    if (job.status !== 'PENDING_APPROVAL')
      throw conflict(
        `任务当前状态为「${FLEET_STATUS_LABELS[JOB_STATUS_KEY[job.status]] ?? job.status}」，不能${verb}`,
        'FLEET_JOB_STATE',
      );
  };

  app.post('/eval-jobs/:id/approve', { preHandler: manage }, async (request) => {
    const { id } = idParams.parse(request.params);
    const user = request.currentUser!;
    // 新任务创建即下发，不再经过审批；这里只为库里遗留的待审批旧任务保留，且发起人本人也可以批准。
    const job = await transition(
      id,
      (j) => notPending(j, '批准'),
      () => ({
        status: 'QUEUED',
        approvedBy: { connect: { id: user.id } },
        approvedAt: new Date(),
      }),
    );
    // 终端已吊销的任务在吊销时已被取消，这里不会到达 QUEUED。
    await audit(request, 'fleet.eval_job.approve', 'fleet_eval_job', id, {
      jobId: job.publicId,
      taskId: job.evalTaskId,
      endpointId: job.endpointId,
      checksum: job.checksum,
    });
    return serializeJob(job);
  });

  app.post('/eval-jobs/:id/reject', { preHandler: manage }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { reason } = z
      .object({ reason: z.string().trim().min(1).max(500) })
      .parse(request.body ?? {});
    const job = await transition(
      id,
      (j) => notPending(j, '驳回'),
      () => ({ status: 'REJECTED', rejectReason: reason, finishedAt: new Date() }),
    );
    await audit(request, 'fleet.eval_job.reject', 'fleet_eval_job', id, {
      jobId: job.publicId,
      taskId: job.evalTaskId,
      reason,
    });
    return serializeJob(job);
  });

  app.post('/eval-jobs/:id/cancel', { preHandler: [authenticate] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { force } = z.object({ force: z.boolean().optional() }).parse(request.body ?? {});
    const user = request.currentUser!;
    const inFlight = (j: FleetEvalJob) => j.status === 'DELIVERED' || j.status === 'RUNNING';
    // 强制结束：终端已接收的任务无法远程中止，终端管理员可以只在平台上把它结束掉，让终端继续领后面的任务。
    // 终端上的进程不受影响，之后回传的结果因状态已变得到 409。
    const forceClose = (j: FleetEvalJob) =>
      force === true && inFlight(j) && user.permissions.has(PERM_MANAGE);
    const attempt = { forced: false, syncFailed: false };
    const job = await transition(
      id,
      (j) => {
        // 申请人本人可取消自己的任务；其他人需要管理权限。
        if (j.requestedById !== user.id && !user.permissions.has(PERM_MANAGE))
          throw forbidden('只有申请人或终端管理员可以取消该任务');
        if (forceClose(j)) return;
        if (inFlight(j))
          throw conflict(
            '终端已接收任务，无法远程中止；如需停止请在终端上停止采集器，任务会在截止时间后失败',
            'FLEET_JOB_NOT_CANCELLABLE',
          );
        if (!(CANCELLABLE_JOB_STATUSES as readonly string[]).includes(j.status))
          throw conflict(
            `任务当前状态为「${FLEET_STATUS_LABELS[JOB_STATUS_KEY[j.status]] ?? j.status}」，不能取消`,
            'FLEET_JOB_STATE',
          );
      },
      (j) => {
        attempt.forced = forceClose(j);
        return attempt.forced
          ? { status: 'FAILED', finishedAt: new Date(), errorCode: 'force_closed' }
          : { status: 'CANCELLED', finishedAt: new Date() };
      },
      () => {
        attempt.syncFailed = true;
      },
    ).catch(async (error: unknown) => {
      // 强制结束时评估任务同步失败：不能因此让终端一直被这个任务占住。权限和状态已在上面的事务里校验过，
      // 这里退一步只结束终端任务，仍带状态条件，与终端回传结果、自动收敛、另一次强制结束互斥。
      if (!attempt.forced || !attempt.syncFailed) throw error;
      request.log.error(
        { jobId: id, err: { message: (error as Error)?.message } },
        '强制结束时同步评估任务失败，只结束终端任务',
      );
      const closed = await prisma.fleetEvalJob.updateMany({
        where: { id, status: { in: ['DELIVERED', 'RUNNING'] } },
        data: { status: 'FAILED', finishedAt: new Date(), errorCode: 'force_closed' },
      });
      const current = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id }, include: jobInclude });
      if (!closed.count)
        throw conflict(
          `任务当前状态为「${FLEET_STATUS_LABELS[JOB_STATUS_KEY[current.status]] ?? current.status}」，不能取消`,
          'FLEET_JOB_STATE',
        );
      return current;
    });
    await audit(request, 'fleet.eval_job.cancel', 'fleet_eval_job', id, {
      jobId: job.publicId,
      taskId: job.evalTaskId,
      ...(job.errorCode === 'force_closed' ? { force: true } : {}),
    });
    return serializeJob(job);
  });

  // ───────────────────────────── 部署信息 ─────────────────────────────
  app.get('/deployment-info', { preHandler: manage }, async (request) => {
    const { info, oneclick, kitWarnings, catalog } = await buildOneclick(requestOrigin(request));
    // Windows 目标补上安装包可用状态，前端据此决定下载按钮是否可点。
    const targets = await Promise.all(
      oneclick.targets.map(async (t) =>
        isInstallerTarget(t.target)
          ? { ...t, installer: await installerAvailability(catalog, info, t.target, PRODUCT_NAME) }
          : t,
      ),
    );
    // 探针包问题只进 warnings，不影响 ready。
    return {
      ...info,
      warnings: [...info.warnings, ...kitWarnings],
      oneclick: { ...oneclick, targets },
    };
  });

  // ───────────────────── 一键安装（无需登录：脚本与探针包不含秘密） ─────────────────────
  app.get('/install/linux.sh', async (request, reply) => {
    const { script } = await buildOneclick(requestOrigin(request));
    if (!script) throw notFound('一键安装暂不可用：部署信息或探针包未就绪');
    // 一次性部署命令带 ?deploy=：记第一次下载脚本的时间（部署计时起点），脚本内容不变。
    await markScriptFetched((request.query as { deploy?: unknown } | undefined)?.deploy);
    return reply
      .type('text/x-shellscript; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(script);
  });

  app.get('/install/linux.sh.sha256', async (request, reply) => {
    const { oneclick } = await buildOneclick(requestOrigin(request));
    if (!oneclick.scriptSha256) throw notFound('一键安装暂不可用：部署信息或探针包未就绪');
    return reply
      .type('text/plain; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(oneclick.scriptSha256 + '\n');
  });

  app.get('/kits/:filename', async (request, reply) => {
    const { filename } = request.params as { filename: string };
    const kit = await resolveKitFile(filename);
    if (!kit) throw notFound('探针包不存在');
    // HEAD 只看文件信息，不算下载；同一 IP 同一文件 30 分钟内只算一次。
    if (request.method === 'GET') {
      const firstFromIp = await recordDownload(`${request.ip}:${kit.item.filename}`);
      // 工具中心的下载溯源（后台写，不等库）：带了有效登录令牌记下载人；
      // 匿名的复用上面的去重，同一 IP 同一文件 30 分钟内只记一条。不加限流：批量装终端常共用 NAT 出口。
      recordProbeDownload(request, { filename: kit.item.filename, firstFromIp });
    }
    return reply
      .type('application/gzip')
      .header('content-length', String(kit.size))
      .header('content-disposition', `attachment; filename="${kit.item.filename}"`)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(kit.path));
  });

  // ───────────── Windows 安装包（需登录：文件里带接入码，不能匿名下载） ─────────────
  const installerBody = z.object({
    code: z
      .string()
      .trim()
      .regex(/^jdc_[A-Za-z0-9_-]{8,200}$/, '接入码格式不正确'),
    target: z.enum(INSTALLER_TARGETS),
  });
  const CODE_UNUSABLE: Record<'EXPIRED' | 'EXHAUSTED' | 'REVOKED', string> = {
    EXPIRED: '接入码已过期，请重新创建接入码',
    EXHAUSTED: '接入码已用完（可接入台数已满），请重新创建接入码',
    REVOKED: '接入码已撤销，请重新创建接入码',
  };

  app.post('/install/windows-installer', { preHandler: manage }, async (request, reply) => {
    const body = installerBody.parse(request.body ?? {});
    const row = await prisma.fleetEnrollmentCode.findUnique({
      where: { codeHash: sha256Hex(body.code) },
    });
    if (!row) throw conflict('接入码不存在，请确认复制的是完整的接入码', 'FLEET_CODE_UNUSABLE');
    const state = codeStatus(row);
    if (state !== 'ACTIVE') throw conflict(CODE_UNUSABLE[state], 'FLEET_CODE_UNUSABLE');

    const info = deploymentInfo();
    const catalog = await loadKitCatalog();
    const check = await checkInstallerTarget(catalog, info, body.target, PRODUCT_NAME);
    if (!check.ok) throw conflict(check.reason, check.code);
    if (!info.server || !info.certificate)
      throw conflict('部署信息尚未就绪', 'FLEET_DEPLOYMENT_NOT_READY');
    const tail = buildInstallerTail({
      server: info.server,
      code: body.code,
      expiresAt: row.expiresAt,
      certPem: info.certificate.pem,
      certSha256: info.certificate.sha256,
    });

    const handle = await open(check.kit.path, 'r');
    let size = -1;
    try {
      size = (await handle.stat()).size;
    } finally {
      // 文件在校验之后又被替换：不发送，让管理员稍后重试。
      if (size !== check.kit.size) await handle.close().catch(() => undefined);
    }
    if (size !== check.kit.size)
      throw conflict('安装包文件刚刚被更新，请稍后重试', 'FLEET_INSTALLER_UNAVAILABLE');

    // 审计只记接入码的 ID 和前缀，不记明文。写审计失败时也要把已打开的文件句柄关掉。
    try {
      await audit(request, 'fleet.installer.download', 'fleet_enrollment_code', row.id, {
        codeId: row.id,
        codePrefix: row.codePrefix,
        target: body.target,
      });
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
    await recordDownload();
    recordProbeDownload(request, {
      filename: `${INSTALLER_FILE_PREFIX}-${body.target}.exe`,
      actor: actorOf(request),
    });
    const stream = Readable.from(streamInstaller(handle, size, check.kit.setup.sha256, tail), {
      objectMode: false,
    });
    // 兜底：客户端在流开始读取前就断开时，生成器的 finally 不会执行，这里保证句柄一定关闭。
    stream.once('close', () => void handle.close().catch(() => undefined));
    return reply
      .type('application/octet-stream')
      .header('content-length', String(size + tail.length))
      .header(
        'content-disposition',
        `attachment; filename="${INSTALLER_FILE_PREFIX}-${body.target}.exe"`,
      )
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(stream);
  });

  app.get(
    '/deployment-info/tls-deployment.json',
    { preHandler: manage },
    async (request, reply) => {
      const info = deploymentInfo();
      if (!info.ready || !info.tlsDeployment)
        throw conflict(`部署信息未就绪：${info.issues.join('；')}`, 'FLEET_DEPLOYMENT_NOT_READY');
      await audit(
        request,
        'download.fleet_tls_deployment',
        'fleet_deployment',
        'tls-deployment.json',
        {
          sha256: info.tlsDeployment.tls_server_cert_sha256,
        },
      );
      return reply
        .type('application/json; charset=utf-8')
        .header('content-disposition', 'attachment; filename="tls-deployment.json"')
        .header('cache-control', 'no-store')
        .send(JSON.stringify(info.tlsDeployment, null, 2) + '\n');
    },
  );
}
