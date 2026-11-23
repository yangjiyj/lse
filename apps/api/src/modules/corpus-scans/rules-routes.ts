import type { FastifyInstance } from 'fastify';
import type { CorpusRule, CorpusRuleSet } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { parseXlsx } from '../../lib/question-import.js';
import {
  REGEX_RULES_MAX,
  RULE_KINDS,
  RULE_SEVERITIES,
  parseRuleImport,
  parseRuleRows,
  validateRule,
  type ParsedRuleImport,
  type RuleInput,
} from './core/custom-rules.js';
import { auditCorpus } from './common.js';

// 语料规则（1.2.3 用户自定义外置规则库）：规则集（租户内）和规则（关键词或正则、类别名、严重度、启用）。
// 看：corpus_scan:read 或 corpus_rule:manage；改、导入、启停：corpus_rule:manage（只给 admin、tenant_admin）。

export const CORPUS_RULE_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
/** 单个规则集的规则数上限，防止一次导入把扫描拖垮 */
export const CORPUS_RULES_PER_SET_MAX = 100_000;

const READ = { preHandler: [requirePermission('corpus_scan:read', 'corpus_rule:manage')] };

/** 正则规则单独限 REGEX_RULES_MAX 条（每条正则每条记录都要跑一遍，比关键词贵得多）。 */
const regexSetFull = () =>
  badRequest(`一个规则集最多 ${REGEX_RULES_MAX} 条正则规则`, 'CORPUS_REGEX_RULES_FULL');
const regexCount = (ruleSetId: string) =>
  prisma.corpusRule.count({ where: { ruleSetId, kind: 'regex' } });
const MANAGE = { preHandler: [requirePermission('corpus_rule:manage')] };

