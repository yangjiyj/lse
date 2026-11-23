import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { findBuiltinCategory } from '@lse/shared';
import { prisma } from '../../../db.js';
import { requirePermission } from '../../../plugins/auth.js';
import { conflict, notFound } from '../../../lib/errors.js';
import { writeAudit } from '../../../lib/audit.js';
import { requireLicensedFeature } from '../../../lib/license-enforcement.js';
import { kindWhere } from '../kind.js';
import { LIVE_BUILTIN_SET, countInactiveQuestions, inactiveQuestionSql } from './live.js';
import { keywordLibraryRoutes } from '../../keyword-library/routes.js';
import { bankUpdateRoutes } from '../bank-updates/routes.js';
import { computeBankCoverage, importBankQuestions, parseBankImport, parseBankKind } from './bank-service.js';

const bankImportBody = z.object({
  format: z.enum(['csv', 'jsonl']),
  filename: z.string().trim().min(1).max(255).default('import'),
  // 文件正文（UTF-8 文本）。字段：itemCode、content、bank。
  content: z.string().min(1).max(20_000_000),
  // 文件里没有 bank 列时使用的题库类别：generation / refusal / non_refusal（或中文别名）。
  bank: z.string().trim().max(40).optional(),
});

const idParams = z.object({ id: z.string().uuid() });
const copyBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  // 只复制指定小类（编码）；不传 = 整库复制。
  categories: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
});

