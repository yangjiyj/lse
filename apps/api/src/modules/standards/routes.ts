import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ANNEX_A_MAJORS,
  BASIS_STATUS_LABELS,
  CLAUSE_CAPABILITY_LABELS,
  EVAL_LINES,
  EVAL_LINE_LABELS,
  LINE_BASES,
  LINE_BASIS_STATEMENT,
  clausesForLine,
  evaluateLine,
  getBasis,
  reportLinesForTask,
  type EvalLine,
  type StandardBasis,
  type StandardClause,
} from '@lse/shared';
import { prisma } from '../../db.js';
import { notFound } from '../../lib/errors.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { buildStandardClauseSnapshot, clauseIdsFromMetadata } from '../reports/standard-clauses.js';
import { selectPrimaryReportResults } from '../reports/report-primary-results.js';

const AUTOMATION_LABELS = { auto: '平台自动判定', semi: '平台取证、人工确认', manual: '人工填报' } as const;
const KIND_LABELS = { risk: '风险类', method: '方法要求', control: '防护措施' } as const;

function basisView(basis: StandardBasis) {
  return {
    id: basis.id,
    code: basis.code ?? null,
    title: basis.title,
    statusLabel: BASIS_STATUS_LABELS[basis.status],
    statusNote: basis.statusNote ?? null,
    issuer: basis.issuer,
  };
}

function basesOf(ids: readonly string[]) {
  return ids
    .map((id) => getBasis(id))
    .filter((b): b is StandardBasis => Boolean(b && b.verified))
    .map(basisView);
}

function clauseView(clause: StandardClause) {
  const basis = getBasis(clause.basisId);
  return {
    id: clause.id,
    basisId: clause.basisId,
    basisName: basis?.code ?? basis?.title ?? clause.basisId,
    ref: clause.ref,
    title: clause.title,
    requirement: clause.requirement,
    kind: clause.kind,
    kindLabel: KIND_LABELS[clause.kind],
    automation: clause.automation,
    automationLabel: AUTOMATION_LABELS[clause.automation],
    capability: clause.capability,
    capabilityLabel: CLAUSE_CAPABILITY_LABELS[clause.capability],
    capabilityNote: clause.capabilityNote ?? null,
    applicability: clause.applicability ?? null,
    sourceRef: clause.sourceRef,
    hasThreshold: Boolean(clause.threshold),
  };
}

/** 只挂已核实依据的条款（依据未核实的条款不对外展示）。 */
function visibleClauses(line: EvalLine): StandardClause[] {
  return clausesForLine(line).filter((c) => getBasis(c.basisId)?.verified);
}

const lineQuery = z.enum(EVAL_LINES as unknown as [EvalLine, ...EvalLine[]]);

