import { loadEndpointSummary } from '../eval-tasks/endpoint-summary-data.js';
import { isPlatformConnector } from '../../lib/platform-connector-access.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { toReportRagSection } from './rag-section.js';
import { Prisma, Severity, type ModelTarget, type Report } from '@prisma/client';
import { z } from 'zod';
import { RISK_DOMAIN, reportGradeForValidCount, reportLinesForTask, type LlmTargetConfig, type Paginated } from '@lse/shared';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { standardReportEvidence } from '../standard-evaluations/task-evidence.js';
import type { CurrentUser } from '../../lib/rbac.js';
import { applyTenantFilter } from '../../lib/all-tenants.js';
import { writeAudit } from '../../lib/audit.js';
import { applyHtmlWatermark, resolveDownloadWatermark } from '../../lib/data-security.js';
import {
  portfolioRiskToWrongAnswer,
  type ReportExplanationMode,
  type ReportInputData,
  type ReportContrastView,
  type ReportResultExplanation,
  type BuiltReport,
  type BuiltReportSummary,
  type BuiltReportRiskDistribution,
} from './report-builder.js';
import { config } from '../../config.js';
import { buildReportRiskContext } from './report-risk-context.js';
import { attachmentDisposition } from '../../lib/attachment.js';
import {
  buildReportDownloadFilename,
  buildReportPdfDoc,
  renderReportPdf,
} from './pdf.js';
import { buildReportHtmlModel, reportIdentifierForDelivery } from './html/model.js';
import { REPORT_OPTIONAL_SECTIONS } from './labels.js';
import {
  REPORT_EXPORT_PROFILES,
  resolveReportExportOptions,
  withNewDefaultSections,
} from './export-options.js';
import { attachFrameworkCoverage } from './framework-coverage-attach.js';
import { withLazyRiskDomainTested } from './risk-domain-tested.js';
import { clauseIdsFromMetadata, withLazyStandardClauses } from './standard-clauses.js';
import { renderReportHtmlString } from './html/render.js';
import { renderReportDocx } from './docx/report-docx.js';
import { DOCX_CONTENT_TYPE } from './docx/docx-kit.js';
import {
  COMBINED_REPORT_KIND,
  combinedBody,
  createCombinedReport,
  gatherCombinedSnapshot,
  loadCombinedTaskViews,
  parseCombinedSnapshot,
  type CombinedTaskView,
} from './combined.js';
import { buildCombinedPdfDoc, buildCombinedView, renderCombinedHtml } from './combined-render.js';
import { renderCombinedDocx } from './docx/combined-docx.js';
import {
  resolveReportTemplate,
  templateRenderOptions,
  templateSnapshot,
} from './report-template.js';
import {
  GBT_REPORT_TITLE,
  buildGbtReport,
  loadGbtReportInput,
  renderGbtReportHtml,
} from './specialized/gbt45654-content.js';
import { isGbtMethodsPlan } from '../standard-evaluations/gbt45654/pipeline.js';

const GBT_REPORT_KIND = 'gbt45654_content';

/**
 * 国标报告的冻结摘要：列表与详情标题显示按 GB/T 45654 判定的结论（不符合 / 尚未完成 / 符合）、
 * 不符合与待完成条数、报告等级和各方法结论，不含通用报告的图表快照。
 */
function buildGbtStoredSummary(model: ReturnType<typeof buildGbtReport>, totalQuestions: number) {
  const gradeLabel = model.grade === 'formal' ? '正式' : '预评估';
  const verdict = model.view.verdict;
  const verdictLabel = verdict.word;
  return {
    kind: GBT_REPORT_KIND,
    headline: `${verdictLabel}（不符合 ${verdict.counts.nonconform} 条${verdict.counts.pending > 0 ? ` · 待完成 ${verdict.counts.pending} 条` : ''} · ${gradeLabel}）`,
    metrics: {
      grade: model.grade,
      gradeLabel,
      overallLabel: verdictLabel,
      validCount: model.validCount,
      ...Object.fromEntries(model.methods.map((m) => [`method_${m.id}`, `${m.label}：${m.verdictLabel}`])),
    } as Record<string, number | string | null>,
    grade: model.grade,
    gradeLabel,
    overall: { conclusion: verdict.status, label: verdictLabel },
    clauseCounts: verdict.counts,
    validCount: model.validCount,
    methods: model.methods,
    totalQuestions,
  };
}
import { buildProtectionStrategySection } from '../policy-suggestions/report-section.js';
import { renderHtmlToPdf } from './html/chromium.js';
import { renderReportDownload } from './report-renderer.js';
import { REPORT_KIND_LABELS } from './specialized/types.js';
import { buildReportTrend, REPORT_TREND_SELECT, type TrendReportInput } from './trend.js';
import { REPORT_KINDS, buildSpecializedReport } from './specialized/index.js';
import {
  buildLocalEvalResultExplanation,
  explainEvalResult,
  type EvalResultExplanationInput,
} from '../eval-tasks/result-explainer.js';
import {
  buildLocalReportJudgment,
  generateReportJudgment,
  type ReportAiJudgment,
} from './report-judge.js';
import { executeReportGenerationPlan } from './report-generation-plan.js';
import { gatherServiceAssuranceReportData } from './service-assurance-data.js';
import { assertTaskAccess } from '../service-assurance/task-access.js';
import {
  redactReportInputData,
  redactReportJson,
  redactReportSnapshot,
  redactReportString,
} from './report-redaction.js';
import {
  assertReportConclusionSnapshotsMatch,
  buildFallbackReportListSummary,
  buildReportListSummary,
  normalizeStoredReportSummary,
  parseReportListSummary,
  REPORT_LIST_SELECT,
} from './report-list-summary.js';
import { mcpExecutionStatus } from './reachability.js';
export { normalizeStoredReportSummary } from './report-list-summary.js';

export const REPORT_LEGACY_SNAPSHOT_INCOMPLETE = 'REPORT_LEGACY_SNAPSHOT_INCOMPLETE' as const;

