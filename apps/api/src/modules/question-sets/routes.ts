// 问题集 / 题目 / 题库导入 路由：覆盖功能清单 #3 #4 #5 #6 与一期"题库上传/预览/标签/风险分类"。
import { BYO_SET_SOURCE } from '../multimodal-jailbreak/byo-images/executor.js';
import { purgeByoImages } from '../multimodal-jailbreak/byo-images/routes.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  LANGUAGE,
  DEFAULT_LANGUAGE,
  QUESTION_TEMPLATES,
  QUESTION_TEMPLATE_TYPES,
  QUESTION_TYPE,
  SEVERITY,
  RETIRED_BUILTIN_SET_SOURCES,
  type Paginated,
  type QuestionTemplateType,
} from '@lse/shared';
import { prisma } from '../../db.js';
import { currentTenantId } from '../../lib/tenant-context.js';
import { PLATFORM_TENANT_ID } from '../../lib/tenant-models.js';
import { tenantOf } from '../../lib/all-tenants.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { riskDomainForCategory, riskDomainLabel } from '../reports/labels.js';
import { badRequest, conflict, forbidden, notFound, permissionDenied } from '../../lib/errors.js';
import { QUESTION_SET_KINDS, classifyQuestionSetKind, kindWhere } from './kind.js';
import { builtinQuestionSetRoutes } from './builtin/routes.js';
import { inactiveQuestionSql } from './builtin/live.js';
import { attackSeedRoutes } from './attack-seeds/routes.js';
import { mutationRoutes } from './mutation/routes.js';
import { writeAudit } from '../../lib/audit.js';
import { connectorOwnerWhere } from '../../lib/platform-connector-access.js';
import { auditDownload, resolveDownloadWatermark } from '../../lib/data-security.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import {
  buildQuestionExport,
  buildTemplateFile,
  groupQuestionsForExport,
  mapSheets,
  parseTabularSheets,
  type ImportFormat,
  type TabularSheet,
} from '../../lib/question-import.js';
import { assertExportSize } from '../../lib/tabular-export.js';
import { sendAttachment } from '../../lib/attachment.js';

const BUILTIN_READONLY = '内置题库不可删改，可“复制为自有题库”后编辑';

async function assertSetEditable(setId: string): Promise<void> {
  const set = await prisma.questionSet.findUnique({
    where: { id: setId },
    select: { isBuiltin: true },
  });
  if (set?.isBuiltin) throw forbidden(BUILTIN_READONLY);
}

const idParams = z.object({ id: z.string().uuid() });
const questionIdParams = z.object({ questionId: z.string().uuid() });
const setIdParams = z.object({ setId: z.string().uuid() });

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  keyword: z.string().trim().optional(),
  type: z.enum(QUESTION_TYPE).optional(),
  domain: z.string().trim().optional(),
  // 列表区分“内置题库 / 自有题库”。
  origin: z.enum(['builtin', 'own']).optional(),
  // 派生分类：种子库 / 自有样本库 / 运行记录。
  kind: z.enum(QUESTION_SET_KINDS).optional(),
  includeAgentRuntime: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // 建任务时只列启用的样本库（enabled=true）；不传 = 全部。
  enabled: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

const questionListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  keyword: z.string().trim().optional(),
  type: z.enum(QUESTION_TYPE).optional(),
  severity: z.enum(SEVERITY).optional(),
  category: z.string().trim().optional(),
  shouldRefuse: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

const questionResultsParams = z.object({
  setId: z.string().uuid(),
  questionId: z.string().uuid(),
});
const questionResultsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const SEVERITY_RANK: Record<string, number> = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

const questionExportQuery = questionListQuery
  .omit({ page: true, pageSize: true })
  .extend({ format: z.enum(['xlsx', 'csv']).default('xlsx') });

/** 题目列表与样本库导出共用的筛选条件。 */
function questionListWhere(
  setId: string,
  q: Omit<z.infer<typeof questionListQuery>, 'page' | 'pageSize'>,
): Prisma.QuestionWhereInput {
  const where: Prisma.QuestionWhereInput = { questionSetId: setId };
  if (q.type) where.type = q.type;
  if (q.severity) where.severity = q.severity;
  if (q.category) where.category = { contains: q.category, mode: 'insensitive' };
  if (q.shouldRefuse !== undefined) where.shouldRefuse = q.shouldRefuse;
  if (q.keyword) {
    where.OR = [
      { content: { contains: q.keyword, mode: 'insensitive' } },
      { category: { contains: q.keyword, mode: 'insensitive' } },
      { externalId: { contains: q.keyword, mode: 'insensitive' } },
    ];
  }
  return where;
}

const createSetBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).optional(),
  type: z.enum(QUESTION_TYPE).default('GENERAL'),
  tags: z.array(z.string().trim().min(1)).max(50).optional(),
  source: z.string().trim().max(200).optional(),
});

const updateSetBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  type: z.enum(QUESTION_TYPE).optional(),
  tags: z.array(z.string().trim().min(1)).max(50).optional(),
  source: z.string().trim().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
});

const createQuestionBody = z.object({
  content: z.string().trim().min(1).max(20000),
  externalId: z.string().trim().max(100).nullable().optional(),
  category: z.string().trim().max(200).nullable().optional(),
  expectedBehavior: z.string().trim().max(20000).nullable().optional(),
  referenceAnswer: z.string().trim().max(20000).nullable().optional(),
  type: z.enum(QUESTION_TYPE).optional(),
  severity: z.enum(SEVERITY).nullable().optional(),
  shouldRefuse: z.boolean().optional(),
  language: z.enum(LANGUAGE).default(DEFAULT_LANGUAGE),
  tags: z.array(z.string().trim().min(1)).max(50).optional(),
});

const updateQuestionBody = createQuestionBody.partial();

const importBody = z
  .object({
    questionSetId: z.string().uuid().optional(),
    setName: z.string().trim().min(1).max(100).optional(),
    setDescription: z.string().trim().max(1000).optional(),
    setTags: z.array(z.string().trim().min(1)).max(50).optional(),
    templateType: z.enum(QUESTION_TEMPLATE_TYPES),
    format: z.enum(['xlsx', 'csv']),
    filename: z.string().trim().min(1).max(255),
    contentBase64: z.string().min(1),
  })
  .refine((d) => Boolean(d.questionSetId) || Boolean(d.setName), {
    message: '请选择已有样本库，或填写新样本库名称。',
  });

/**
 * 题集列表的关联计数。内置题集是平台共享的，而任务引用与导入记录是各租户自己的：
 * 不带租户条件就成了全平台计数，所以按当前租户过滤（没有租户上下文时保持全量）。
 */
function setInclude() {
  const tenantId = currentTenantId();
  return {
    createdBy: { select: { id: true, username: true, displayName: true } },
    _count: {
      select: {
        questions: true,
        taskLinks: tenantId ? { where: { task: { tenantId } } } : true,
        imports: tenantId ? { where: importTenantWhere(tenantId) } : true,
      },
    },
  } satisfies Prisma.QuestionSetInclude;
}
type SetPayload = Prisma.QuestionSetGetPayload<{ include: ReturnType<typeof setInclude> }>;

type QuestionPayload = Prisma.QuestionGetPayload<Record<string, never>>;

const importInclude = {
  // tenantId 用来校验导入记录归属（导入记录本身不带租户列）。
  uploadedBy: { select: { id: true, username: true, displayName: true, tenantId: true } },
} satisfies Prisma.QuestionImportInclude;
type ImportPayload = Prisma.QuestionImportGetPayload<{ include: typeof importInclude }>;

/**
 * 导入记录是题集的子表（不带 tenantId），归属这样定：
 * 导入到某个租户自己的题集 → 归该题集的租户；题集为平台共享或已不存在 → 归上传人所在租户；
 * 历史上没有上传人的记录 → 归平台租户。平台租户也只看自己的，不看别的租户的。
 */
function importTenantWhere(tenantId: string | undefined): Prisma.QuestionImportWhereInput {
  // 全部租户视角（以及没有租户上下文的后台调用）：不按租户过滤导入记录。
  if (!tenantId) return {};
  const noPrivateSet: Prisma.QuestionImportWhereInput = {
    OR: [{ questionSetId: null }, { questionSet: { is: { tenantId: null } } }],
  };
  return {
    OR: [
      { questionSet: { is: { tenantId } } },
      { AND: [noPrivateSet, { uploadedBy: { is: { tenantId } } }] },
      ...(tenantId === PLATFORM_TENANT_ID ? [{ AND: [noPrivateSet, { uploadedById: null }] }] : []),
    ],
  };
}