const idParams = z.object({ id: z.string().uuid() });
const setBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullish(),
});
const setPatch = setBody.partial();
const ruleBody = z.object({
  kind: z.enum(RULE_KINDS),
  pattern: z.string().min(1).max(1000),
  category: z.string().trim().min(1).max(50),
  severity: z.enum(RULE_SEVERITIES).default('MEDIUM'),
  enabled: z.boolean().default(true),
});
const rulePatch = ruleBody.partial().refine((b) => Object.keys(b).length > 0, '没有要修改的字段');
const ruleListQuery = z.object({
  kind: z.enum(RULE_KINDS).optional(),
  enabled: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const importQuery = z.object({
  format: z.enum(['csv', 'txt', 'xlsx']),
  category: z.string().trim().min(1).max(50).default('自定义'),
  severity: z.enum(RULE_SEVERITIES).default('MEDIUM'),
  kind: z.enum(RULE_KINDS).default('keyword'),
});

function ruleView(r: CorpusRule) {
  return {
    id: r.id,
    ruleSetId: r.ruleSetId,
    kind: r.kind,
    pattern: r.pattern,
    category: r.category,
    severity: r.severity,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function setView(s: CorpusRuleSet, ruleCount: number, enabledCount: number) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    ruleCount,
    enabledCount,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

async function loadSet(id: string): Promise<CorpusRuleSet> {
  const set = await prisma.corpusRuleSet.findFirst({ where: { id } });
  if (!set) throw notFound('规则集不存在', 'CORPUS_RULE_SET_NOT_FOUND');
  return set;
}

function invalidRule(message: string) {
  return badRequest(message, 'CORPUS_RULE_INVALID');
}

export async function corpusRuleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: CORPUS_RULE_IMPORT_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.get('/sets', READ, async () => {
    const sets = await prisma.corpusRuleSet.findMany({ orderBy: { createdAt: 'desc' } });
    const counts = await prisma.corpusRule.groupBy({
      by: ['ruleSetId', 'enabled'],
      where: { ruleSetId: { in: sets.map((s) => s.id) } },
      _count: { _all: true },
    });
    const total = new Map<string, number>();
    const on = new Map<string, number>();
    for (const c of counts) {
      total.set(c.ruleSetId, (total.get(c.ruleSetId) ?? 0) + c._count._all);
      if (c.enabled) on.set(c.ruleSetId, c._count._all);
    }
    return { items: sets.map((s) => setView(s, total.get(s.id) ?? 0, on.get(s.id) ?? 0)) };
  });

  app.post('/sets', MANAGE, async (req, reply) => {
    const body = setBody.parse(req.body);
    if (await prisma.corpusRuleSet.findFirst({ where: { name: body.name } })) {
      throw conflict('同名规则集已存在', 'CORPUS_RULE_SET_EXISTS');
    }
    const set = await prisma.corpusRuleSet.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        createdById: req.currentUser!.id,
      },
    });
    await auditCorpus(req, 'corpus_rule.create_set', 'corpus_rule_set', set.id, { name: set.name });
    reply.code(201);
    return setView(set, 0, 0);
  });

  app.patch('/sets/:id', MANAGE, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = setPatch.parse(req.body);
    const set = await loadSet(id);
    if (
      body.name &&
      body.name !== set.name &&
      (await prisma.corpusRuleSet.findFirst({ where: { name: body.name } }))
    ) {
      throw conflict('同名规则集已存在', 'CORPUS_RULE_SET_EXISTS');
    }
    const updated = await prisma.corpusRuleSet.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description ?? null } : {}),
      },
    });
    await auditCorpus(req, 'corpus_rule.update_set', 'corpus_rule_set', id, body);
    const [ruleCount, enabledCount] = await Promise.all([
      prisma.corpusRule.count({ where: { ruleSetId: id } }),
      prisma.corpusRule.count({ where: { ruleSetId: id, enabled: true } }),
    ]);
    return setView(updated, ruleCount, enabledCount);
  });

  app.delete('/sets/:id', MANAGE, async (req) => {
    const { id } = idParams.parse(req.params);
    const set = await loadSet(id);
    await prisma.corpusRuleSet.delete({ where: { id } });
    await auditCorpus(req, 'corpus_rule.delete_set', 'corpus_rule_set', id, { name: set.name });
    return { deleted: true };
  });

  app.get('/sets/:id/rules', READ, async (req) => {
    const { id } = idParams.parse(req.params);
    const q = ruleListQuery.parse(req.query);
    await loadSet(id);
    const where = {
      ruleSetId: id,
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.enabled ? { enabled: q.enabled === 'true' } : {}),
      ...(q.q
        ? {
            OR: [
              { pattern: { contains: q.q, mode: 'insensitive' as const } },
              { category: { contains: q.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.corpusRule.count({ where }),
      prisma.corpusRule.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { items: rows.map(ruleView), total, page: q.page, pageSize: q.pageSize };
  });

  app.post('/sets/:id/rules', MANAGE, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = ruleBody.parse(req.body);
    await loadSet(id);
    const err = validateRule(body);
    if (err) throw invalidRule(err);
    if (
      await prisma.corpusRule.findFirst({
        where: { ruleSetId: id, kind: body.kind, pattern: body.pattern },
      })
    ) {
      throw conflict('规则集里已经有这条规则', 'CORPUS_RULE_EXISTS');
    }
    if ((await prisma.corpusRule.count({ where: { ruleSetId: id } })) >= CORPUS_RULES_PER_SET_MAX) {
      throw badRequest(`一个规则集最多 ${CORPUS_RULES_PER_SET_MAX} 条规则`, 'CORPUS_RULE_SET_FULL');
    }
    if (body.kind === 'regex' && (await regexCount(id)) >= REGEX_RULES_MAX) throw regexSetFull();
    const rule = await prisma.corpusRule.create({ data: { ruleSetId: id, ...body } });
    await auditCorpus(req, 'corpus_rule.create', 'corpus_rule', rule.id, {
      ruleSetId: id,
      kind: rule.kind,
      pattern: rule.pattern,
    });
    reply.code(201);
    return ruleView(rule);
  });

  app.patch('/rules/:id', MANAGE, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = rulePatch.parse(req.body);
    const rule = await prisma.corpusRule.findFirst({ where: { id } });
    if (!rule) throw notFound('规则不存在', 'CORPUS_RULE_NOT_FOUND');
    const next: RuleInput = {
      kind: body.kind ?? (rule.kind as RuleInput['kind']),
      pattern: body.pattern ?? rule.pattern,
      category: body.category ?? rule.category,
      severity: body.severity ?? (rule.severity as RuleInput['severity']),
      enabled: body.enabled ?? rule.enabled,
    };
    const err = validateRule(next);
    if (err) throw invalidRule(err);
    if (
      (next.kind !== rule.kind || next.pattern !== rule.pattern) &&
      (await prisma.corpusRule.findFirst({
        where: { ruleSetId: rule.ruleSetId, kind: next.kind, pattern: next.pattern, NOT: { id } },
      }))
    ) {
      throw conflict('规则集里已经有这条规则', 'CORPUS_RULE_EXISTS');
    }
    if (
      next.kind === 'regex' &&
      rule.kind !== 'regex' &&
      (await regexCount(rule.ruleSetId)) >= REGEX_RULES_MAX
    ) {
      throw regexSetFull();
    }
    const updated = await prisma.corpusRule.update({ where: { id }, data: next });
    await auditCorpus(req, 'corpus_rule.update', 'corpus_rule', id, body);
    return ruleView(updated);
  });

  app.delete('/rules/:id', MANAGE, async (req) => {
    const { id } = idParams.parse(req.params);
    const rule = await prisma.corpusRule.findFirst({ where: { id } });
    if (!rule) throw notFound('规则不存在', 'CORPUS_RULE_NOT_FOUND');
    await prisma.corpusRule.delete({ where: { id } });
    await auditCorpus(req, 'corpus_rule.delete', 'corpus_rule', id, {
      ruleSetId: rule.ruleSetId,
      kind: rule.kind,
      pattern: rule.pattern,
    });
    return { deleted: true };
  });

  /** 批量导入：请求体是文件原始字节（application/octet-stream），CSV、xlsx 认表头，txt 每行一个。 */
  app.post('/sets/:id/import', MANAGE, async (req) => {
    const { id } = idParams.parse(req.params);
    const q = importQuery.parse(req.query);
    await loadSet(id);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw badRequest('请选择要导入的文件', 'CORPUS_RULE_IMPORT_EMPTY');
    }
    const defaults = { category: q.category, severity: q.severity, kind: q.kind };
    let parsed: ParsedRuleImport;
    if (q.format === 'xlsx') {
      const rows = await parseXlsx(req.body).catch(() => {
        throw badRequest('xlsx 文件读不出来，请确认是 Excel 工作簿', 'CORPUS_RULE_IMPORT_FORMAT');
      });
      parsed = parseRuleRows(rows, defaults);
    } else {
      parsed = parseRuleImport(q.format, req.body.toString('utf8'), defaults);
    }

    const existingRows = await prisma.corpusRule.findMany({
      where: { ruleSetId: id },
      select: { kind: true, pattern: true },
    });
    const existing = new Set(existingRows.map((r) => `${r.kind}\u0000${r.pattern}`));
    const unseen = parsed.rows.filter((r) => !existing.has(`${r.kind}\u0000${r.pattern}`));
    let duplicates = parsed.duplicates + (parsed.rows.length - unseen.length);
    const issues = [...parsed.issues];
    // 正则规则单独限条数：超出的正则不导入，关键词照常
    let regexRoom = Math.max(
      0,
      REGEX_RULES_MAX - existingRows.filter((r) => r.kind === 'regex').length,
    );
    let regexOver = 0;
    const fresh = unseen.filter((r) => {
      if (r.kind !== 'regex') return true;
      if (regexRoom > 0) {
        regexRoom -= 1;
        return true;
      }
      regexOver += 1;
      return false;
    });
    if (regexOver > 0) {
      issues.push({
        row: 0,
        message: `超出正则规则上限 ${REGEX_RULES_MAX} 条，${regexOver} 条正则没有导入`,
      });
    }
    const room = Math.max(0, CORPUS_RULES_PER_SET_MAX - existing.size);
    if (fresh.length > room) {
      issues.push({
        row: 0,
        message: `超出规则集上限 ${CORPUS_RULES_PER_SET_MAX} 条，后面 ${fresh.length - room} 条没有导入`,
      });
    }
    const toAdd = fresh.slice(0, room);
    let added = 0;
    for (let i = 0; i < toAdd.length; i += 2000) {
      const res = await prisma.corpusRule.createMany({
        data: toAdd.slice(i, i + 2000).map((r) => ({ ruleSetId: id, ...r })),
        skipDuplicates: true,
      });
      added += res.count;
      duplicates += Math.min(2000, toAdd.length - i) - res.count;
    }
    const result = {
      totalRows: parsed.totalRows,
      added,
      duplicates,
      failed: parsed.issues.length + regexOver + (fresh.length - toAdd.length),
      issues: issues.slice(0, 100),
    };
    await auditCorpus(req, 'corpus_rule.import', 'corpus_rule_set', id, {
      format: q.format,
      totalRows: result.totalRows,
      added,
      duplicates,
      failed: result.failed,
    });
    return result;
  });
}