const listQuery = z.object({
  taskId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
  kind: z.enum([...REPORT_KINDS, COMBINED_REPORT_KIND]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

const createBody = z.object({
  taskId: z.string().uuid(),
  // 报告模板（2.4.7）：生成时把模板内容快照进报告，下载不另选模板时按它渲染。
  templateId: z.string().uuid().optional(),
  kind: z.enum(REPORT_KINDS).default('comprehensive'),
  title: z.string().trim().min(1).max(200).optional(),
  explanationMode: z.enum(['local', 'self', 'review_model']).default('local'),
  explanationModelTargetId: z.string().uuid().optional(),
  // 生成时选定的可选章节范围（缺省=全部）。
  sections: z.array(z.enum(REPORT_OPTIONAL_SECTIONS)).optional(),
  applicationContext: z
    .object({
      businessScenario: z.string().trim().max(500).optional(),
      deploymentMode: z
        .enum(['third_party_api', 'self_hosted_open_weights', 'self_trained', 'unknown'])
        .optional(),
      controlScope: z.string().trim().max(500).optional(),
    })
    .optional(),
});

const idParams = z.object({ id: z.string().uuid() });
const commaList = (inner: z.ZodTypeAny) =>
  z
    .preprocess(
      (v) =>
        typeof v === 'string'
          ? v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : v,
      inner,
    )
    .optional();
// 下载时按严重等级筛选"风险项明细"，并按章节筛选导出内容（逗号分隔，缺省=按报告生成时范围/全量）。
const severityListParam = commaList(z.array(z.nativeEnum(Severity)));
const sectionListParam = commaList(z.array(z.enum(REPORT_OPTIONAL_SECTIONS)));
const riskDomainListParam = commaList(z.array(z.enum(RISK_DOMAIN)));
/** 报告下载的 ASCII 兜底文件名（中文名放在 filename*）。 */
const REPORT_FALLBACK_PDF = 'llm-safety-report.pdf';
const REPORT_FALLBACK_HTML = 'llm-safety-report.html';
const REPORT_FALLBACK_DOCX = 'llm-safety-report.docx';

const downloadQuery = z.object({
  format: z.enum(['pdf', 'html', 'docx']).default('pdf'),
  profile: z.enum(REPORT_EXPORT_PROFILES).optional(),
  severity: severityListParam,
  riskDomain: riskDomainListParam,
  sections: sectionListParam,
  templateId: z.string().uuid().optional(),
});
const trendQuery = z.object({
  modelTargetId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function serializeDetail(r: Report) {
  const listSummary = parseReportListSummary(r.listSummary, {
    kind: r.kind,
    totalQuestions: r.totalQuestions,
    riskDistribution: r.riskDistribution,
  });
  if (r.kind === GBT_REPORT_KIND) {
    // 国标报告正文是完整 HTML，不走通用快照校验与历史报告包装。
    return {
      id: r.id,
      taskId: r.taskId,
      tenantId: r.tenantId ?? null,
      title: redactReportString(r.title),
      format: r.format,
      kind: r.kind,
      content: r.content,
      summary: { ...(isRecord(r.summary) ? r.summary : {}), kind: r.kind },
      passRate: null,
      totalQuestions: r.totalQuestions ?? 0,
      riskDistribution: null,
      generatedById: r.generatedById,
      createdAt: r.createdAt,
    };
  }
  const summary = normalizeStoredReportSummary(r.summary, r.kind, listSummary);
  const storedContent = redactReportString(r.content);
  const content =
    summary.conclusionSnapshot?.source === 'LEGACY_FALLBACK'
      ? [
          '# 历史报告（结论不可验证）',
          '',
          '> 该报告未保存统一结论快照。以下历史原文仅供追溯，不构成当前评估结论；如需对外使用，请重新生成报告。',
          '',
          '---',
          '',
          storedContent,
        ].join('\n')
      : storedContent;
  return {
    id: r.id,
    taskId: r.taskId,
    tenantId: r.tenantId ?? null,
    title: redactReportString(r.title),
    format: r.format,
    kind: r.kind,
    content,
    summary,
    passRate: summary.conclusionSnapshot?.passRate ?? null,
    totalQuestions: summary.totalQuestions ?? r.totalQuestions,
    riskDistribution: redactReportSnapshot(r.riskDistribution),
    generatedById: r.generatedById,
    createdAt: r.createdAt,
  };
}

function isRenderableReportSummary(summary: BuiltReportSummary): boolean {
  const charts = summary.charts;
  return Boolean(
    summary.conclusionSnapshot?.source === 'DETERMINISTIC_RULE' &&
    isRecord(charts) &&
    Array.isArray(charts.severity) &&
    Array.isArray(charts.verdict) &&
    Array.isArray(charts.riskCategory) &&
    Array.isArray(charts.riskDomain) &&
    Array.isArray(charts.engineStatus) &&
    Array.isArray(charts.engineRuns) &&
    (charts.passRatePercent === null ||
      (typeof charts.passRatePercent === 'number' && Number.isFinite(charts.passRatePercent))) &&
    Array.isArray(summary.findingSamples) &&
    Array.isArray(summary.wrongAnswerSamples) &&
    Array.isArray(summary.riskItemsBySeverity) &&
    Array.isArray(summary.remediationItems) &&
    isRecord(summary.securityScore),
  );
}

type ReportListRow = Prisma.ReportGetPayload<{ select: typeof REPORT_LIST_SELECT }>;

function serializeListItem(r: ReportListRow) {
  const summary = parseReportListSummary(r.listSummary, {
    kind: r.kind,
    totalQuestions: r.totalQuestions,
    riskDistribution: r.riskDistribution,
  });
  const taskCount = summary.metrics?.taskCount;
  // 从组合任务生成的综合检测报告：列表标签「综合检测 · N 项」（N 为组合任务的子任务数）。
  const detectItemCount = (summary.metrics as { detectItemCount?: unknown } | undefined)
    ?.detectItemCount;
  return {
    ...(r.kind === COMBINED_REPORT_KIND && typeof taskCount === 'number' ? { taskCount } : {}),
    ...(r.kind === COMBINED_REPORT_KIND && typeof detectItemCount === 'number'
      ? { detectItemCount, label: `综合检测 · ${detectItemCount} 项` }
      : {}),
    id: r.id,
    taskId: r.taskId,
    tenantId: r.tenantId ?? null,
    title: redactReportString(r.title),
    format: r.format,
    kind: r.kind,
    summary,
    passRate: summary.conclusionSnapshot.passRate,
    totalQuestions: summary.totalQuestions,
    riskDistribution: redactReportSnapshot(r.riskDistribution),
    generatedById: r.generatedById,
    createdAt: r.createdAt,
  };
}

/** 组合报告详情：冻结快照 + 任务清单（已删除的任务标 deleted）。 */
function serializeCombinedDetail(r: Report, tasks: CombinedTaskView[]) {
  const snapshot = parseCombinedSnapshot(r.summary);
  return {
    id: r.id,
    taskId: null,
    tenantId: r.tenantId ?? null,
    title: redactReportString(r.title),
    format: r.format,
    kind: r.kind,
    content: redactReportString(r.content),
    summary: { ...(snapshot ?? {}), kind: r.kind },
    passRate: null,
    totalQuestions: r.totalQuestions ?? 0,
    riskDistribution: redactReportSnapshot(r.riskDistribution),
    generatedById: r.generatedById,
    createdAt: r.createdAt,
    tasks,
  };
}

/** 单任务报告所属的评估任务；组合报告不挂单个任务，不走单任务的处理。 */
function reportTaskId(report: Pick<Report, 'taskId'>): string {
  if (!report.taskId) throw notFound('报告不存在');
  return report.taskId;
}

export interface ContrastRow {
  controlGroupId: string | null;
  side: string | null;
  finalVerdict: string | null;
  questionId: string;
}

/**
 * 红队 A/B 对照视图：按 controlGroupId 把同一对照对的 A/B 两行配成一对，
 * 统计「网关挡下」（A 破 B 未破：A=FAIL,B=PASS）与「绕过」（A 破 B 也破：A=FAIL,B=FAIL）。
 * 纯函数；普通评测行（无 controlGroupId 或 side 非 A/B）一律忽略。
 */
export function buildContrastView(rows: ContrastRow[]): ReportContrastView {
  const groups = new Map<string, { A?: string | null; B?: string | null }>();
  for (const r of rows) {
    if (!r.controlGroupId || (r.side !== 'A' && r.side !== 'B')) continue;
    const g = groups.get(r.controlGroupId) ?? {};
    g[r.side as 'A' | 'B'] = r.finalVerdict;
    groups.set(r.controlGroupId, g);
  }
  const pairs = [...groups.entries()].map(([id, g]) => ({
    controlGroupId: id,
    sideA: g.A ?? null,
    sideB: g.B ?? null,
  }));
  const blockedByGateway = pairs.filter((p) => p.sideA === 'FAIL' && p.sideB === 'PASS').length;
  const bypassedGateway = pairs.filter((p) => p.sideA === 'FAIL' && p.sideB === 'FAIL').length;
  return {
    pairs,
    blockedByGateway,
    bypassedGateway,
    note: '对比数字为本次实测；若样本不足请在报告标注「示意」。',
  };
}

interface GatheredReportData {
  data: ReportInputData;
  evaluatedTargetId: string;
  evaluatedTarget: ModelTarget;
}

export function reportVisibilityWhere(currentUser: CurrentUser): Prisma.ReportWhereInput {
  if (isPlatformConnector(currentUser)) return { task: { createdById: currentUser.id } };
  if (currentUser.isBuiltin) return {};
  const visibleServiceTasks = currentUser.permissions.has('service_assurance:read')
    ? { OR: [{ createdById: currentUser.id }, { createdById: null }] }
    : { id: { equals: '__service_report_hidden__' } };
  return {
    OR: [
      { kind: { not: 'service_assurance' } },
      { kind: 'service_assurance', task: visibleServiceTasks },
    ],
  };
}

function targetSnapshot(target: Pick<ModelTarget, 'name' | 'provider' | 'model'>) {
  return {
    displayName: target.name,
    provider: target.provider,
    model: target.model,
  };
}

function redTeamTargetConfig(metadata: unknown): {
  mode: 'protected_compare' | 'single_model';
  gatewayTargetId: string | null;
} | null {
  if (!isRecord(metadata) || metadata.kind !== 'red_team' || !isRecord(metadata.redteam)) {
    return null;
  }
  const mode = metadata.redteam.mode;
  const gatewayTargetId = metadata.redteam.gatewayTargetId;
  if (mode === 'protected_compare' && typeof gatewayTargetId === 'string' && gatewayTargetId) {
    return { mode, gatewayTargetId };
  }
  if (mode === 'single_model') return { mode, gatewayTargetId: null };
  return null;
}

/**
 * 从题目 metadata 取「客户可读标题」。
 *
 * 智能体样本的 Question.content 开头是引擎规格（角色/工具边界/业务指令），
 * 报告表格直接印 content 会让客户读到一堆内部术语。metadata.displayTitle 是
 * 生成器另存的一句话业务描述，报告优先用它。只取这一个字段，不下发整段 metadata。
 */
function reportQuestionDisplayTitle(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).displayTitle;
  return typeof value === 'string' && value.trim() ? value : null;
}

/** 只读取任务、结果与证据并组装快照；不执行评估、不调用模型、不写数据库。 */
export async function gatherReportData(
  db: Prisma.TransactionClient,
  taskId: string,
  generatedAt: Date,
): Promise<GatheredReportData> {
  const task = await db.evalTask.findUnique({
    where: { id: taskId },
    include: {
      modelTarget: true,
      standardRun: { select: { id: true, bankReleaseId: true } },
      questionSets: {
        include: {
          questionSet: {
            select: {
              id: true,
              name: true,
              type: true,
              language: true,
              source: true,
              tags: true,
              _count: { select: { questions: true } },
              questions: { select: { metadata: true }, take: 1 },
            },
          },
        },
      },
    },
  });
  if (!task) throw notFound('评估任务不存在');

  // 国标专项的样本证据在 standard_* 表里；用它替换 eval_results 和 findings，
  // 否则结论快照会把一次跑完的评估读成"观察到 0 条"，安全不合格项也无风险证据可依。
  const standardEvidence = task.standardRun ? await standardReportEvidence(db, taskId) : null;

  const grouped = await db.evalResult.groupBy({
    by: ['finalVerdict'],
    where: { taskId },
    _count: { _all: true },
  });
  const verdictCounts: Record<string, number> = {};
  if (standardEvidence) {
    for (const row of standardEvidence.results) {
      if (row.finalVerdict)
        verdictCounts[row.finalVerdict] = (verdictCounts[row.finalVerdict] ?? 0) + 1;
    }
  } else {
    for (const g of grouped) {
      if (g.finalVerdict) verdictCounts[g.finalVerdict] = g._count._all;
    }
  }

  const [findings, engineRuns, wrongAnswers, results, contrastRows] = await Promise.all([
    db.finding.findMany({
      where: { taskId },
      orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
    }),
    db.engineRun.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } }),
    db.wrongAnswer.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } }),
    db.evalResult.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      include: {
        question: {
          select: {
            content: true,
            questionSetId: true,
            type: true,
            shouldRefuse: true,
            language: true,
            severity: true,
            category: true,
            metadata: true,
          },
        },
        engineRuns: {
          select: {
            engine: true,
            status: true,
            skippedCount: true,
            errorMessage: true,
            requestPayload: true,
            rawOutput: true,
          },
        },
      },
    }),
    db.evalResult.findMany({
      where: { taskId },
      select: { controlGroupId: true, side: true, finalVerdict: true, questionId: true },
    }),
  ]);

  // 红队任务（存在 side 非空行）才附加 A/B 对照视图；普通评测任务保持原结构不变。
  const isRedTeam = contrastRows.some((r) => r.side !== null);
  const contrast = isRedTeam ? buildContrastView(contrastRows) : undefined;

  const redTeamConfig = task.questionSets
    .map((link) => redTeamTargetConfig(link.questionSet.questions[0]?.metadata))
    .find((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
  const declaredRedTeam = task.dimensions.includes('redteam_attack') || isRedTeam;
  let evaluatedTarget = task.modelTarget;
  let assessmentTarget:
    | {
        schemaVersion: 1;
        mode: 'STANDARD' | 'RED_TEAM_SINGLE' | 'RED_TEAM_PROTECTED';
        basis: 'REPORT_GENERATION_LOOKUP';
        evaluatedTarget: ReturnType<typeof targetSnapshot>;
        baselineTarget?: ReturnType<typeof targetSnapshot>;
      }
    | undefined;

  if (declaredRedTeam) {
    if (!redTeamConfig) {
      throw badRequest(
        '红队任务缺少冻结的对照对象配置，不能生成正式报告',
        'REPORT_EVALUATED_TARGET_UNRESOLVED',
      );
    }
    const sideAIds = new Set(
      results.flatMap((result) => (result.side === 'A' ? [result.modelTargetId] : [])),
    );
    const sideBIds = new Set(
      results.flatMap((result) => (result.side === 'B' ? [result.modelTargetId] : [])),
    );
    if ([...sideAIds].some((id) => id !== task.modelTarget.id)) {
      throw badRequest(
        '红队基线侧结果与任务基线对象不一致，无法生成正式报告',
        'REPORT_EVALUATED_TARGET_UNRESOLVED',
      );
    }
    if (redTeamConfig.mode === 'protected_compare') {
      if (redTeamConfig.gatewayTargetId === task.modelTarget.id) {
        throw badRequest(
          '红队对照对象不能与基线对象相同',
          'RED_TEAM_COMPARISON_TARGET_MUST_DIFFER',
        );
      }
      const protectedTarget = await db.modelTarget.findUnique({
        where: { id: redTeamConfig.gatewayTargetId! },
      });
      if (!protectedTarget || [...sideBIds].some((id) => id !== protectedTarget.id)) {
        throw badRequest(
          '红队 B 侧对象无法解析或与冻结配置不一致，不能生成正式报告',
          'REPORT_EVALUATED_TARGET_UNRESOLVED',
        );
      }
      evaluatedTarget = protectedTarget;
      assessmentTarget = {
        schemaVersion: 1,
        mode: 'RED_TEAM_PROTECTED',
        basis: 'REPORT_GENERATION_LOOKUP',
        evaluatedTarget: targetSnapshot(protectedTarget),
        baselineTarget: targetSnapshot(task.modelTarget),
      };
    } else {
      if (sideBIds.size > 0) {
        throw badRequest(
          '单模型红队任务不应包含 B 侧结果，不能生成正式报告',
          'REPORT_EVALUATED_TARGET_UNRESOLVED',
        );
      }
      assessmentTarget = {
        schemaVersion: 1,
        mode: 'RED_TEAM_SINGLE',
        basis: 'REPORT_GENERATION_LOOKUP',
        evaluatedTarget: targetSnapshot(task.modelTarget),
      };
    }
  } else {
    assessmentTarget = {
      schemaVersion: 1,
      mode: 'STANDARD',
      basis: 'REPORT_GENERATION_LOOKUP',
      evaluatedTarget: targetSnapshot(task.modelTarget),
    };
  }

  // RAG 专项评估：只取已冻结的运行摘要与清理结果，不含被测接入配置或凭据。
  const ragSections = task.engines.includes('rag-eval')
    ? (
        await db.ragEvalRun.findMany({
          where: { taskId },
          orderBy: { createdAt: 'asc' },
          select: {
            alignmentMode: true,
            alignmentConfirmedByName: true,
            packageImported: true,
            summary: true,
            cleanup: true,
            testSet: { select: { name: true } },
          },
        })
      ).map(toReportRagSection)
    : [];

  return {
    evaluatedTargetId: evaluatedTarget.id,
    evaluatedTarget,
    data: redactReportInputData({
      ...(task.modelTarget.targetType === 'ENDPOINT_AGENT' ||
      task.engines.includes('endpoint-agent-eval')
        ? { endpointSummary: await loadEndpointSummary(db, taskId) }
        : {}),
      task: {
        id: task.id,
        name: task.name,
        description: task.description,
        status: task.status,
        concurrency: task.concurrency,
        engines: task.engines,
        // 终端测评按场景结果判定覆盖（未回传的场景记为无法判定），不写引擎运行记录，不计入期望引擎。
        expectedEngines: (task.dimensions.includes('comprehensive')
          ? [
              ...new Set([
                ...task.engines,
                ...(task.dimensions.includes('redteam_attack') ? [RED_TEAM_ENGINE] : []),
              ]),
            ]
          : task.dimensions.includes('redteam_attack')
            ? [RED_TEAM_ENGINE]
            : task.engines
        ).filter((engine) => engine !== 'endpoint-agent-eval'),
        dimensions: task.dimensions,
        totalQuestions: task.totalQuestions,
        processedQuestions: task.processedQuestions,
        passedCount: task.passedCount,
        failedCount: task.failedCount,
        errorCount: task.errorCount,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        modelTarget: {
          name: evaluatedTarget.name,
          targetType: evaluatedTarget.targetType,
          provider: evaluatedTarget.provider,
          model: evaluatedTarget.model,
        },
        assessmentTarget,
        questionSets: task.questionSets.map((link) => ({
          id: link.questionSet.id,
          name: link.questionSet.name,
          type: link.questionSet.type,
          language: link.questionSet.language,
          source: link.questionSet.source,
          tags: link.questionSet.tags,
          questionCount: link.questionSet._count.questions,
        })),
      },
      verdictCounts,
      findings:
        standardEvidence?.findings ??
        findings.map((f) => ({
          resultId: f.resultId,
          stableId: f.id,
          engine: f.engine,
          riskCategory: f.riskCategory,
          severity: f.severity,
          verdict: f.verdict,
          score: f.score,
          confidence: f.confidence,
          evidenceStrength: f.evidenceStrength,
          executionOutcome: f.executionOutcome,
          reviewStatus: f.reviewStatus,
          reviewReason: f.reviewReason,
          remediationStatus: f.remediationStatus,
          remediationOwner: f.remediationOwner,
          remediationTeam: f.remediationTeam,
          remediationLocation: f.remediationLocation,
          remediationAction: f.remediationAction,
          remediationDueAt: f.remediationDueAt,
          remediationRecord: f.remediationRecord,
          remediationAcceptanceCriteria: f.remediationAcceptanceCriteria,
          remediationRetestTaskId: f.remediationRetestTaskId,
          remediationClosureEvidence: f.remediationClosureEvidence,
          remediationClosedAt: f.remediationClosedAt,
          suppressionKey: f.suppressionKey,
          evidence: f.evidence,
          title: f.title,
          detail: f.detail,
        })),
      engineRuns: engineRuns.map((e) => ({
        resultId: e.resultId,
        engine: e.engine,
        status: e.status,
        rawOutput: e.rawOutput,
        normalizedCount: e.normalizedCount,
        skippedCount: e.skippedCount,
        durationMs: e.durationMs,
        errorMessage: e.errorMessage,
      })),
      wrongAnswers: wrongAnswers.map((w) => ({
        resultId: w.resultId,
        questionContent: w.questionContent,
        modelResponse: w.modelResponse,
        riskCategory: w.riskCategory,
        severity: w.severity,
        engine: w.engine,
        reason: w.reason,
      })),
      results:
        standardEvidence?.results ??
        results.map((r) => ({
          id: r.id,
          prompt: r.prompt,
          response: r.response,
          controlGroupId: r.controlGroupId,
          side: r.side,
          finalVerdict: r.finalVerdict,
          status: r.status,
          errorMessage: r.errorMessage,
          engineRuns: r.engineRuns.map((e) => ({
            status: e.status,
            skippedCount: e.skippedCount,
            errorMessage: e.errorMessage,
            executionStatus: mcpExecutionStatus(e.rawOutput),
          })),
          question: {
            questionSetId: r.question.questionSetId,
            content: r.question.content,
            type: r.question.type,
            shouldRefuse: r.question.shouldRefuse,
            language: r.question.language,
            severity: r.question.severity,
            category: r.question.category,
            displayTitle: reportQuestionDisplayTitle(r.question.metadata),
            clauseIds: clauseIdsFromMetadata(r.question.metadata) ?? null,
          },
          redTeamTrace: parseRedTeamTraceFromRuns(r.engineRuns, r.side),
        })),
      generatedAt,
      contrast,
      ...(ragSections.length ? { rag: ragSections } : {}),
    }),
  };
}

/** 将持久化报告行还原为 BuiltReport（供 PDF 渲染），只使用生成时冻结数据。 */
export async function toBuiltReport(report: Report): Promise<BuiltReport> {
  const listSummary = parseReportListSummary(report.listSummary, {
    kind: report.kind,
    totalQuestions: report.totalQuestions,
    riskDistribution: report.riskDistribution,
  });
  const summary = normalizeStoredReportSummary(report.summary, report.kind, listSummary);
  if (
    listSummary.conclusionSnapshot.source === 'DETERMINISTIC_RULE' &&
    isRenderableReportSummary(summary)
  ) {
    const riskDistribution = (redactReportSnapshot(
      report.riskDistribution,
    ) as BuiltReportRiskDistribution | null) ?? {
      bySeverity: {},
      byRiskCategory: {},
      byRiskDomain: {},
    };
    return {
      title: redactReportString(report.title),
      format: 'markdown',
      content: redactReportString(report.content),
      summary,
      passRate: summary.conclusionSnapshot?.passRate ?? null,
      totalQuestions: summary.totalQuestions ?? report.totalQuestions ?? 0,
      riskDistribution,
    };
  }
  throw badRequest(
    '历史报告缺少完整渲染快照，无法可靠下载；请重新生成报告。',
    REPORT_LEGACY_SNAPSHOT_INCOMPLETE,
    { reportId: report.id },
  );
}

const REPORT_EXPLANATION_LIMIT = 6;
const REPORT_EXPLANATION_CONCURRENCY = 2;
const REPORT_EXPLANATION_TIMEOUT_MS = 30_000;

const REPORT_EXPLANATION_LABELS: Record<ReportExplanationMode, string> = {
  local: '规则依据分析',
  self: '评估对象辅助分析',
  review_model: '独立模型复核分析',
};

const RED_TEAM_ENGINE = 'autonomous-red-team';
const RED_TEAM_TRACE_LIMIT = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => (typeof item === 'string' && item.trim() ? [item.trim()] : []))
    : [];
}

