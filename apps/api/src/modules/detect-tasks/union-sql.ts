import { Prisma } from '@prisma/client';
import {
  DETECT_CATEGORIES,
  DETECT_RECORD_KINDS,
  DETECT_TASK_STATUSES,
  type DetectCategory,
  type DetectRecordKind,
  type DetectTaskStatus,
} from '@lse/shared';
import { prisma } from '../../db.js';
import {
  detectStatusSql,
  evalTaskDetectCategorySql,
  evalTaskRecordKindSql,
  tenantCondition,
} from '../../lib/detect-sql.js';

// 统一任务视图（2.4.1、2.4.4）：按可见的记录类型拼各表的 SELECT，UNION ALL 汇总。不迁移数据。
// 原始 SQL 不经租户查询扩展：每段都带 tenantCondition。

const EVAL_TASK_KINDS: DetectRecordKind[] = [
  'eval_task',
  'standard_run',
  'rag_eval',
  'fleet_eval_job',
];

interface Source {
  kinds: DetectRecordKind[];
  select: (tenant: (column: string) => Prisma.Sql) => Prisma.Sql;
}

const lit = (v: string) => Prisma.sql`${v}::text`;

/**
 * 每段输出同一组列：kind、category、id、name、raw_status、created_at、started_at、finished_at、
 * created_by_id、tenant_id。
 */
const SOURCES: Source[] = [
  {
    kinds: EVAL_TASK_KINDS,
    select: (tenant) => Prisma.sql`
      SELECT ${evalTaskRecordKindSql('t')} AS kind, ${evalTaskDetectCategorySql('t')} AS category,
        t."id", t."name", t."status"::text AS raw_status, t."createdAt" AS created_at,
        t."startedAt" AS started_at, t."finishedAt" AS finished_at, t."createdById" AS created_by_id,
        t."tenantId" AS tenant_id
      FROM "eval_tasks" t WHERE TRUE ${tenant('t."tenantId"')}`,
  },
  {
    kinds: ['batch_evaluation'],
    select: (tenant) => Prisma.sql`
      SELECT ${lit('batch_evaluation')}, ${lit(DETECT_RECORD_KINDS.batch_evaluation)},
        b."id", b."name", b."status"::text, b."createdAt", b."startedAt", b."finishedAt", b."createdById", b."tenantId"
      FROM "batch_evaluations" b WHERE TRUE ${tenant('b."tenantId"')}`,
  },
  {
    kinds: ['model_file_scan'],
    select: (tenant) => Prisma.sql`
      SELECT ${lit('model_file_scan')}, ${lit(DETECT_RECORD_KINDS.model_file_scan)},
        m."id", m."path", m."status"::text, m."createdAt", m."startedAt", m."finishedAt", m."createdById", m."tenantId"
      FROM "model_file_scans" m WHERE TRUE ${tenant('m."tenantId"')}`,
  },
  {
    kinds: ['corpus_scan'],
    select: (tenant) => Prisma.sql`
      SELECT ${lit('corpus_scan')}, ${lit(DETECT_RECORD_KINDS.corpus_scan)},
        c."id", c."fileName", c."status", c."createdAt", c."startedAt", c."finishedAt", c."createdById", c."tenantId"
      FROM "corpus_scans" c WHERE TRUE ${tenant('c."tenantId"')}`,
  },
  {
    kinds: ['asset_discovery'],
    select: (tenant) => Prisma.sql`
      SELECT ${lit('asset_discovery')}, ${lit(DETECT_RECORD_KINDS.asset_discovery)},
        a."id", array_to_string(a."targets", '、'), a."status", a."createdAt", a."startedAt",
        a."finishedAt", a."createdById", a."tenantId"
      FROM "asset_discovery_runs" a WHERE TRUE ${tenant('a."tenantId"')}`,
  },
  {
    kinds: ['service_assurance'],
    select: (tenant) => Prisma.sql`
      SELECT ${lit('service_assurance')}, ${lit(DETECT_RECORD_KINDS.service_assurance)},
        s."id", s."targetName", s."status"::text, s."createdAt", s."startedAt", s."endedAt", s."createdById", s."tenantId"
      FROM "service_assurance_runs" s WHERE TRUE ${tenant('s."tenantId"')}`,
  },
  {
    kinds: ['ai_component_scan'],
    select: (tenant) => Prisma.sql`
      SELECT ${lit('ai_component_scan')}, ${lit(DETECT_RECORD_KINDS.ai_component_scan)},
        x."id", x."assetName", x."status", x."createdAt", x."createdAt", x."createdAt", x."createdById", x."tenantId"
      FROM "ai_component_scans" x WHERE TRUE ${tenant('x."tenantId"')}`,
  },
];

export interface DetectTaskFilter {
  /** 当前用户能看的记录类型；为空时什么都不返回 */
  kinds: DetectRecordKind[];
  /** 全部租户视角下的 ?tenantId=；其余情况取当前租户范围 */
  tenantId?: string;
  category?: DetectCategory;
  kind?: DetectRecordKind;
  status?: DetectTaskStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
  jobId?: string;
}