function serializeSet(s: SetPayload, riskCoverage: string[] = []) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    type: s.type,
    tags: s.tags,
    source: s.source,
    isBuiltin: s.isBuiltin,
    enabled: s.enabled,
    kind: classifyQuestionSetKind(s),
    questionCount: s._count.questions,
    importCount: s._count.imports,
    taskLinkCount: s._count.taskLinks,
    // 库内样本实际覆盖的风险分类（去重，按出现频次降序）。比粗粒度 type 更能反映真实覆盖面。
    riskCoverage,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function serializeQuestion(q: QuestionPayload) {
  return {
    id: q.id,
    questionSetId: q.questionSetId,
    externalId: q.externalId,
    content: q.content,
    expectedBehavior: q.expectedBehavior,
    referenceAnswer: q.referenceAnswer,
    category: q.category,
    language: q.language,
    type: q.type,
    severity: q.severity,
    shouldRefuse: q.shouldRefuse,
    tags: q.tags,
    metadata: q.metadata,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  };
}

function serializeImport(imp: ImportPayload) {
  return {
    id: imp.id,
    questionSetId: imp.questionSetId,
    filename: imp.filename,
    format: imp.format,
    templateType: imp.templateType,
    totalRows: imp.totalRows,
    importedRows: imp.importedRows,
    failedRows: imp.failedRows,
    status: imp.status,
    errorReport: imp.errorReport,
    uploadedBy: imp.uploadedBy,
    createdAt: imp.createdAt,
  };
}

