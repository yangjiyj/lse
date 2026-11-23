import { Prisma } from '@prisma/client';
import type { DetectJobItem } from '@prisma/client';
import {
  canReadDetectRecord,
  DETECT_JOB_ITEM_META,
  DETECT_RECORD_KIND_LABELS,
  DETECT_RECORD_KINDS,
  isDetectJobItemKind,
  isDetectTaskTerminal,
  type DetectCategory,
  type DetectRecordKind,
  type DetectTaskStatus,
} from '@lse/shared';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import type { CurrentUser } from '../../lib/rbac.js';
import {
  COMBINED_REPORT_KIND,
  createCombinedReport,
  gatherCombinedSnapshot,
  type CombinedRecordSnapshot,
  type CombinedSnapshot,
} from '../reports/combined.js';
import { summarizeDetectRecord } from '../reports/detect-record-summary.js';
import { SEVERITY_ZH } from '../reports/html/derive.js';
import { buildFallbackReportListSummary } from '../reports/report-list-summary.js';
import { redactReportString } from '../reports/report-redaction.js';
import { templateSnapshot } from '../reports/report-template.js';
import { gatherReportData } from '../reports/routes.js';
import { syncItemStatuses } from './orchestrator.js';

// 从组合任务生成综合检测报告（2.4.7）：报告类型沿用组合报告（kind = combined），快照多带 job 和 records。
// 生成时按记录当前状态重筛：仍存在且已完成的评估类子任务（内容评估、终端体检）走组合报告的任务取数；
// 其他子任务、没完成或后来被重评的评估类记录出小结；记录已被删除、没启动、生成人没有读权限的
// 也各占一行写明原因，不计风险。报告里「共 N 项」与表格行数一致。

/** 走组合报告任务取数的子任务类型（它们的检测记录都是评估任务）。 */
const EVAL_ITEM_KINDS = new Set(['eval_task', 'fleet_posture']);

/** 不计风险的占位行：只写状态和原因。 */
function placeholderRecord(
  kind: DetectRecordKind,
  item: DetectJobItem,
  name: string,
  line: string,
): CombinedRecordSnapshot {
  return {
    kind,
    category: DETECT_RECORD_KINDS[kind],
    id: item.recordId ?? item.id,
    name: redactReportString(name),
    status: item.status as DetectTaskStatus,
    finishedAt: item.finishedAt?.toISOString() ?? null,
    riskCount: 0,
    bySeverity: {},
    lines: [line],
    topFindings: [],
  };
}

