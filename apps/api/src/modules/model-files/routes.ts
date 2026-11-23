import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FindingRemediationStatus, FindingReviewStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile, open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { uploadMetaPathFor, uploadPathFor } from './executor.js';
import { browseDirectory, BROWSE_LIMITS } from './browse.js';
import { resolveAllowed } from './filesystem.js';
import { uploadTooLargeMessage } from './messages.js';
import { readLibraryUpload, withLibraryUpload } from './library.js';
import {
  appendLibraryChunk,
  assertDiskSpace,
  assertOffset,
  CHUNK_BYTES,
  deleteLibraryFiles,
  diskFreeBytes,
  finishLibraryUpload,
  isStaleUpload,
  libraryPaths,
  uploadByteLimit,
  uploadStreamLimit,
} from './library-storage.js';
import { modelFileRemediationRoutes } from './remediation.js';
import {
  aibomFields,
  aibomOptions,
  cancelModelFileScan,
  createQueuedScan,
  queueModelFileScan,
  rootsEmpty,
} from './launch.js';
import { MODEL_FILE_RULES, SCRIPT_RISK_FORMATS } from './rules.js';
import { describeRoots, toHostPath, usableAdminRoots, validateAdminRoots } from './roots.js';
import {
  CONFIG_SCHEMA_VERSION,
  effectiveRoots,
  ENV_ROOTS,
  HOST_DIR,
  LIMIT_BOUNDS,
  loadConfig,
  serializeScan,
  SETTING_KEY,
  UPLOAD_DIR,
  UPLOAD_MAX_BYTES,
} from './service.js';

const uploadSchema = z
  .object({
    uploadId: z.string().uuid(),
    fileName: z.string().min(1).max(255).optional(),
    ...aibomFields,
  })
  .strict();
const stageQuery = z.object({ fileName: z.string().min(1).max(255) });
const STAGE_TTL_MS = 24 * 60 * 60 * 1000;
const directorySchema = z.object({ path: z.string().min(1).max(2000), ...aibomFields }).strict();
const outOfRange = (what: string, min: string, max: string) =>
  `${what}超出范围，请填写 ${min} 到 ${max} 之间的数值`;
const configSchema = z
  .object({
    roots: z.array(z.string().max(1000, '目录路径过长')).max(20, '管理员最多添加 20 个目录'),
    pickleMaxBytes: z
      .number({ invalid_type_error: '「单个 pickle 文件的解析上限」请填写数字' })
      .int()
      .min(
        LIMIT_BOUNDS.pickleMaxBytes.min,
        outOfRange('「单个 pickle 文件的解析上限」', '1 KiB', '8 GiB'),
      )
      .max(
        LIMIT_BOUNDS.pickleMaxBytes.max,
        outOfRange('「单个 pickle 文件的解析上限」', '1 KiB', '8 GiB'),
      ),
    totalMaxBytes: z
      .number({ invalid_type_error: '「单次扫描总量上限」请填写数字' })
      .int()
      .min(LIMIT_BOUNDS.totalMaxBytes.min, outOfRange('「单次扫描总量上限」', '1 KiB', '16 TiB'))
      .max(LIMIT_BOUNDS.totalMaxBytes.max, outOfRange('「单次扫描总量上限」', '1 KiB', '16 TiB')),
    maxFiles: z
      .number({ invalid_type_error: '「单次扫描文件数上限」请填写数字' })
      .int()
      .min(LIMIT_BOUNDS.maxFiles.min, outOfRange('「单次扫描文件数上限」', '1', '100000'))
      .max(LIMIT_BOUNDS.maxFiles.max, outOfRange('「单次扫描文件数上限」', '1', '100000')),
  })
  .strict();
