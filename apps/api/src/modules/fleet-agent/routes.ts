import { LIVE_EVAL_BLOCKED_REASONS } from '../../../../../packages/shared/src/fleet-live-eval.js';
// 终端接入协议 /agent/v1/*（protocol-subset.md）。独立插件注册，前缀 /agent/v1：
// - 不走平台登录 JWT：注册用接入码，其余用终端令牌，二者都只比 sha256 哈希；
// - 先鉴权（onRequest，只看请求头）→ 再读体（路由级 bodyLimit，超限 413）→ 再校验；
// - 成功一律 200 + JSON；错误体统一 {"error":"<code>"}，不细分泄露原因；
// - 响应一律 Cache-Control: no-store；日志不记 Authorization 头与任何响应体；
// - 服务端绝不访问请求里出现的 URL / 路径（sink_base_url、报告里的地址都只存不用）。
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma, type FleetEndpoint, type FleetEnrollmentCode } from '@prisma/client';
import { prisma } from '../../db.js';
import {
  findEndpointByToken,
  findUsableEnrollmentCode,
  generateEndpointPublicId,
  generateEndpointToken,
  hashSecret,
  parseBearer,
  safeEqual,
} from './auth.js';
import { containsBadString, sha256Hex } from './checksum.js';
import { BODY_LIMITS, fleetAgentEnabled, fleetAgentRateLimits } from './config.js';
import { closeOverdueJobs, jobResultDueAt } from '../fleet-admin/service.js';
import { onFleetJobFinished } from './hooks.js';
import { TokenBucketLimiter, type RateLimiter } from './rate-limit.js';
import { hasPartialCompletion, resultErrorCode } from './result-error.js';
import { InvalidResultError, validateResult } from './validate-result.js';
import { onProbeReportStored } from '../fleet-admin/remote-deploy/hooks.js';

declare module 'fastify' {
  interface FastifyRequest {
    fleetEndpoint?: FleetEndpoint;
    fleetEnrollmentCode?: FleetEnrollmentCode;
  }
  interface FastifyContextConfig {
    fleetAuth?: 'enrollment' | 'endpoint';
  }
}

/** 协议层拒绝：status + 对外错误码。 */
export class FleetReject extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'FleetReject';
  }
}

const reject = (status: number, code: string): never => {
  throw new FleetReject(status, code);
};

export interface FleetAgentRoutesOptions {
  /** 限流器注入；测试可传 noopLimiter 关闭。 */
  rateLimiters?: { ip?: RateLimiter; register?: RateLimiter; endpoint?: RateLimiter };
  /** 时钟注入（测试用）。 */
  now?: () => Date;
}

const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SCANNED_AT_SKEW_MS = 5 * 60 * 1000;
const POLICY_CHECKSUM = 'sha256:' + sha256Hex('jiandun-fleet-policy-v1');

