import type { ModelFileUpload, Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { libraryPaths } from './library-storage.js';
import { UPLOAD_DIR } from './service.js';

type UploadActor = { id: string; isBuiltin: boolean; permissions: Set<string> };

function checkUploadActor(
  row: ModelFileUpload | null,
  actor: UploadActor | null,
): asserts row is ModelFileUpload {
  if (!row || row.status === 'DELETED') throw notFound('上传文件不存在或已删除');
  if (
    actor &&
    !actor.isBuiltin &&
    !actor.permissions.has('platform_setting:update') &&
    row.createdById !== actor.id
  )
    throw forbidden('只能操作自己上传的模型文件', 'MODEL_FILE_LIBRARY_ACCESS_DENIED');
}

/** 查询只读取已提交的进度，不等待正在写入或核对文件的会话锁。 */
export async function readLibraryUpload(id: string, actor: UploadActor) {
  libraryPaths(UPLOAD_DIR, id);
  const row = await prisma.modelFileUpload.findUnique({ where: { id } });
  checkUploadActor(row, actor);
  return row;
}

/** 行锁覆盖会话的磁盘与数据库修改，多个 API 进程也不能同时追加或删除。 */
export async function withLibraryUpload<T>(
  id: string,
  actor: UploadActor | null,
  action: (row: ModelFileUpload, tx: Prisma.TransactionClient) => Promise<T>,
) {
  libraryPaths(UPLOAD_DIR, id);
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM model_file_uploads WHERE id = ${id} FOR UPDATE`;
      const row = await tx.modelFileUpload.findUnique({ where: { id } });
      checkUploadActor(row, actor);
      return action(row, tx);
    },
    { timeout: 30 * 60 * 1000, maxWait: 10_000 },
  );
}