export async function createDetectJobReport(
  user: CurrentUser,
  jobId: string,
  input: { title?: string; templateId?: string },
  ctx: { ip: string | null; userAgent: string | null },
): Promise<{ id: string; title: string }> {
  const job = await prisma.detectJob.findUnique({ where: { id: jobId } });
  if (!job) throw notFound('组合任务不存在', 'DETECT_JOB_NOT_FOUND');
  const items = await syncItemStatuses(jobId);
  if (!isDetectTaskTerminal(job.status) || !items.some((i) => i.status === 'COMPLETED')) {
    throw conflict('组合任务结束且至少一项完成后才能生成综合报告', 'DETECT_JOB_REPORT_NOT_READY');
  }
  const template = input.templateId
    ? await prisma.reportTemplate.findUnique({ where: { id: input.templateId } })
    : null;
  if (input.templateId && !template) {
    throw notFound('报告模板不存在', 'REPORT_TEMPLATE_NOT_FOUND');
  }

  const canRead = (kind: DetectRecordKind) =>
    canReadDetectRecord(kind, (code) => user.permissions.has(code));
  const kindOf = (i: DetectJobItem): DetectRecordKind | null =>
    i.recordKind && i.recordKind in DETECT_RECORD_KINDS
      ? (i.recordKind as DetectRecordKind)
      : isDetectJobItemKind(i.kind)
        ? DETECT_JOB_ITEM_META[i.kind].recordKind
        : null;
  // 子任务完成后记录可能被删或被重评：按记录当前状态重筛，只把仍存在且已完成的交给组合报告。
  const candidates = items.filter(
    (i) =>
      EVAL_ITEM_KINDS.has(i.kind) &&
      i.status === 'COMPLETED' &&
      i.recordId &&
      canRead(kindOf(i) ?? 'eval_task'),
  );
  const stillCompleted = new Set(
    candidates.length
      ? (
          await prisma.evalTask.findMany({
            where: { id: { in: candidates.map((i) => i.recordId!) }, status: 'COMPLETED' },
            select: { id: true },
          })
        ).map((t) => t.id)
      : [],
  );
  const evalItems = candidates.filter((i) => stillCompleted.has(i.recordId!));
  const taskIds = [...new Set(evalItems.map((i) => i.recordId!))];
  const taskCategories: Record<string, DetectCategory> = {};
  for (const i of evalItems) {
    if (isDetectJobItemKind(i.kind))
      taskCategories[i.recordId!] = DETECT_JOB_ITEM_META[i.kind].category;
  }
  const generatedAt = new Date();
  const base = await gatherCombinedSnapshot(taskIds, generatedAt, {
    loadTaskData: async (taskId) =>
      (
        await prisma.$transaction((tx) => gatherReportData(tx, taskId, generatedAt), {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        })
      ).data,
  });
  const records: CombinedRecordSnapshot[] = [];
  for (const item of items) {
    if (evalItems.includes(item)) continue;
    const kind = kindOf(item);
    if (!kind) continue;
    if (!canRead(kind)) {
      records.push(
        placeholderRecord(
          kind,
          item,
          DETECT_RECORD_KIND_LABELS[kind],
          '无权查看该类检测记录，未计入风险统计',
        ),
      );
      continue;
    }
    if (!item.recordId) {
      const why = item.error ? `未启动（${item.error}）` : '未启动';
      records.push(placeholderRecord(kind, item, item.title, `${why}，未计入风险统计`));
      continue;
    }
    const rec = await summarizeDetectRecord(kind, item.recordId);
    records.push(
      rec ?? placeholderRecord(kind, item, item.title, '检测记录已被删除，未计入风险统计'),
    );
  }
  // 「共 N 项」按报告里的行数算：组合报告的任务行 + 其他检测项行。
  const rowCount = base.tasks.length + records.length;

  const recordRisks = records.reduce((s, r) => s + r.riskCount, 0);
  const total = base.totals.findingCount + recordRisks;
  const severity = new Map<string, number>();
  for (const [k, n] of Object.entries(base.riskDistribution.bySeverity)) severity.set(k, n);
  for (const r of records) {
    for (const [k, n] of Object.entries(r.bySeverity)) severity.set(k, (severity.get(k) ?? 0) + n);
  }
  const severityText = [...severity.entries()]
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${SEVERITY_ZH[k as keyof typeof SEVERITY_ZH] ?? '未定级'} ${n} 项`)
    .join('、');
  const snapshot: CombinedSnapshot & { reportTemplate?: unknown } = {
    ...base,
    headline: `组合任务「${redactReportString(job.name)}」共 ${rowCount} 项检测，${total > 0 ? `发现风险 ${total} 项（${severityText}）` : '未发现风险'}`,
    job: {
      id: job.id,
      name: redactReportString(job.name),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      itemCount: rowCount,
      taskCategories,
    },
    records,
    ...(template ? { reportTemplate: templateSnapshot(template) } : {}),
  };

  const title = redactReportString(input.title?.trim() || `${job.name} 综合检测报告`).slice(0, 200);
  const listSummary = {
    ...buildFallbackReportListSummary({
      kind: COMBINED_REPORT_KIND,
      totalQuestions: base.totals.totalQuestions,
      riskDistribution: base.riskDistribution,
    }),
    processedQuestions: base.totals.totalQuestions,
    passedCount: base.totals.passedCount,
    failedCount: base.totals.failedCount,
    errorCount: base.totals.errorCount,
    headline: snapshot.headline,
    metrics: { taskCount: base.tasks.length, detectItemCount: rowCount },
  };
  const report = await createCombinedReport({
    title,
    snapshot,
    listSummary: listSummary as unknown as Prisma.InputJsonValue,
    generatedById: user.id,
  });
  await writeAudit({
    actorId: user.id,
    actorName: user.username,
    action: 'report.generate',
    targetType: 'report',
    targetId: report.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    detail: {
      kind: COMBINED_REPORT_KIND,
      detectJobId: job.id,
      taskIds,
      recordCount: records.length,
      ...(template ? { templateId: template.id } : {}),
    },
  });
  return { id: report.id, title: report.title };
}
