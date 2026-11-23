import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { basename, extname } from 'node:path';
import type { CorpusFinding, CorpusScan, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { enqueueCorpusScan } from '../../lib/queue.js';
import { attachmentDisposition } from '../../lib/attachment.js';
import { csvWatermarkLine, resolveDownloadWatermark } from '../../lib/data-security.js';
import { assertExportSize, csvRow, exportTime } from '../../lib/tabular-export.js';
import { CORPUS_FORMATS, type Container } from './core/formats.js';
import { FINDING_CATEGORIES, FINDING_CATEGORY_LABELS, type FindingCategory } from './core/scan.js';
import { auditCorpus } from './common.js';
import { rescanCorpus } from './rescan.js';
import {
  assertCorpusDiskSpace,
  corpusFilePath,
  corpusUploadMaxBytes,
  corpusUploadTooLarge,
  removeCorpusFile,
  storeCorpusUpload,
} from './storage.js';

// 语料扫描（数据安全工具，1.2.1、1.2.2、1.2.3、1.2.5）。
// 上传：请求体是文件原始字节（application/octet-stream），文件名和选项走 query，与模型文件上传的写法一致
// （仓库里没有 multipart 依赖，不新增依赖）。上传后建扫描记录，交给 worker 流式处理。
// 查看：corpus_scan:read；发起：corpus_scan:create；导出命中原文、下载打码副本：corpus_scan:export；
// 删除：发起人自己（要有 corpus_scan:create），或有 corpus_scan:manage 的用户。

const READ = { preHandler: [requirePermission('corpus_scan:read')] };
const CREATE = { preHandler: [requirePermission('corpus_scan:create')] };
const EXPORT = { preHandler: [requirePermission('corpus_scan:export')] };
const DELETE = { preHandler: [requirePermission('corpus_scan:create', 'corpus_scan:manage')] };
/** 导出时每批从库里读的命中条数 */
const EXPORT_BATCH = 1000;

const idParams = z.object({ id: z.string().uuid() });
const createQuery = z.object({
  fileName: z.string().trim().min(1).max(255),
  format: z.enum(CORPUS_FORMATS).default('auto'),
  ruleSetId: z.string().uuid().optional(),
  judgeReview: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  judgeLimit: z.coerce.number().int().min(1).max(1000).default(200),
  /** CSV 要检测的列，逗号分隔；不给就是全部列 */
  csvColumns: z.string().max(4000).optional(),
});
const rescanBody = z
  .object({
    ruleSetId: z.string().uuid().nullable().optional(),
    judgeReview: z.boolean().optional(),
  })
  .strict();
const listQuery = z.object({
  status: z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const findingQuery = z.object({
  category: z.enum(FINDING_CATEGORIES).optional(),
  subtype: z.string().trim().min(1).max(100).optional(),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const exportQuery = z.object({ format: z.enum(['csv', 'json']).default('csv') });

const SEVERITY_LABELS: Record<string, string> = {
  CRITICAL: '严重',
  HIGH: '高',
  MEDIUM: '中',
  LOW: '低',
};
const VERDICT_LABELS: Record<string, string> = {
  CONFIRMED: '确认违规',
  DISMISSED: '判为误报',
  ERROR: '复核失败',
};
const EXPORT_HEADER = [
  '记录序号',
  '行号',
  '字段',
  '类别',
  '子类',
  '子类名称',
  '命中原文',
  '前文',
  '后文',
  '严重度',
  '复核结论',
  '复核说明',
];
const MASKED_CONTENT_TYPES: Record<Container, string> = {
  jsonl: 'application/x-ndjson; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

/** 打码副本的文件名：train.jsonl → train.masked.jsonl */
function maskedFileName(fileName: string): string {
  const ext = extname(fileName);
  return `${ext ? fileName.slice(0, -ext.length) : fileName}.masked${ext}`;
}

/** ASCII 兜底文件名里的扩展名：只认字母数字，否则用 .txt（客户端文件名不可信） */
function safeExt(fileName: string): string {
  const ext = extname(fileName);
  return /^\.[A-Za-z0-9]{1,10}$/.test(ext) ? ext : '.txt';
}

type ScanRow = CorpusScan & { ruleSet: { id: string; name: string } | null };
type UserRef = { id: string; name: string };

async function usersById(ids: (string | null)[]): Promise<Map<string, UserRef>> {
  const want = [...new Set(ids.filter((v): v is string => !!v))];
  if (want.length === 0) return new Map();
  const rows = await prisma.user.findMany({
    where: { id: { in: want } },
    select: { id: true, username: true, displayName: true },
  });
  return new Map(rows.map((u) => [u.id, { id: u.id, name: u.displayName || u.username }]));
}

export function scanView(s: ScanRow, users: Map<string, UserRef>) {
  return {
    id: s.id,
    fileName: s.fileName,
    bytes: Number(s.bytes),
    sha256: s.sha256,
    format: s.format,
    detectedFormat: s.detectedFormat,
    container: s.container,
    csvColumns: (s.csvColumns as string[] | null) ?? null,
    ruleSet: s.ruleSet,
    judgeReview: s.judgeReview,
    judgeLimit: s.judgeLimit,
    status: s.status,
    error: s.error,
    progressBytes: Number(s.progressBytes),
    totalRecords: s.totalRecords,
    invalidRecords: s.invalidRecords,
    findingCount: s.findingCount,
    storedFindings: s.storedFindings,
    truncated: s.truncated,
    stats: s.stats ?? null,
    judgeReviewed: s.judgeReviewed,
    judgeNote: s.judgeNote,
    maskedCopyReady: s.status === 'COMPLETED' && !!s.maskedKey && !s.filesPurgedAt,
    filesPurgedAt: s.filesPurgedAt?.toISOString() ?? null,
    createdBy: s.createdById ? (users.get(s.createdById) ?? null) : null,
    createdAt: s.createdAt.toISOString(),
    startedAt: s.startedAt?.toISOString() ?? null,
    finishedAt: s.finishedAt?.toISOString() ?? null,
  };
}

/** 命中原文按客户要求不打码，原样返回。 */
export function findingView(f: CorpusFinding) {
  return {
    id: f.id,
    recordIndex: f.recordIndex,
    line: f.line,
    fieldPath: f.fieldPath,
    category: f.category,
    subtype: f.subtype,
    subtypeLabel: f.subtypeLabel,
    matchText: f.matchText,
    contextBefore: f.contextBefore,
    contextAfter: f.contextAfter,
    severity: f.severity,
    judgeVerdict: f.judgeVerdict,
    judgeReason: f.judgeReason,
  };
}

const scanInclude = { ruleSet: { select: { id: true, name: true } } } as const;

export async function loadScan(id: string): Promise<ScanRow> {
  const scan = await prisma.corpusScan.findFirst({ where: { id }, include: scanInclude });
  if (!scan) throw notFound('语料扫描不存在', 'CORPUS_SCAN_NOT_FOUND');
  return scan;
}

export function findingWhere(
  scanId: string,
  q: { category?: string; subtype?: string; severity?: string },
) {
  return {
    scanId,
    ...(q.category ? { category: q.category } : {}),
    ...(q.subtype ? { subtype: q.subtype } : {}),
    ...(q.severity ? { severity: q.severity } : {}),
  } satisfies Prisma.CorpusFindingWhereInput;
}

export async function corpusScanRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  // 原始字节上传：把请求流原样交给路由流式写盘（仅本插件作用域）。
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
  );

  app.post('/', CREATE, async (req, reply) => {
    const q = createQuery.parse(req.query);
    const max = corpusUploadMaxBytes();
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > max) throw corpusUploadTooLarge(max);
    if (!(req.body && typeof (req.body as Readable).pipe === 'function')) {
      throw badRequest('上传方式不正确，请在页面中选择文件上传', 'CORPUS_UPLOAD_TYPE');
    }
    // 没有 Content-Length（分块上传）时按上限估
    await assertCorpusDiskSpace(declared > 0 ? declared : max);
    if (q.ruleSetId && !(await prisma.corpusRuleSet.findFirst({ where: { id: q.ruleSetId } }))) {
      throw notFound('规则集不存在', 'CORPUS_RULE_SET_NOT_FOUND');
    }
    const csvColumns = (q.csvColumns ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const file = await storeCorpusUpload(req.body as Readable, max);
    let scan: CorpusScan;
    try {
      scan = await prisma.corpusScan.create({
        data: {
          fileName: basename(q.fileName),
          storageKey: file.storageKey,
          bytes: BigInt(file.bytes),
          sha256: file.sha256,
          format: q.format,
          ...(csvColumns.length > 0 ? { csvColumns } : {}),
          ruleSetId: q.ruleSetId ?? null,
          judgeReview: q.judgeReview,
          judgeLimit: q.judgeLimit,
          createdById: req.currentUser!.id,
        },
      });
    } catch (e) {
      await removeCorpusFile(file.storageKey);
      throw e;
    }
    try {
      await enqueueCorpusScan(scan.id);
    } catch {
      await prisma.corpusScan.update({
        where: { id: scan.id },
        data: { status: 'FAILED', error: '扫描排队失败，请稍后重试', finishedAt: new Date() },
      });
      throw new AppError(503, '扫描排队失败，请稍后重试', 'CORPUS_SCAN_QUEUE_FAILED');
    }
    await auditCorpus(req, 'corpus_scan.create', 'corpus_scan', scan.id, {
      fileName: scan.fileName,
      bytes: file.bytes,
      sha256: file.sha256,
      format: q.format,
      ruleSetId: q.ruleSetId ?? null,
      judgeReview: q.judgeReview,
    });
    reply.code(201);
    return { id: scan.id, status: scan.status };
  });

  // 重新扫描：复制原文件建新扫描（规则集、裁判复核可以换），原文件已清理时 409。
  app.post('/:id/rescan', CREATE, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = rescanBody.parse(req.body ?? {});
    const ua = req.headers['user-agent'];
    const scan = await rescanCorpus(
      req.currentUser!,
      { sourceScanId: id, ...body },
      { ip: req.ip, userAgent: typeof ua === 'string' ? ua : null },
    );
    reply.code(201);
    return scan;
  });

  app.get('/', READ, async (req) => {
    const q = listQuery.parse(req.query);
    const where = q.status ? { status: q.status } : {};
    const [total, rows] = await Promise.all([
      prisma.corpusScan.count({ where }),
      prisma.corpusScan.findMany({
        where,
        include: scanInclude,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    const users = await usersById(rows.map((r) => r.createdById));
    return {
      items: rows.map((r) => scanView(r, users)),
      total,
      page: q.page,
      pageSize: q.pageSize,
      uploadMaxBytes: corpusUploadMaxBytes(),
    };
  });

  app.get('/:id', READ, async (req) => {
    const { id } = idParams.parse(req.params);
    const scan = await loadScan(id);
    return scanView(scan, await usersById([scan.createdById]));
  });

  app.get('/:id/findings', READ, async (req) => {
    const { id } = idParams.parse(req.params);
    const q = findingQuery.parse(req.query);
    await loadScan(id);
    const where = findingWhere(id, q);
    const [total, rows] = await Promise.all([
      prisma.corpusFinding.count({ where }),
      prisma.corpusFinding.findMany({
        where,
        orderBy: [{ recordIndex: 'asc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { items: rows.map(findingView), total, page: q.page, pageSize: q.pageSize };
  });

  /**
   * 导出全部已保存的命中（最多 50,000 条）：CSV（UTF-8 带 BOM、防公式注入、下载水印）或 JSON。命中原文不打码。
   * 按批读库、逐批写出，不把全部命中拼成一个大字符串。
   */
  app.get('/:id/export', EXPORT, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { format } = exportQuery.parse(req.query);
    const scan = await loadScan(id);
    const count = await prisma.corpusFinding.count({ where: { scanId: id } });
    assertExportSize(count);
    const watermark = await resolveDownloadWatermark(req.currentUser!);
    await auditCorpus(req, 'corpus_scan.export', 'corpus_scan', id, {
      format,
      count,
      watermark: watermark?.text ?? null,
    });
    const base = `语料扫描-${scan.fileName.replace(/\.[^.]*$/, '')}`;
    reply.header(
      'Content-Disposition',
      attachmentDisposition(`${base}.${format}`, `corpus-scan-${id}.${format}`),
    );
    if (format === 'json') {
      const head = {
        watermark: watermark?.text ?? null,
        exportedAt: exportTime(new Date()),
        scan: scanView(scan, await usersById([scan.createdById])),
      };
      async function* json() {
        yield `${JSON.stringify(head).slice(0, -1)},"findings":[\n`;
        let first = true;
        for await (const rows of findingBatches(id)) {
          const text = rows.map((f) => JSON.stringify(findingView(f))).join(',\n');
          yield `${first ? '' : ',\n'}${text}`;
          first = false;
        }
        yield '\n]}\n';
      }
      reply.type('application/json; charset=utf-8');
      return reply.send(Readable.from(json()));
    }
    async function* csv() {
      yield Buffer.from([0xef, 0xbb, 0xbf]);
      const head = [csvRow(EXPORT_HEADER)];
      if (watermark) head.unshift(csvWatermarkLine(watermark));
      yield `${head.join('\r\n')}\r\n`;
      for await (const rows of findingBatches(id)) {
        let text = '';
        for (const f of rows) {
          text += `${csvRow([
            f.recordIndex,
            f.line,
            f.fieldPath,
            FINDING_CATEGORY_LABELS[f.category as FindingCategory] ?? f.category,
            f.subtype,
            f.subtypeLabel,
            f.matchText,
            f.contextBefore,
            f.contextAfter,
            SEVERITY_LABELS[f.severity] ?? f.severity,
            f.judgeVerdict ? (VERDICT_LABELS[f.judgeVerdict] ?? f.judgeVerdict) : '',
            f.judgeReason,
          ])}\r\n`;
        }
        yield text;
      }
    }
    reply.type('text/csv; charset=utf-8');
    return reply.send(Readable.from(csv()));
  });

  /** 打码副本：worker 扫完时已生成好（敏感信息换成 [类型]，违规关键词不换，格式、行数和原文件一致），直接发文件。 */
  app.get('/:id/masked-copy', EXPORT, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const scan = await loadScan(id);
    if (scan.filesPurgedAt) {
      throw new AppError(410, '原文件和打码副本已超过保留期限被清理', 'CORPUS_FILES_PURGED');
    }
    if (scan.status !== 'COMPLETED' || !scan.container) {
      throw conflict('扫描完成后才能下载打码副本', 'CORPUS_SCAN_NOT_COMPLETED');
    }
    if (!scan.maskedKey) throw conflict('打码副本还没有生成', 'CORPUS_MASKED_NOT_READY');
    const path = corpusFilePath(scan.maskedKey);
    if (!(await stat(path).catch(() => null))?.isFile()) {
      throw notFound('打码副本文件已不存在', 'CORPUS_FILE_MISSING');
    }
    const container = scan.container as Container;
    await auditCorpus(req, 'corpus_scan.masked_copy', 'corpus_scan', id, {
      fileName: scan.fileName,
      container,
    });
    reply.header(
      'Content-Disposition',
      attachmentDisposition(
        maskedFileName(scan.fileName),
        `corpus-masked-${id}${safeExt(scan.fileName)}`,
      ),
    );
    reply.type(MASKED_CONTENT_TYPES[container] ?? 'text/plain; charset=utf-8');
    return reply.send(createReadStream(path));
  });

  app.delete('/:id', DELETE, async (req) => {
    const { id } = idParams.parse(req.params);
    const scan = await loadScan(id);
    const user = req.currentUser!;
    if (!user.permissions.has('corpus_scan:manage') && scan.createdById !== user.id) {
      throw forbidden('只能删除自己发起的扫描', 'CORPUS_SCAN_NOT_OWNER');
    }
    await prisma.corpusScan.delete({ where: { id } });
    await removeCorpusFile(scan.storageKey);
    await removeCorpusFile(scan.maskedKey);
    await auditCorpus(req, 'corpus_scan.delete', 'corpus_scan', id, {
      fileName: scan.fileName,
      status: scan.status,
    });
    return { deleted: true };
  });
}

/** 按固定顺序逐批读一次扫描的全部命中（游标分页）。 */
async function* findingBatches(scanId: string): AsyncGenerator<CorpusFinding[]> {
  let cursor: string | null = null;
  for (;;) {
    const rows: CorpusFinding[] = await prisma.corpusFinding.findMany({
      where: { scanId },
      orderBy: [{ recordIndex: 'asc' }, { category: 'asc' }, { id: 'asc' }],
      take: EXPORT_BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < EXPORT_BATCH) return;
    cursor = rows[rows.length - 1]!.id;
  }
}
