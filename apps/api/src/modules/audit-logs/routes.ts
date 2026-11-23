import { Readable } from 'node:stream';
import type { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { sanitizeJson } from '../../lib/redact.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { applyTenantFilter } from '../../lib/all-tenants.js';
import { writeAudit } from '../../lib/audit.js';
import { loadSecurityPolicy } from '../../lib/security-policy.js';
import { csvCell } from '../../lib/tabular-export.js';

/** 单次导出上限。 */
export const AUDIT_EXPORT_MAX_ROWS = 50_000;
/** 导出时每批从库里读的行数。 */
export const AUDIT_EXPORT_BATCH_SIZE = 2000;
const CSV_HEADER = ['时间', '操作人', '动作', '对象类型', '对象', 'IP', '详情'];
/** 「全部租户」视角下导出追加的列。 */
const CSV_TENANT_HEADER = '租户';

/** 不以 download.* 命名、但属于文件下载的审计动作（历史的报告下载、风险样本导出，以及各类导出）。 */
export const LEGACY_DOWNLOAD_ACTIONS = [
  'report.download',
  'wrong_answer.export',
  'eval_task.list_export',
  'eval_task.log_export',
  'question_set.export',
  'corpus_scan.export',
  'corpus_scan.masked_copy',
  'detect_scheme.guide_download',
] as const;

const filterQuery = z.object({
  action: z.string().trim().min(1).optional(),
  tenantId: z.string().uuid().optional(),
  /** download：所有文件下载日志（download.* 以及历史的报告下载、风险样本导出）。 */
  category: z.enum(['download']).optional(),
  actorName: z.string().trim().min(1).optional(),
  targetType: z.string().trim().min(1).optional(),
  start: z
    .string()
    .trim()
    .min(1)
    .refine((v) => !Number.isNaN(Date.parse(v)), '非法 start 日期')
    .optional(),
  end: z
    .string()
    .trim()
    .min(1)
    .refine((v) => !Number.isNaN(Date.parse(v)), '非法 end 日期')
    .optional(),
});

const listQuery = filterQuery.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const exportQuery = filterQuery.extend({
  format: z.enum(['csv', 'json']).default('csv'),
});

type AuditLogWhere = {
  action?: string;
  tenantId?: string;
  actorName?: { contains: string; mode: 'insensitive' };
  targetType?: string;
  createdAt?: { gte?: Date; lte?: Date };
  OR?: Array<{ action: { startsWith: string } | { in: string[] } }>;
};

/** 列表与导出共用的筛选条件。 */
function buildWhere(request: FastifyRequest, q: z.infer<typeof filterQuery>): AuditLogWhere {
  const where: AuditLogWhere = {};
  if (q.action) where.action = q.action;
  if (q.category === 'download') {
    where.OR = [
      { action: { startsWith: 'download.' } },
      { action: { in: [...LEGACY_DOWNLOAD_ACTIONS] } },
    ];
  }
  if (q.actorName) where.actorName = { contains: q.actorName, mode: 'insensitive' };
  if (q.targetType) where.targetType = q.targetType;
  if (q.start || q.end) {
    where.createdAt = {};
    if (q.start) where.createdAt.gte = new Date(q.start);
    if (q.end) where.createdAt.lte = new Date(q.end);
  }
  applyTenantFilter(request, where as Record<string, unknown>);
  return where;
}

/** 安全策略设为「仅平台管理员」时，审计员和租户管理员不能查看、检索、导出操作日志。 */
const requireAuditLogAccess: preHandlerHookHandler = async (request) => {
  const policy = await loadSecurityPolicy();
  if (policy.auditLogAccess === 'system_admin_only' && !request.currentUser?.isPlatformAdmin) {
    throw forbidden('操作日志仅平台管理员可查看', 'AUDIT_LOG_ADMIN_ONLY');
  }
};

const canRead = [requirePermission('audit_log:read'), requireAuditLogAccess];

const csvTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

type AuditLogRow = {
  id: string;
  tenantId: string | null;
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  detail: unknown;
  createdAt: Date;
};

function serializeAuditLog(row: AuditLogRow, includeFullDetail: boolean) {
  return {
    id: row.id,
    tenantId: row.tenantId ?? null,
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    ip: row.ip,
    userAgent: row.userAgent,
    detail: includeFullDetail ? sanitizeJson(row.detail) : sanitizeJson(row.detail, 'summary'),
    createdAt: row.createdAt,
  };
}

/** 各导出格式用得到的列：CSV 不需要 actorId、userAgent。 */
const EXPORT_SELECT = {
  csv: {
    id: true,
    tenantId: true,
    actorName: true,
    action: true,
    targetType: true,
    targetId: true,
    ip: true,
    detail: true,
    createdAt: true,
  },
  json: {
    id: true,
    tenantId: true,
    actorId: true,
    actorName: true,
    action: true,
    targetType: true,
    targetId: true,
    ip: true,
    userAgent: true,
    detail: true,
    createdAt: true,
  },
} satisfies Record<'csv' | 'json', Prisma.AuditLogSelect>;

type ExportRow = Omit<AuditLogRow, 'actorId' | 'userAgent'> &
  Partial<Pick<AuditLogRow, 'actorId' | 'userAgent'>>;

/**
 * 按 (createdAt, id) 倒序分批读取导出行：键集游标翻页，每批最多 batchSize 行，只取该格式用得到的列。
 * 查询扩展靠请求上下文取租户范围，所以要在请求处理函数里迭代完，不要挪进响应流里懒读。
 */
export async function* readAuditLogBatches(
  where: AuditLogWhere,
  format: 'csv' | 'json',
  batchSize = AUDIT_EXPORT_BATCH_SIZE,
): AsyncGenerator<ExportRow[]> {
  const base = where as Prisma.AuditLogWhereInput;
  let last: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const page = (await prisma.auditLog.findMany({
      where: last
        ? {
            AND: [
              base,
              {
                OR: [
                  { createdAt: { lt: last.createdAt } },
                  { createdAt: last.createdAt, id: { lt: last.id } },
                ],
              },
            ],
          }
        : base,
      select: EXPORT_SELECT[format],
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: batchSize,
    })) as ExportRow[];
    if (page.length > 0) yield page;
    if (page.length < batchSize) return;
    last = page[page.length - 1]!;
  }
}