export async function standardsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/catalog', { preHandler: [requirePermission('eval_task:read')] }, async () => ({
    lines: EVAL_LINES.map((line) => ({
      line,
      label: EVAL_LINE_LABELS[line],
      basisStatement: LINE_BASIS_STATEMENT[line],
      bases: basesOf([...LINE_BASES[line].primary, ...LINE_BASES[line].supporting]),
      references: basesOf(LINE_BASES[line].reference).map((b) => b.title),
      clauses: visibleClauses(line).map(clauseView),
    })),
  }));

  app.get('/coverage', { preHandler: [requirePermission('eval_task:read')] }, async (request) => {
    const query = z
      .object({
        line: lineQuery.optional(),
        taskId: z.string().uuid().optional(),
        targetId: z.string().uuid().optional(),
        days: z.coerce.number().int().min(1).max(3650).optional(),
      })
      .parse(request.query);
    // 租户隔离由数据库层按当前租户过滤：跨租户的任务或对象在这里查不到，按不存在处理。
    if (query.taskId && !(await prisma.evalTask.findUnique({ where: { id: query.taskId }, select: { id: true } })))
      throw notFound('评估任务不存在');
    if (query.targetId && !(await prisma.modelTarget.findUnique({ where: { id: query.targetId }, select: { id: true } })))
      throw notFound('评估对象不存在');

    const tasks = await prisma.evalTask.findMany({
      where: {
        ...(query.taskId ? { id: query.taskId } : {}),
        ...(query.targetId ? { modelTargetId: query.targetId } : {}),
        ...(query.days ? { createdAt: { gte: new Date(Date.now() - query.days * 86400_000) } } : {}),
      },
      select: {
        id: true,
        engines: true,
        dimensions: true,
        modelTarget: { select: { targetType: true } },
      },
    });
    const linesOfTask = new Map<string, EvalLine[]>(
      tasks.map((t) => [
        t.id,
        reportLinesForTask({
          engines: t.engines,
          dimensions: t.dimensions ?? [],
          endpoint: t.modelTarget?.targetType === 'ENDPOINT_AGENT',
        }),
      ]),
    );
    const wantedLines = query.line ? [query.line] : [...EVAL_LINES];

    type Row = {
      taskId: string;
      finalVerdict: string | null;
      side: string | null;
      controlGroupId: string | null;
      question: { category: string | null; content: string; metadata: unknown };
    };
    const rowsByLine = new Map<EvalLine, Row[]>(wantedLines.map((l) => [l, []]));
    const taskIds = tasks.filter((t) => (linesOfTask.get(t.id) ?? []).some((l) => wantedLines.includes(l))).map((t) => t.id);
    const BATCH = 5000;
    let cursor: string | undefined;
    while (taskIds.length > 0) {
      const page = await prisma.evalResult.findMany({
        where: { taskId: { in: taskIds }, finalVerdict: { in: ['PASS', 'FAIL', 'UNKNOWN', 'ERROR'] } },
        select: {
          id: true,
          taskId: true,
          finalVerdict: true,
          side: true,
          controlGroupId: true,
          question: { select: { category: true, content: true, metadata: true } },
        },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      for (const r of page) {
        for (const line of linesOfTask.get(r.taskId) ?? []) rowsByLine.get(line)?.push(r as Row);
      }
      if (page.length < BATCH) break;
      cursor = page[page.length - 1]!.id;
    }

    const lines = wantedLines.map((line) => {
      const rows = selectPrimaryReportResults(rowsByLine.get(line) ?? []);
      const snapshot = buildStandardClauseSnapshot(
        rows.map((r) => ({
          finalVerdict: r.finalVerdict,
          question: {
            category: r.question.category,
            content: r.question.content,
            clauseIds: clauseIdsFromMetadata(r.question.metadata) ?? null,
          },
        })),
        [line],
      );
      // 带阈值的方法类条款（合格率、拒答率、题库规模）由各评估报告按阈值核算，这里不用计数推算。
      const observations = (snapshot?.observations ?? []).filter(
        (o) => !visibleClauses(line).find((c) => c.id === o.clauseId)?.threshold,
      );
      const visible = new Set(visibleClauses(line).map((c) => c.id));
      const results = evaluateLine(line, observations).filter((r) => visible.has(r.clause.id));
      const validCount = rows.filter((r) => r.finalVerdict === 'PASS' || r.finalVerdict === 'FAIL').length;
      const byVerdict: Record<string, number> = {};
      for (const r of results) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
      return {
        line,
        label: EVAL_LINE_LABELS[line],
        validCount,
        taskCount: tasks.filter((t) => (linesOfTask.get(t.id) ?? []).includes(line)).length,
        summary: { clauses: results.length, byVerdict },
        clauses: results.map((r) => ({
          ...clauseView(r.clause),
          verdict: r.verdict,
          verdictLabel: r.label,
          tested: r.tested,
          failed: r.failed,
          invalid: r.invalid,
          note: r.clause.threshold ? '该条按阈值在评估报告中核算，本页不用题数推算。' : r.note,
        })),
        ...(snapshot?.annexMajors
          ? {
              annexMajors: Object.entries(ANNEX_A_MAJORS).map(([code, name]) => ({
                code,
                name,
                ...(snapshot.annexMajors![code] ?? { tested: 0, failed: 0, invalid: 0 }),
              })),
            }
          : {}),
      };
    });

    return {
      scope: { line: query.line ?? null, taskId: query.taskId ?? null, targetId: query.targetId ?? null, days: query.days ?? null },
      lines,
    };
  });
}