const listQuery = z.object({
  targetId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const findingQuery = z.object({
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']).optional(),
  reviewStatus: z.nativeEnum(FindingReviewStatus).optional(),
  remediationStatus: z.nativeEnum(FindingRemediationStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const idParams = z.object({ id: z.string().uuid() });
const include = {
  target: { select: { id: true, name: true } },
  createdBy: { select: { id: true, displayName: true } },
} as const;

/**
 * 可见性口径（与风险处置台一致）：读——具备模块读权限（由各路由 requirePermission 把关）即可看全部扫描；
 * 写（取消/复核/整改）——仅创建者或内置管理员（取消见 launch.ts 的 cancelModelFileScan）。
 */
function audit(
  req: FastifyRequest,
  action: string,
  targetType: string,
  targetId: string,
  detail: unknown,
) {
  return writeAudit({
    actorId: req.currentUser!.id,
    actorName: req.currentUser!.username,
    action,
    targetType,
    targetId,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    detail,
  });
}
function auditContext(req: FastifyRequest) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] ?? null };
}
function message(e: unknown) {
  return e instanceof Error ? e.message : '扫描失败';
}

function uploadTooLarge() {
  return uploadTooLargeMessage(UPLOAD_MAX_BYTES, HOST_DIR);
}

/** 配置接口的统一返回：上限、目录明细（含服务器路径、来源、可用状态）与取值范围。 */
async function configPayload(cfg: Awaited<ReturnType<typeof loadConfig>>) {
  const usable = usableAdminRoots(cfg.roots);
  return {
    ...cfg,
    envRoots: ENV_ROOTS,
    uploadMaxBytes: UPLOAD_MAX_BYTES,
    hostDir: HOST_DIR,
    rootDetails: await describeRoots({
      deployRoots: ENV_ROOTS,
      adminRoots: cfg.roots,
      hostDir: HOST_DIR,
    }),
    limitBounds: LIMIT_BOUNDS,
    ignoredRoots: cfg.roots.filter((r) => !usable.includes(r)),
  };
}
/** 完成的库文件永久保留，仅清理七天无进展的会话与旧的一次性暂存。 */
export async function sweepStaleUploads() {
  const rows = await prisma.modelFileUpload.findMany({
    select: { id: true, status: true, updatedAt: true },
  });
  for (const row of rows.filter((r) => isStaleUpload(r))) {
    await withLibraryUpload(row.id, null, async (current, tx) => {
      if (!isStaleUpload(current)) return;
      await deleteLibraryFiles(UPLOAD_DIR, row.id);
      await tx.modelFileUpload.update({ where: { id: row.id }, data: { status: 'DELETED' } });
    }).catch((e: unknown) => {
      if (!(e instanceof AppError && e.statusCode === 404)) throw e;
    });
  }
  const libraryIds = new Set(rows.map((r) => r.id));
  for (const name of await readdir(UPLOAD_DIR).catch(() => [] as string[])) {
    const match = /^([0-9a-f-]{36})\.(bin|json|part)$/i.exec(name);
    if (!match || libraryIds.has(match[1]!)) continue;
    const p = resolve(UPLOAD_DIR, name);
    const s = await stat(p).catch(() => null);
    const ttl = match[2] === 'part' ? 7 * STAGE_TTL_MS : STAGE_TTL_MS;
    if (s?.isFile() && Date.now() - s.mtimeMs > ttl) await rm(p, { force: true });
  }
}

export async function modelFileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  // 原始字节上传：不经 JSON/Base64，把请求流原样交给路由处理（仅本插件作用域）。
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
  );
  await app.register(modelFileRemediationRoutes);
  const sweepTimer = setInterval(
    () => {
      void sweepStaleUploads().catch(() => app.log.error('模型文件库清理未完成，将在下次重试'));
    },
    60 * 60 * 1000,
  );
  sweepTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweepTimer);
  });

  app.get(
    '/config',
    { preHandler: [requirePermission('platform_setting:read', 'engine:scan')] },
    async () => configPayload(await loadConfig()),
  );

  app.put(
    '/config',
    { preHandler: [requirePermission('platform_setting:update')] },
    async (req) => {
      const parsed = configSchema.safeParse(req.body);
      if (!parsed.success)
        throw badRequest(
          parsed.error.issues[0]?.message ?? '参数不正确',
          'MODEL_FILE_CONFIG_INVALID',
        );
      const body = parsed.data;
      const before = await loadConfig();
      const checked = await validateAdminRoots(body.roots, {
        deployRoots: ENV_ROOTS,
        savedRoots: before.roots,
      });
      if (checked.rejected.length)
        throw badRequest(
          checked.rejected.map((r) => `${r.path || '（空）'}：${r.reason}`).join('；'),
          'MODEL_FILE_ROOT_INVALID',
          { rejected: checked.rejected },
        );
      const saved = { ...body, roots: checked.roots };
      const value = { ...saved, schemaVersion: CONFIG_SCHEMA_VERSION };
      await prisma.systemSetting.upsert({
        where: { key: SETTING_KEY },
        create: {
          key: SETTING_KEY,
          value: value as unknown as Prisma.InputJsonValue,
          updatedById: req.currentUser!.id,
        },
        update: {
          value: value as unknown as Prisma.InputJsonValue,
          updatedById: req.currentUser!.id,
        },
      });
      const previous = new Set(before.roots);
      await audit(req, 'model_file_scan.config.update', 'system_setting', SETTING_KEY, {
        rootCount: saved.roots.length,
        addedRoots: saved.roots.filter((r) => !previous.has(r)),
        removedRoots: before.roots.filter((r) => !saved.roots.includes(r)),
        pickleMaxBytes: saved.pickleMaxBytes,
        totalMaxBytes: saved.totalMaxBytes,
        maxFiles: saved.maxFiles,
      });
      return configPayload({ ...before, ...saved });
    },
  );

  /** 列出白名单根下某目录的子目录与模型文件（含大小、修改时间），供页面逐级浏览；条数有上限。 */
  app.get('/browse', { preHandler: [requirePermission('engine:scan')] }, async (req) => {
    const { path } = z.object({ path: z.string().min(1).max(2000) }).parse(req.query);
    const roots = effectiveRoots(await loadConfig());
    if (!roots.length) throw rootsEmpty();
    const real = await resolveAllowed(path, roots).catch((e) => {
      throw badRequest(message(e), 'MODEL_FILE_PATH_REJECTED');
    });
    const listing = await browseDirectory(real, BROWSE_LIMITS).catch((e: NodeJS.ErrnoException) => {
      throw badRequest(
        e.code === 'EACCES' || e.code === 'EPERM'
          ? '没有读取权限：平台进程读不了这个目录，请联系管理员检查目录权限'
          : '目录读取失败，请刷新后重试',
        'MODEL_FILE_BROWSE_FAILED',
      );
    });
    return { path: real, hostPath: toHostPath(real, HOST_DIR), ...listing };
  });

  const libraryQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  });
  const createUpload = z
    .object({
      fileName: z.string().trim().min(1).max(255),
      totalBytes: z.number().int().nonnegative().safe().optional(),
    })
    .strict();
  const ensureUploading = (status: string) => {
    if (status !== 'UPLOADING') throw conflict('文件已上传完成，不能继续写入');
  };
  const libraryPermission = { preHandler: [requirePermission('engine:scan')] };

  app.post('/library/uploads', libraryPermission, async (req) => {
    const b = createUpload.parse(req.body);
    await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
    await sweepStaleUploads();
    assertDiskSpace(await diskFreeBytes(UPLOAD_DIR), b.totalBytes ?? CHUNK_BYTES);
    if (UPLOAD_MAX_BYTES > 0 && (b.totalBytes ?? 0) > UPLOAD_MAX_BYTES)
      throw new AppError(413, uploadTooLarge(), 'MODEL_FILE_UPLOAD_TOO_LARGE');
    const id = randomUUID();
    const fileName = basename(b.fileName.replaceAll('\\', '/'));
    if (!fileName || fileName === '.' || fileName === '..') throw badRequest('请提供文件名');
    const part = libraryPaths(UPLOAD_DIR, id).part;
    const handle = await open(part, 'wx', 0o600);
    await handle.close();
    try {
      await prisma.modelFileUpload.create({
        data: {
          id,
          fileName,
          storedPath: id,
          expectedBytes: b.totalBytes === undefined ? null : BigInt(b.totalBytes),
          createdById: req.currentUser!.id,
        },
      });
    } catch (e) {
      await rm(part, { force: true });
      throw e;
    }
    return { uploadId: id, chunkSize: CHUNK_BYTES };
  });

  app.get('/library/uploads/:id', libraryPermission, async (req) => {
    const { id } = idParams.parse(req.params);
    const row = await readLibraryUpload(id, req.currentUser!);
    return {
      status: row.status,
      bytes: Number(row.bytes),
      expectedBytes: row.expectedBytes === null ? null : Number(row.expectedBytes),
    };
  });

  app.put(
    '/library/uploads/:id/chunk',
    { ...libraryPermission, bodyLimit: CHUNK_BYTES },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const { offset } = z
        .object({ offset: z.coerce.number().int().nonnegative().safe() })
        .parse(req.query);
      if (!(req.body && typeof (req.body as Readable).pipe === 'function'))
        throw badRequest('请选择文件后继续上传');
      return withLibraryUpload(id, req.currentUser!, async (row, tx) => {
        ensureUploading(row.status);
        assertOffset(offset, Number(row.bytes));
        const declared = Number(req.headers['content-length'] ?? 0);
        const remaining =
          row.expectedBytes === null ? CHUNK_BYTES : Number(row.expectedBytes) - offset;
        const maxBytes = Math.min(
          CHUNK_BYTES,
          remaining,
          uploadByteLimit(UPLOAD_MAX_BYTES) - offset,
        );
        if (declared > maxBytes)
          throw new AppError(
            413,
            '本次上传内容超过文件剩余大小或分段大小，请重新选择文件',
            'MODEL_FILE_CHUNK_TOO_LARGE',
          );
        assertDiskSpace(
          await diskFreeBytes(UPLOAD_DIR),
          declared || Math.min(CHUNK_BYTES, maxBytes),
        );
        const bytes = await appendLibraryChunk(
          libraryPaths(UPLOAD_DIR, id).part,
          offset,
          req.body as Readable,
          async (needed) => assertDiskSpace(await diskFreeBytes(UPLOAD_DIR), needed),
          maxBytes,
        );
        await tx.modelFileUpload.update({ where: { id }, data: { bytes: BigInt(bytes) } });
        return { bytes };
      });
    },
  );

  app.post('/library/uploads/:id/complete', libraryPermission, async (req) => {
    const { id } = idParams.parse(req.params);
    return withLibraryUpload(id, req.currentUser!, async (row, tx) => {
      if (row.status === 'READY')
        return { uploadId: id, status: row.status, bytes: Number(row.bytes) };
      const result = await finishLibraryUpload(
        UPLOAD_DIR,
        id,
        Number(row.bytes),
        row.expectedBytes === null ? null : Number(row.expectedBytes),
      );
      await tx.modelFileUpload.update({
        where: { id },
        data: { status: 'READY', completedAt: new Date(), sha256: result.sha256 },
      });
      return { uploadId: id, status: 'READY' as const, bytes: Number(row.bytes) };
    });
  });

  app.get('/library', libraryPermission, async (req) => {
    const q = libraryQuery.parse(req.query);
    const where = { status: { in: ['UPLOADING', 'READY'] as Array<'UPLOADING' | 'READY'> } };
    const [items, total, usage] = await Promise.all([
      prisma.modelFileUpload.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          createdBy: { select: { id: true, displayName: true } },
          scans: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              status: true,
              highCount: true,
              mediumCount: true,
              lowCount: true,
              truncatedCount: true,
            },
          },
        },
      }),
      prisma.modelFileUpload.count({ where }),
      prisma.modelFileUpload.aggregate({ where, _sum: { bytes: true } }),
    ]);
    await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
    return {
      items: items.map(({ storedPath: _path, scans, ...row }) => {
        const last = scans[0];
        const verdict =
          !last || last.status !== 'COMPLETED'
            ? null
            : last.highCount > 0
              ? '高风险'
              : last.mediumCount > 0
                ? '中风险'
                : last.lowCount > 0
                  ? '低风险'
                  : last.truncatedCount > 0
                    ? '部分内容未检查'
                    : '未发现风险';
        return {
          ...row,
          bytes: Number(row.bytes),
          expectedBytes: row.expectedBytes === null ? null : Number(row.expectedBytes),
          latestScan: last ? { id: last.id, status: last.status, verdict } : null,
        };
      }),
      total,
      page: q.page,
      pageSize: q.pageSize,
      diskFreeBytes: await diskFreeBytes(UPLOAD_DIR),
      libraryBytes: Number(usage._sum.bytes ?? 0),
    };
  });

  app.delete('/library/:id', libraryPermission, async (req) => {
    const { id } = idParams.parse(req.params);
    const row = await withLibraryUpload(id, req.currentUser!, async (row, tx) => {
      const active = await tx.modelFileScan.count({
        where: { uploadId: id, status: { in: ['PENDING', 'RUNNING'] } },
      });
      if (active) throw conflict('这个文件正在排队或扫描，请等待扫描结束后再删除');
      await deleteLibraryFiles(UPLOAD_DIR, id);
      await tx.modelFileUpload.update({ where: { id }, data: { status: 'DELETED' } });
      return row;
    });
    await audit(req, 'model_file_library.delete', 'model_file_upload', id, {
      fileName: row.fileName,
      bytes: Number(row.bytes),
    });
    return { deleted: true };
  });

  app.post('/library/:id/scan', libraryPermission, async (req) => {
    const { id } = idParams.parse(req.params);
    const b = z
      .object(aibomFields)
      .strict()
      .parse(req.body ?? {});
    return queueModelFileScan(
      req.currentUser!,
      { from: 'library', uploadId: id, body: b },
      auditContext(req),
    );
  });

  /** 第一步：原始字节流式写入暂存文件（元数据走 query），返回 uploadId。 */
  app.post(
    '/uploads',
    {
      preHandler: [requirePermission('engine:scan')],
      bodyLimit: uploadByteLimit(UPLOAD_MAX_BYTES),
    },
    async (req) => {
      const { fileName } = stageQuery.parse(req.query);
      const declared = Number(req.headers['content-length'] ?? 0);
      if (UPLOAD_MAX_BYTES > 0 && declared > UPLOAD_MAX_BYTES)
        throw badRequest(uploadTooLarge(), 'MODEL_FILE_UPLOAD_TOO_LARGE');
      if (!(req.body && typeof (req.body as Readable).pipe === 'function'))
        throw badRequest('上传方式不正确，请在页面中选择文件上传', 'MODEL_FILE_UPLOAD_TYPE');
      await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
      await sweepStaleUploads();
      assertDiskSpace(await diskFreeBytes(UPLOAD_DIR), declared);
      const uploadId = randomUUID();
      const dest = uploadPathFor(uploadId);
      let bytes = 0;
      try {
        await pipeline(
          req.body as Readable,
          uploadStreamLimit(
            UPLOAD_MAX_BYTES,
            (n) => (bytes = n),
            async (needed) => assertDiskSpace(await diskFreeBytes(UPLOAD_DIR), needed),
          ),
          createWriteStream(dest, { flags: 'wx', mode: 0o600 }),
        );
      } catch (e) {
        await rm(dest, { force: true });
        throw e;
      }
      if (bytes === 0) {
        await rm(dest, { force: true });
        throw badRequest('上传文件为空', 'MODEL_FILE_UPLOAD_EMPTY');
      }
      await writeFile(
        uploadMetaPathFor(uploadId),
        JSON.stringify({
          userId: req.currentUser!.id,
          fileName: basename(fileName),
          bytes,
          at: Date.now(),
        }),
        { mode: 0o600 },
      );
      return { uploadId, fileName: basename(fileName), bytes };
    },
  );

  /** 第二步：引用暂存文件建扫描任务（仅上传者本人可用，24 小时内有效），由后台扫描服务执行。 */
  app.post('/scan/upload', { preHandler: [requirePermission('engine:scan')] }, async (req) => {
    const b = uploadSchema.parse(req.body);
    const meta = await readFile(uploadMetaPathFor(b.uploadId), 'utf8')
      .then((s) => JSON.parse(s) as { userId: string; fileName: string; bytes: number; at: number })
      .catch(() => null);
    if (!meta || meta.userId !== req.currentUser!.id || Date.now() - meta.at > STAGE_TTL_MS)
      throw badRequest('上传文件不存在或已过期，请重新上传', 'MODEL_FILE_UPLOAD_MISSING');
    const { opts } = await aibomOptions(b);
    const fileName = meta.fileName;
    const row = await createQueuedScan(req.currentUser!, 'UPLOAD', fileName, b.targetId ?? null, {
      uploadId: b.uploadId,
      fileName,
      displayName: b.name || fileName,
      aibom: opts,
    });
    await audit(req, 'model_file_scan.run', 'model_file_scan', row.id, {
      source: 'upload',
      fileName,
      bytes: meta.bytes,
      targetId: b.targetId ?? null,
    });
    return { id: row.id, status: row.status };
  });

  app.post('/scan/directory', { preHandler: [requirePermission('engine:scan')] }, async (req) => {
    const { path, ...body } = directorySchema.parse(req.body);
    return queueModelFileScan(
      req.currentUser!,
      { from: 'directory', path, body },
      auditContext(req),
    );
  });

  app.post('/scans/:id/cancel', { preHandler: [requirePermission('engine:scan')] }, async (req) => {
    const { id } = idParams.parse(req.params);
    return cancelModelFileScan(req.currentUser!, id, auditContext(req));
  });

  app.get(
    '/scans',
    { preHandler: [requirePermission('engine:scan', 'remediation:read')] },
    async (req) => {
      const q = listQuery.parse(req.query);
      const where: Prisma.ModelFileScanWhereInput = {
        ...(q.targetId ? { targetId: q.targetId } : {}),
      };
      const [items, total] = await Promise.all([
        prisma.modelFileScan.findMany({
          where,
          include,
          orderBy: { createdAt: 'desc' },
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        prisma.modelFileScan.count({ where }),
      ]);
      return {
        items: items.map((r) => {
          const { files: _f, ...s } = serializeScan(r);
          return s;
        }),
        total,
        page: q.page,
        pageSize: q.pageSize,
      };
    },
  );

  app.get(
    '/scans/:id',
    { preHandler: [requirePermission('engine:scan', 'remediation:read')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const row = await prisma.modelFileScan.findFirst({
        where: { id },
        include,
      });
      if (!row) throw notFound('扫描记录不存在');
      return serializeScan(row);
    },
  );

  app.get(
    '/scans/:id/findings',
    { preHandler: [requirePermission('engine:scan', 'remediation:read')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const q = findingQuery.parse(req.query);
      if (
        !(await prisma.modelFileScan.findFirst({
          where: { id },
          select: { id: true },
        }))
      )
        throw notFound('扫描记录不存在');
      const where: Prisma.ModelFileFindingWhereInput = {
        scanId: id,
        ...(q.severity ? { severity: q.severity } : {}),
      };
      const [items, total] = await Promise.all([
        prisma.modelFileFinding.findMany({
          where,
          orderBy: [{ severity: 'desc' }, { filePath: 'asc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        prisma.modelFileFinding.count({ where }),
      ]);
      return { items, total, page: q.page, pageSize: q.pageSize };
    },
  );

  /** 扫描明细「脚本风险」：脚本和配置文件的问题按语言分组，不含提示级。 */
  app.get(
    '/scans/:id/script-risks',
    { preHandler: [requirePermission('engine:scan', 'remediation:read')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      if (!(await prisma.modelFileScan.findFirst({ where: { id }, select: { id: true } })))
        throw notFound('扫描记录不存在');
      const rows = await prisma.modelFileFinding.findMany({
        where: { scanId: id, format: { in: [...SCRIPT_RISK_FORMATS] }, severity: { not: 'INFO' } },
        orderBy: [{ severity: 'desc' }, { filePath: 'asc' }],
        take: 5000,
      });
      const groups = SCRIPT_RISK_FORMATS.map((format) => {
        const items = rows.filter((r) => r.format === format);
        return { format, total: items.length, items: items.slice(0, 200) };
      }).filter((g) => g.total > 0);
      return { groups };
    },
  );

  /** 模型文件扫描的规则清单（格式解析、已知模型校验、脚本、宏、配置）。 */
  app.get(
    '/rules',
    { preHandler: [requirePermission('engine:scan', 'remediation:read')] },
    async () => {
      const detectTotal = MODEL_FILE_RULES.filter((r) => r.kind === 'detect').length;
      return {
        total: MODEL_FILE_RULES.length,
        detectTotal,
        noteTotal: MODEL_FILE_RULES.length - detectTotal,
        items: MODEL_FILE_RULES,
      };
    },
  );

  app.get(
    '/scans/:id/aibom',
    { preHandler: [requirePermission('engine:scan', 'remediation:read', 'model_target:read')] },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      // 仅有 model_target:read 时只能导出已关联评估对象的 AIBOM（评估对象详情页入口）
      const p = req.currentUser!.permissions;
      const scope: Prisma.ModelFileScanWhereInput =
        p.has('engine:scan') || p.has('remediation:read') ? {} : { targetId: { not: null } };
      const row = await prisma.modelFileScan.findFirst({
        where: { id, ...scope },
        select: { id: true, aibom: true },
      });
      if (!row?.aibom) throw notFound('该扫描没有 AIBOM');
      await audit(req, 'model_file_scan.aibom.export', 'model_file_scan', row.id, {});
      return reply
        .header('content-type', 'application/vnd.cyclonedx+json; charset=utf-8')
        .header('content-disposition', `attachment; filename="aibom-${row.id}.cdx.json"`)
        .send(JSON.stringify(row.aibom, null, 2));
    },
  );

  /** 评估对象详情页：该对象最近一次关联扫描的 AIBOM。 */
  app.get(
    '/targets/:id/aibom',
    { preHandler: [requirePermission('model_target:read')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const row = await prisma.modelFileScan.findFirst({
        where: { targetId: id, status: 'COMPLETED', aibom: { not: Prisma.AnyNull } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true, source: true, aibom: true },
      });
      return row
        ? { scanId: row.id, createdAt: row.createdAt, source: row.source, aibom: row.aibom }
        : null;
    },
  );

  /** 评估对象详情页：最近一次关联扫描的结论（含排队/执行中/失败），无扫描返回 null。 */
  app.get(
    '/targets/:id/latest',
    { preHandler: [requirePermission('model_target:read')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      return prisma.modelFileScan.findFirst({
        where: { targetId: id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          source: true,
          path: true,
          createdAt: true,
          finishedAt: true,
          fileCount: true,
          highCount: true,
          mediumCount: true,
          lowCount: true,
          truncatedCount: true,
          error: true,
        },
      });
    },
  );

  /** 风险处置台来源：跨扫描列出模型文件问题（默认中危及以上），复核/整改见 remediation.ts。 */
  app.get(
    '/findings',
    { preHandler: [requirePermission('remediation:read', 'wrong_answer:export', 'engine:scan')] },
    async (req) => {
      const q = findingQuery.parse(req.query);
      const where: Prisma.ModelFileFindingWhereInput = {
        severity: q.severity ?? { in: ['CRITICAL', 'HIGH', 'MEDIUM'] },
        ...(q.reviewStatus ? { reviewStatus: q.reviewStatus } : {}),
        ...(q.remediationStatus ? { remediationStatus: q.remediationStatus } : {}),
      };
      const [items, total] = await Promise.all([
        prisma.modelFileFinding.findMany({
          where,
          include: {
            scan: {
              select: {
                id: true,
                source: true,
                path: true,
                createdAt: true,
                createdById: true,
                target: { select: { id: true, name: true } },
              },
            },
          },
          orderBy: [{ createdAt: 'desc' }, { severity: 'desc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        prisma.modelFileFinding.count({ where }),
      ]);
      return { items, total, page: q.page, pageSize: q.pageSize };
    },
  );
}
