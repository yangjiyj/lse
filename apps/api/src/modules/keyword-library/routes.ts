import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAnnexItemCode } from '@lse/shared';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/auth.js';
import { conflict } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import {
  KEYWORD_EDITABLE_STATUSES,
  KEYWORD_REVIEW_STATUSES,
  computeKeywordCoverage,
  exportKeywordsCsv,
  importKeywords,
  listKeywords,
  parseKeywordImport,
  setKeywordStatus,
} from './service.js';

const importBody = z.object({
  format: z.enum(['csv', 'txt']),
  filename: z.string().trim().min(1).max(255).default('import'),
  content: z.string().min(1).max(20_000_000),
  // TXT 每行一个词时用；CSV 有 itemCode 列时可不填。
  itemCode: z.string().trim().max(10).optional(),
});

// 按 id 改，或按「小项 + 原状态」改；两种用法不混用。
const statusBody = z
  .object({
    ids: z.array(z.string().trim().min(1).max(64)).min(1).max(5000).optional(),
    itemCode: z.string().trim().max(10).optional(),
    fromStatus: z.enum(KEYWORD_EDITABLE_STATUSES).optional(),
    to: z.enum(['approved', 'disabled']),
  })
  .superRefine((b, ctx) => {
    const byIds = b.ids !== undefined;
    if (byIds ? b.itemCode !== undefined || b.fromStatus !== undefined : !b.itemCode || !b.fromStatus) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '请按关键词 id 修改，或同时给出小项和原状态' });
    }
    if (b.fromStatus && b.fromStatus === b.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '原状态与目标状态相同' });
    }
  });

const listQuery = z.object({
  itemCode: z.string().trim().max(10).optional(),
  keyword: z.string().trim().max(50).optional(),
  reviewStatus: z.enum(KEYWORD_REVIEW_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * 关键词库接口（GB/T 45654 附录 B.1.1），挂在 /api/question-sets/builtin/keywords 下，继承父级登录鉴权。
 * 内置词随产品版本更新，2026.11.4 起覆盖 A.1、A.2 全部 17 项；客户也可以导入自己的词。
 */
export async function keywordLibraryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/coverage', { preHandler: [requirePermission('question_set:read')] }, async () => {
    return computeKeywordCoverage(prisma);
  });

  app.get('/', { preHandler: [requirePermission('question_set:read')] }, async (request) => {
    const q = listQuery.parse(request.query);
    if (q.itemCode && !isAnnexItemCode(q.itemCode)) throw conflict('附录 A 小项编号不存在');
    return listKeywords(prisma, q);
  });

  app.post('/import', { preHandler: [requirePermission('question_set:create')] }, async (request, reply) => {
    const body = importBody.parse(request.body ?? {});
    if (body.itemCode && !isAnnexItemCode(body.itemCode.replace(/^a\./i, 'A.'))) {
      throw conflict('附录 A 小项编号不存在，应形如 A.2.e');
    }
    const parsed = parseKeywordImport(body.format, body.content, body.itemCode ?? null);
    if (parsed.rows.length === 0) {
      reply.code(400);
      return {
        message:
          parsed.issues[0]?.message ??
          (parsed.skippedInactive > 0 ? '文件里只有停用的词，没有可导入的关键词' : '没有可导入的关键词'),
        issues: parsed.issues.slice(0, 50),
        totalRows: parsed.totalRows,
        skippedInactive: parsed.skippedInactive,
      };
    }
    const result = await importKeywords(prisma, parsed, { source: `import:${body.format}` });
    await writeAudit({
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action: 'keyword_library.import',
      targetType: 'keyword_library',
      targetId: 'gbt45654',
      detail: {
        filename: body.filename,
        added: result.added,
        duplicates: result.duplicates,
        failed: result.failed,
        skippedInactive: result.skippedInactive,
      },
    });
    return { ...result, issues: result.issues.slice(0, 50) };
  });

  // 批量改状态（生效 / 停用）：按 id，或按小项 + 原状态。平台词只有能写平台共享词表的账号能改，租户只改自己导入的词。
  app.post('/status', { preHandler: [requirePermission('question_set:update')] }, async (request) => {
    const body = statusBody.parse(request.body ?? {});
    if (body.itemCode && !isAnnexItemCode(body.itemCode)) throw conflict('附录 A 小项编号不存在');
    const result = await setKeywordStatus(prisma, {
      ids: body.ids,
      itemCode: body.itemCode,
      fromStatus: body.fromStatus,
      to: body.to,
      actorName: request.currentUser!.username,
    });
    await writeAudit({
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action: 'keyword_library.status',
      targetType: 'keyword_library',
      targetId: result.itemCode ?? 'gbt45654',
      detail: { to: result.to, count: result.changed, itemCode: result.itemCode, terms: result.terms },
    });
    return { to: result.to, itemCode: result.itemCode, changed: result.changed };
  });

  app.get('/export', { preHandler: [requirePermission('question_set:read')] }, async (request, reply) => {
    const { itemCode } = z.object({ itemCode: z.string().trim().max(10).optional() }).parse(request.query);
    if (itemCode && !isAnnexItemCode(itemCode)) throw conflict('附录 A 小项编号不存在');
    const csv = await exportKeywordsCsv(prisma, itemCode);
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="gbt45654_keywords${itemCode ? '_' + itemCode : ''}.csv"`);
    return csv;
  });
}
