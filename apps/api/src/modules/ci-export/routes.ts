import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { EVAL_TASKS_READ_SCOPE, requireApiTokenOrUser } from '../../plugins/api-token-auth.js';
import {
  EXPORT_FORMATS,
  FORMAT_META,
  buildJsonExport,
  buildJunit,
  buildSarif,
  safeSummary,
  type CaseVerdict,
  type ExportBundle,
  type ExportCase,
  type ExportFormat,
  type ExportFrameworkRef,
} from './format.js';

const idParams = z.object({ id: z.string().uuid() });
const exportQuery = z.object({ format: z.enum(EXPORT_FORMATS).default('json') });

const SEVERITY_RANK: Record<string, number> = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const MAX_RESULTS = 50_000;

function maxSeverity(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (best === null || (SEVERITY_RANK[v] ?? -1) > (SEVERITY_RANK[best] ?? -1)) best = v;
  }
  return best;
}

function normalizeVerdict(v: string | null | undefined): CaseVerdict {
  return v === 'PASS' || v === 'FAIL' || v === 'ERROR' ? v : 'UNKNOWN';
}

export async function buildExportBundle(taskId: string): Promise<ExportBundle | null> {
  const task = await prisma.evalTask.findUnique({
    where: { id: taskId },
    include: { modelTarget: { select: { name: true } } },
  });
  if (!task) return null;

  const [results, findings, evals] = await Promise.all([
    prisma.evalResult.findMany({
      where: { taskId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_RESULTS,
      // 刻意不取 response：导出不含模型完整回答。
      select: {
        id: true,
        questionId: true,
        finalVerdict: true,
        errorMessage: true,
        latencyMs: true,
        question: { select: { category: true, content: true, severity: true } },
      },
    }),
    prisma.finding.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      take: MAX_RESULTS,
      select: {
        id: true,
        resultId: true,
        questionId: true,
        engine: true,
        riskCategory: true,
        severity: true,
        verdict: true,
        title: true,
        evidence: true,
        frameworkMappings: {
          where: { action: { not: 'REMOVE' } },
          select: { framework: true, entryId: true, entryName: true },
        },
      },
    }),
    prisma.gateEvaluation.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      include: { gate: { select: { name: true } } },
    }),
  ]);

  const resultIds = new Set(results.map((r) => r.id));
  const byResult = new Map<string, typeof findings>();
  const orphans: typeof findings = [];
  for (const f of findings) {
    if (f.resultId && resultIds.has(f.resultId)) {
      const list = byResult.get(f.resultId) ?? [];
      list.push(f);
      byResult.set(f.resultId, list);
    } else {
      orphans.push(f);
    }
  }

  const frameworksOf = (fs: typeof findings): ExportFrameworkRef[] => {
    const seen = new Set<string>();
    const out: ExportFrameworkRef[] = [];
    for (const f of fs)
      for (const m of f.frameworkMappings) {
        const key = `${m.framework}:${m.entryId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ framework: m.framework, entryId: m.entryId, entryName: m.entryName });
      }
    return out;
  };

  const summaryOf = (fs: typeof findings): string =>
    safeSummary(
      fs
        .map((f) => [f.title, f.evidence].filter(Boolean).join('：'))
        .filter(Boolean)
        .join('；'),
    );

  const cases: ExportCase[] = results.map((r) => {
    const fs = byResult.get(r.id) ?? [];
    const failing = fs.filter((f) => f.verdict === 'FAIL');
    const verdict = normalizeVerdict(r.finalVerdict);
    let summary = '';
    if (verdict === 'FAIL')
      summary = summaryOf(failing.length ? failing : fs) || '判定未通过（无证据摘要）';
    else if (verdict === 'ERROR') summary = safeSummary(r.errorMessage) || summaryOf(fs);
    else if (verdict === 'UNKNOWN') summary = summaryOf(fs) || '暂无可用判定结论';
    return {
      resultId: r.id,
      questionId: r.questionId,
      category: r.question?.category || fs[0]?.riskCategory || '未分类',
      title: safeSummary(r.question?.content, 80),
      verdict,
      severity: maxSeverity([...failing.map((f) => f.severity), r.question?.severity]),
      summary,
      engines: [...new Set(fs.map((f) => f.engine))],
      frameworks: frameworksOf(fs),
      latencyMs: r.latencyMs,
    };
  });

  for (const f of orphans) {
    cases.push({
      resultId: f.resultId ?? f.id,
      questionId: f.questionId ?? f.id,
      category: f.riskCategory || '未分类',
      title: safeSummary(f.title, 80),
      verdict: normalizeVerdict(f.verdict),
      severity: f.severity,
      summary: summaryOf([f]),
      engines: [f.engine],
      frameworks: frameworksOf([f]),
      latencyMs: null,
    });
  }

  // 每个门禁只取该任务下最新一次判定。
  const seenGate = new Set<string>();
  const gates = evals
    .filter((e) => {
      if (seenGate.has(e.gateId)) return false;
      seenGate.add(e.gateId);
      return true;
    })
    .map((e) => ({
      gateId: e.gateId,
      gateName: e.gate.name,
      passed: e.passed,
      reasons: Array.isArray(e.reasons) ? e.reasons.map(String) : [],
      metrics: e.metrics ?? null,
      evaluatedAt: e.createdAt.toISOString(),
    }));

  return {
    generatedAt: new Date().toISOString(),
    task: {
      id: task.id,
      name: task.name,
      status: task.status,
      modelTargetName: task.modelTarget?.name ?? null,
      startedAt: task.startedAt?.toISOString() ?? null,
      finishedAt: task.finishedAt?.toISOString() ?? null,
      totalQuestions: task.totalQuestions,
      passedCount: task.passedCount,
      failedCount: task.failedCount,
      errorCount: task.errorCount,
    },
    gates,
    cases,
  };
}

/**
 * 只读导出：挂在 /api/eval-tasks 前缀下，但独立成插件——
 * evalTaskRoutes 全局挂了 JWT authenticate，API 令牌无法通过，故不能并入。
 */
export async function ciExportRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/:id/export',
    { preHandler: [requireApiTokenOrUser(EVAL_TASKS_READ_SCOPE, 'eval_task:read')] },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const parsed = exportQuery.safeParse(request.query);
      if (!parsed.success) throw badRequest('format 仅支持 junit、sarif、json');
      const format: ExportFormat = parsed.data.format;
      const bundle = await buildExportBundle(id);
      if (!bundle) throw notFound('评估任务不存在');

      const user = request.currentUser;
      const token = request.apiToken;
      await writeAudit({
        actorId: token ? null : (user?.id ?? null),
        actorName: token ? `API 令牌：${token.name}` : (user?.username ?? null),
        action: 'eval_task.export',
        targetType: 'eval_task',
        targetId: id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        detail: { format, cases: bundle.cases.length, via: token ? 'api_token' : 'user' },
      });

      const meta = FORMAT_META[format];
      reply.header('Content-Type', meta.contentType);
      reply.header('Content-Disposition', `attachment; filename="lse-${id}.${meta.ext}"`);
      reply.header('Cache-Control', 'no-store');
      if (format === 'junit') return buildJunit(bundle);
      if (format === 'sarif') return JSON.stringify(buildSarif(bundle));
      return JSON.stringify(buildJsonExport(bundle));
    },
  );
}
