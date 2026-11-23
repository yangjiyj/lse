import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';
import {
  TOOL_MANUAL_EXTS,
  TOOL_MANUAL_MAX_BYTES,
  TOOL_MANUAL_TYPES,
  toolManualExt,
} from '@lse/shared';
import { prisma } from '../../db.js';
import { attachmentDisposition } from '../../lib/attachment.js';
import { auditDownload } from '../../lib/data-security.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import {
  audit,
  creator,
  declaredLength,
  idParams,
  isMissingRecord,
  loadTool,
  loadVisibleTool,
} from './access.js';
import { actorOf, recordToolDownload } from './downloads.js';
import { manualView } from './service.js';
import { displayFilename, openStored, removeStored, storeUpload } from './storage.js';

// 工具操作手册（2.3.3、2.3.5）：上传、替换（id 不变）、删除、下载。
// 只收 pdf、docx、md、txt，单个 100 MiB；手册下载记下载记录，但不计登录页下载量。
// 工具禁用时手册仍可下载（禁用只拦安装包和建任务）。

const manualParams = idParams.extend({ manualId: z.string().uuid() });
const manualQuery = z.object({
  filename: z.string().min(1).max(1000),
  title: z.string().trim().max(200).optional(),
});

/** 文件名校验并取格式；不在白名单里 400。 */
function manualFile(raw: string) {
  const filename = displayFilename(raw);
  const ext = filename ? toolManualExt(filename) : null;
  if (!ext) throw badRequest(`手册只支持 ${TOOL_MANUAL_EXTS.join('、')} 格式`, 'TOOL_MANUAL_TYPE');
  return { filename, mime: TOOL_MANUAL_TYPES[ext] };
}

const titleOf = (filename: string) => filename.replace(/\.[^.]+$/, '') || filename;

export function toolManualRoutes(
  app: FastifyInstance,
  opts: { read: RouteShorthandOptions; manage: RouteShorthandOptions; uploadLimit: number },
): void {
  const { read, manage, uploadLimit } = opts;

  app.post('/:id/manuals', { ...manage, bodyLimit: uploadLimit }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const q = manualQuery.parse(request.query);
    const { filename, mime } = manualFile(q.filename);
    await loadTool(id);
    const stored = await storeUpload(
      request.body,
      declaredLength(request),
      TOOL_MANUAL_MAX_BYTES,
      '手册',
    );
    const manual = await prisma.toolManual
      .create({
        data: {
          toolId: id,
          title: q.title || titleOf(filename),
          filename,
          mime,
          size: BigInt(stored.size),
          sha256: stored.sha256,
          storageKey: stored.storageKey,
          createdById: request.currentUser!.id,
        },
        include: { createdBy: creator },
      })
      .catch(async (err: unknown) => {
        await removeStored(stored.storageKey);
        // 上传过程中工具被删了。
        if (isMissingRecord(err)) throw notFound('工具不存在');
        throw err;
      });
    await audit(request, 'tool.manual_upload', 'tool_manual', manual.id, {
      toolId: id,
      title: manual.title,
      filename,
      size: stored.size,
      sha256: stored.sha256,
    });
    reply.code(201);
    return manualView(id, manual);
  });

  /**
   * 替换手册文件：id 不变；没给新标题时保留原标题。
   * 按读到的旧文件做条件更新：两个人同时替换时后写的那个 409，删掉自己刚写的文件，不留孤儿文件。
   */
  app.put('/:id/manuals/:manualId', { ...manage, bodyLimit: uploadLimit }, async (request) => {
    const { id, manualId } = manualParams.parse(request.params);
    const q = manualQuery.parse(request.query);
    const { filename, mime } = manualFile(q.filename);
    const old = await prisma.toolManual.findFirst({ where: { id: manualId, toolId: id } });
    if (!old) throw notFound('手册不存在');
    const stored = await storeUpload(
      request.body,
      declaredLength(request),
      TOOL_MANUAL_MAX_BYTES,
      '手册',
    );
    const { count } = await prisma.toolManual
      .updateMany({
        where: { id: manualId, toolId: id, storageKey: old.storageKey },
        data: {
          title: q.title || old.title,
          filename,
          mime,
          size: BigInt(stored.size),
          sha256: stored.sha256,
          storageKey: stored.storageKey,
        },
      })
      .catch(async (err: unknown) => {
        await removeStored(stored.storageKey);
        throw err;
      });
    if (count === 0) {
      await removeStored(stored.storageKey);
      const still = await prisma.toolManual.findFirst({
        where: { id: manualId, toolId: id },
        select: { id: true },
      });
      if (!still) throw notFound('手册不存在');
      throw conflict('手册刚被别人替换过，请刷新后再试', 'TOOL_MANUAL_CHANGED');
    }
    await removeStored(old.storageKey);
    const manual = await prisma.toolManual.findUniqueOrThrow({
      where: { id: manualId },
      include: { createdBy: creator },
    });
    await audit(request, 'tool.manual_replace', 'tool_manual', manualId, {
      toolId: id,
      title: manual.title,
      filename,
      previousSha256: old.sha256,
      sha256: stored.sha256,
    });
    return manualView(id, manual);
  });

  app.delete('/:id/manuals/:manualId', manage, async (request, reply) => {
    const { id, manualId } = manualParams.parse(request.params);
    const manual = await prisma.toolManual.findFirst({ where: { id: manualId, toolId: id } });
    if (!manual) throw notFound('手册不存在');
    await prisma.toolManual.delete({ where: { id: manualId } });
    await removeStored(manual.storageKey);
    await audit(request, 'tool.manual_delete', 'tool_manual', manualId, {
      toolId: id,
      title: manual.title,
      filename: manual.filename,
    });
    return reply.code(204).send();
  });

  app.get('/:id/manuals/:manualId/download', read, async (request, reply) => {
    const { id, manualId } = manualParams.parse(request.params);
    const tool = await loadVisibleTool(request, id);
    const manual = tool.manuals.find((m) => m.id === manualId);
    if (!manual) throw notFound('手册不存在');
    const file = await openStored(manual.storageKey);
    await recordToolDownload(request, {
      toolId: id,
      kind: 'manual',
      manualId,
      filename: manual.filename,
      actor: actorOf(request),
    });
    await auditDownload(
      request.currentUser!,
      {
        kind: 'tool_manual',
        targetType: 'tool_manual',
        targetId: manualId,
        detail: { toolId: id, code: tool.code, title: manual.title, filename: manual.filename },
      },
      request,
    );
    return reply
      .type(manual.mime)
      .header('content-length', String(file.size))
      .header('content-disposition', attachmentDisposition(manual.filename))
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(file.stream);
  });
}
