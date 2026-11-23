import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../../db.js';
import { badRequest, notFound } from '../../../lib/errors.js';
import { requirePermission } from '../../../plugins/auth.js';
import { acceptToolBaseline, MCP_FETCH_AVAILABLE, VULNDB_AVAILABLE } from './integrations.js';
import { linkScanToTask } from './link-task.js';
import { taxonomyForAiAssetRule } from './taxonomy.js';

type AuditFn = (req: FastifyRequest, action: string, targetId: string, detail: Record<string, unknown>) => Promise<void>;

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  assetKey: z.string().max(300).optional(),
  keyword: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const findingQuery = z.object({
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
  reviewStatus: z.enum(['PENDING', 'CONFIRMED', 'FALSE_POSITIVE']).optional(),
});
const reviewBody = z.object({ status: z.enum(['PENDING', 'CONFIRMED', 'FALSE_POSITIVE']), note: z.string().trim().max(1000).optional() }).strict();
const linkBody = z.object({ taskId: z.string().uuid(), includeFalsePositive: z.boolean().default(false) }).strict();
const compareQuery = z.object({ base: z.string().uuid(), target: z.string().uuid() });

const SCAN_SELECT = {
  id: true, assetName: true, assetType: true, assetVersion: true, assetKey: true, sourceType: true, sourceLabel: true,
  endpointUrl: true, contentSha256: true, status: true, error: true, fileCount: true, totalBytes: true, skippedCount: true,
  criticalCount: true, highCount: true, mediumCount: true, lowCount: true, judgeStatus: true, linkedTaskId: true,
  linkedAt: true, createdById: true, createdByName: true, createdAt: true,
} satisfies Prisma.AiComponentScanSelect;

function serialize<T extends { createdAt: Date; linkedAt?: Date | null }>(row: T) {
  return { ...row, createdAt: row.createdAt.toISOString(), linkedAt: row.linkedAt ? row.linkedAt.toISOString() : null };
}