function parseRawOutput(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function fallbackRedTeamAttackerMessage(item: Record<string, unknown>): string {
  const phase = optionalString(item.phaseLabel);
  const move = optionalString(item.move);
  const context = phase || move ? `阶段：${phase ?? move}。` : '';
  return `攻击模型本轮未生成有效对抗内容。${context}系统已保留评估对象响应；建议重新发起任务以获取完整对抗证据。`;
}

const storedWordingSignals = z.object({
  source: z.literal('lexical'),
  version: z.literal(1),
  refusal: z.boolean(),
  qualification: z.boolean(),
  continuation: z.boolean(),
  empty: z.boolean(),
});
const storedRoundJudgment = z
  .object({
    source: z.enum(['judge', 'not_evaluated']),
    verdict: z.enum(['PASS', 'FAIL', 'UNKNOWN', 'ERROR']),
    engine: z.string().optional(),
  })
  .refine((value) => value.source === 'judge' || value.verdict === 'UNKNOWN');

export function parseRedTeamTraceFromRuns(
  runs: Array<{
    engine: string;
    requestPayload: Prisma.JsonValue | null;
    rawOutput: string | null;
  }>,
  side: string | null,
) {
  const run = runs.find((item) => item.engine === RED_TEAM_ENGINE);
  if (!run) return null;
  const payload = isRecord(run.requestPayload) ? run.requestPayload : {};
  const raw = parseRawOutput(run.rawOutput) ?? {};
  const playbook = isRecord(raw.playbook) ? raw.playbook : {};
  const transcript = Array.isArray(raw.transcript) ? raw.transcript : [];
  const replayMessages = Array.isArray(raw.replayMessages) ? raw.replayMessages : [];
  return {
    side: optionalString(payload.side) ?? side,
    headName: optionalString(payload.headName),
    playbookVariant: optionalString(
      payload.playbookVariant ?? raw.playbookVariant ?? playbook.variant,
    ),
    playbookLabel: optionalString(payload.playbookLabel ?? raw.playbookLabel ?? playbook.label),
    rounds: optionalNumber(payload.rounds) ?? null,
    stopReason: optionalString(payload.stopReason),
    movesUsed: optionalStringArray(payload.movesUsed),
    transcript: transcript.slice(0, RED_TEAM_TRACE_LIMIT).flatMap((item) => {
      if (!isRecord(item)) return [];
      return [
        {
          index: optionalNumber(item.index) ?? null,
          move: optionalString(item.move) ?? '—',
          attackerMessage:
            optionalString(item.attackerMessage) ?? fallbackRedTeamAttackerMessage(item),
          modelResponse: optionalString(item.modelResponse) ?? '—',
          conversationId: optionalString(item.conversationId),
          attitude: optionalString(item.attitude) ?? '—',
          wordingSignals: storedWordingSignals.safeParse(item.wordingSignals).data,
          roundJudgment: storedRoundJudgment.safeParse(item.roundJudgment).data,
          phaseId: optionalString(item.phaseId),
          phaseLabel: optionalString(item.phaseLabel),
          rationale: optionalString(item.rationale),
          successSignal: optionalString(item.successSignal),
        },
      ];
    }),
    replayMessages: replayMessages.slice(0, RED_TEAM_TRACE_LIMIT * 2).flatMap((item) => {
      if (!isRecord(item)) return [];
      const role = optionalString(item.role) ?? 'message';
      const content = optionalString(item.content);
      return content ? [{ role, content }] : [];
    }),
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index]!);
      }
    }),
  );
  return results;
}

