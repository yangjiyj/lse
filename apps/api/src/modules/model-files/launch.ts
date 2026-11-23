import type { ModelFileScanSource, ModelFileScanStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { enqueueModelFileScan } from '../../lib/queue.js';
import type { CurrentUser } from '../../lib/rbac.js';
import { parseSbomUpload, SbomInputError, type ParsedSbom } from '../service-assurance/sbom.js';
import { removeUpload, type ScanRequest } from './executor.js';
import { resolveAllowed } from './filesystem.js';
import { readLibraryUpload, withLibraryUpload } from './library.js';
import { rootsEmptyMessage } from './messages.js';
import { effectiveRoots, HOST_DIR, loadConfig } from './service.js';

// 模型文件扫描的发起与停止（接口和组合任务的子任务共用）。

export const aibomFields = {
  targetId: z.string().uuid().nullable().optional(),
  name: z.string().trim().max(255).optional(),
  source: z.string().trim().max(1000).optional(),
  license: z.string().trim().max(500).optional(),
  parameterInfo: z.string().trim().max(1000).optional(),
  datasetRefs: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
  dependencySbom: z
    .object({ contentType: z.string().max(100), content: z.string().max(3 * 1024 * 1024) })
    .strict()
    .optional(),
};
const aibomSchema = z.object(aibomFields).strict();
export type AibomBody = z.infer<typeof aibomSchema>;

export interface LaunchAuditContext {
  ip: string | null;
  userAgent: string | null;
}

export function scanFailureMessage(e: unknown) {
  return e instanceof Error ? e.message : '扫描失败';
}

export const rootsEmpty = () =>
  badRequest(rootsEmptyMessage(HOST_DIR), 'MODEL_FILE_ROOTS_EMPTY', { hostDir: HOST_DIR });

function audit(
  user: { id: string; username: string },
  ctx: LaunchAuditContext,
  action: string,
  targetId: string,
  detail: unknown,
) {
  return writeAudit({
    actorId: user.id,
    actorName: user.username,
    action,
    targetType: 'model_file_scan',
    targetId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    detail,
  });
}

export async function aibomOptions(b: {
  targetId?: string | null;
  source?: string;
  license?: string;
  parameterInfo?: string;
  datasetRefs: string[];
  dependencySbom?: { contentType: string; content: string };
}) {
  const target = b.targetId
    ? await prisma.modelTarget.findUnique({
        where: { id: b.targetId },
        select: { id: true, name: true, model: true },
      })
    : null;
  if (b.targetId && !target) throw notFound('评估对象不存在');
  let dependencySbom: ParsedSbom | null = null;
  if (b.dependencySbom) {
    try {
      dependencySbom = parseSbomUpload(b.dependencySbom);
    } catch (e) {
      if (e instanceof SbomInputError) throw badRequest(e.message, e.code);
      throw e;
    }
  }
  return {
    target,
    opts: {
      source: b.source || null,
      license: b.license || null,
      parameterInfo: b.parameterInfo || null,
      datasetRefs: b.datasetRefs,
      target,
      dependencySbom,
    },
  };
}

/** 建 PENDING 扫描记录并入队；入队失败则置 FAILED 并清理上传暂存。 */
export async function createQueuedScan(
  user: CurrentUser,
  source: ModelFileScanSource,
  path: string,
  targetId: string | null,
  request: ScanRequest,
) {
  const data: Prisma.ModelFileScanUncheckedCreateInput = {
    source,
    path,
    targetId,
    status: 'PENDING',
    request: request as unknown as Prisma.InputJsonValue,
    createdById: user.id,
    ...(request.libraryUpload ? { uploadId: request.uploadId } : {}),
  };
  const row =
    request.libraryUpload && request.uploadId
      ? await withLibraryUpload(request.uploadId, user, async (upload, tx) => {
          if (upload.status !== 'READY') throw conflict('文件尚未上传完成，请先继续上传');
          return tx.modelFileScan.create({ data });
        })
      : await prisma.modelFileScan.create({ data });
  try {
    await enqueueModelFileScan(row.id);
  } catch (e) {
    await prisma.modelFileScan.update({
      where: { id: row.id },
      data: {
        status: 'FAILED',
        error: `扫描任务入队失败：${scanFailureMessage(e)}`,
        finishedAt: new Date(),
      },
    });
    if (!request.libraryUpload) await removeUpload(request.uploadId);
    throw badRequest(
      '扫描任务提交失败，后台扫描服务暂不可用，请稍后重试或联系管理员',
      'MODEL_FILE_ENQUEUE_FAILED',
      {
        scanId: row.id,
      },
    );
  }
  return row;
}

export type QueueModelFileScanInput =
  | { from: 'directory'; path: string; body: AibomBody }
  | { from: 'library'; uploadId: string; body: AibomBody };

/**
 * 发起一次模型文件扫描：服务器目录（在允许目录内）或模型库里已上传完成的文件。
 * 审计 model_file_scan.directory / model_file_scan.run。
 */
export async function queueModelFileScan(
  user: CurrentUser,
  input: QueueModelFileScanInput,
  ctx: LaunchAuditContext,
): Promise<{ id: string; status: ModelFileScanStatus }> {
  const b = input.body;
  if (input.from === 'directory') {
    const roots = effectiveRoots(await loadConfig());
    if (!roots.length) throw rootsEmpty();
    const real = await resolveAllowed(input.path, roots).catch((e) => {
      throw badRequest(scanFailureMessage(e), 'MODEL_FILE_PATH_REJECTED');
    });
    const { opts } = await aibomOptions(b);
    const row = await createQueuedScan(user, 'DIRECTORY', real, b.targetId ?? null, {
      aibom: opts,
    });
    await audit(user, ctx, 'model_file_scan.directory', row.id, {
      path: real,
      targetId: b.targetId ?? null,
    });
    return { id: row.id, status: row.status };
  }
  const upload = await readLibraryUpload(input.uploadId, user);
  if (upload.status !== 'READY') throw conflict('文件尚未上传完成，请先继续上传');
  const { opts } = await aibomOptions(b);
  const row = await createQueuedScan(user, 'UPLOAD', upload.fileName, b.targetId ?? null, {
    uploadId: input.uploadId,
    libraryUpload: true,
    fileName: upload.fileName,
    displayName: b.name || upload.fileName,
    aibom: opts,
  });
  await audit(user, ctx, 'model_file_scan.run', row.id, {
    source: 'library',
    uploadId: input.uploadId,
    fileName: upload.fileName,
    bytes: Number(upload.bytes),
  });
  return { id: row.id, status: row.status };
}

/**
 * 停止扫描：只能停自己发起的（内置管理员不限），只有排队中或执行中的能停。
 * auditActor：审计里记的操作人（组合任务以创建人身份停止时记实际点按钮的人），不给就是 user。
 */
export async function cancelModelFileScan(
  user: CurrentUser,
  id: string,
  ctx: LaunchAuditContext,
  auditActor: { id: string; username: string } = user,
): Promise<{ id: string; status: 'CANCELLED' }> {
  const scope: Prisma.ModelFileScanWhereInput = user.isBuiltin ? {} : { createdById: user.id };
  const r = await prisma.modelFileScan.updateMany({
    where: { id, ...scope, status: { in: ['PENDING', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });
  if (r.count === 0) {
    const exists = await prisma.modelFileScan.findUnique({
      where: { id },
      select: { createdById: true },
    });
    if (!exists) throw notFound('扫描记录不存在');
    if (!user.isBuiltin && exists.createdById !== user.id)
      throw forbidden('只能取消自己发起的扫描', 'MODEL_FILE_SCAN_ACCESS_DENIED');
    throw conflict('只有排队中或执行中的扫描可以取消', 'MODEL_FILE_SCAN_NOT_CANCELLABLE');
  }
  await audit(auditActor, ctx, 'model_file_scan.cancel', id, {});
  return { id, status: 'CANCELLED' };
}