/** 秒级 UTC：YYYY-MM-DDTHH:MM:SSZ（截掉毫秒）。 */
export const isoSeconds = (d: Date): string => d.toISOString().slice(0, 19) + 'Z';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 解析原始字节为 JSON；空体或非法 JSON 返回 undefined。 */
function parseJson(body: unknown): unknown {
  if (!Buffer.isBuffer(body) || body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

function jsonObject(body: unknown): Obj {
  const value = parseJson(body);
  if (!isObj(value)) reject(400, 'invalid_request');
  return value as Obj;
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export async function fleetAgentRoutes(
  app: FastifyInstance,
  options: FleetAgentRoutesOptions = {},
): Promise<void> {
  const limits = fleetAgentRateLimits();
  const ipLimiter =
    options.rateLimiters?.ip ?? new TokenBucketLimiter(limits.ipPerMinute, limits.ipPerMinute);
  const registerLimiter =
    options.rateLimiters?.register ??
    new TokenBucketLimiter(limits.registerPerMinute, limits.registerPerMinute);
  const endpointLimiter =
    options.rateLimiters?.endpoint ??
    new TokenBucketLimiter(limits.endpointPerMinute, limits.endpointPerMinute);
  const now = options.now ?? (() => new Date());

  // 只在本插件内：所有请求体按原始字节收取，自行解析（便于计算报告体哈希、统一 400/409 语义）。
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.setErrorHandler((err: FastifyError | FleetReject, request, reply) => {
    if (err instanceof FleetReject) return reply.code(err.statusCode).send({ error: err.code });
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status === 413) return reply.code(413).send({ error: 'payload_too_large' });
    if (status >= 400 && status < 500) return reply.code(status).send({ error: 'invalid_request' });
    // 只记错误类型与消息，不记请求头/体。
    request.log.error({ err: { name: err.name, message: err.message } }, 'fleet-agent 内部错误');
    return reply.code(500).send({ error: 'internal' });
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  /** 终端令牌鉴权 + 按终端限流。 */
  async function authenticateEndpoint(request: FastifyRequest): Promise<FleetEndpoint> {
    const token = parseBearer(request.headers.authorization);
    if (!token) return reject(401, 'unauthorized');
    const endpoint = await findEndpointByToken(token);
    if (!endpoint) return reject(401, 'unauthorized');
    if (!endpointLimiter.take(endpoint.id)) return reject(429, 'rate_limited');
    request.fleetEndpoint = endpoint;
    return endpoint;
  }

  // 开关 → IP 限流 → 鉴权，全部在读请求体之前完成。
  app.addHook('onRequest', async (request) => {
    if (!fleetAgentEnabled()) reject(404, 'not_found');
    if (!ipLimiter.take(request.ip)) reject(429, 'rate_limited');
    const kind = request.routeOptions.config?.fleetAuth;
    if (kind === 'endpoint') {
      await authenticateEndpoint(request);
    } else if (kind === 'enrollment') {
      if (!registerLimiter.take(request.ip)) reject(429, 'rate_limited');
      // 缺失/格式错误/无效/过期/撤销一律同一个 403，不细分原因。
      const code = parseBearer(request.headers.authorization);
      if (!code) reject(403, 'enrollment_rejected');
      const row = await findUsableEnrollmentCode(code!, now());
      if (!row) reject(403, 'enrollment_rejected');
      request.fleetEnrollmentCode = row!;
    }
  });

  // 未实现端点：先鉴权再 404，未认证探测拿不到差异化应答。
  app.setNotFoundHandler(async (request, reply) => {
    if (!fleetAgentEnabled()) return reply.code(404).send({ error: 'not_found' });
    await authenticateEndpoint(request);
    return reply.code(404).send({ error: 'not_found' });
  });

  const endpointOf = (request: FastifyRequest) => request.fleetEndpoint!;

  // ---------- §1 登记 ----------
  app.post(
    '/endpoints/register',
    { bodyLimit: BODY_LIMITS.register, config: { fleetAuth: 'enrollment' } },
    async (request) => {
      const code = request.fleetEnrollmentCode!;
      const q = jsonObject(request.body);
      const input = parseRegisterBody(q);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const { publicId, token } = await registerEndpoint(code, input, now());
          // 注意：本响应体含令牌明文，任何地方都不要记录它。
          return {
            endpoint_id: publicId,
            endpoint_token: token,
            mode: 'monitor',
            capture_level: 'metadata',
          };
        } catch (err) {
          // installation_id / publicId 并发撞唯一键：事务已回滚（配额未占用），重试会走幂等分支。
          if (isUniqueViolation(err) && attempt < 2) continue;
          throw err;
        }
      }
      return reject(403, 'enrollment_rejected');
    },
  );

  // ---------- §2 心跳 ----------
  app.post(
    '/endpoints/heartbeat',
    { bodyLimit: BODY_LIMITS.heartbeat, config: { fleetAuth: 'endpoint' } },
    async (request) => {
      const endpoint = endpointOf(request);
      const q = jsonObject(request.body);
      if (typeof q.endpoint_id !== 'string' || !safeEqual(q.endpoint_id, endpoint.publicId))
        reject(401, 'unauthorized');
      const health = isObj(q.health) ? q.health : {};
      if (Buffer.byteLength(JSON.stringify(health), 'utf8') > BODY_LIMITS.heartbeat)
        reject(413, 'payload_too_large');
      // PostgreSQL JSONB 不接受 \u0000：提前拒绝，避免 500。
      if (containsBadString(health)) reject(400, 'invalid_request');
      const caps = isObj(health.capabilities) ? health.capabilities : {};
      const evalRunner =
        typeof caps.eval_runner === 'string' && caps.eval_runner.length <= 64
          ? caps.eval_runner
          : null;
      // 探针原地升级不会重新登记，版本以心跳里的部署版本为准；格式不对就保留原值。
      const revision = isObj(health.collector) && isObj(health.collector.deployment)
        ? health.collector.deployment.revision
        : undefined;
      const agentVersion =
        typeof revision === 'string' && /^[0-9a-f]{7,64}$/i.test(revision) ? revision : undefined;
      const updated = await prisma.fleetEndpoint.updateMany({
        where: { id: endpoint.id, status: 'ACTIVE' },
        data: {
          lastHealth: health as Prisma.InputJsonObject,
          evalRunner,
          lastSeenAt: now(),
          ...(agentVersion ? { agentVersion } : {}),
        },
      });
      if (updated.count === 0) reject(401, 'unauthorized');
      return { server_time: isoSeconds(now()), revoked: false, upgrade: null };
    },
  );

  // ---------- §3 体检上报 ----------
  app.post(
    '/probe-reports',
    { bodyLimit: BODY_LIMITS.probeReport, config: { fleetAuth: 'endpoint' } },
    async (request) => {
      const endpoint = endpointOf(request);
      if (request.url.includes('?')) reject(400, 'invalid_request');
      const contentType = String(request.headers['content-type'] ?? '')
        .split(';')[0]!
        .trim()
        .toLowerCase();
      if (contentType !== 'application/json') reject(415, 'unsupported_media_type');
      const raw = request.body as Buffer | undefined;
      const report = jsonObject(raw);
      if (report.schema_version !== 'aiprobe.report.v1') reject(422, 'invalid_report');
      if (
        typeof report.endpoint_id !== 'string' ||
        !safeEqual(report.endpoint_id, endpoint.publicId)
      )
        reject(401, 'endpoint_mismatch');
      const scanned = report.scanned_at;
      if (typeof scanned !== 'string' || !UTC_SECONDS.test(scanned)) reject(422, 'invalid_report');
      const scannedAt = new Date(scanned as string);
      if (Number.isNaN(scannedAt.getTime()) || isoSeconds(scannedAt) !== scanned)
        reject(422, 'invalid_report');
      if (scannedAt.getTime() > now().getTime() + SCANNED_AT_SKEW_MS) reject(422, 'invalid_report');
      const expected = 'pr_' + sha256Hex(endpoint.publicId + '\u0000' + scanned);
      if (report.report_id !== expected) reject(422, 'invalid_report');
      if (report.status !== 'complete' && report.status !== 'partial')
        reject(422, 'invalid_report');
      if (!Array.isArray(report.assets) || !Array.isArray(report.collectors))
        reject(422, 'invalid_report');
      if (containsBadString(report)) reject(422, 'invalid_report');
      const assets = report.assets as unknown[];
      const bodyHash = sha256Hex(raw!);

      const ack = (duplicate: boolean) => ({
        schema_version: 'aiprobe.report.ack.v1',
        report_id: expected,
        accepted: true,
        duplicate,
        asset_count: assets.length,
      });
      const compare = async () => {
        const prior = await prisma.fleetProbeReport.findUnique({
          where: { reportId: expected },
          select: { endpointId: true, bodyHash: true },
        });
        if (!prior) return null;
        if (prior.endpointId !== endpoint.id || prior.bodyHash !== bodyHash)
          return reject(409, 'report_conflict');
        return ack(true);
      };
      const existing = await compare();
      if (existing) return existing;
      try {
        await prisma.fleetProbeReport.create({
          data: {
            endpointId: endpoint.id,
            reportId: expected,
            scannedAt,
            status: report.status as string,
            assetCount: assets.length,
            bodyHash,
            body: report as Prisma.InputJsonObject,
          },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const raced = await compare();
        if (raced) return raced;
        throw err;
      }
      // 远程部署（2.4.8）的回传结果：记第一次上报，按设置自动体检。不影响上报应答。
      void onProbeReportStored(endpoint.id).catch((err: unknown) =>
        request.log.error({ err }, '远程部署上报后处理失败'),
      );
      return ack(false);
    },
  );

  // ---------- §4 策略（仅用于 set-https 轮换证书） ----------
  app.get(
    '/policy',
    { bodyLimit: BODY_LIMITS.get, config: { fleetAuth: 'endpoint' } },
    async (request) => {
      const view = (request.query as Obj | undefined)?.view;
      if (view !== undefined) reject(404, 'not_found');
      return { version: 1, checksum: POLICY_CHECKSUM };
    },
  );

  // ---------- §7 凭据下发：第一期固定为空，消除采集器的永久错误 ----------
  app.get(
    '/credential-deliveries',
    { bodyLimit: BODY_LIMITS.get, config: { fleetAuth: 'endpoint' } },
    async () => ({ items: [] }),
  );

  // ---------- §5.1 领取测评任务 ----------
  app.get(
    '/eval-jobs',
    { bodyLimit: BODY_LIMITS.get, config: { fleetAuth: 'endpoint' } },
    async (request, reply) => {
      const endpoint = endpointOf(request);
      const t = now();
      // 上一个任务早已过了回传期限（终端断电、执行器被强杀）时先收尾，否则这台终端永远领不到新任务。
      // 单个任务收尾出错只记日志：不能因此让采集器拿到 500 而长时间退避。
      await closeOverdueJobs({ endpointId: endpoint.id }, t, (message, jobId, err) =>
        request.log.error({ jobId, err: { message: (err as Error)?.message } }, `fleet-agent ${message}`),
      );
      const busy = await prisma.fleetEvalJob.count({
        where: { endpointId: endpoint.id, status: { in: ['DELIVERED', 'RUNNING'] } },
      });
      if (busy > 0) return reply.send([]);
      const candidates = await prisma.fleetEvalJob.findMany({
        where: { endpointId: endpoint.id, status: 'QUEUED', deadline: { gt: t } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 5,
      });
      for (const job of candidates) {
        const item = deliverable(job);
        if (item) return reply.send([item]);
        request.log.warn(
          { jobId: job.id },
          'fleet-agent 任务 payload 不完整或与 checksum 不符，跳过',
        );
      }
      return reply.send([]);
    },
  );

  // ---------- §5.3 状态机 ----------
  const loadJob = async (request: FastifyRequest) => {
    const { jobId } = request.params as { jobId: string };
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) return reject(404, 'not_found');
    const job = await prisma.fleetEvalJob.findUnique({ where: { publicId: jobId } });
    // 不存在与不属于本终端同样 404，避免跨终端枚举 job_id。
    if (!job || job.endpointId !== endpointOf(request).id) return reject(404, 'not_found');
    return job;
  };
  const transitionOptions = {
    bodyLimit: BODY_LIMITS.transition,
    config: { fleetAuth: 'endpoint' as const },
  };

  app.post('/eval-jobs/:jobId/ack', transitionOptions, async (request) => {
    const job = await loadJob(request);
    const q = jsonObject(request.body);
    const t = now();
    const keys = Object.keys(q);
    if (
      keys.length !== 1 ||
      keys[0] !== 'checksum' ||
      typeof q.checksum !== 'string' ||
      !safeEqual(q.checksum, job.checksum) ||
      job.status !== 'QUEUED' ||
      t.getTime() >= job.deadline.getTime()
    )
      reject(409, 'conflict');
    const acknowledged = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM fleet_endpoints WHERE id = ${job.endpointId} FOR UPDATE`;
      const lockedTime = now();
      const busy = await tx.fleetEvalJob.count({
        where: { endpointId: job.endpointId, status: { in: ['DELIVERED', 'RUNNING'] } },
      });
      if (busy) return false;
      const candidates = await tx.fleetEvalJob.findMany({
        where: { endpointId: job.endpointId, status: 'QUEUED', deadline: { gt: lockedTime } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 5,
      });
      if (candidates.find((candidate) => deliverable(candidate))?.id !== job.id) return false;
      const updated = await tx.fleetEvalJob.updateMany({
        where: { id: job.id, status: 'QUEUED', deadline: { gt: lockedTime } },
        data: { status: 'DELIVERED', deliveredAt: lockedTime },
      });
      return updated.count === 1;
    });
    if (!acknowledged) reject(409, 'conflict');
    return { job_id: job.publicId, status: 'delivered' };
  });

  app.post('/eval-jobs/:jobId/started', transitionOptions, async (request) => {
    const job = await loadJob(request);
    const q = jsonObject(request.body);
    const t = now();
    // 与回传结果同一个期限：领取后迟迟没开始、已过回传期限的任务不再进入执行中（跑完回传也只会得到 409），
    // 留给收敛按「终端超时未回传」收尾。
    if (
      Object.keys(q).length !== 0 ||
      job.status !== 'DELIVERED' ||
      t >= job.deadline ||
      t.getTime() >= jobResultDueAt(job).getTime()
    )
      reject(409, 'conflict');
    const updated = await prisma.fleetEvalJob.updateMany({
      where: { id: job.id, status: 'DELIVERED', deadline: { gt: t } },
      data: { status: 'RUNNING', startedAt: t },
    });
    if (updated.count === 0) reject(409, 'conflict');
    return { job_id: job.publicId, status: 'running' };
  });

  app.post(
    '/eval-jobs/:jobId/result',
    { bodyLimit: BODY_LIMITS.result, config: { fleetAuth: 'endpoint' } },
    async (request) => {
      const job = await loadJob(request);
      const t = now();
      // 回传期限与执行中收敛同一口径：过了期限的结果一律 409，不会和收敛抢同一个任务。
      if (job.status !== 'RUNNING' || t.getTime() >= jobResultDueAt(job).getTime())
        reject(409, 'conflict');
      const finished = (status: 'COMPLETED' | 'FAILED') => {
        void onFleetJobFinished(job.id, (err) =>
          request.log.error(
            { jobId: job.id, err: { message: (err as Error)?.message } },
            'fleet-agent 任务结束钩子失败',
          ),
        );
        return { job_id: job.publicId, status: status.toLowerCase() };
      };

      let outcome: 'completed' | 'failed';
      let result: Obj;
      try {
        const pack = jobScenarioPack(job.payloadCanonical);
        const parsed = parseJson(request.body);
        // 非 JSON / 非对象也按「结果不合格」处理：返回 400 会让采集器退避约 10 小时不领新任务（§5.5）。
        if (!isObj(parsed)) throw new InvalidResultError('结果不是 JSON 对象');
        outcome = validateResult(parsed, job.product, pack);
        result = parsed;
      } catch (err) {
        if (!(err instanceof InvalidResultError)) throw err;
        const failed = await prisma.fleetEvalJob.updateMany({
          where: { id: job.id, status: 'RUNNING' },
          data: { status: 'FAILED', errorCode: 'invalid_result', finishedAt: t },
        });
        if (failed.count > 0) finished('FAILED');
        return reject(409, 'invalid_result');
      }

      const status = outcome === 'completed' ? 'COMPLETED' : 'FAILED';
      const updated = await prisma.fleetEvalJob.updateMany({
        where: { id: job.id, status: 'RUNNING' },
        data: {
          status,
          result: result as Prisma.InputJsonObject,
          // 场景自带的阻断原因（未登记、无隔离、超时等）只在没有场景跑完时才代表整批；
          // 有场景跑完时整批是「部分没跑完」，各场景的原因在结果页逐条显示。
          errorCode:
            status === 'FAILED'
              ? (hasPartialCompletion(result.scenarios as Obj[])
                  ? 'partial_scenario_failed'
                  : ((result.scenarios as Obj[])
                      .map((s) => s.error_code)
                      .find(
                        (code): code is string =>
                          typeof code === 'string' &&
                          code !== 'scenario_failed' &&
                          code in LIVE_EVAL_BLOCKED_REASONS,
                      ) ?? resultErrorCode(result, job.product, endpointOf(request).lastHealth)))
              : null,
          finishedAt: t,
        },
      });
      if (updated.count === 0) reject(409, 'conflict');
      return finished(status);
    },
  );
}

// ---------- 登记 ----------

interface RegisterInput {
  machineId: string;
  installationId: string;
  hostname: string;
  os: string;
  osVersion: string;
  arch: string;
  osUser: string;
  agentVersion: string;
  capabilities: string[];
}

function parseRegisterBody(q: Obj): RegisterInput {
  const bad = () => reject(400, 'invalid_request');
  const required = (key: string): string => {
    const v = q[key];
    if (typeof v !== 'string' || !v.trim() || v.length > 256) bad();
    return v as string;
  };
  const optional = (key: string): string => {
    const v = q[key];
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string' || v.length > 256) bad();
    return v as string;
  };
  if (containsBadString(q)) bad();
  const input: RegisterInput = {
    machineId: required('machine_id'),
    hostname: required('hostname'),
    os: required('os'),
    arch: required('arch'),
    installationId: required('installation_id'),
    osVersion: optional('os_version'),
    osUser: optional('os_user'),
    agentVersion: optional('agent_version'),
    capabilities: [],
  };
  if (required('agent_product') !== 'aiprobe') bad();
  for (const key of ['adapter_name', 'adapter_version']) optional(key);
  if (!UUID_V4.test(input.installationId)) bad();
  const caps = q.capabilities ?? [];
  if (!Array.isArray(caps) || caps.length > 64) bad();
  for (const c of caps as unknown[]) if (typeof c !== 'string' || !c || c.length > 256) bad();
  if (new Set(caps as string[]).size !== (caps as string[]).length) bad();
  input.capabilities = caps as string[];
  return input;
}

async function registerEndpoint(
  code: FleetEnrollmentCode,
  input: RegisterInput,
  t: Date,
): Promise<{ publicId: string; token: string }> {
  const token = generateEndpointToken();
  const tokenHash = hashSecret(token);
  const meta = {
    hostname: input.hostname,
    os: input.os,
    osVersion: input.osVersion,
    arch: input.arch,
    osUser: input.osUser,
    agentVersion: input.agentVersion,
    capabilities: input.capabilities,
  };
  return prisma.$transaction(async (tx) => {
    const existing = await tx.fleetEndpoint.findUnique({
      where: { installationId: input.installationId },
    });
    if (existing) {
      // 幂等重登记：同码、同 installation_id、同 machine_id、未吊销 → 复用终端、轮换令牌、不占配额。
      if (
        existing.enrollmentCodeId !== code.id ||
        existing.machineId !== input.machineId ||
        existing.status !== 'ACTIVE' ||
        existing.revokedAt
      )
        reject(403, 'enrollment_rejected');
      await tx.fleetEndpoint.update({ where: { id: existing.id }, data: { ...meta, tokenHash } });
      return { publicId: existing.publicId, token };
    }
    // 条件原子自增防超卖：行锁下重新评估条件，并发请求最多成功 maxUses - usedCount 次。
    const claimed = await tx.fleetEnrollmentCode.updateMany({
      where: {
        id: code.id,
        status: 'ACTIVE',
        revokedAt: null,
        expiresAt: { gt: t },
        usedCount: { lt: prisma.fleetEnrollmentCode.fields.maxUses },
      },
      data: { usedCount: { increment: 1 } },
    });
    if (claimed.count === 0) reject(403, 'enrollment_rejected');
    const publicId = generateEndpointPublicId();
    await tx.fleetEndpoint.create({
      data: {
        ...meta,
        publicId,
        installationId: input.installationId,
        machineId: input.machineId,
        tokenHash,
        enrollmentCodeId: code.id,
        lastSeenAt: t,
      },
    });
    return { publicId, token };
  });
}

// ---------- 任务 payload ----------

interface StoredPayload {
  product: string;
  scenario_pack: Obj & { scenarios: Array<{ scenario_id: string }> };
  sink_base_url: string;
}

/** 从固化的 canonical 原文解析执行 payload；结构不完整返回 null。 */
function parseStoredPayload(canonical: string): StoredPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(canonical);
  } catch {
    return null;
  }
  if (!isObj(value)) return null;
  const { product, scenario_pack: pack, sink_base_url: sink } = value;
  if (typeof product !== 'string' || typeof sink !== 'string' || !isObj(pack)) return null;
  if (!Array.isArray(pack.scenarios)) return null;
  if (!pack.scenarios.every((s) => isObj(s) && typeof s.scenario_id === 'string')) return null;
  return value as unknown as StoredPayload;
}

function deliverable(job: {
  publicId: string;
  product: string;
  payloadCanonical: string;
  checksum: string;
  deadline: Date;
}) {
  if (!JOB_ID.test(job.publicId)) return null;
  // 下发前自检：库里的 checksum 必须是 canonical 原文的 sha256，product 列与 payload 一致。
  if (sha256Hex(Buffer.from(job.payloadCanonical, 'utf8')) !== job.checksum) return null;
  const payload = parseStoredPayload(job.payloadCanonical);
  if (!payload || payload.product !== job.product) return null;
  return {
    job_id: job.publicId,
    product: payload.product,
    scenario_pack: payload.scenario_pack,
    sink_base_url: payload.sink_base_url,
    checksum: job.checksum,
    deadline: isoSeconds(job.deadline),
  };
}

function jobScenarioPack(canonical: string): StoredPayload['scenario_pack'] {
  const payload = parseStoredPayload(canonical);
  if (!payload) throw new Error('任务 payload 损坏');
  return payload.scenario_pack;
}