const builtinBrowseQuery = z.object({
  minor: z.string().trim().min(1).max(32),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * 内置合规题库相关接口（挂在 /api/question-sets 下，继承父级登录鉴权）。
 * GET /builtin/stats 为态势概览（工作流 D）依赖的契约接口，结构不可改。
 */
export async function builtinQuestionSetRoutes(app: FastifyInstance): Promise<void> {
  await app.register(keywordLibraryRoutes, { prefix: '/builtin/keywords' });
  await app.register(bankUpdateRoutes, { prefix: '/builtin/updates' });
  app.get('/builtin/stats', { preHandler: [requirePermission('question_set:read')] }, async () => {
    const [builtinSets, ownSetCount] = await Promise.all([
      prisma.questionSet.findMany({
        // 已下线的内置题库（信通院、能源行业）不计入。
        where: LIVE_BUILTIN_SET,
        select: { id: true, _count: { select: { questions: true } } },
      }),
      // 与样本库页「自有样本库」、首页样本资产同一口径（kind.ts 的分类；运行记录不算自有）。
      prisma.questionSet.count({ where: kindWhere('own') }),
    ]);
    // 按版本对齐下线、尚未生效（自动更新进行中）的题不计入。
    const retiredTotal = await countInactiveQuestions(builtinSets.map((s) => s.id));
    // 分类计数同样不含已下线与尚未生效（自动更新进行中）的题。
    const rows = builtinSets.length
      ? (
          await prisma.$queryRaw<{ category: string | null; n: number }[]>`
            SELECT q."category" AS category, count(*)::int AS n FROM "questions" q
            WHERE q."questionSetId" IN (${Prisma.join(builtinSets.map((s) => s.id))})
              AND NOT ${inactiveQuestionSql('q')}
            GROUP BY q."category"`
        ).map((r) => ({ category: r.category, _count: r.n }))
      : [];
    const categories = rows
      .map((r) => ({ ref: r.category ? findBuiltinCategory(r.category) : undefined, n: r._count }))
      .filter((x): x is { ref: NonNullable<typeof x.ref>; n: number } => Boolean(x.ref))
      .sort((a, b) => a.ref.minorCode.localeCompare(b.ref.minorCode, 'en', { numeric: true }))
      .map(({ ref, n }) => ({
        taxonomy: ref.taxonomy,
        major: ref.major,
        minor: ref.minor,
        count: n,
      }));
    return {
      builtinQuestionTotal: builtinSets.reduce((acc, s) => acc + s._count.questions, 0) - retiredTotal,
      builtinSetCount: builtinSets.length,
      ownSetCount,
      categories,
    };
  });

  // 按小类浏览内置题目：与 /builtin/stats 的小类题数同口径（在用的内置库、不含已下线与尚未生效的题），
  // 跨库列出并带所属题库。题集清单按租户范围查出，原始 SQL 只用这些 id。
  app.get('/builtin/browse', { preHandler: [requirePermission('question_set:read')] }, async (request) => {
    const q = builtinBrowseQuery.parse(request.query);
    if (!findBuiltinCategory(q.minor)) throw conflict('小类编号不存在');
    const sets = await prisma.questionSet.findMany({ where: LIVE_BUILTIN_SET, select: { id: true } });
    if (sets.length === 0) return { total: 0, page: q.page, pageSize: q.pageSize, items: [] };
    const where = Prisma.sql`q."questionSetId" IN (${Prisma.join(sets.map((s) => s.id))})
      AND q."category" = ${q.minor} AND NOT ${inactiveQuestionSql('q')}`;
    const [count, items] = await Promise.all([
      prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "questions" q WHERE ${where}`,
      prisma.$queryRaw<{ id: string; content: string; setName: string; setSource: string | null }[]>`
        SELECT q."id", q."content", s."name" AS "setName", s."source" AS "setSource"
        FROM "questions" q JOIN "question_sets" s ON s."id" = q."questionSetId"
        WHERE ${where}
        ORDER BY s."source" NULLS LAST, q."createdAt", q."id"
        LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
    ]);
    return { total: count[0]?.n ?? 0, page: q.page, pageSize: q.pageSize, items };
  });

  // GB/T 45654 附录 B 三套题库的覆盖统计（内置 + 导入合并）。
  app.get('/builtin/bank-coverage', { preHandler: [requirePermission('question_set:read')] }, async () => {
    return { banks: await computeBankCoverage(prisma) };
  });

  // 按小项导入国标题目（CSV 或 JSONL，字段 itemCode、content、bank）。
  app.post('/builtin/bank-import', { preHandler: [requirePermission('question_set:create')] }, async (request, reply) => {
    const body = bankImportBody.parse(request.body ?? {});
    const defaultBank = body.bank ? parseBankKind(body.bank) : null;
    if (body.bank && !defaultBank) throw conflict('题库类别不认识，可填 生成内容、应拒答、非拒答');
    const parsed = parseBankImport(body.format, body.content, defaultBank);
    if (parsed.rows.length === 0 && parsed.issues.length > 0) {
      reply.code(400);
      return { message: parsed.issues[0]!.message, issues: parsed.issues.slice(0, 50), totalRows: parsed.totalRows };
    }
    const result = await importBankQuestions(prisma, parsed, { filename: body.filename });
    await writeAudit({
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action: 'question_set.bank_import',
      targetType: 'question_set',
      targetId: 'gbt45654',
      detail: { filename: body.filename, imported: result.imported, duplicates: result.duplicates, failed: result.failed },
    });
    return { ...result, issues: result.issues.slice(0, 50) };
  });

  // 导入模板（CSV）。
  app.get('/builtin/bank-import/template', { preHandler: [requirePermission('question_set:read')] }, async (_request, reply) => {
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="gbt45654_bank_import_template.csv"');
    return '﻿itemCode,content,bank\r\nA.1.a,（题目内容）,generation\r\nA.2.e,（题目内容）,refusal\r\n,（题目内容；非拒答题的 itemCode 填方面名或留空）,non_refusal\r\n';
  });

  // 复制为自有题库：内置题库不可删改，用户可复制后自由编辑。
  app.post(
    '/:id/copy',
    { preHandler: [requirePermission('question_set:create'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = copyBody.parse(request.body ?? {});
      const src = await prisma.questionSet.findUnique({ where: { id } });
      if (!src) throw notFound('样本库不存在');
      const name = body.name ?? `${src.name}（副本）`;
      if (await prisma.questionSet.findFirst({ where: { name } })) {
        throw conflict('样本库名称已存在');
      }
      const categories = body.categories ?? [];
      // 大题库（10 万级）复制：库内 INSERT … SELECT，不把题目读进内存；可按小类只复制一部分。
      const { set, copied } = await prisma.$transaction(
        async (tx) => {
          const set = await tx.questionSet.create({
            data: {
              name,
              description: src.description,
              type: src.type,
              tags: src.tags.filter((t) => t !== '内置'),
              language: src.language,
              source: `copy:${src.id}`,
              isBuiltin: false,
              createdById: request.currentUser!.id,
            },
          });
          const categoryFilter = categories.length
            ? Prisma.sql`AND q."category" IN (${Prisma.join(categories)})`
            : Prisma.empty;
          const copied = await tx.$executeRaw`
            INSERT INTO "questions" ("id", "questionSetId", "externalId", "content", "expectedBehavior",
              "category", "type", "severity", "referenceAnswer", "language", "shouldRefuse", "tags",
              "metadata", "createdAt", "updatedAt")
            SELECT gen_random_uuid()::text, ${set.id}, q."externalId", q."content", q."expectedBehavior",
              q."category", q."type", q."severity", q."referenceAnswer", q."language", q."shouldRefuse",
              array_remove(q."tags", '内置'), q."metadata", now(), now()
            FROM "questions" q
            WHERE q."questionSetId" = ${src.id} ${categoryFilter}
              -- 只复制在用题：已下线和自动更新进行中尚未生效的不复制
              AND COALESCE(q."metadata"->>'retired', 'false') <> 'true'
              AND (q."metadata"->>'pendingVersion') IS NULL
            ORDER BY q."createdAt", q."id"`;
          return { set, copied };
        },
        { timeout: 120_000 },
      );
      const created = set;
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'question_set.copy',
        targetType: 'question_set',
        targetId: created.id,
        detail: { from: src.id, name, questionCount: copied, categories },
      });
      reply.code(201);
      return { id: created.id, name: created.name, questionCount: copied };
    },
  );
}
