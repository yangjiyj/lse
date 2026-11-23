import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FleetRemoteDeploy } from '@prisma/client';
import { z } from 'zod';
import { prisma, prismaUnscoped } from '../../../db.js';
import { writeAudit } from '../../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../../lib/errors.js';
import { authenticate, requirePermission } from '../../../plugins/auth.js';
import { buildOneclick, kitBaseUrl, shQuote } from '../install-script.js';
import { sha256Hex } from '../service.js';
import {
  resolveDeployTarget,
  validDeployHost,
  validSshUsername,
  type DeployLookup,
} from './host.js';
import { runSshDeploy, type RemoteShell } from './runner.js';
import { cleanupStaleSshDirs, sshCapability, systemRemoteShell } from './system-ssh.js';

// 远程部署终端探针（2.4.8）/api/fleet/remote-deploys：经 SSH 推送，或给一次性部署命令；只给 fleet:remote_deploy。

export interface RemoteDeployRoutesOptions {
  /** 测试注入假的 SSH 实现 */
  shell?: RemoteShell;
  /** 测试拿到后台部署的 Promise */
  onDeployStarted?: (deployId: string, done: Promise<void>) => void;
  /** 测试替换域名解析 */
  lookup?: DeployLookup;
}

const PERM = { preHandler: [requirePermission('fleet:remote_deploy')] };
/** 部署目标在 5 分钟内没有进展就算被服务重启打断（单次部署上限 120 秒）。 */
const STALE_MS = 5 * 60_000;
/** 每个租户同时进行的 SSH 部署上限。 */
export const REMOTE_DEPLOY_MAX_ACTIVE = 5;
const ACTIVE_STATUSES = ['PENDING', 'CONNECTING', 'INSTALLING'];
const SSH_CODE_TTL_MS = 15 * 60_000;
const MANUAL_CODE_TTL_MS = 24 * 3600_000;
export const DEPLOY_TARGET_MS = 30_000;

const idParams = z.object({ id: z.string().uuid() });
const hostField = z.string().trim().min(1).max(253).refine(validDeployHost);
const portField = z.number().int().min(1).max(65535);
const hostKeyBody = z.object({ host: hostField, port: portField.default(22) }).strict();
const sshBody = z
  .object({
    mode: z.literal('ssh'),
    host: hostField,
    port: portField.default(22),
    username: z.string().refine(validSshUsername),
    auth: z.discriminatedUnion('type', [
      z.object({ type: z.literal('password'), password: z.string().min(1).max(512) }).strict(),
      z
        .object({
          type: z.literal('key'),
          privateKey: z.string().min(1).max(16_384),
          passphrase: z.string().max(512).optional(),
        })
        .strict(),
    ]),
    sudoPassword: z.string().max(512).optional(),
    hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{20,}$/),
    hostKeyType: z.string().min(1).max(64),
    enableEval: z.boolean().default(false),
    runPosture: z.boolean().default(true),
  })
  .strict();
const manualBody = z
  .object({
    mode: z.literal('manual'),
    host: hostField,
    enableEval: z.boolean().default(false),
    runPosture: z.boolean().default(true),
  })
  .strict();
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** 参数校验失败只报字段名，不回显任何输入（口令、私钥）。 */
function parseOrInvalid<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path.join('.') || '请求体';
  throw badRequest(`参数不合法：${field}`, 'REMOTE_DEPLOY_INVALID');
}

function requestOrigin(request: FastifyRequest): string | null {
  const host = request.headers.host;
  return host ? `${request.protocol}://${host}` : null;
}

/** 一次性接入码（maxUses 1），明文只留在内存里。 */
async function issueCode(
  host: string,
  userId: string,
  ttlMs: number,
  db: Pick<typeof prisma, 'fleetEnrollmentCode'> = prisma,
) {
  const code = `jdc_${randomBytes(32).toString('base64url')}`;
  const row = await db.fleetEnrollmentCode.create({
    data: {
      label: `远程部署 ${host}`.slice(0, 200),
      codeHash: sha256Hex(code),
      codePrefix: code.slice(0, 8),
      maxUses: 1,
      expiresAt: new Date(Date.now() + ttlMs),
      createdById: userId,
    },
  });
  return { code, id: row.id };
}