export async function registerAiComponentQueryRoutes(app: FastifyInstance, audit: AuditFn): Promise<void> {
  app.get('/ai-components/scans', { preHandler: [requirePermission('engine:scan', 'eval_task:read')] }, async (req) => {
    const q = listQuery.parse(req.query);
    const where: Prisma.AiComponentScanWhereInput = {
      ...(q.assetKey ? { assetKey: q.assetKey } : {}),
      ...(q.keyword ? { OR: [{ assetName: { contains: q.keyword, mode: 'insensitive' } }, { sourceLabel: { contains: q.keyword, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.aiComponentScan.findMany({ where, select: SCAN_SELECT, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.aiComponentScan.count({ where }),
    ]);
    const tasks = rows.some((r) => r.linkedTaskId)
      ? await prisma.evalTask.findMany({ where: { id: { in: rows.flatMap((r) => (r.linkedTaskId ? [r.linkedTaskId] : [])) } }, select: { id: true, name: true } })
      : [];
    const taskName = new Map(tasks.map((t) => [t.id, t.name]));
    return {
      items: rows.map((r) => ({ ...serialize(r), linkedTaskName: r.linkedTaskId ? (taskName.get(r.linkedTaskId) ?? '（任务已删除）') : null })),
      total,
      page: q.page,
      pageSize: q.pageSize,
      capabilities: { vulnDb: VULNDB_AVAILABLE, mcpFetch: MCP_FETCH_AVAILABLE },
    };
  });

  app.get('/ai-components/scans/:id', { preHandler: [requirePermission('engine:scan', 'eval_task:read')] }, async (req) => {
    const { id } = idParams.parse(req.params);
    const row = await prisma.aiComponentScan.findUnique({ where: { id }, select: { ...SCAN_SELECT, files: true, snapshot: true, inputBlob: true } });
    if (!row) throw notFound('扫描记录不存在');
    const { inputBlob, ...rest } = row;
    const previous = await prisma.aiComponentScan.findFirst({
      where: { assetKey: row.assetKey, createdAt: { lt: row.createdAt }, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, assetVersion: true, createdAt: true },
    });
    const task = row.linkedTaskId ? await prisma.evalTask.findUnique({ where: { id: row.linkedTaskId }, select: { name: true } }) : null;
    return {
      ...serialize(rest),
      linkedTaskName: row.linkedTaskId ? (task?.name ?? '（任务已删除）') : null,
      canRescan: !!inputBlob && row.sourceType !== 'MCP_ENDPOINT',
      previousScan: previous ? serialize(previous) : null,
    };
  });

  app.get('/ai-components/scans/:id/findings', { preHandler: [requirePermission('engine:scan', 'eval_task:read')] }, async (req) => {
    const { id } = idParams.parse(req.params);
    const q = findingQuery.parse(req.query);
    if (!(await prisma.aiComponentScan.findUnique({ where: { id }, select: { id: true } }))) throw notFound('扫描记录不存在');
    const rows = await prisma.aiComponentFinding.findMany({
      where: { scanId: id, ...(q.severity ? { severity: q.severity } : {}), ...(q.reviewStatus ? { reviewStatus: q.reviewStatus } : {}) },
      orderBy: [{ severity: 'desc' }, { filePath: 'asc' }, { line: 'asc' }],
    });
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), reviewedAt: r.reviewedAt?.toISOString() ?? null, taxonomy: taxonomyForAiAssetRule(r.ruleId) }));
  });

  app.patch('/ai-components/findings/:id/review', { preHandler: [requirePermission('engine:scan')] }, async (req) => {
    const { id } = idParams.parse(req.params);
    const b = reviewBody.parse(req.body);
    const f = await prisma.aiComponentFinding.findUnique({ where: { id }, select: { id: true, scanId: true, ruleId: true, linkedFindingId: true } });
    if (!f) throw notFound('发现项不存在');
    const row = await prisma.aiComponentFinding.update({
      where: { id },
      data: { reviewStatus: b.status, reviewNote: b.note ?? null, reviewedById: req.currentUser!.id, reviewedAt: new Date() },
    });
    // 已关联到评估任务的发现项同步复核结论
    if (f.linkedFindingId) {
      await prisma.finding.updateMany({
        where: { id: f.linkedFindingId },
        data: { reviewStatus: b.status === 'CONFIRMED' ? 'CONFIRMED' : b.status === 'FALSE_POSITIVE' ? 'FALSE_POSITIVE' : 'UNREVIEWED', reviewReason: b.note ?? null },
      });
    }
    await audit(req, 'ai_component.finding.review', f.scanId, { findingId: id, ruleId: f.ruleId, status: b.status });
    return { ...row, createdAt: row.createdAt.toISOString(), reviewedAt: row.reviewedAt?.toISOString() ?? null };
  });

  app.post('/ai-components/findings/:id/accept-baseline', { preHandler: [requirePermission('engine:scan')] }, async (req) => {
    const { id } = idParams.parse(req.params);
    const f = await prisma.aiComponentFinding.findUnique({ where: { id }, include: { scan: { select: { id: true, assetKey: true, snapshot: true } } } });
    if (!f || f.ruleId !== 'mcp.rug_pull') throw badRequest('只有“工具描述与基线不一致”的发现项可以确认为新基线', 'AI_COMPONENT_NOT_RUG_PULL');
    const toolName = ((f.locations as Array<{ toolName?: string }> | null) ?? [])[0]?.toolName;
    const current = (f.detail as { currentTool?: { description: string; inputSchema?: unknown; annotations?: unknown } } | null)?.currentTool;
    if (!toolName || !current) throw badRequest('该发现项缺少当前工具描述，无法更新基线', 'AI_COMPONENT_BASELINE_MISSING');
    await acceptToolBaseline(f.scan.assetKey, toolName, current, f.scan.id);
    await prisma.aiComponentFinding.update({ where: { id }, data: { reviewStatus: 'FALSE_POSITIVE', reviewNote: '已人工确认描述变更并更新基线', reviewedById: req.currentUser!.id, reviewedAt: new Date() } });
    await audit(req, 'ai_component.baseline.accept', f.scan.id, { findingId: id, toolName });
    return { ok: true };
  });

  app.delete('/ai-components/scans/:id', { preHandler: [requirePermission('engine:scan')] }, async (req) => {
    const { id } = idParams.parse(req.params);
    const row = await prisma.aiComponentScan.findUnique({ where: { id }, select: { id: true, assetName: true, linkedTaskId: true } });
    if (!row) throw notFound('扫描记录不存在');
    // 已关联到评估任务的发现项属于该任务的评估证据，不随扫描记录删除
    await prisma.aiComponentScan.delete({ where: { id } });
    await audit(req, 'ai_component.delete', id, { assetName: row.assetName, linkedTaskId: row.linkedTaskId });
    return { ok: true };
  });

  app.post('/ai-components/scans/:id/link-task', { preHandler: [requirePermission('engine:scan')] }, async (req) => {
    const { id } = idParams.parse(req.params);
    const b = linkBody.parse(req.body);
    const result = await linkScanToTask(id, b.taskId, { includeFalsePositive: b.includeFalsePositive });
    await audit(req, 'ai_component.link_task', id, { taskId: b.taskId, linkedCount: result.linkedCount });
    return result;
  });

  app.get('/ai-components/compare', { preHandler: [requirePermission('engine:scan', 'eval_task:read')] }, async (req) => {
    const q = compareQuery.parse(req.query);
    const scans = await prisma.aiComponentScan.findMany({ where: { id: { in: [q.base, q.target] } }, select: { id: true, assetKey: true } });
    if (scans.length !== 2) throw notFound('扫描记录不存在');
    if (scans[0]!.assetKey !== scans[1]!.assetKey) throw badRequest('只能对比同一资产的两次扫描', 'AI_COMPONENT_COMPARE_ASSET_MISMATCH');
    const [base, target] = await Promise.all([
      prisma.aiComponentFinding.findMany({ where: { scanId: q.base } }),
      prisma.aiComponentFinding.findMany({ where: { scanId: q.target } }),
    ]);
    // rug pull 发现项附带逐字段的基线值与当前值，前端据此做字段级 diff
    const toolChange = (r: (typeof base)[number]) => {
      if (r.ruleId !== 'mcp.rug_pull') return undefined;
      const d = (r.detail ?? {}) as { baseline?: Record<string, unknown>; currentTool?: Record<string, unknown> };
      const toolName = ((r.locations as Array<{ toolName?: string }> | null) ?? [])[0]?.toolName ?? null;
      return {
        toolName,
        baseline: {
          description: d.baseline?.previousDescription ?? null,
          inputSchema: d.baseline?.previousInputSchema ?? null,
          annotations: d.baseline?.previousAnnotations ?? null,
          inputSchemaRecorded: d.baseline?.inputSchemaRecorded ?? false,
        },
        current: { description: d.currentTool?.description ?? null, inputSchema: d.currentTool?.inputSchema ?? null, annotations: d.currentTool?.annotations ?? null },
      };
    };
    const pick = (r: (typeof base)[number]) => {
      const tc = toolChange(r);
      return { id: r.id, ruleId: r.ruleId, severity: r.severity, title: r.title, filePath: r.filePath, line: r.line, evidence: r.evidence, ...(tc ? { toolChange: tc } : {}) };
    };
    const baseFp = new Set(base.map((r) => r.fingerprint));
    const targetFp = new Set(target.map((r) => r.fingerprint));
    return {
      added: target.filter((r) => !baseFp.has(r.fingerprint)).map(pick),
      removed: base.filter((r) => !targetFp.has(r.fingerprint)).map(pick),
      unchanged: target.filter((r) => baseFp.has(r.fingerprint)).length,
      descriptionChanged: target.filter((r) => r.ruleId === 'mcp.rug_pull').map(pick),
    };
  });
}
