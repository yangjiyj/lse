import type { FastifyInstance } from 'fastify';
import { Prisma, type ImportStatus } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import {
  listBenchmarkAdapters,
  listBenchmarkSamples,
  loadBenchmarkSample,
  parseBenchmark,
} from './index.js';
import type { BenchmarkParseResult } from './index.js';

const importInclude = {
  uploadedBy: { select: { id: true, username: true, displayName: true } },
} satisfies Prisma.QuestionImportInclude;
type ImportPayload = Prisma.QuestionImportGetPayload<{ include: typeof importInclude }>;

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

/**
 * 导入请求体：
 * - 来源二选一：sampleId（内置样本集）或 formatId + contentBase64（上传基准文件）。
 * - 目标二选一：questionSetId（追加到已有题集）或 setName（新建题集）。
 * formatId 用 z.string() 而非 z.enum——BENCHMARK_FORMAT_IDS 是 readonly string[] 而非元组，
 * 未知格式交由 parseBenchmark 抛错并映射为 400。
 */
const importBodySchema = z
  .object({
    sampleId: z.string().min(1).optional(),
    formatId: z.string().min(1).optional(),
    filename: z.string().min(1).max(255).optional(),
    contentBase64: z.string().min(1).optional(),
    questionSetId: z.string().min(1).optional(),
    setName: z.string().min(1).max(200).optional(),
    setDescription: z.string().max(2000).optional(),
    setTags: z.array(z.string()).optional(),
  })
  .refine((b) => (b.sampleId ? 1 : 0) + (b.formatId && b.contentBase64 ? 1 : 0) === 1, {
    message: '请选择内置评估基准，或上传基准数据文件。',
  })
  .refine((b) => (b.questionSetId ? 1 : 0) + (b.setName ? 1 : 0) === 1, {
    message: '请选择已有样本库，或填写新样本库名称。',
  });

/** 测评基准路由：展示可用的基准格式适配器与内置样本集，并支持将基准导入为题集。 */
export async function benchmarkRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/formats', { preHandler: [requirePermission('question_set:read')] }, async () =>
    listBenchmarkAdapters(),
  );

  app.get('/samples', { preHandler: [requirePermission('question_set:read')] }, async () =>
    listBenchmarkSamples(),
  );

  app.post(
    '/import',
    { preHandler: [requirePermission('question:import'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const body = importBodySchema.parse(request.body);
      const actor = request.currentUser!;

      // 1) 解析基准来源 → 归一化结果
      let parsed: BenchmarkParseResult;
      let formatId: string;
      let filename: string;

      if (body.sampleId) {
        try {
          parsed = loadBenchmarkSample(body.sampleId);
        } catch {
          throw notFound(`未找到内置样本集：${body.sampleId}`);
        }
        formatId = parsed.formatId;
        filename = body.filename ?? `sample:${body.sampleId}`;
      } else {
        formatId = body.formatId!;
        filename = body.filename ?? `upload.${formatId}`;
        const buf = Buffer.from(body.contentBase64!, 'base64');
        try {
          parsed = parseBenchmark(buf, formatId);
        } catch (err) {
          throw badRequest(err instanceof Error ? err.message : '基准内容解析失败');
        }
      }

      if (parsed.items.length === 0) {
        throw badRequest('基准文件为空或未解析到有效测试样本。');
      }

      const status: ImportStatus =
        parsed.importedRows === 0 ? 'FAILED' : parsed.failedRows > 0 ? 'PARTIAL' : 'SUCCESS';

      // 2) 事务：建/取题集 → createMany → 记录导入 → 触碰题集 updatedAt
      const result = await prisma.$transaction(async (tx) => {
        let setId: string;
        if (body.questionSetId) {
          const existing = await tx.questionSet.findUnique({ where: { id: body.questionSetId } });
          if (!existing) throw notFound('所选样本库不存在。');
          setId = existing.id;
        } else {
          const dup = await tx.questionSet.findFirst({ where: { name: body.setName! } });
          if (dup) throw conflict(`样本库名称已存在：${body.setName}`);
          const created = await tx.questionSet.create({
            data: {
              name: body.setName!,
              description: body.setDescription ?? `由评估基准导入（${formatId}）`,
              type: 'GENERAL',
              tags: body.setTags ?? [],
              source: body.sampleId ? `benchmark:${body.sampleId}` : `benchmark:${formatId}`,
              createdById: actor.id,
            },
          });
          setId = created.id;
        }

        await tx.question.createMany({
          data: parsed.items.map((it) => ({
            questionSetId: setId,
            externalId: it.externalId,
            content: it.content,
            category: it.category,
            expectedBehavior: it.expectedBehavior,
            referenceAnswer: it.referenceAnswer,
            type: it.type,
            severity: it.severity,
            shouldRefuse: it.shouldRefuse,
            tags: it.tags,
            metadata: (it.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          })),
        });

        const imp = await tx.questionImport.create({
          data: {
            questionSetId: setId,
            filename,
            format: formatId,
            templateType: 'benchmark',
            totalRows: parsed.totalRows,
            importedRows: parsed.importedRows,
            failedRows: parsed.failedRows,
            status,
            errorReport:
              parsed.issues.length > 0
                ? (parsed.issues as unknown as Prisma.InputJsonValue)
                : Prisma.DbNull,
            uploadedById: actor.id,
          },
          include: importInclude,
        });

        await tx.questionSet.update({ where: { id: setId }, data: {} });

        return { setId, imp };
      });

      await writeAudit({
        actorId: actor.id,
        actorName: actor.username,
        action: 'benchmark.import',
        targetType: 'question_set',
        targetId: result.setId,
        detail: {
          source: body.sampleId ? { sampleId: body.sampleId } : { formatId, filename },
          totalRows: parsed.totalRows,
          importedRows: parsed.importedRows,
          failedRows: parsed.failedRows,
          duplicateRows: parsed.duplicateRows ?? 0,
          status,
        },
      });

      reply.code(201);
      return { questionSetId: result.setId, import: serializeImport(result.imp) };
    },
  );
}