const reportExplanationResultInclude = {
  question: {
    select: {
      content: true,
      type: true,
      severity: true,
    },
  },
  findings: true,
} satisfies Prisma.EvalResultInclude;
type ReportExplanationResultPayload = Prisma.EvalResultGetPayload<{
  include: typeof reportExplanationResultInclude;
}>;

function explanationDefaultParams(t: ModelTarget): Record<string, unknown> | null {
  const params = (t.defaultParams as Record<string, unknown> | null) ?? null;
  if (!/qwen/i.test(t.model)) return params;
  return { ...(params ?? {}), enable_thinking: false };
}

function modelTargetToCfg(t: ModelTarget): LlmTargetConfig {
  return {
    baseUrl: t.baseUrl,
    apiKey: t.apiKey,
    model: t.model,
    extraHeaders: (t.extraHeaders as Record<string, string> | null) ?? null,
    defaultParams: explanationDefaultParams(t),
  };
}

function targetUnavailableReason(target: ModelTarget | null | undefined): string | null {
  if (!target) return '没有找到可用的报告解释模型，已使用规则依据分析。';
  if (!target.isActive) return '所选报告解释模型已禁用，已使用规则依据分析。';
  if (target.targetType !== 'MODEL' && target.targetType !== 'JUDGE') {
    return '所选对象不支持报告解释，已改用规则依据分析。';
  }
  if (!target.baseUrl || !target.model || !target.apiKey) {
    return '所选报告解释模型的连接配置不完整，已改用规则依据分析。';
  }
  return null;
}