/** 补齐这一批里还没查过的租户名称；查不到（租户已删）的用 ID 代替。 */
async function loadTenantNames(rows: ExportRow[], names: Map<string, string>): Promise<void> {
  const missing = [
    ...new Set(rows.map((r) => r.tenantId).filter((id): id is string => !!id && !names.has(id))),
  ];
  if (missing.length === 0) return;
  const tenants = await prisma.tenant.findMany({
    where: { id: { in: missing } },
    select: { id: true, name: true },
  });
  for (const t of tenants) names.set(t.id, t.name);
  for (const id of missing) if (!names.has(id)) names.set(id, id);
}

function csvLine(row: ExportRow, tenantName?: string): string {
  const cells = [
    csvTime.format(row.createdAt),
    row.actorName,
    row.action,
    row.targetType,
    row.targetId,
    row.ip,
    row.detail == null ? '' : JSON.stringify(sanitizeJson(row.detail)),
  ];
  if (tenantName !== undefined) cells.push(tenantName);
  return cells.map(csvCell).join(',');
}

export async function auditLogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/', { preHandler: canRead }, async (request) => {
    const q = listQuery.parse(request.query);
    const { page, pageSize } = q;
    const where = buildWhere(request, q);
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);
    return {
      items: rows.map((r) => serializeAuditLog(r, false)),
      total,
      page,
      pageSize,
    };
  });

  app.get('/export', { preHandler: canRead }, async (request, reply) => {
    const q = exportQuery.parse(request.query);
    const where = buildWhere(request, q);
    const total = await prisma.auditLog.count({ where });
    if (total > AUDIT_EXPORT_MAX_ROWS) {
      throw badRequest(
        `共 ${total} 条，单次最多导出 ${AUDIT_EXPORT_MAX_ROWS} 条，请缩小范围`,
        'EXPORT_TOO_LARGE',
      );
    }
    const user = request.currentUser!;
    // \u300c\u5168\u90e8\u79df\u6237\u300d\u89c6\u89d2\u6c47\u603b\u4e86\u591a\u4e2a\u79df\u6237\u7684\u65e5\u5fd7\uff0c\u5bfc\u51fa\u65f6\u5e26\u4e0a\u79df\u6237\u540d\u79f0\u3002
    const withTenant = user.allTenants;
    const tenantNames = new Map<string, string>();
    const tenantName = (row: ExportRow) =>
      row.tenantId ? (tenantNames.get(row.tenantId) ?? row.tenantId) : '';

    // \u5206\u6279\u8bfb\u3001\u9010\u6279\u62fc\u6210\u8f93\u51fa\u7247\u6bb5\uff0c\u4e0d\u628a\u6574\u4efd\u7ed3\u679c\u7684\u884c\u5bf9\u8c61\u4e00\u6b21\u7559\u5728\u5185\u5b58\u91cc\u3002
    const chunks: string[] = [];
    if (q.format === 'json') {
      chunks.push('[');
    } else {
      const header = withTenant ? [...CSV_HEADER, CSV_TENANT_HEADER] : CSV_HEADER;
      chunks.push('\ufeff' + header.join(',') + '\r\n');
    }
    let count = 0;
    for await (const batch of readAuditLogBatches(where, q.format)) {
      const rows = batch.slice(0, AUDIT_EXPORT_MAX_ROWS - count);
      if (withTenant) await loadTenantNames(rows, tenantNames);
      if (q.format === 'json') {
        const items = rows.map((r) => {
          const item = serializeAuditLog(r as AuditLogRow, true);
          return JSON.stringify(withTenant ? { ...item, tenantName: tenantName(r) } : item);
        });
        chunks.push((count > 0 ? ',' : '') + items.join(','));
      } else {
        chunks.push(
          rows.map((r) => csvLine(r, withTenant ? tenantName(r) : undefined) + '\r\n').join(''),
        );
      }
      count += rows.length;
      if (count >= AUDIT_EXPORT_MAX_ROWS) break;
    }
    if (q.format === 'json') chunks.push(']');

    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      action: 'audit_log.export',
      targetType: 'audit_log',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      detail: {
        format: q.format,
        count,
        filters: { ...q, format: undefined },
      },
    });
    const stamp = csvTime.format(new Date()).replace(/[-: ]/g, '').slice(0, 12);
    const filename = `audit-logs-${stamp}.${q.format}`;
    reply.header('content-disposition', `attachment; filename="${filename}"`);
    reply.header(
      'content-type',
      q.format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
    );
    return Readable.from(chunks);
  });

  app.get('/:id', { preHandler: canRead }, async (request) => {
    const { id } = z.object({ id: z.string().trim().min(1) }).parse(request.params);
    const row = await prisma.auditLog.findUnique({ where: { id } });
    if (!row) throw notFound('审计日志不存在');
    return serializeAuditLog(row, true);
  });
}