export interface DetectTaskRawRow {
  kind: DetectRecordKind;
  category: DetectCategory;
  id: string;
  name: string;
  raw_status: string;
  status: DetectTaskStatus;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  created_by_id: string | null;
  tenant_id: string | null;
  created_by_username: string | null;
  job_id: string | null;
  job_name: string | null;
}

/** LIKE 的 % _ \ 按字面匹配。 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 汇总后的记录集（CTE 名 r），带统一状态和所属组合任务。filters 里的 status 不在这里过滤，
 * 统计按状态分组时要用全部状态。
 */
function recordsCte(f: DetectTaskFilter, withStatus: boolean): Prisma.Sql | null {
  const visible = f.kind ? f.kinds.filter((k) => k === f.kind) : f.kinds;
  if (visible.length === 0) return null;
  const tenant = (column: string) => tenantCondition(column, f.tenantId);
  const parts = SOURCES.filter((s) => s.kinds.some((k) => visible.includes(k))).map((s) =>
    s.select(tenant),
  );
  const where: Prisma.Sql[] = [Prisma.sql`u.kind IN (${Prisma.join(visible)})`];
  if (f.category) where.push(Prisma.sql`u.category = ${f.category}`);
  if (f.q) where.push(Prisma.sql`u.name ILIKE ${`%${escapeLike(f.q)}%`} ESCAPE '\\'`);
  if (f.createdFrom) where.push(Prisma.sql`u.created_at >= ${f.createdFrom}`);
  if (f.createdTo) where.push(Prisma.sql`u.created_at <= ${f.createdTo}`);
  const statusExpr = detectStatusSql(Prisma.raw('u.raw_status'));
  if (withStatus && f.status) where.push(Prisma.sql`${statusExpr} = ${f.status}`);
  if (f.jobId) {
    where.push(Prisma.sql`EXISTS (SELECT 1 FROM "detect_job_items" ji
      WHERE ji."jobId" = ${f.jobId} AND ji."recordId" = u.id AND ji."recordKind" = u.kind)`);
  }
  return Prisma.sql`WITH u (kind, category, id, name, raw_status, created_at, started_at, finished_at, created_by_id, tenant_id) AS (
      ${Prisma.join(parts, ' UNION ALL ')}
    ),
    r AS (
      SELECT u.*, ${statusExpr} AS status FROM u WHERE ${Prisma.join(where, ' AND ')}
    )`;
}

export async function queryDetectTasks(
  f: DetectTaskFilter,
  page: number,
  pageSize: number,
): Promise<{ rows: DetectTaskRawRow[]; total: number }> {
  const cte = recordsCte(f, true);
  if (!cte) return { rows: [], total: 0 };
  const [count] = await prisma.$queryRaw<Array<{ total: bigint }>>`
    ${cte} SELECT count(*)::bigint AS total FROM r`;
  // 先排序取出当前页，再只对这一页关联创建人和所属组合任务（不对全部行做关联）。
  const rows = await prisma.$queryRaw<DetectTaskRawRow[]>`
    ${cte},
    p AS (
      SELECT * FROM r ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    )
    SELECT p.*, usr."username" AS created_by_username, job."id" AS job_id, job."name" AS job_name
    FROM p
    LEFT JOIN "users" usr ON usr."id" = p.created_by_id
    LEFT JOIN LATERAL (
      SELECT j."id", j."name" FROM "detect_job_items" ji JOIN "detect_jobs" j ON j."id" = ji."jobId"
      WHERE ji."recordId" = p.id AND ji."recordKind" = p.kind
      ORDER BY ji."createdAt" DESC LIMIT 1
    ) job ON TRUE
    ORDER BY p.created_at DESC, p.id DESC`;
  return { rows, total: Number(count?.total ?? 0) };
}

export type StatusCounts = Record<DetectTaskStatus, number>;

export function emptyStatusCounts(): StatusCounts {
  return Object.fromEntries(DETECT_TASK_STATUSES.map((s) => [s, 0])) as StatusCounts;
}

export async function detectTaskStats(f: DetectTaskFilter) {
  const byStatus = emptyStatusCounts();
  const byCategory = Object.fromEntries(
    DETECT_CATEGORIES.map((c) => [c, { total: 0, byStatus: emptyStatusCounts() }]),
  ) as Record<DetectCategory, { total: number; byStatus: StatusCounts }>;
  const byKind: Partial<Record<DetectRecordKind, number>> = {};
  let total = 0;
  const cte = recordsCte({ ...f, status: undefined }, false);
  if (cte) {
    const groups = await prisma.$queryRaw<
      Array<{
        kind: DetectRecordKind;
        category: DetectCategory;
        status: DetectTaskStatus;
        n: bigint;
      }>
    >`${cte} SELECT kind, category, status, count(*)::bigint AS n FROM r GROUP BY kind, category, status`;
    for (const g of groups) {
      const n = Number(g.n);
      total += n;
      byStatus[g.status] += n;
      if (byCategory[g.category]) {
        byCategory[g.category].total += n;
        byCategory[g.category].byStatus[g.status] += n;
      }
      byKind[g.kind] = (byKind[g.kind] ?? 0) + n;
    }
  }
  return { total, byStatus, byCategory, byKind, kinds: f.kinds };
}
