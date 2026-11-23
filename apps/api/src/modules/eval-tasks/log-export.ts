import type { Prisma, PrismaClient } from '@prisma/client';

/** 任务日志导出每批读的行数。 */
export const LOG_EXPORT_BATCH = 2000;

export interface ExportLogRow {
  id: string;
  createdAt: Date;
  level: string;
  message: string;
  context: Prisma.JsonValue | null;
}

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * 按 (createdAt, id) 游标分批读一个任务的日志，每批交给 onBatch 转成输出后即丢弃，
 * 不把全部日志对象（含 context）一次读进内存；返回读到的总行数。
 * 必须在请求处理函数里直接 await：查询的租户范围来自请求上下文，不要挪进响应流里懒读。
 */
export async function forEachLogBatch(
  db: Db,
  taskId: string,
  onBatch: (rows: ExportLogRow[]) => void,
  batchSize = LOG_EXPORT_BATCH,
): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows: ExportLogRow[] = await db.evalTaskLog.findMany({
      where: { taskId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, createdAt: true, level: true, message: true, context: true },
    });
    if (rows.length === 0) break;
    onBatch(rows);
    total += rows.length;
    if (rows.length < batchSize) break;
    cursor = rows[rows.length - 1]!.id;
  }
  return total;
}
