import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import {
  RISK_DOMAIN_ATLAS_TECHNIQUES,
  ATLAS_DATA,
  OWASP_DATA,
  atlasTacticZh,
  atlasTechniqueZh,
} from './index.js';
import { isValidFrameworkEntry } from './mapping-utils.js';
import { GBT45654_ANNEX_A_LABELS, PLATFORM_APP_COMPLIANCE } from '../reports/compliance-mapping.js';
import { riskDomainLabel } from '../reports/labels.js';
import {
  COVERAGE_FRAMEWORKS,
  computeFrameworkCoverage,
  entriesFor,
  resultDomains,
} from './coverage.js';

const bodySchema = z.object({
  framework: z.enum(['ATLAS', 'OWASP_LLM', 'OWASP_AGENTIC', 'GBT45654_ANNEX_A']),
  entryId: z.string().trim().min(1).max(100),
  entryName: z.string().trim().min(1).max(300),
  action: z.enum(['UPSERT', 'REMOVE']).default('UPSERT'),
  reason: z.string().trim().min(1).max(1000),
});

export async function frameworkRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/catalog', { preHandler: [requirePermission('eval_task:read')] }, async () => ({
    atlas: ATLAS_DATA,
    owasp: OWASP_DATA,
    gbt45654AnnexA: GBT45654_ANNEX_A_LABELS,
    domainTechniques: RISK_DOMAIN_ATLAS_TECHNIQUES,
    disclaimer: '平台参考映射，非认证结论',
  }));

  app.get('/coverage', { preHandler: [requirePermission('eval_task:read')] }, async (request) => {
    const query = z
      .object({
        framework: z.enum(COVERAGE_FRAMEWORKS as [string, ...string[]]).optional(),
        taskId: z.string().uuid().optional(),
        targetId: z.string().uuid().optional(),
        days: z.coerce.number().int().min(1).max(3650).optional(),
      })
      .parse(request.query);
    if (
      query.taskId &&
      !(await prisma.evalTask.findUnique({ where: { id: query.taskId }, select: { id: true } }))
    )
      throw notFound('评估任务不存在');
    if (
      query.targetId &&
      !(await prisma.modelTarget.findUnique({
        where: { id: query.targetId },
        select: { id: true },
      }))
    )
      throw notFound('评估对象不存在');
    const result = await computeFrameworkCoverage(
      { taskId: query.taskId, targetId: query.targetId, days: query.days },
      query.framework ? [query.framework as (typeof COVERAGE_FRAMEWORKS)[number]] : undefined,
    );
    return {
      scope: {
        taskId: query.taskId ?? null,
        targetId: query.targetId ?? null,
        days: query.days ?? null,
      },
      ...result,
      disclaimer: '覆盖矩阵按平台风险域参考映射统计，未测试不等于安全，非认证结论',
    };
  });

  app.post(
    '/findings/:id/mappings',
    { preHandler: [requirePermission('eval_task:create')] },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = bodySchema.parse(request.body);
      if (!isValidFrameworkEntry(body.framework, body.entryId))
        throw badRequest('框架条目编号无效');
      const finding = await prisma.finding.findUnique({ where: { id }, select: { id: true } });
      if (!finding) throw notFound('风险发现不存在');
      const mapping = await prisma.findingFrameworkMapping.upsert({
        where: {
          findingId_framework_entryId: {
            findingId: id,
            framework: body.framework,
            entryId: body.entryId,
          },
        },
        create: { findingId: id, ...body, createdById: request.currentUser!.id },
        update: { ...body, createdById: request.currentUser!.id },
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'finding.framework_mapping.update',
        targetType: 'finding',
        targetId: id,
        detail: {
          framework: body.framework,
          entryId: body.entryId,
          action: body.action,
          reason: body.reason,
        },
      });
      return mapping;
    },
  );

  app.get('/heatmap', { preHandler: [requirePermission('eval_task:read')] }, async (request) => {
    const query = z
      .object({
        dimension: z.enum(['target', 'task']).default('target'),
        framework: z
          .enum(['ATLAS_MATRIX', 'OWASP_LLM', 'OWASP_AGENTIC', 'GBT45654_ANNEX_A'])
          .default('OWASP_LLM'),
      })
      .parse(request.query);
    const tasks = await prisma.evalTask.findMany({
      where: { status: 'COMPLETED' },
      select: {
        id: true,
        name: true,
        modelTargetId: true,
        modelTarget: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const columnsMap = new Map<string, { id: string; label: string }>();
    for (const task of tasks) {
      const id = query.dimension === 'task' ? task.id : task.modelTargetId;
      const label = query.dimension === 'task' ? task.name : task.modelTarget.name;
      columnsMap.set(id, { id, label });
    }
    const columns = [...columnsMap.values()];
    const items = frameworkItems(query.framework);
    const itemIds = new Set(items.map(({ id }) => id));
    const resultRows = await prisma.evalResult.findMany({
      where: { taskId: { in: tasks.map(({ id }) => id) }, finalVerdict: { in: ['PASS', 'FAIL'] } },
      select: {
        id: true,
        taskId: true,
        modelTargetId: true,
        finalVerdict: true,
        question: { select: { category: true, tags: true } },
        findings: {
          select: {
            id: true,
            riskCategory: true,
            frameworkMappings: { select: { framework: true, entryId: true, action: true } },
          },
        },
      },
    });
    const counts = new Map<
      string,
      { resultIds: Set<string>; failIds: Set<string>; findingIds: Set<string> }
    >();
    const judgedByColumn = new Map<string, Set<string>>();
    let unmappedCount = 0;
    const unmappedByDomain = new Map<string, { label: string; count: number }>();
    for (const result of resultRows) {
      const task = taskById.get(result.taskId);
      if (!task) continue;
      const columnId = query.dimension === 'task' ? task.id : result.modelTargetId;
      const judged = judgedByColumn.get(columnId) ?? new Set<string>();
      judged.add(result.id);
      judgedByColumn.set(columnId, judged);
      // 口径与覆盖矩阵一致：风险域（含平台应用场景标签）→ 条目，复用 coverage.ts 的归类。
      const frameworkCode = query.framework === 'ATLAS_MATRIX' ? 'ATLAS' : query.framework;
      const domains = resultDomains({
        question: { category: result.question.category, tags: result.question.tags },
        findings: result.findings,
      });
      const appScenarios = result.question.tags.filter((tag) =>
        Object.hasOwn(PLATFORM_APP_COMPLIANCE, tag),
      );
      const entryIds = new Set(
        [...entriesFor(domains, appScenarios)]
          .filter((key) => key.startsWith(`${frameworkCode}:`))
          .map((key) => key.slice(frameworkCode.length + 1))
          .filter((id) => itemIds.has(id)),
      );
      for (const finding of result.findings) {
        for (const mapping of finding.frameworkMappings) {
          if (mapping.framework !== frameworkCode || !itemIds.has(mapping.entryId)) continue;
          if (mapping.action === 'REMOVE') entryIds.delete(mapping.entryId);
          else entryIds.add(mapping.entryId);
        }
      }
      if (!entryIds.size) {
        unmappedCount += 1;
        const unmappedKey = domains.join('+');
        const entry = unmappedByDomain.get(unmappedKey) ?? {
          label: domains.map((domain) => riskDomainLabel(domain)).join(' / '),
          count: 0,
        };
        entry.count += 1;
        unmappedByDomain.set(unmappedKey, entry);
        continue;
      }
      for (const entryId of entryIds) {
        const key = `${entryId}:${columnId}`;
        const cell = counts.get(key) ?? {
          resultIds: new Set<string>(),
          failIds: new Set<string>(),
          findingIds: new Set<string>(),
        };
        cell.resultIds.add(result.id);
        if (result.finalVerdict === 'FAIL') cell.failIds.add(result.id);
        for (const finding of result.findings) cell.findingIds.add(finding.id);
        counts.set(key, cell);
      }
    }
    const cells = items.flatMap((item) =>
      columns.map((column) => {
        const cell = counts.get(`${item.id}:${column.id}`);
        const testCount = cell?.resultIds.size ?? 0;
        const failCount = cell?.failIds.size ?? 0;
        return {
          entryId: item.id,
          columnId: column.id,
          tested: testCount > 0,
          testCount,
          failCount,
          rate: testCount ? failCount / testCount : null,
          coverage:
            (judgedByColumn.get(column.id)?.size ?? 0) > 0
              ? testCount / judgedByColumn.get(column.id)!.size
              : 0,
          findingIds: [...(cell?.findingIds ?? [])],
        };
      }),
    );
    return {
      framework: query.framework,
      columns,
      items,
      cells,
      unmappedCount,
      unmapped: [...unmappedByDomain.values()].sort((x, y) => y.count - x.count),
      disclaimer: '按平台风险域参考映射聚合，非认证结论',
      limitation: unmappedCount
        ? `未映射结果 ${unmappedCount} 条；分类映射为平台参考，不代表认证结论。`
        : undefined,
    };
  });
}

interface HeatmapItem {
  id: string;
  nameEn: string;
  nameZh: string;
  /** 所属分组（ATLAS 为战术中文名），仅用于界面副标题。 */
  groupZh?: string;
}

function frameworkItems(framework: string): HeatmapItem[] {
  if (framework === 'OWASP_LLM')
    return OWASP_DATA.llm.items.map(({ id, nameEn, nameZh }) => ({ id, nameEn, nameZh }));
  if (framework === 'OWASP_AGENTIC')
    return OWASP_DATA.agentic.items.map(({ id, nameEn, nameZh }) => ({ id, nameEn, nameZh }));
  if (framework === 'GBT45654_ANNEX_A')
    return Object.entries(GBT45654_ANNEX_A_LABELS).map(([id, label]) => ({
      id,
      nameEn: '',
      nameZh: label.replace(/^A\.\d\s*/, ''),
    }));
  const matrix = ATLAS_DATA.matrices[0];
  if (!matrix) return [];
  const tacticById = new Map(matrix.tactics.map(({ id, name }) => [id, atlasTacticZh(id) || name]));
  return matrix.techniques.map(({ id, name, tactics }) => ({
    id,
    nameEn: name,
    nameZh: atlasTechniqueZh(id),
    groupZh:
      tactics
        ?.map((tactic) => tacticById.get(tactic))
        .filter(Boolean)
        .join(' / ') ?? '',
  }));
}