export async function questionSetRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  await app.register(builtinQuestionSetRoutes);
  await app.register(attackSeedRoutes);
  await app.register(mutationRoutes);

  // ---------- 模板（静态路由，置于 /:id 之前）----------
  app.get('/templates', { preHandler: [requirePermission('question_set:read')] }, async () => {
    return {
      items: QUESTION_TEMPLATE_TYPES.map((t) => {
        const def = QUESTION_TEMPLATES[t];
        return {
          type: def.type,
          questionType: def.questionType,
          label: def.label,
          description: def.description,
          shouldRefuse: def.shouldRefuse,
          columns: def.columns.map((c) => ({
            field: c.field,
            header: c.header,
            required: c.required,
            aliases: c.aliases,
            example: c.example,
          })),
        };
      }),
    };
  });

  app.get(
    '/templates/:templateType/download',
    { preHandler: [requirePermission('question_set:read')] },
    async (request, reply: FastifyReply) => {
      const { templateType } = z
        .object({ templateType: z.enum(QUESTION_TEMPLATE_TYPES) })
        .parse(request.params);
      const { format } = z
        .object({ format: z.enum(['xlsx', 'csv']).default('xlsx') })
        .parse(request.query);
      const watermark = await resolveDownloadWatermark(request.currentUser!);
      const buf = await buildTemplateFile(
        templateType as QuestionTemplateType,
        format as ImportFormat,
        watermark,
      );
      await auditDownload(
        request.currentUser!,
        {
          kind: 'question_template',
          targetType: 'question_template',
          targetId: templateType,
          detail: { format, watermark: watermark?.text ?? null },
        },
        request,
      );
      const ext = format;
      const mime =
        format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      reply
        .header('content-type', mime)
        .header('content-disposition', `attachment; filename="template_${templateType}.${ext}"`);
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- binary template download, not HTML rendering.
      return reply.send(buf);
    },
  );

  // ---------- 导入历史（静态路由）----------
  app.get('/imports', { preHandler: [requirePermission('question:read')] }, async (request) => {
    const { page, pageSize } = listQuery.pick({ page: true, pageSize: true }).parse(request.query);
    const setIdRaw = (request.query as Record<string, unknown>).questionSetId;
    const where: Prisma.QuestionImportWhereInput = {
      AND: [
        importTenantWhere(tenantOf(request.currentUser!)),
        ...(typeof setIdRaw === 'string' && setIdRaw ? [{ questionSetId: setIdRaw }] : []),
      ],
    };
    const [items, total] = await Promise.all([
      prisma.questionImport.findMany({
        where,
        include: importInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.questionImport.count({ where }),
    ]);
    return { items: items.map(serializeImport), total, page, pageSize } satisfies Paginated<
      ReturnType<typeof serializeImport>
    >;
  });

  app.get('/imports/:id', { preHandler: [requirePermission('question:read')] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const imp = await prisma.questionImport.findFirst({
      where: { AND: [{ id }, importTenantWhere(tenantOf(request.currentUser!))] },
      include: importInclude,
    });
    // 别的租户的导入记录（包括平台租户看别人的）一律按不存在处理。
    if (!imp) throw notFound('导入记录不存在');
    return serializeImport(imp);
  });

  // ---------- 题目（静态前缀 /questions，置于 /:id 之前）----------
  app.patch(
    '/questions/:questionId',
    { preHandler: [requirePermission('question:update'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const { questionId } = questionIdParams.parse(request.params);
      const body = updateQuestionBody.parse(request.body);
      const existing = await prisma.question.findUnique({ where: { id: questionId } });
      if (!existing) throw notFound('测试样本不存在');
      await assertSetEditable(existing.questionSetId);

      const data: Prisma.QuestionUpdateInput = {};
      if (body.content !== undefined) data.content = body.content;
      if (body.externalId !== undefined) data.externalId = body.externalId;
      if (body.category !== undefined) data.category = body.category;
      if (body.expectedBehavior !== undefined) data.expectedBehavior = body.expectedBehavior;
      if (body.referenceAnswer !== undefined) data.referenceAnswer = body.referenceAnswer;
      if (body.type !== undefined) data.type = body.type;
      if (body.severity !== undefined) data.severity = body.severity;
      if (body.shouldRefuse !== undefined) data.shouldRefuse = body.shouldRefuse;
      if (body.language !== undefined) data.language = body.language;
      if (body.tags !== undefined) data.tags = body.tags;

      const updated = await prisma.question.update({ where: { id: questionId }, data });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'question.update',
        targetType: 'question',
        targetId: questionId,
        detail: { fields: Object.keys(data) },
      });
      return serializeQuestion(updated);
    },
  );

  app.delete(
    '/questions/:questionId',
    { preHandler: [requirePermission('question:delete'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const { questionId } = questionIdParams.parse(request.params);
      const existing = await prisma.question.findUnique({ where: { id: questionId } });
      if (!existing) throw notFound('测试样本不存在');
      await assertSetEditable(existing.questionSetId);
      await prisma.question.delete({ where: { id: questionId } });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'question.delete',
        targetType: 'question',
        targetId: questionId,
        detail: { questionSetId: existing.questionSetId },
      });
      return { ok: true };
    },
  );

  // ---------- 导入（静态路由 /import）----------
  app.post(
    '/import',
    { preHandler: [requirePermission('question:import'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = importBody.parse(request.body);
      let buffer: Buffer;
      try {
        buffer = Buffer.from(body.contentBase64, 'base64');
      } catch {
        throw badRequest('上传文件编码无效，请重新选择文件。');
      }
      if (buffer.length === 0) throw badRequest('上传文件内容为空');

      let sheets: TabularSheet[];
      try {
        sheets = await parseTabularSheets(buffer, body.format as ImportFormat);
      } catch (err) {
        throw badRequest(`文件解析失败：${(err as Error).message}`);
      }

      const mapped = mapSheets(sheets, body.templateType as QuestionTemplateType);
      if (mapped.missingHeaders.length > 0) {
        throw badRequest(`缺少必需列：${mapped.missingHeaders.join('、')}`);
      }
      if (mapped.parsed.length === 0) {
        throw badRequest('未解析到有效测试样本，请检查文件内容与导入模板是否匹配。');
      }

      const def = QUESTION_TEMPLATES[body.templateType as QuestionTemplateType];
      const result = await prisma.$transaction(async (tx) => {
        let setId: string;
        if (body.questionSetId) {
          const set = await tx.questionSet.findUnique({ where: { id: body.questionSetId } });
          if (!set) throw notFound('所选样本库不存在');
          if (set.isBuiltin) throw forbidden(BUILTIN_READONLY);
          setId = set.id;
        } else {
          const dup = await tx.questionSet.findFirst({ where: { name: body.setName! } });
          if (dup) throw conflict('样本库名称已存在');
          const set = await tx.questionSet.create({
            data: {
              name: body.setName!,
              description: body.setDescription,
              type: def.questionType,
              tags: body.setTags ?? [],
              source: `上传:${body.filename}`,
              createdById: request.currentUser!.id,
            },
          });
          setId = set.id;
        }

        await tx.question.createMany({
          data: mapped.parsed.map((p) => ({
            questionSetId: setId,
            externalId: p.externalId,
            content: p.content,
            category: p.category,
            expectedBehavior: p.expectedBehavior,
            referenceAnswer: p.referenceAnswer,
            type: p.type,
            severity: p.severity,
            shouldRefuse: p.shouldRefuse,
            tags: p.tags,
            ...(p.metadata ? { metadata: p.metadata as Prisma.InputJsonValue } : {}),
          })),
        });

        const status =
          mapped.importedRows === 0 ? 'FAILED' : mapped.failedRows > 0 ? 'PARTIAL' : 'SUCCESS';
        const imp = await tx.questionImport.create({
          data: {
            questionSetId: setId,
            filename: body.filename,
            format: body.format,
            templateType: body.templateType,
            totalRows: mapped.totalRows,
            importedRows: mapped.importedRows,
            failedRows: mapped.failedRows,
            status,
            errorReport:
              mapped.issues.length > 0
                ? (mapped.issues as unknown as Prisma.InputJsonValue)
                : Prisma.DbNull,
            uploadedById: request.currentUser!.id,
          },
          include: importInclude,
        });
        await tx.questionSet.update({ where: { id: setId }, data: {} });
        return { setId, imp };
      });

      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'question.import',
        targetType: 'question_set',
        targetId: result.setId,
        detail: {
          filename: body.filename,
          templateType: body.templateType,
          imported: mapped.importedRows,
          failed: mapped.failedRows,
        },
      });

      reply.code(201);
      return { questionSetId: result.setId, import: serializeImport(result.imp) };
    },
  );

  // ---------- 问题集列表 / 详情 / 增删改 / 预览 ----------
  app.get('/', { preHandler: [requirePermission('question_set:read')] }, async (request) => {
    const { page, pageSize, keyword, type, domain, origin, kind, includeAgentRuntime, enabled } =
      listQuery.parse(request.query);
    const where: Prisma.QuestionSetWhereInput = {};
    const and: Prisma.QuestionSetWhereInput[] = [];
    if (type) and.push({ type });
    if (enabled !== undefined) and.push({ enabled });
    if (origin) and.push({ isBuiltin: origin === 'builtin' });
    if (kind) and.push(kindWhere(kind));
    // 按风险域筛：原始分类(自由文本/agent:码)先归一到域，命中该域的原始分类有任一样本即纳入。
    if (domain) {
      const allCats = await prisma.question.groupBy({
        by: ['category'],
        where: { category: { not: null } },
      });
      const matching = allCats
        .map((c) => c.category)
        .filter((c): c is string => c != null && riskDomainForCategory(c) === domain);
      and.push({ questions: { some: { category: { in: matching } } } });
    }
    if (keyword) {
      and.push({
        OR: [
          { name: { contains: keyword, mode: 'insensitive' } },
          { description: { contains: keyword, mode: 'insensitive' } },
        ],
      });
    }
    // 显式按 kind 筛选时不再隐藏 agent-runtime（运行记录里需要能看到）。
    if (!includeAgentRuntime && !kind) {
      and.push({ OR: [{ source: null }, { source: { not: { startsWith: 'agent-runtime:' } } }] });
    }
    // 已下线的内置题库（信通院、能源行业）不再列出。
    and.push({ OR: [{ source: null }, { source: { notIn: [...RETIRED_BUILTIN_SET_SOURCES] } }] });
    if (and.length > 0) where.AND = and;
    const [items, total] = await Promise.all([
      prisma.questionSet.findMany({
        where,
        include: setInclude(),
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.questionSet.count({ where }),
    ]);
    // 取本页各样本库覆盖的风险分类（按出现频次降序），供列表展示真实覆盖面。
    const pageIds = items.map((i) => i.id);
    const catRows = pageIds.length
      ? await prisma.question.groupBy({
          by: ['questionSetId', 'category'],
          where: { questionSetId: { in: pageIds }, category: { not: null } },
          _count: true,
        })
      : [];
    const coverageMap = new Map<string, Map<string, number>>();
    for (const r of catRows) {
      if (!r.category) continue;
      const dom = riskDomainForCategory(r.category);
      const m = coverageMap.get(r.questionSetId) ?? new Map<string, number>();
      m.set(dom, (m.get(dom) ?? 0) + r._count);
      coverageMap.set(r.questionSetId, m);
    }
    // 国标三个题库会按版本下线旧题、自动更新时先放进尚未生效的题，表里的总行数不是在用题数：
    // 单独算在用题数（与 live.ts 同口径），种子库页拿它和附录 B 的规模要求比较。其他题源没有下线标记，在用题数即总题数。
    const gbtIds = items.filter((i) => i.source?.startsWith('builtin:gbt45654')).map((i) => i.id);
    const inactiveRows = gbtIds.length
      ? await prisma.$queryRaw<{ id: string; n: number }[]>`
          SELECT q."questionSetId" AS id, count(*)::int AS n FROM "questions" q
          WHERE q."questionSetId" = ANY(${gbtIds}::text[]) AND ${inactiveQuestionSql('q')}
          GROUP BY q."questionSetId"`
      : [];
    const inactive = new Map(inactiveRows.map((r) => [r.id, r.n]));
    const serialized = items.map((s) => ({
      ...serializeSet(
        s,
        [...(coverageMap.get(s.id) ?? new Map<string, number>())]
          .sort((a, b) => b[1] - a[1])
          .map(([dom]) => riskDomainLabel(dom)),
      ),
      activeQuestionCount: s._count.questions - (inactive.get(s.id) ?? 0),
    }));
    return { items: serialized, total, page, pageSize } satisfies Paginated<
      ReturnType<typeof serializeSet> & { activeQuestionCount: number }
    >;
  });

  // 全部样本库覆盖到的风险分类（去重·计数·按频次降序），供列表筛选器。
  app.get(
    '/risk-categories',
    { preHandler: [requirePermission('question_set:read')] },
    async () => {
      const rows = await prisma.question.groupBy({
        by: ['category'],
        where: { category: { not: null } },
        _count: true,
      });
      const byDomain = new Map<string, number>();
      for (const r of rows) {
        if (!r.category) continue;
        const dom = riskDomainForCategory(r.category);
        byDomain.set(dom, (byDomain.get(dom) ?? 0) + r._count);
      }
      return {
        items: [...byDomain]
          .map(([domain, count]) => ({ domain, label: riskDomainLabel(domain), count }))
          .sort((a, b) => b.count - a.count),
      };
    },
  );

  app.post(
    '/',
    { preHandler: [requirePermission('question_set:create'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = createSetBody.parse(request.body);
      const dup = await prisma.questionSet.findFirst({ where: { name: body.name } });
      if (dup) throw conflict('样本库名称已存在');
      const set = await prisma.questionSet.create({
        data: {
          name: body.name,
          description: body.description,
          type: body.type,
          tags: body.tags ?? [],
          source: body.source,
          createdById: request.currentUser!.id,
        },
        include: setInclude(),
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'question_set.create',
        targetType: 'question_set',
        targetId: set.id,
        detail: { name: set.name, type: set.type },
      });
      reply.code(201);
      return serializeSet(set);
    },
  );

  app.get('/:id', { preHandler: [requirePermission('question_set:read')] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const set = await prisma.questionSet.findUnique({ where: { id }, include: setInclude() });
    if (!set) throw notFound('样本库不存在');
    return serializeSet(set);
  });

  app.patch(
    '/:id',
    { preHandler: [requirePermission('question_set:update'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = updateSetBody.parse(request.body);
      const existing = await prisma.questionSet.findUnique({ where: { id } });
      if (!existing) throw notFound('样本库不存在');
      if (existing.isBuiltin && body.enabled !== undefined) {
        throw badRequest('内置样本库不能禁用', 'BUILTIN_SET_CANNOT_DISABLE');
      }
      if (existing.isBuiltin) throw forbidden(BUILTIN_READONLY);
      if (body.name && body.name !== existing.name) {
        const dup = await prisma.questionSet.findFirst({
          where: { name: body.name, id: { not: id } },
        });
        if (dup) throw conflict('样本库名称已存在');
      }
      const data: Prisma.QuestionSetUpdateInput = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.description !== undefined) data.description = body.description;
      if (body.type !== undefined) data.type = body.type;
      if (body.tags !== undefined) data.tags = body.tags;
      if (body.source !== undefined) data.source = body.source;
      if (body.enabled !== undefined) data.enabled = body.enabled;
      const updated = await prisma.questionSet.update({ where: { id }, data, include: setInclude() });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'question_set.update',
        targetType: 'question_set',
        targetId: id,
        detail: { fields: Object.keys(data) },
      });
      return serializeSet(updated);
    },
  );

  app.delete(
    '/:id',
    { preHandler: [requirePermission('question_set:delete'), requireLicensedFeature('web_ai')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const set = await prisma.questionSet.findUnique({
        where: { id },
        include: { _count: { select: { taskLinks: true } } },
      });
      if (!set) throw notFound('样本库不存在');
      if (set.isBuiltin) throw forbidden(BUILTIN_READONLY);
      if (set._count.taskLinks > 0) {
        throw badRequest(`该样本库已被 ${set._count.taskLinks} 个评估任务引用，无法删除`);
      }
      // 自带图片集：先走专用清理（审计只记数量与哈希），再删集合。
      if (set.source === BYO_SET_SOURCE) {
        await purgeByoImages(id, request.currentUser!, 'question_set_delete');
      }
      await prisma.questionSet.delete({ where: { id } });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'question_set.delete',
        targetType: 'question_set',
        targetId: id,
        detail: { name: set.name },
      });
      return { ok: true };
    },
  );

  app.get(
    '/:id/preview',
    { preHandler: [requirePermission('question_set:preview')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { limit } = z
        .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
        .parse(request.query);
      const set = await prisma.questionSet.findUnique({ where: { id }, include: setInclude() });
      if (!set) throw notFound('样本库不存在');

      const [samples, byType, bySeverity, shouldRefuseCount] = await Promise.all([
        prisma.question.findMany({
          where: { questionSetId: id },
          orderBy: { createdAt: 'asc' },
          take: limit,
        }),
        prisma.question.groupBy({ by: ['type'], where: { questionSetId: id }, _count: true }),
        prisma.question.groupBy({ by: ['severity'], where: { questionSetId: id }, _count: true }),
        prisma.question.count({ where: { questionSetId: id, shouldRefuse: true } }),
      ]);

      return {
        set: serializeSet(set),
        stats: {
          total: set._count.questions,
          shouldRefuseCount,
          byType: Object.fromEntries(byType.map((r) => [r.type, r._count])),
          bySeverity: Object.fromEntries(bySeverity.map((r) => [r.severity ?? 'UNSET', r._count])),
        },
        samples: samples.map(serializeQuestion),
      };
    },
  );

  // 样本库的分类（按样本数倒序）：预览时按分类筛选，大库按分类导出。
  app.get(
    '/:id/categories',
    { preHandler: [requirePermission('question:read')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const set = await prisma.questionSet.findUnique({ where: { id }, select: { id: true } });
      if (!set) throw notFound('样本库不存在');
      const rows = await prisma.question.groupBy({
        by: ['category'],
        where: { questionSetId: id, category: { not: null } },
        _count: true,
      });
      return {
        items: rows
          .map((r) => ({ category: r.category!, count: r._count }))
          .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
      };
    },
  );

  // 样本库导出：按每道题自身的题型出导入模板的列（题型混合时 Excel 每种题型一个工作表），
  // 追加预期表现/参考答案、应拒答、条目编码、来源数据集、许可，导出的文件能原样导回去。
  // 内置库导出只给平台管理员（平台级权限点），自建库给有 question_set:export 的角色。
  app.get(
    '/:id/export',
    { preHandler: [requirePermission('question_set:export', 'question_set:export_builtin')] },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { format, ...filters } = questionExportQuery.parse(request.query);
      const set = await prisma.questionSet.findUnique({
        where: { id },
        select: { id: true, name: true, type: true, isBuiltin: true },
      });
      if (!set) throw notFound('样本库不存在');
      const required = set.isBuiltin ? 'question_set:export_builtin' : 'question_set:export';
      if (!request.currentUser!.permissions.has(required)) throw permissionDenied([required]);
      const where = questionListWhere(id, filters);
      assertExportSize(await prisma.question.count({ where }), '请先按分类筛选');
      const questions = await prisma.question.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          externalId: true,
          content: true,
          category: true,
          expectedBehavior: true,
          referenceAnswer: true,
          severity: true,
          tags: true,
          type: true,
          shouldRefuse: true,
          metadata: true,
        },
      });
      const groups = groupQuestionsForExport(questions, set.type);
      if (format === 'csv' && groups.length > 1) {
        throw badRequest('该样本库含多种题型，请导出 Excel', 'QUESTION_SET_EXPORT_MIXED_TYPES');
      }
      const watermark = await resolveDownloadWatermark(request.currentUser!);
      const file = await buildQuestionExport(groups, format, watermark);
      const ua = request.headers['user-agent'];
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'question_set.export',
        targetType: 'question_set',
        targetId: id,
        ip: request.ip,
        userAgent: typeof ua === 'string' ? ua : null,
        detail: {
          format,
          templateTypes: groups.map((g) => g.templateType),
          count: questions.length,
          builtin: set.isBuiltin,
          filters,
          watermark: watermark?.text ?? null,
        },
      });
      return sendAttachment(reply, file, {
        contentType:
          format === 'csv'
            ? 'text/csv; charset=utf-8'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `${set.name}.${format}`,
        fallbackName: `question-set-${id}.${format}`,
      });
    },
  );

  // ---------- 某问题集下的题目：列表 / 新增 ----------
  app.get(
    '/:setId/questions',
    { preHandler: [requirePermission('question:read')] },
    async (request) => {
      const { setId } = setIdParams.parse(request.params);
      const q = questionListQuery.parse(request.query);
      const set = await prisma.questionSet.findUnique({ where: { id: setId } });
      if (!set) throw notFound('样本库不存在');

      const where = questionListWhere(setId, q);
      const [items, total] = await Promise.all([
        prisma.question.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        prisma.question.count({ where }),
      ]);
      return {
        items: items.map(serializeQuestion),
        total,
        page: q.page,
        pageSize: q.pageSize,
      } satisfies Paginated<ReturnType<typeof serializeQuestion>>;
    },
  );

  // 从规则反查检测结果：这道题在各任务里的结果，按时间倒序，限当前租户。
  app.get(
    '/:setId/questions/:questionId/results',
    { preHandler: [requirePermission('question:read'), requirePermission('eval_task:read')] },
    async (request) => {
      const { setId, questionId } = questionResultsParams.parse(request.params);
      const { limit } = questionResultsQuery.parse(request.query);
      const question = await prisma.question.findFirst({
        where: { id: questionId, questionSetId: setId },
        select: { id: true },
      });
      if (!question) throw notFound('测试样本不存在');
      const where: Prisma.EvalResultWhereInput = { questionId };
      const owner = connectorOwnerWhere(request.currentUser!);
      if (Object.keys(owner).length > 0) where.task = owner;
      const [rows, total] = await Promise.all([
        prisma.evalResult.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit,
          select: {
            taskId: true,
            finalVerdict: true,
            createdAt: true,
            task: { select: { name: true } },
            modelTarget: { select: { name: true } },
            findings: { where: { severity: { not: null } }, select: { severity: true } },
          },
        }),
        prisma.evalResult.count({ where }),
      ]);
      return {
        items: rows.map((r) => ({
          taskId: r.taskId,
          taskName: r.task.name,
          targetName: r.modelTarget.name,
          verdict: r.finalVerdict,
          severity: r.findings.reduce<string | null>(
            (top, f) =>
              top === null || SEVERITY_RANK[f.severity!]! > SEVERITY_RANK[top]! ? f.severity : top,
            null,
          ),
          createdAt: r.createdAt,
        })),
        total,
      };
    },
  );

  app.post(
    '/:setId/questions',
    { preHandler: [requirePermission('question:create'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const { setId } = setIdParams.parse(request.params);
      const body = createQuestionBody.parse(request.body);
      const set = await prisma.questionSet.findUnique({ where: { id: setId } });
      if (!set) throw notFound('样本库不存在');
      if (set.isBuiltin) throw forbidden(BUILTIN_READONLY);
      const created = await prisma.question.create({
        data: {
          questionSetId: setId,
          content: body.content,
          externalId: body.externalId ?? null,
          category: body.category ?? null,
          expectedBehavior: body.expectedBehavior ?? null,
          referenceAnswer: body.referenceAnswer ?? null,
          type: body.type ?? set.type,
          severity: body.severity ?? null,
          shouldRefuse: body.shouldRefuse ?? set.type === 'SHOULD_REFUSE',
          language: body.language,
          tags: body.tags ?? [],
        },
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'question.create',
        targetType: 'question',
        targetId: created.id,
        detail: { questionSetId: setId },
      });
      reply.code(201);
      return serializeQuestion(created);
    },
  );
}