/** 一次性部署命令：终端那边登记后按接入码补上终端、登记时间和耗时（脚本下载到登记）。 */
async function reconcileManual(d: FleetRemoteDeploy): Promise<FleetRemoteDeploy> {
  if (d.mode !== 'manual' || d.endpointId || !d.enrollmentCodeId) return d;
  const endpoint = await prismaUnscoped.fleetEndpoint.findFirst({
    where: { enrollmentCodeId: d.enrollmentCodeId },
    select: { id: true, registeredAt: true },
  });
  if (!endpoint) return d;
  return prismaUnscoped.fleetRemoteDeploy.update({
    where: { id: d.id },
    data: {
      endpointId: endpoint.id,
      registeredAt: endpoint.registeredAt,
      status: 'SUCCEEDED',
      durationMs: d.scriptFetchedAt
        ? endpoint.registeredAt.getTime() - d.scriptFetchedAt.getTime()
        : null,
    },
  });
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function serializeDeploy(d: FleetRemoteDeploy) {
  return {
    id: d.id,
    mode: d.mode,
    host: d.host,
    port: d.port,
    username: d.username,
    authType: d.authType,
    hostKeyFingerprint: d.hostKeyFingerprint,
    hostKeyType: d.hostKeyType,
    status: d.status,
    enableEval: d.enableEval,
    runPosture: d.runPosture,
    endpointId: d.endpointId,
    endpointHref: d.endpointId ? `/fleet/endpoints/${encodeURIComponent(d.endpointId)}` : null,
    postureTaskId: d.postureTaskId,
    postureTaskHref: d.postureTaskId ? `/eval-tasks/${encodeURIComponent(d.postureTaskId)}` : null,
    startedAt: iso(d.startedAt),
    connectedAt: iso(d.connectedAt),
    uploadedAt: iso(d.uploadedAt),
    scriptFetchedAt: iso(d.scriptFetchedAt),
    installedAt: iso(d.installedAt),
    registeredAt: iso(d.registeredAt),
    firstReportAt: iso(d.firstReportAt),
    durationMs: d.durationMs,
    withinTarget: d.durationMs !== null && d.durationMs <= DEPLOY_TARGET_MS,
    errorCode: d.errorCode,
    errorMessage: d.errorMessage,
    log: d.log,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/**
 * 周期清理（终端接入的 60 秒清扫和服务启动时调用，不按租户）：
 * - SSH 部署超过 5 分钟还停在排队、连接中、安装中：执行进程已经没了，置为失败「部署中断」并吊销接入码；
 * - 一次性部署命令的接入码已过期、终端也没登记：置为已过期。
 */
export async function sweepRemoteDeploys(now = new Date()): Promise<{
  interrupted: number;
  expired: number;
}> {
  const stale = await prismaUnscoped.fleetRemoteDeploy.findMany({
    where: {
      mode: 'ssh',
      status: { in: ACTIVE_STATUSES },
      updatedAt: { lt: new Date(now.getTime() - STALE_MS) },
    },
    select: { id: true, enrollmentCodeId: true },
  });
  for (const d of stale) {
    const r = await prismaUnscoped.fleetRemoteDeploy.updateMany({
      where: { id: d.id, status: { in: ACTIVE_STATUSES } },
      data: {
        status: 'FAILED',
        errorCode: 'INTERRUPTED',
        errorMessage: '部署中断（服务重启或执行进程退出），请重新部署',
      },
    });
    if (r.count > 0 && d.enrollmentCodeId) {
      await prismaUnscoped.fleetEnrollmentCode.updateMany({
        where: { id: d.enrollmentCodeId, status: { not: 'REVOKED' } },
        data: { status: 'REVOKED', revokedAt: now },
      });
    }
  }
  const waiting = await prismaUnscoped.fleetRemoteDeploy.findMany({
    where: { mode: 'manual', status: 'PENDING', endpointId: null, enrollmentCodeId: { not: null } },
  });
  const expiredCodes = new Set(
    waiting.length
      ? (
          await prismaUnscoped.fleetEnrollmentCode.findMany({
            where: {
              id: { in: waiting.map((d) => d.enrollmentCodeId!) },
              expiresAt: { lt: now },
            },
            select: { id: true },
          })
        ).map((c) => c.id)
      : [],
  );
  let expired = 0;
  for (const d of waiting.filter((w) => expiredCodes.has(w.enrollmentCodeId!))) {
    // 过期前刚登记的：补上终端，不算过期。
    const settled = await reconcileManual(d);
    if (settled.status !== 'PENDING') continue;
    const r = await prismaUnscoped.fleetRemoteDeploy.updateMany({
      where: { id: d.id, status: 'PENDING', endpointId: null },
      data: {
        status: 'EXPIRED',
        errorCode: 'EXPIRED',
        errorMessage: '一次性部署命令已过期，未在目标主机上执行',
      },
    });
    expired += r.count;
  }
  return { interrupted: stale.length, expired };
}

/** 服务启动时：清理被重启打断的部署、过期的一次性命令和上次进程留下的临时目录。 */
export async function failInterruptedRemoteDeploys(): Promise<number> {
  await cleanupStaleSshDirs().catch(() => 0);
  const r = await sweepRemoteDeploys();
  return r.interrupted;
}

/** 一键脚本下载（GET /api/fleet/install/linux.sh?deploy=）：只记一次性部署命令第一次下载脚本的时间。 */
export async function markScriptFetched(deployId: unknown): Promise<void> {
  const parsed = z.string().uuid().safeParse(deployId);
  if (!parsed.success) return;
  await prismaUnscoped.fleetRemoteDeploy.updateMany({
    where: { id: parsed.data, mode: 'manual', status: 'PENDING', scriptFetchedAt: null },
    data: { scriptFetchedAt: new Date() },
  });
}

export async function remoteDeployRoutes(
  app: FastifyInstance,
  options: RemoteDeployRoutesOptions = {},
): Promise<void> {
  app.addHook('preHandler', authenticate);
  const shell = options.shell ?? systemRemoteShell;
  const resolveTarget = (host: string) => resolveDeployTarget(host, options.lookup);

  const audit = (req: FastifyRequest, action: string, d: FleetRemoteDeploy) => {
    const ua = req.headers['user-agent'];
    return writeAudit({
      actorId: req.currentUser!.id,
      actorName: req.currentUser!.username,
      action,
      targetType: 'fleet_remote_deploy',
      targetId: d.id,
      ip: req.ip,
      userAgent: typeof ua === 'string' ? ua : null,
      // 只有这些字段，不含任何凭据和接入码。
      detail: {
        mode: d.mode,
        host: d.host,
        port: d.port,
        username: d.username,
        authType: d.authType,
        hostKeyFingerprint: d.hostKeyFingerprint,
        status: d.status,
        durationMs: d.durationMs,
      },
    });
  };

  app.get('/capability', PERM, async (req) => {
    const cap = sshCapability();
    const { oneclick } = await buildOneclick(requestOrigin(req));
    // 页面只说「一键安装包还没配置好」，具体缺什么（环境变量、证书）记日志给运维看。
    if (!oneclick.available) {
      req.log.info({ reasons: oneclick.reasons }, '远程部署：一键安装暂不可用');
    }
    return {
      ssh: cap.ssh,
      missing: cap.missing,
      oneclick: oneclick.available,
      reasons: oneclick.reasons,
    };
  });

  // 取主机指纹：展示给用户核对，确认后才部署。主机名解析一次，扫的是校验过范围的那个 IP。
  app.post('/host-key', PERM, async (req) => {
    const body = parseOrInvalid(hostKeyBody, req.body ?? {});
    const target = await resolveTarget(body.host);
    if (!sshCapability().ssh) {
      throw conflict(
        '平台未安装 SSH 客户端，只能使用一次性部署命令',
        'REMOTE_DEPLOY_SSH_UNAVAILABLE',
      );
    }
    let key: { type: string; fingerprint: string };
    try {
      key = await shell.scanHostKey(target.address, body.port);
    } catch (err) {
      throw new AppError(
        502,
        `取不到主机公钥：${(err as Error).message}`,
        'REMOTE_DEPLOY_HOST_KEY_FAILED',
      );
    }
    const ua = req.headers['user-agent'];
    await writeAudit({
      actorId: req.currentUser!.id,
      actorName: req.currentUser!.username,
      action: 'fleet.remote_deploy.host_key',
      targetType: 'fleet_remote_deploy',
      targetId: null,
      ip: req.ip,
      userAgent: typeof ua === 'string' ? ua : null,
      detail: {
        host: body.host,
        address: target.address,
        port: body.port,
        hostKeyType: key.type,
        hostKeyFingerprint: key.fingerprint,
      },
    });
    return { type: key.type, fingerprint: key.fingerprint };
  });

  app.post('/', PERM, async (req, reply) => {
    const mode = (req.body as { mode?: unknown } | null)?.mode;
    const user = req.currentUser!;
    const { oneclick, script } = await buildOneclick(requestOrigin(req));

    if (mode === 'ssh') {
      const body = parseOrInvalid(sshBody, req.body);
      const target = await resolveTarget(body.host);
      const cap = sshCapability();
      if (!cap.ssh) {
        throw new AppError(
          409,
          '平台未安装 SSH 客户端，只能使用一次性部署命令',
          'REMOTE_DEPLOY_SSH_UNAVAILABLE',
          { missing: cap.missing },
        );
      }
      if (!script) {
        throw new AppError(409, '一键安装暂不可用', 'REMOTE_DEPLOY_ONECLICK_UNAVAILABLE', {
          reasons: oneclick.reasons,
        });
      }
      // 每个租户同时进行的 SSH 部署有上限：按租户加事务锁，数完再建，并发请求不会一起越过上限。
      const { issued, deploy } = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`remote-deploy:${user.tenantId ?? ''}`}))`;
        const active = await tx.fleetRemoteDeploy.count({
          where: { mode: 'ssh', status: { in: ACTIVE_STATUSES } },
        });
        if (active >= REMOTE_DEPLOY_MAX_ACTIVE) {
          throw new AppError(
            429,
            `同时进行的远程部署最多 ${REMOTE_DEPLOY_MAX_ACTIVE} 个，请等前面的部署结束`,
            'REMOTE_DEPLOY_TOO_MANY',
          );
        }
        const issued = await issueCode(body.host, user.id, SSH_CODE_TTL_MS, tx);
        const deploy = await tx.fleetRemoteDeploy.create({
          data: {
            mode: 'ssh',
            host: body.host,
            port: body.port,
            username: body.username,
            authType: body.auth.type,
            hostKeyFingerprint: body.hostKeyFingerprint,
            hostKeyType: body.hostKeyType,
            enrollmentCodeId: issued.id,
            enableEval: body.enableEval,
            runPosture: body.runPosture,
            createdById: user.id,
          },
        });
        return { issued, deploy };
      });
      await audit(req, 'fleet.remote_deploy.start', deploy);
      // 在 API 进程后台执行；凭据只传给执行函数，不落库。
      const done = runSshDeploy(
        deploy.id,
        {
          auth: body.auth,
          sudoPassword: body.sudoPassword,
          code: issued.code,
          script,
          address: target.address,
        },
        { shell },
      ).catch((err: unknown) => console.error(`[remote-deploy] 部署异常 id=${deploy.id}:`, err));
      options.onDeployStarted?.(deploy.id, done);
      reply.code(202);
      return serializeDeploy(deploy);
    }

    const body = parseOrInvalid(manualBody, req.body);
    await resolveTarget(body.host);
    const base = kitBaseUrl(requestOrigin(req));
    if (!script || !base || !oneclick.scriptSha256) {
      throw new AppError(409, '一键安装暂不可用', 'REMOTE_DEPLOY_ONECLICK_UNAVAILABLE', {
        reasons: oneclick.reasons,
      });
    }
    const issued = await issueCode(body.host, user.id, MANUAL_CODE_TTL_MS);
    const deploy = await prisma.fleetRemoteDeploy.create({
      data: {
        mode: 'manual',
        host: body.host,
        enrollmentCodeId: issued.id,
        enableEval: body.enableEval,
        runPosture: body.runPosture,
        createdById: user.id,
      },
    });
    await audit(req, 'fleet.remote_deploy.start', deploy);
    const url = `${base}/api/fleet/install/linux.sh?deploy=${deploy.id}`;
    // 与接入页一样：下载 → 校验脚本 SHA-256 → sudo 执行；落盘用 mktemp，不用固定文件名，执行完删掉。
    const command =
      `f=$(mktemp /tmp/jiandun-probe.XXXXXX) && curl -fsSL ${shQuote(url)} -o "$f"` +
      ` && printf '%s  %s\\n' ${shQuote(oneclick.scriptSha256)} "$f" | sha256sum -c -` +
      ` && sudo bash "$f" --code ${shQuote(issued.code)}` +
      (body.enableEval ? ' --enable-eval' : '') +
      '; rm -f "$f"';
    reply.code(201);
    // 命令里的接入码明文只返回这一次。
    return { item: serializeDeploy(deploy), command };
  });

  app.get('/', PERM, async (req) => {
    const q = listQuery.parse(req.query);
    const [total, rows] = await Promise.all([
      prisma.fleetRemoteDeploy.count(),
      prisma.fleetRemoteDeploy.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    const items = await Promise.all(rows.map(reconcileManual));
    return { items: items.map(serializeDeploy), total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/:id', PERM, async (req) => {
    const { id } = idParams.parse(req.params);
    const row = await prisma.fleetRemoteDeploy.findUnique({ where: { id } });
    if (!row) throw notFound('部署记录不存在');
    return serializeDeploy(await reconcileManual(row));
  });
}