async function loadAutomaticReportReviewTarget(
  taskModelTarget: ModelTarget | null,
): Promise<ModelTarget | null> {
  if (!taskModelTarget) return null;
  const target = await prisma.modelTarget.findFirst({
    where: { targetType: 'JUDGE', isActive: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (!target) return null;
  if (target.id === taskModelTarget.id) return null;
  if (target.baseUrl === taskModelTarget.baseUrl && target.model === taskModelTarget.model) {
    return null;
  }
  return targetUnavailableReason(target) ? null : target;
}

function explanationInputFromReportResult(
  result: ReportExplanationResultPayload,
): EvalResultExplanationInput {
  return redactReportJson({
    prompt: result.prompt,
    response: result.response,
    finalVerdict: result.finalVerdict,
    question: {
      content: result.question.content,
      type: result.question.type,
      severity: result.question.severity,
    },
    findings: result.findings.map((f) => ({
      engine: f.engine,
      riskCategory: f.riskCategory,
      severity: f.severity,
      verdict: f.verdict,
      title: f.title,
      evidence: f.evidence,
      detail: f.detail,
    })),
  }) as EvalResultExplanationInput;
}

function localReportExplanation(
  input: EvalResultExplanationInput,
  mode: ReportExplanationMode,
  skippedReason?: string,
  modelTargetName?: string,
): ReportResultExplanation {
  return {
    ...buildLocalEvalResultExplanation(input),
    mode,
    ...(redactReportString(skippedReason)
      ? { skippedReason: redactReportString(skippedReason) }
      : {}),
    ...(redactReportString(modelTargetName)
      ? { modelTargetName: redactReportString(modelTargetName) }
      : {}),
  };
}

async function resolveReportExplanationTarget(input: {
  mode: ReportExplanationMode;
  taskModelTarget: ModelTarget | null;
  reviewModelTargetId?: string;
}): Promise<{ target: ModelTarget | null; unavailableReason: string | null }> {
  if (input.mode === 'local') return { target: null, unavailableReason: null };
  const target =
    input.mode === 'self'
      ? input.taskModelTarget
      : await prisma.modelTarget.findUnique({ where: { id: input.reviewModelTargetId! } });
  return { target, unavailableReason: targetUnavailableReason(target) };
}

interface ReportExplanationDependencies {
  explainResult?: typeof explainEvalResult;
}

export async function enrichReportDataWithExplanations(
  data: ReportInputData,
  input: {
    mode: ReportExplanationMode;
    taskModelTarget: ModelTarget | null;
    reviewModelTargetId?: string;
  },
  resolvedModelTarget?: ModelTarget | null,
  dependencies: ReportExplanationDependencies = {},
): Promise<ReportInputData> {
  // LLM 具体化解释名额有限：先剔除无有效 Finding 的旧样本/纯误报，再按严重度取前 N 条。
  const sevRank: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
  const findingsByResultId = new Map<string, ReportInputData['findings']>();
  for (const finding of data.findings) {
    const resultId = finding.resultId?.trim();
    if (!resultId) continue;
    const findings = findingsByResultId.get(resultId) ?? [];
    findings.push(finding);
    findingsByResultId.set(resultId, findings);
  }
  const candidatesByResultId = new Map<
    string,
    {
      resultId: string;
      wrongAnswer: ReportInputData['wrongAnswers'][number];
      findings: ReportInputData['findings'];
      findingSeverityRank: number;
    }
  >();
  // 红队仅持久化 Finding/EvalResult 也必须参与解释；不依赖 WrongAnswer 表是否有旁路记录。
  const reportAnswers = [...data.wrongAnswers];
  const answerIds = new Set(
    reportAnswers.flatMap((answer) => (answer.resultId ? [answer.resultId] : [])),
  );
  for (const risk of buildReportRiskContext(data).activeRisks) {
    if (!risk.resultId || answerIds.has(risk.resultId)) continue;
    reportAnswers.push(portfolioRiskToWrongAnswer(risk));
    answerIds.add(risk.resultId);
  }
  for (const wrongAnswer of reportAnswers) {
    const resultId = wrongAnswer.resultId?.trim();
    if (!resultId || candidatesByResultId.has(resultId)) continue;
    const findings = findingsByResultId.get(resultId) ?? [];
    const activeFindings = findings.filter((finding) => finding.reviewStatus !== 'FALSE_POSITIVE');
    // 无 Finding 或纯人工误报已不属于有效风险，不占解释名额，也不进入 attempted/fallback。
    if (activeFindings.length === 0) continue;
    candidatesByResultId.set(resultId, {
      resultId,
      wrongAnswer,
      findings,
      findingSeverityRank: Math.max(
        ...activeFindings.map((finding) =>
          finding.severity ? (sevRank[finding.severity] ?? -1) : -1,
        ),
      ),
    });
  }
  const candidates = [...candidatesByResultId.values()]
    // Finding 是唯一风险事实源；WrongAnswer 的旧严重度不能决定有限的模型说明名额。
    .sort(
      (a, b) =>
        b.findingSeverityRank - a.findingSeverityRank ||
        (a.resultId === b.resultId ? 0 : a.resultId < b.resultId ? -1 : 1),
    )
    .slice(0, REPORT_EXPLANATION_LIMIT);

  const skippedReasons = new Set<string>();
  let fallbackCount = 0;
  const explainableCandidates = new Map<
    string,
    { stableId: string; engine: string; riskCategory: string }
  >();
  for (const candidate of candidates) {
    // 含误报旁证在内必须恰好一条，才能建立结果级说明与 Finding 的一一对应关系。
    if (candidate.findings.length !== 1) {
      skippedReasons.add('同一结果存在多条检测证据，尚未建立逐项说明关联，已使用规则依据分析。');
      if (input.mode !== 'local') fallbackCount += 1;
      continue;
    }
    const finding = candidate.findings[0]!;
    const stableId = finding.stableId?.trim();
    if (!stableId) {
      skippedReasons.add('检测证据缺少稳定标识，已使用规则依据分析。');
      if (input.mode !== 'local') fallbackCount += 1;
      continue;
    }
    if (
      candidate.wrongAnswer.riskCategory !== finding.riskCategory ||
      candidate.wrongAnswer.engine !== finding.engine
    ) {
      skippedReasons.add('风险样本标签与检测证据不一致，已使用规则依据分析。');
      if (input.mode !== 'local') fallbackCount += 1;
      continue;
    }
    explainableCandidates.set(candidate.resultId, {
      stableId,
      engine: finding.engine,
      riskCategory: finding.riskCategory,
    });
  }
  const { target, unavailableReason } =
    resolvedModelTarget !== undefined
      ? {
          target: resolvedModelTarget,
          unavailableReason:
            input.mode === 'local' ? null : targetUnavailableReason(resolvedModelTarget),
        }
      : await resolveReportExplanationTarget(input);
  const explanations = new Map<string, ReportResultExplanation>();
  let llmCount = 0;
  const explainResult = dependencies.explainResult ?? explainEvalResult;

  if (explainableCandidates.size > 0) {
    const explainableResultIds = [...explainableCandidates.keys()];
    const rows = await prisma.evalResult.findMany({
      where: { id: { in: explainableResultIds }, taskId: data.task.id },
      include: reportExplanationResultInclude,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const verifiedResultIds: string[] = [];
    for (const resultId of explainableResultIds) {
      const row = byId.get(resultId);
      const expected = explainableCandidates.get(resultId)!;
      if (!row) {
        skippedReasons.add('未读取到对应评估结果，已使用规则依据分析。');
        if (input.mode !== 'local') fallbackCount += 1;
        continue;
      }
      const currentFinding = row.findings.length === 1 ? row.findings[0] : undefined;
      if (
        !currentFinding ||
        currentFinding.id !== expected.stableId ||
        currentFinding.reviewStatus === 'FALSE_POSITIVE' ||
        currentFinding.engine !== expected.engine ||
        currentFinding.riskCategory !== expected.riskCategory
      ) {
        skippedReasons.add('检测证据在说明生成期间发生变化，已使用规则依据分析。');
        if (input.mode !== 'local') fallbackCount += 1;
        continue;
      }
      verifiedResultIds.push(resultId);
    }
    const explained = await mapWithConcurrency(
      verifiedResultIds,
      REPORT_EXPLANATION_CONCURRENCY,
      async (resultId): Promise<{ resultId: string; explanation: ReportResultExplanation }> => {
        const row = byId.get(resultId)!;
        const explanationInput = explanationInputFromReportResult(row);
        let explanation: ReportResultExplanation;
        if (input.mode === 'local') {
          explanation = localReportExplanation(explanationInput, 'local');
        } else if (unavailableReason || !target) {
          explanation = localReportExplanation(
            explanationInput,
            input.mode,
            unavailableReason ?? '风险解释模型不可用，已使用规则依据分析。',
            target?.name,
          );
        } else {
          explanation = await explainResult(explanationInput, {
            mode: input.mode,
            target: modelTargetToCfg(target),
            targetName: target.name,
            timeoutMs: REPORT_EXPLANATION_TIMEOUT_MS,
          });
        }
        return { resultId, explanation };
      },
    );

    for (const item of explained) {
      const { resultId, explanation } = item;
      if (explanation.source === 'llm') llmCount += 1;
      else if (input.mode !== 'local') fallbackCount += 1;
      if (explanation.skippedReason) skippedReasons.add(explanation.skippedReason);
      explanations.set(resultId, explanation);
    }
  }

  return {
    ...data,
    wrongAnswers: reportAnswers.map((wrongAnswer) => ({
      ...wrongAnswer,
      explanation: wrongAnswer.resultId ? explanations.get(wrongAnswer.resultId) : undefined,
    })),
    explanationRun: {
      mode: input.mode,
      label: REPORT_EXPLANATION_LABELS[input.mode],
      ...(target?.name ? { modelTargetName: target.name } : {}),
      attemptedCount: candidates.length,
      llmCount,
      fallbackCount,
      skippedReasons: [...skippedReasons].slice(0, 3),
    },
  };
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // 生成内容安全评估报告（GB/T 45654）：按条款逐条给结论，数据来自按附录 B 方法抽样的标准专项运行。
  app.get(
    '/gbt45654/:runId',
    { preHandler: [requirePermission('report:read')] },
    async (request, reply) => {
      const { runId } = z.object({ runId: z.string().uuid() }).parse(request.params);
      const { format } = z
        .object({ format: z.enum(['html', 'json', 'pdf']).default('html') })
        .parse(request.query ?? {});
      const input = await loadGbtReportInput(prisma, runId);
      if (!input) throw notFound('没有找到按附录 B 方法抽样的标准专项运行');
      const model = buildGbtReport(input);
      if (model.grade === 'blocked') {
        throw badRequest(model.gradeNote ?? '尚无有效判定，不出具报告', 'REPORT_NO_VALID_JUDGMENT');
      }
      if (format === 'json') return model;
      const watermark = await resolveDownloadWatermark(request.currentUser!);
      const raw = renderGbtReportHtml(model);
      const html = watermark ? applyHtmlWatermark(raw, watermark) : raw;
      if (format === 'pdf') {
        const pdf = await renderHtmlToPdf(html, {
          executablePath: config.REPORT_CHROMIUM_PATH || undefined,
        });
        reply
          .type('application/pdf')
          .header('Content-Disposition', `attachment; filename="gbt45654-${runId}.pdf"`);
        return pdf;
      }
      reply.type('text/html; charset=utf-8');
      return html;
    },
  );

  // 生成报告
  app.post(
    '/',
    {
      preHandler: [
        requirePermission('report:generate'),
        requireLicensedFeature('content_retention'),
      ],
    },
    async (request, reply) => {
      const body = createBody.parse(request.body);

      // 国标任务（附录 B 方法抽样）：不论请求什么类型，一律出国标报告。
      const gbtRun = await prisma.standardRun.findUnique({
        where: { taskId: body.taskId },
        select: {
          id: true,
          status: true,
          samplePlan: true,
          task: { select: { id: true, name: true, modelTargetId: true } },
        },
      });
      if (gbtRun && isGbtMethodsPlan(gbtRun.samplePlan)) {
        if (gbtRun.status === 'RUNNING') {
          throw badRequest('评估任务仍在运行，请等待完成或取消后再生成报告', 'REPORT_TASK_NOT_COMPLETED');
        }
        const input = await loadGbtReportInput(prisma, gbtRun.id);
        if (!input) throw notFound('没有找到按附录 B 方法抽样的标准专项运行');
        const model = buildGbtReport(input);
        if (model.grade === 'blocked') {
          throw badRequest(
            model.gradeNote ?? '本次评估没有任何有效判定，不出具报告',
            'REPORT_NO_VALID_JUDGMENT',
          );
        }
        const totalQuestions = Object.values(input.selectedCounts).reduce(
          (sum, n) => sum + (typeof n === 'number' ? n : 0),
          0,
        );
        const summary = buildGbtStoredSummary(model, totalQuestions);
        const baseList = buildFallbackReportListSummary({
          kind: GBT_REPORT_KIND,
          totalQuestions,
          riskDistribution: null,
        });
        const listSummary = { ...baseList, headline: summary.headline, metrics: summary.metrics };
        const title = redactReportString(`${GBT_REPORT_TITLE} - ${gbtRun.task.name}`);
        // 先定报告编号，正文页脚要印出来。
        const reportId = randomUUID();
        const report = await prisma.report.create({
          data: {
            id: reportId,
            taskId: body.taskId,
            evaluatedTargetId: gbtRun.task.modelTargetId ?? null,
            title,
            format: 'html',
            kind: GBT_REPORT_KIND,
            content: renderGbtReportHtml(model, { reportId }),
            summary: summary as unknown as Prisma.InputJsonValue,
            listSummary: listSummary as unknown as Prisma.InputJsonValue,
            passRate: null,
            totalQuestions,
            generatedById: request.currentUser!.id,
          },
        });
        await writeAudit({
          actorId: request.currentUser!.id,
          actorName: request.currentUser!.username,
          action: 'report.generate',
          targetType: 'report',
          targetId: report.id,
          detail: {
            taskId: body.taskId,
            kind: GBT_REPORT_KIND,
            requestedKind: body.kind,
            grade: model.grade,
            overall: model.overall.label,
          },
        });
        reply.code(201);
        return serializeDetail(report);
      }

      const serviceAssuranceReport = body.kind === 'service_assurance';
      if (serviceAssuranceReport) {
        await assertTaskAccess(request.currentUser!, body.taskId, 'report');
      }
      const task = serviceAssuranceReport
        ? await prisma.evalTask.findUnique({
            where: { id: body.taskId },
            select: { id: true, status: true },
          })
        : await prisma.evalTask.findUnique({
            where: { id: body.taskId },
            include: { modelTarget: true },
          });
      if (!task) throw notFound('评估任务不存在');
      if (task.status !== 'COMPLETED') {
        throw badRequest('评估任务尚未完成，不能生成正式报告', 'REPORT_TASK_NOT_COMPLETED');
      }
      if (
        !serviceAssuranceReport &&
        body.explanationMode === 'review_model' &&
        !body.explanationModelTargetId
      ) {
        throw badRequest('请选择报告复核模型', 'REPORT_REVIEW_MODEL_REQUIRED');
      }

      const generatedAt = new Date();
      let evaluatedTargetId: string;
      let deliveryData: ReportInputData;
      let reviewTarget: LlmTargetConfig | null = null;
      let reviewTargetName: string | undefined;
      if (serviceAssuranceReport) {
        const gathered = await prisma.$transaction(
          (tx) => gatherServiceAssuranceReportData(tx, body.taskId, generatedAt),
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
        evaluatedTargetId = gathered.evaluatedTargetId;
        deliveryData = redactReportInputData(gathered.data);
      } else {
        const gathered = await prisma.$transaction(
          (tx) => gatherReportData(tx, body.taskId, generatedAt),
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
        evaluatedTargetId = gathered.evaluatedTargetId;
        if (gathered.data.endpointSummary) {
          deliveryData = gathered.data;
        } else {
          const automaticReviewTarget =
            body.explanationMode === 'local'
              ? await loadAutomaticReportReviewTarget(gathered.evaluatedTarget)
              : null;
          const reviewInput = {
            mode: automaticReviewTarget ? ('review_model' as const) : body.explanationMode,
            taskModelTarget: gathered.evaluatedTarget,
            reviewModelTargetId: automaticReviewTarget?.id ?? body.explanationModelTargetId,
          };
          const reviewModelTarget =
            automaticReviewTarget ?? (await resolveReportExplanationTarget(reviewInput)).target;
          reviewTarget = reviewModelTarget ? modelTargetToCfg(reviewModelTarget) : null;
          reviewTargetName = reviewModelTarget?.name;
          const enriched = await enrichReportDataWithExplanations(
            gathered.data,
            reviewInput,
            reviewModelTarget,
          );
          // explanationRun 先进入交付边界；后续 plan、研判和报告构建共享同一份 deliveryData。
          deliveryData = redactReportInputData(enriched);
        }
      }
      if (body.applicationContext) {
        deliveryData = redactReportInputData({
          ...deliveryData,
          applicationContext: body.applicationContext,
        });
      }
      const generation = await executeReportGenerationPlan(body.kind, deliveryData, {
        generateJudgment: async (judgeInput) => {
          if (serviceAssuranceReport || deliveryData.endpointSummary) return undefined;
          try {
            return await generateReportJudgment(judgeInput, {
              target: reviewTarget,
              targetName: reviewTargetName,
            });
          } catch (err) {
            // 不能 return undefined：那会让 report-builder 的 aiJudgment 分支整段不渲染，
            // 客户拿到一份没有任何研判结论的报告。降级到本地确定性研判，至少保证有结论段。
            request.log?.warn(
              { err },
              'report judgment failed; falling back to local deterministic judgment',
            );
            return buildLocalReportJudgment(judgeInput);
          }
        },
        redactJudgment: (judgment) => redactReportJson(judgment) as unknown as ReportAiJudgment,
        buildReport: (kind, data, context) => buildSpecializedReport(kind, data, context),
      });
      if (!generation.report) {
        throw badRequest('报告方向与当前评估任务不匹配', 'REPORT_KIND_NOT_APPLICABLE', {
          requestedKind: body.kind,
          allowedKinds: generation.plan.allowedKinds,
        });
      }
      const built = generation.report;
      // 出具门槛：有效判定（通过 + 不合格）为 0 时不出报告——全部未执行或无法判定，任何结论都没有依据。
      if (!serviceAssuranceReport) {
        const full = task as unknown as { engines: string[]; dimensions: string[] };
        const lines = reportLinesForTask({
          engines: full.engines,
          dimensions: full.dimensions,
          endpoint: Boolean(deliveryData.endpointSummary),
        });
        const valid = (built.summary.passedCount ?? 0) + (built.summary.failedCount ?? 0);
        // 有风险项本身就是证据（例如只落风险项、不落逐题结果的扫描类任务），不拦。
        const findings = built.summary.findingCount ?? 0;
        if (lines.length > 0 && findings === 0 && reportGradeForValidCount(valid) === 'blocked') {
          throw badRequest(
            '本次评估没有任何有效判定（测试项全部未执行或无法判定），不出具报告。请先排查未执行原因并补测。',
            'REPORT_NO_VALID_JUDGMENT',
          );
        }
      }
      // 生成时选定的可选章节范围写入快照（缺省=不写=全部）；下载时可再覆盖。
      if (body.sections) built.summary.sectionScope = body.sections;
      if (body.templateId) {
        const template = await prisma.reportTemplate.findUnique({
          where: { id: body.templateId },
        });
        if (!template) throw notFound('报告模板不存在', 'REPORT_TEMPLATE_NOT_FOUND');
        // 模板的章节留在模板快照里，不写进 sectionScope：sectionScope 只记生成时显式选的章节，
        // 下载时排在模板前面；下载时另选模板也能按新模板的章节出。
        built.summary.reportTemplate = templateSnapshot(template);
      }
      // 框架覆盖矩阵：按该任务范围计算，失败只降级为不写，不影响报告生成。
      if (!serviceAssuranceReport) {
        await attachFrameworkCoverage(built.summary, body.taskId, request.log);
      }

      const listSummary = buildReportListSummary(built.summary);
      const canonicalPassRate = listSummary.conclusionSnapshot.passRate;
      assertReportConclusionSnapshotsMatch(built.summary, listSummary, built.kind, built.passRate);
      const report = await prisma.report.create({
        data: {
          taskId: body.taskId,
          evaluatedTargetId,
          title: serviceAssuranceReport
            ? built.title
            : redactReportString(body.title?.trim()) || built.title,
          format: built.format,
          kind: built.kind,
          content: built.content,
          summary: built.summary as unknown as Prisma.InputJsonValue,
          listSummary: listSummary as unknown as Prisma.InputJsonValue,
          passRate: canonicalPassRate,
          totalQuestions: built.totalQuestions,
          riskDistribution: built.riskDistribution as unknown as Prisma.InputJsonValue,
          generatedById: request.currentUser!.id,
        },
      });

      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'report.generate',
        targetType: 'report',
        targetId: report.id,
        detail: {
          taskId: body.taskId,
          kind: body.kind,
          passRate: canonicalPassRate,
          ...(serviceAssuranceReport
            ? {}
            : {
                explanationMode: body.explanationMode,
                explanationModelTargetId: body.explanationModelTargetId,
              }),
        },
      });

      reply.code(201);
      return serializeDetail(report);
    },
  );

  // 多任务组合报告（2.6.3）：从 2～20 个当前租户已完成的评估任务组合，权限同生成报告。
  app.post(
    '/combined',
    {
      preHandler: [
        requirePermission('report:generate'),
        requireLicensedFeature('content_retention'),
      ],
    },
    async (request, reply) => {
      const body = combinedBody.parse(request.body);
      const template = body.templateId
        ? await prisma.reportTemplate.findUnique({ where: { id: body.templateId } })
        : null;
      if (body.templateId && !template) {
        throw notFound('报告模板不存在', 'REPORT_TEMPLATE_NOT_FOUND');
      }
      const generatedAt = new Date();
      // 每个任务按它单任务报告的同一取数路径（含脱敏）逐个取，风险口径与单任务报告一致。
      const snapshot = await gatherCombinedSnapshot(body.taskIds, generatedAt, {
        loadTaskData: async (taskId) =>
          (
            await prisma.$transaction((tx) => gatherReportData(tx, taskId, generatedAt), {
              isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
            })
          ).data,
      });
      const listSummary = {
        ...buildFallbackReportListSummary({
          kind: COMBINED_REPORT_KIND,
          totalQuestions: snapshot.totals.totalQuestions,
          riskDistribution: snapshot.riskDistribution,
        }),
        processedQuestions: snapshot.totals.totalQuestions,
        passedCount: snapshot.totals.passedCount,
        failedCount: snapshot.totals.failedCount,
        errorCount: snapshot.totals.errorCount,
        headline: snapshot.headline,
        metrics: { taskCount: snapshot.tasks.length },
      };
      const withTemplate: typeof snapshot & { reportTemplate?: unknown } = template
        ? { ...snapshot, reportTemplate: templateSnapshot(template) }
        : snapshot;
      const report = await createCombinedReport({
        title: redactReportString(body.title),
        snapshot: withTemplate,
        listSummary: listSummary as unknown as Prisma.InputJsonValue,
        generatedById: request.currentUser!.id,
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'report.generate',
        targetType: 'report',
        targetId: report.id,
        detail: {
          kind: COMBINED_REPORT_KIND,
          taskIds: body.taskIds,
          ...(template ? { templateId: template.id } : {}),
        },
      });
      reply.code(201);
      return serializeCombinedDetail(report, await loadCombinedTaskViews(report));
    },
  );

  // 报告列表（不含正文）
  app.get('/', { preHandler: [requirePermission('report:read')] }, async (request) => {
    const q = listQuery.parse(request.query);
    if (q.kind === 'service_assurance' && q.taskId) {
      await assertTaskAccess(request.currentUser!, q.taskId, 'read');
    }
    const filters: Prisma.ReportWhereInput = {
      ...(q.taskId ? { taskId: q.taskId } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
    };
    const where: Prisma.ReportWhereInput = {
      AND: [filters, reportVisibilityWhere(request.currentUser!)],
    };
    applyTenantFilter(request, where as Record<string, unknown>);
    const [items, total] = await Promise.all([
      prisma.report.findMany({
        where,
        select: REPORT_LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.report.count({ where }),
    ]);
    return {
      items: items.map(serializeListItem),
      total,
      page: q.page,
      pageSize: q.pageSize,
    } satisfies Paginated<ReturnType<typeof serializeListItem>>;
  });

  // 趋势：按模型对象聚合历史报告（M14 报告富化 · Part 3）
  app.get('/trend', { preHandler: [requirePermission('report:read')] }, async (request) => {
    const q = trendQuery.parse(request.query);
    const rows = await prisma.report.findMany({
      where: {
        AND: [
          {
            OR: [
              { evaluatedTargetId: q.modelTargetId },
              // 旧报告没有冻结主评对象列，只能按历史 task 归档；其结论会按 legacy 保守降级。
              { evaluatedTargetId: null, task: { modelTargetId: q.modelTargetId } },
            ],
          },
          reportVisibilityWhere(request.currentUser!),
        ],
      },
      select: REPORT_TREND_SELECT,
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    rows.reverse();
    // 组合报告不挂单个任务、也没有主评对象，查询条件本就排除；这里再按类型收窄。
    const inputs: TrendReportInput[] = rows.flatMap((r) =>
      r.taskId
        ? [
            {
              id: r.id,
              taskId: r.taskId,
              taskName: redactReportString(r.task?.name ?? '—'),
              createdAt: r.createdAt,
              kind: r.kind,
              listSummary: r.listSummary,
            },
          ]
        : [],
    );
    return buildReportTrend(q.modelTargetId, inputs);
  });

  // 报告详情（含正文）
  app.get('/:id', { preHandler: [requirePermission('report:read')] }, async (request) => {
    const { id } = idParams.parse(request.params);
    const report = await prisma.report.findUnique({ where: { id } });
    if (!report) throw notFound('报告不存在');
    if (report.kind === COMBINED_REPORT_KIND) {
      return serializeCombinedDetail(report, await loadCombinedTaskViews(report));
    }
    if (report.kind === 'service_assurance') {
      await assertTaskAccess(request.currentUser!, reportTaskId(report), 'read');
    }
    return serializeDetail(report);
  });

  // 下载报告（仅 PDF 交付报告）
  app.delete(
    '/:id',
    { preHandler: [requirePermission('report:generate')] },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const report = await prisma.report.findUnique({ where: { id } });
      if (!report) throw notFound('报告不存在');
      if (report.kind === 'service_assurance') {
        await assertTaskAccess(request.currentUser!, reportTaskId(report), 'report');
      }
      await prisma.report.delete({ where: { id } });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'report.delete',
        targetType: 'report',
        targetId: id,
        detail: { title: redactReportString(report.title), kind: report.kind },
      });
      reply.code(204);
    },
  );

  app.get(
    '/:id/download',
    { preHandler: [requirePermission('report:download')] },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { format, profile, severity, riskDomain, sections, templateId } = downloadQuery.parse(
        request.query,
      );
      const report = await prisma.report.findUnique({ where: { id } });
      if (!report) throw notFound('报告不存在');
      if (report.kind === 'service_assurance') {
        await assertTaskAccess(request.currentUser!, reportTaskId(report), 'read');
      }

      if (report.kind === COMBINED_REPORT_KIND) {
        // 组合报告按生成时的快照渲染；任务被删的那一节标「任务已删除」。
        const snapshot = parseCombinedSnapshot(report.summary);
        if (!snapshot) {
          throw badRequest(
            '组合报告缺少生成时的快照，请重新生成',
            'REPORT_COMBINED_SNAPSHOT_MISSING',
          );
        }
        // 报告模板：query 指定 > 生成时快照 > 本租户默认 > 无。
        const template = templateRenderOptions(
          await resolveReportTemplate({
            templateId,
            snapshot: (report.summary as { reportTemplate?: unknown } | null)?.reportTemplate,
            tenantId: report.tenantId,
          }),
        );
        const view = buildCombinedView({
          title: redactReportString(report.title),
          reportId: report.id,
          createdAt: report.createdAt,
          snapshot,
          tasks: await loadCombinedTaskViews(report),
          template,
        });
        const watermark = await resolveDownloadWatermark(request.currentUser!);
        const ua = request.headers['user-agent'];
        const audit = (renderer: string) =>
          writeAudit({
            actorId: request.currentUser!.id,
            actorName: request.currentUser!.username,
            action: 'report.download',
            targetType: 'report',
            targetId: report.id,
            ip: request.ip,
            userAgent: typeof ua === 'string' ? ua : null,
            detail: {
              format,
              renderer,
              kind: COMBINED_REPORT_KIND,
              ...(template.templateId ? { templateId: template.templateId } : {}),
            },
          });
        const filename = (ext: string) => `${redactReportString(report.title)}.${ext}`;
        if (format === 'docx') {
          const docx = await renderCombinedDocx(view, { watermark: watermark?.text });
          await audit('docx');
          reply.header(
            'Content-Disposition',
            attachmentDisposition(filename('docx'), REPORT_FALLBACK_DOCX),
          );
          reply.type(DOCX_CONTENT_TYPE);
          return reply.send(docx);
        }
        const raw = renderCombinedHtml(view);
        const html = watermark ? applyHtmlWatermark(raw, watermark) : raw;
        if (format === 'html') {
          await audit('html');
          reply.header(
            'Content-Disposition',
            attachmentDisposition(filename('html'), REPORT_FALLBACK_HTML),
          );
          reply.type('text/html; charset=utf-8');
          // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- report file download (attachment), same HTML as the PDF renderer.
          return reply.send(html);
        }
        const rendered = await renderReportDownload(config.REPORT_RENDERER, {
          html: () =>
            renderHtmlToPdf(html, {
              executablePath: config.REPORT_CHROMIUM_PATH || undefined,
            }),
          pdfkit: () =>
            renderReportPdf(buildCombinedPdfDoc(view), {
              cjkFontPath: config.PDF_CJK_FONT_PATH || undefined,
              cjkFontFamily: config.PDF_CJK_FONT_FAMILY || undefined,
              watermark: watermark?.text,
            }),
        }).catch((err: unknown) => {
          request.log.error(
            { err, reportId: report.id, renderer: config.REPORT_RENDERER },
            'combined report renderer failed; download aborted',
          );
          throw err;
        });
        await audit(rendered.renderer);
        reply.header(
          'Content-Disposition',
          attachmentDisposition(filename('pdf'), REPORT_FALLBACK_PDF),
        );
        reply.header('X-Report-Renderer', rendered.renderer);
        reply.type('application/pdf');
        return reply.send(rendered.buffer);
      }

      if (report.kind === GBT_REPORT_KIND) {
        if (format === 'docx') {
          throw badRequest(
            '国标报告暂不支持导出 Word，请下载 PDF 或 HTML',
            'REPORT_DOCX_UNSUPPORTED',
          );
        }
        // 国标报告正文已是完整 HTML，直接转 PDF（与 /gbt45654/:runId?format=pdf 同一渲染）。
        const watermark = await resolveDownloadWatermark(request.currentUser!);
        const html = watermark ? applyHtmlWatermark(report.content, watermark) : report.content;
        if (format === 'html') {
          await writeAudit({
            actorId: request.currentUser!.id,
            actorName: request.currentUser!.username,
            action: 'report.download',
            targetType: 'report',
            targetId: report.id,
            detail: { format, renderer: 'html', kind: GBT_REPORT_KIND },
          });
          reply.header(
            'Content-Disposition',
            attachmentDisposition(`${redactReportString(report.title)}.html`, REPORT_FALLBACK_HTML),
          );
          reply.type('text/html; charset=utf-8');
          // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- report file download (attachment), same HTML as the PDF renderer.
          return reply.send(html);
        }
        const pdf = await renderHtmlToPdf(html, {
          executablePath: config.REPORT_CHROMIUM_PATH || undefined,
        });
        await writeAudit({
          actorId: request.currentUser!.id,
          actorName: request.currentUser!.username,
          action: 'report.download',
          targetType: 'report',
          targetId: report.id,
          detail: { format, renderer: 'html', kind: GBT_REPORT_KIND },
        });
        reply.header(
          'Content-Disposition',
          attachmentDisposition(`${redactReportString(report.title)}.pdf`, REPORT_FALLBACK_PDF),
        );
        reply.header('X-Report-Renderer', 'html');
        reply.type('application/pdf');
        return reply.send(pdf);
      }

      const taskId = reportTaskId(report);
      // 存量快照缺 riskDomainTested 时，仅为本次渲染按任务结果懒计算（不改写快照；失败静默回退）。
      const builtWithDomains = await withLazyRiskDomainTested(
        prisma,
        await toBuiltReport(report),
        taskId,
        request.log,
      );
      const taskMeta = await prisma.evalTask.findUnique({
        where: { id: taskId },
        select: { engines: true, dimensions: true, startedAt: true, finishedAt: true },
      });
      const evalLines = reportLinesForTask({
        engines: taskMeta?.engines ?? [],
        dimensions: taskMeta?.dimensions ?? [],
        endpoint: Boolean(builtWithDomains.summary.endpointSummary),
      });
      // 存量快照缺条款观察值时同样懒算（只用于本次渲染）。
      const built = await withLazyStandardClauses(
        prisma,
        builtWithDomains,
        taskId,
        evalLines,
        request.log,
      );
      // 报告模板（2.4.7）：query 指定 > 生成时快照 > 本租户默认 > 无。
      const template = templateRenderOptions(
        await resolveReportTemplate({
          templateId,
          snapshot: built.summary.reportTemplate,
          tenantId: report.tenantId,
        }),
      );
      // 章节：下载时显式给的 > 生成时显式选的（快照里的 sectionScope）> 报告模板的 > 导出范围（profile）默认。
      // 证据详略：下载时显式选了导出范围的按导出范围 > 报告模板的 > 默认完整。
      const exportOptions = resolveReportExportOptions({
        profile,
        sections:
          sections ?? withNewDefaultSections(built.summary.sectionScope) ?? template.sections,
        severityFilter: severity,
        riskDomainFilter: riskDomain,
      });
      if (!profile && template.evidenceDetail) {
        exportOptions.evidenceDetail = template.evidenceDetail;
      }
      const sectionScope = exportOptions.sections;
      const watermark = await resolveDownloadWatermark(request.currentUser!);
      // HTML、Word 下载与 PDF（chromium）用同一份报告模型；HTML 与 PDF 用同一份 HTML 渲染结果，含下载水印。
      const buildDownloadModel = async () => {
        const policyRows = await prisma.policySuggestion.findMany({
          where: { taskId },
          orderBy: { createdAt: 'asc' },
        });
        const assessedAt = taskMeta?.finishedAt ?? taskMeta?.startedAt;
        const model = buildReportHtmlModel(built, {
          evalLines,
          generatedAtFallback: report.createdAt.toISOString(),
          ...(assessedAt ? { assessedAtFallback: assessedAt.toISOString() } : {}),
          kindLabel:
            REPORT_KIND_LABELS[report.kind as keyof typeof REPORT_KIND_LABELS] ?? '评估报告',
          reportId: reportIdentifierForDelivery(report.kind, report.id),
          classification: template.classification,
          cover: template.cover,
          page: template.page,
          severityFilter: exportOptions.severityFilter,
          riskDomainFilter: exportOptions.riskDomainFilter,
          evidenceDetail: exportOptions.evidenceDetail,
          sections: sectionScope,
          protectionStrategy: buildProtectionStrategySection(policyRows),
        });
        return model;
      };
      const renderDownloadHtml = async (): Promise<string> => {
        const html = renderReportHtmlString(await buildDownloadModel());
        return watermark ? applyHtmlWatermark(html, watermark) : html;
      };
      const auditDetail = {
        profile: exportOptions.profile,
        severity: exportOptions.severityFilter ?? '全部',
        riskDomain: exportOptions.riskDomainFilter ?? '全部',
        sections: sectionScope,
        // 套用了报告模板才记模板 id（不用模板时审计内容与原来一致）。
        ...(template.templateId ? { templateId: template.templateId } : {}),
      };
      if (format === 'html') {
        const html = await renderDownloadHtml();
        await writeAudit({
          actorId: request.currentUser!.id,
          actorName: request.currentUser!.username,
          action: 'report.download',
          targetType: 'report',
          targetId: report.id,
          detail: { format, renderer: 'html', ...auditDetail },
        });
        reply.header(
          'Content-Disposition',
          attachmentDisposition(buildReportDownloadFilename(built, 'html'), REPORT_FALLBACK_HTML),
        );
        reply.type('text/html; charset=utf-8');
        // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- report file download (attachment), same HTML as the PDF renderer.
        return reply.send(html);
      }
      if (format === 'docx') {
        if (built.summary.endpointSummary) {
          throw badRequest('终端报告暂不支持 Word，请下载 PDF 或 HTML', 'REPORT_DOCX_UNSUPPORTED');
        }
        const docx = await renderReportDocx(await buildDownloadModel(), {
          watermark: watermark?.text,
        });
        await writeAudit({
          actorId: request.currentUser!.id,
          actorName: request.currentUser!.username,
          action: 'report.download',
          targetType: 'report',
          targetId: report.id,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          detail: { format, renderer: 'docx', ...auditDetail },
        });
        reply.header(
          'Content-Disposition',
          attachmentDisposition(buildReportDownloadFilename(built, 'docx'), REPORT_FALLBACK_DOCX),
        );
        reply.type(DOCX_CONTENT_TYPE);
        return reply.send(docx);
      }
      const rendered = await renderReportDownload(config.REPORT_RENDERER, {
        html: async () =>
          renderHtmlToPdf(await renderDownloadHtml(), {
            executablePath: config.REPORT_CHROMIUM_PATH || undefined,
          }),
        pdfkit: async () => {
          const docModel = buildReportPdfDoc(built, {
            severityFilter: exportOptions.severityFilter,
            riskDomainFilter: exportOptions.riskDomainFilter,
            sections: sectionScope,
          });
          return renderReportPdf(docModel, {
            cjkFontPath: config.PDF_CJK_FONT_PATH || undefined,
            cjkFontFamily: config.PDF_CJK_FONT_FAMILY || undefined,
            watermark: watermark?.text,
          });
        },
      }).catch((err: unknown) => {
        request.log.error(
          { err, reportId: report.id, renderer: config.REPORT_RENDERER },
          'report renderer failed; download aborted',
        );
        throw err;
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'report.download',
        targetType: 'report',
        targetId: report.id,
        detail: { format, renderer: rendered.renderer, ...auditDetail },
      });
      reply.header(
        'Content-Disposition',
        attachmentDisposition(buildReportDownloadFilename(built, 'pdf'), REPORT_FALLBACK_PDF),
      );
      reply.header('X-Report-Renderer', rendered.renderer);
      reply.type('application/pdf');
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- generated PDF bytes with application/pdf content type.
      return reply.send(rendered.buffer);
    },
  );
}
