// 多任务组合报告（2.6.3）：从多个已完成的评估任务汇总，生成时冻结快照，下载时按快照渲染。
import type { Prisma, Report } from '@prisma/client';
import type { DetectCategory, DetectRecordKind, DetectTaskStatus, RiskDomain } from '@lse/shared';
import { z } from 'zod';
import { prisma, prismaUnscoped } from '../../db.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { weightedScoresByTask } from '../../lib/weighted-score.js';
import { isGbtMethodsPlan } from '../standard-evaluations/gbt45654/pipeline.js';
import {
  SEVERITY_ORDER,
  SEVERITY_ZH,
  domainShortLabel,
  humanizeIdentifiers,
  summarizeFinding,
  titleForFinding,
  type SeverityKey,
} from './html/derive.js';
import { formatDateTime, riskDomainLabel } from './labels.js';
import {
  riskItemForPortfolioRisk,
  taskReportRiskDistribution,
  taskReportRiskDomain,
  type ReportInputData,
} from './report-builder.js';
import { redactReportSnapshot, redactReportString } from './report-redaction.js';
import {
  buildReportRiskContext,
  fullReportRiskView,
  type ReportPortfolioRisk,
} from './report-risk-context.js';
import { distributionFromFindings, specializedFindingDomain } from './specialized/common.js';
import { isEndpointReportData } from './specialized/endpoint.js';

export const COMBINED_REPORT_KIND = 'combined';
export const COMBINED_REPORT_KIND_LABEL = '组合报告';
export const COMBINED_MIN_TASKS = 2;
export const COMBINED_MAX_TASKS = 20;
/** 跨任务主要风险最多列出的条数。 */
const TOP_RISK_LIMIT = 50;

export const combinedBody = z.object({
  title: z.string().trim().min(1).max(200),
  taskIds: z.array(z.string().uuid()).min(COMBINED_MIN_TASKS).max(COMBINED_MAX_TASKS),
  // 报告模板（2.4.7）：生成时快照进报告，下载不另选模板时按它渲染。
  templateId: z.string().uuid().optional(),
});

export interface CombinedRiskDistribution {
  bySeverity: Record<string, number>;
  byRiskCategory: Record<string, number>;
  byRiskDomain: Record<string, number>;
}

export interface CombinedTaskSnapshot {
  id: string;
  name: string;
  targetName: string;
  model: string;
  startedAt: string | null;
  finishedAt: string | null;
  totalQuestions: number;
  passedCount: number;
  failedCount: number;
  errorCount: number;
  /** 有效判定通过率（0~1）；没有有效判定时为空。 */
  passRate: number | null;
  /** 综合评估得分，与任务列表「评估得分」同口径；评估不完整时为空。 */
  score: number | null;
  /** 风险数，与该任务单任务报告同一口径。 */
  findingCount: number;
  /** 风险分布，与该任务单任务报告同一口径。 */
  riskDistribution: CombinedRiskDistribution;
}

export interface CombinedTopRisk {
  /** 这一类里排在最前的风险的标题（客户语言，不含内部标识）。 */
  title: string;
  severity: SeverityKey;
  severityLabel: string;
  domainLabel: string;
  count: number;
  taskIds: string[];
}

/** 综合检测报告（2.4.7）里评估任务以外的检测项小结。 */
export interface CombinedRecordSnapshot {
  kind: DetectRecordKind;
  category: DetectCategory;
  id: string;
  name: string;
  status: DetectTaskStatus;
  finishedAt: string | null;
  /** 风险数，与首页四类风险同口径（lib/detect-risk-scope.ts） */
  riskCount: number;
  bySeverity: Record<string, number>;
  /** 小结，中文短句 */
  lines: string[];
  /** 最多 10 条，按严重度排 */
  topFindings: Array<{ title: string; severity: SeverityKey }>;
}

/** 从组合任务生成时的组合任务信息。 */
export interface CombinedJobSnapshot {
  id: string;
  name: string;
  startedAt: string | null;
  finishedAt: string | null;
  itemCount: number;
  /** 快照里各评估任务属于哪一类（评估归内容，终端体检归应用与环境），按类别统计风险用 */
  taskCategories?: Record<string, DetectCategory>;
}

export interface CombinedSnapshot {
  kind: typeof COMBINED_REPORT_KIND;
  generatedAt: string;
  headline: string;
  tasks: CombinedTaskSnapshot[];
  /** 从组合任务生成时才有（2.4.7 综合检测报告）；E 线组合报告没有 */
  job?: CombinedJobSnapshot;
  records?: CombinedRecordSnapshot[];
  totals: {
    totalQuestions: number;
    passedCount: number;
    failedCount: number;
    errorCount: number;
    findingCount: number;
  };
  riskDistribution: CombinedRiskDistribution;
  topRisks: CombinedTopRisk[];
}

/** 报告详情、下载时的任务条目：快照内容 + 任务现在的状态。 */
export type CombinedTaskView = CombinedTaskSnapshot & {
  /** 任务已被删除。 */
  deleted: boolean;
  /** 任务已迁到别的租户（报告留在原租户）。 */
  movedOut: boolean;
};

const emptyDistribution = (): CombinedRiskDistribution => ({
  bySeverity: {},
  byRiskCategory: {},
  byRiskDomain: {},
});

function add(dist: Record<string, number>, key: string, n = 1): void {
  dist[key] = (dist[key] ?? 0) + n;
}

/** 按任务汇总的风险分布逐项相加。 */
export function mergeRiskDistributions(list: CombinedRiskDistribution[]): CombinedRiskDistribution {
  const out = emptyDistribution();
  for (const d of list) {
    for (const key of ['bySeverity', 'byRiskCategory', 'byRiskDomain'] as const) {
      for (const [k, v] of Object.entries(d[key])) add(out[key], k, v);
    }
  }
  return out;
}

const severityRank = (s: SeverityKey) => SEVERITY_ORDER.indexOf(s);

/** 单任务报告把未定级的风险记为 UNKNOWN；展示时与 UNSPECIFIED 一样算「未定级」。 */
function severityKeyOf(key: string | null | undefined): SeverityKey {
  return key && key !== 'UNKNOWN' && (SEVERITY_ORDER as string[]).includes(key)
    ? (key as SeverityKey)
    : 'UNSPECIFIED';
}

/** 风险等级分布按严重度从高到低列出（未定级合并为一项，计数为 0 的不列）。 */
export function severityEntries(dist: Record<string, number>): Array<[SeverityKey, number]> {
  const merged = new Map<SeverityKey, number>();
  for (const [k, n] of Object.entries(dist)) {
    if (n > 0) merged.set(severityKeyOf(k), (merged.get(severityKeyOf(k)) ?? 0) + n);
  }
  return SEVERITY_ORDER.filter((k) => merged.has(k)).map((k) => [k, merged.get(k)!]);
}

/** 结论一句话：组合了几个任务、多少测试项、多少风险，最高到什么级别。 */
function buildHeadline(snapshot: Omit<CombinedSnapshot, 'headline'>): string {
  const t = snapshot.totals;
  const parts = severityEntries(snapshot.riskDistribution.bySeverity).map(
    ([k, n]) => `${SEVERITY_ZH[k]} ${n} 项`,
  );
  const risk =
    t.findingCount > 0 ? `发现风险 ${t.findingCount} 项（${parts.join('、')}）` : '未发现风险';
  return `组合 ${snapshot.tasks.length} 个评估任务，共 ${t.totalQuestions} 个测试项，${risk}`;
}

interface TaskRiskEntry {
  risk: ReportPortfolioRisk;
  severity: SeverityKey;
  domain: RiskDomain;
}

export interface TaskRiskTally {
  findingCount: number;
  riskDistribution: CombinedRiskDistribution;
  /** 每项风险（按单任务报告的排序）及它的严重度、风险类别。 */
  risks: TaskRiskEntry[];
}

/**
 * 与该任务单任务报告同一口径的风险数据：
 * 风险按测试项归并（同一题多个引擎的发现只算一项），不含人工标记的误报、模型判定的疑似误报和非主评估结果；
 * 终端评估任务走终端报告的口径，只算判定为不通过的发现。
 */
export function tallyTaskRisks(data: ReportInputData): TaskRiskTally {
  const context = buildReportRiskContext(data);
  if (isEndpointReportData(data)) {
    const view = fullReportRiskView(context);
    return {
      findingCount: view.findingCount,
      riskDistribution: distributionFromFindings(view.representativeFindings),
      risks: view.risks.map((risk) => ({
        risk: risk.sourceRisk,
        severity: severityKeyOf(risk.representative.severity),
        domain: specializedFindingDomain(risk.representative),
      })),
    };
  }
  const risks = context.portfolio.activeRisks;
  return {
    findingCount: risks.length,
    riskDistribution: taskReportRiskDistribution(risks),
    risks: risks.map((risk) => ({
      risk,
      severity: severityKeyOf(risk.representative.severity),
      domain: taskReportRiskDomain(risk),
    })),
  };
}

/** 执行器写进 Finding 标题的引擎前缀，如「[rule-judge] jailbreak」。 */
const INTERNAL_TAG = /\[[a-z0-9]+(?:[-_][a-z0-9]+)*\]\s*/gi;

/** 风险标题：与单任务报告「主要风险」同一套取法（一句话问题的首句、风险类别名兜底），去掉内部标识。 */
function riskTitle(risk: ReportPortfolioRisk, domain: RiskDomain): string {
  const item = riskItemForPortfolioRisk(risk);
  const domainLabel = riskDomainLabel(domain);
  const title = titleForFinding(item, domainLabel, summarizeFinding(item, domain));
  const clean = humanizeIdentifiers(redactReportString(title).replace(INTERNAL_TAG, ''));
  return clean || domainShortLabel(domainLabel);
}

export interface CombinedGatherDeps {
  /** 取某个任务出单任务报告时用的同一份输入数据。 */
  loadTaskData: (taskId: string) => Promise<ReportInputData>;
}

/**
 * 校验所选任务并汇总冻结快照：
 * 只能选当前租户（查询自动按租户过滤）的已完成任务；找不到的一律 404，不区分是否属于别的租户。
 * 每个任务的风险按它自己单任务报告的取数路径逐个计算，不一次性取全部 Finding。
 */
export async function gatherCombinedSnapshot(
  taskIds: string[],
  generatedAt: Date,
  deps: CombinedGatherDeps,
): Promise<CombinedSnapshot> {
  if (new Set(taskIds).size !== taskIds.length) {
    throw badRequest('所选任务有重复', 'REPORT_TASKS_DUPLICATED');
  }
  const rows = await prisma.evalTask.findMany({
    where: { id: { in: taskIds } },
    select: {
      id: true,
      name: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      totalQuestions: true,
      passedCount: true,
      failedCount: true,
      errorCount: true,
      modelTarget: { select: { name: true, model: true } },
    },
  });
  if (rows.length !== taskIds.length) throw notFound('评估任务不存在');
  const order = new Map(taskIds.map((id, i) => [id, i]));
  const ordered = [...rows].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const unfinished = ordered.filter((r) => r.status !== 'COMPLETED');
  if (unfinished.length) {
    throw badRequest(
      `以下评估任务尚未完成，不能生成组合报告：${unfinished.map((r) => `「${r.name}」`).join('、')}`,
      'REPORT_TASK_NOT_COMPLETED',
      { taskIds: unfinished.map((r) => r.id) },
    );
  }
  // 国标任务按条款给结论（国标报告），没有能与其他任务相加的风险数和分布。
  const standardRuns = await prisma.standardRun.findMany({
    where: { taskId: { in: taskIds } },
    select: { taskId: true, samplePlan: true },
  });
  const gbtIds = new Set(
    standardRuns.filter((r) => isGbtMethodsPlan(r.samplePlan)).map((r) => r.taskId),
  );
  const gbt = ordered.filter((r) => gbtIds.has(r.id));
  if (gbt.length) {
    throw badRequest(
      `以下任务是国标（GB/T 45654）评估，按条款给结论，没有能和其他任务合并的风险数据，请单独生成报告：${gbt.map((r) => `「${r.name}」`).join('、')}`,
      'REPORT_COMBINED_TASK_UNSUPPORTED',
      { taskIds: gbt.map((r) => r.id) },
    );
  }

  const scores = await weightedScoresByTask(taskIds);
  const tallies = new Map<string, TaskRiskTally>();
  for (const r of ordered) {
    let data: ReportInputData;
    try {
      data = await deps.loadTaskData(r.id);
    } catch (err) {
      if (err instanceof AppError && err.statusCode < 500) {
        throw badRequest(
          `「${r.name}」取不到能合并的风险数据：${err.message}。请单独生成该任务的报告`,
          'REPORT_COMBINED_TASK_UNSUPPORTED',
          { taskIds: [r.id], reason: err.code },
        );
      }
      throw err;
    }
    tallies.set(r.id, tallyTaskRisks(data));
  }

  const groups = new Map<string, CombinedTopRisk>();
  for (const r of ordered) {
    for (const entry of tallies.get(r.id)!.risks) {
      const key = `${entry.severity}\u0000${entry.domain}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          title: riskTitle(entry.risk, entry.domain),
          severity: entry.severity,
          severityLabel: SEVERITY_ZH[entry.severity],
          domainLabel: riskDomainLabel(entry.domain),
          count: 0,
          taskIds: [],
        };
        groups.set(key, g);
      }
      g.count += 1;
      if (!g.taskIds.includes(r.id)) g.taskIds.push(r.id);
    }
  }

  const tasks: CombinedTaskSnapshot[] = ordered.map((r) => {
    const valid = r.passedCount + r.failedCount;
    const tally = tallies.get(r.id)!;
    return {
      id: r.id,
      name: redactReportString(r.name),
      targetName: redactReportString(r.modelTarget.name),
      model: redactReportString(r.modelTarget.model),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      totalQuestions: r.totalQuestions,
      passedCount: r.passedCount,
      failedCount: r.failedCount,
      errorCount: r.errorCount,
      passRate: valid > 0 ? r.passedCount / valid : null,
      score: scores.get(r.id) ?? null,
      findingCount: tally.findingCount,
      riskDistribution: tally.riskDistribution,
    };
  });
  const topRisks = [...groups.values()]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.count - a.count)
    .slice(0, TOP_RISK_LIMIT);
  const base = {
    kind: COMBINED_REPORT_KIND,
    generatedAt: generatedAt.toISOString(),
    tasks,
    totals: {
      totalQuestions: tasks.reduce((s, t) => s + t.totalQuestions, 0),
      passedCount: tasks.reduce((s, t) => s + t.passedCount, 0),
      failedCount: tasks.reduce((s, t) => s + t.failedCount, 0),
      errorCount: tasks.reduce((s, t) => s + t.errorCount, 0),
      findingCount: tasks.reduce((s, t) => s + t.findingCount, 0),
    },
    riskDistribution: mergeRiskDistributions(tasks.map((t) => t.riskDistribution)),
    topRisks,
  } satisfies Omit<CombinedSnapshot, 'headline'>;
  return { ...base, headline: buildHeadline(base) };
}

/** 报告详情页的文字摘要（正文另由下载渲染）。 */
export function combinedMarkdown(title: string, snapshot: CombinedSnapshot): string {
  const lines = [`# ${title}`, '', snapshot.headline + '。', '', '## 任务清单', ''];
  snapshot.tasks.forEach((t, i) => {
    lines.push(
      `${i + 1}. ${t.name}：评估对象 ${t.targetName}（${t.model}），完成于 ${t.finishedAt ? formatDateTime(new Date(t.finishedAt)) : '—'}，风险 ${t.findingCount} 项`,
    );
  });
  return lines.join('\n');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 读取冻结快照；不是组合报告快照时返回空。 */
export function parseCombinedSnapshot(value: unknown): CombinedSnapshot | null {
  if (!isRecord(value) || value.kind !== COMBINED_REPORT_KIND || !Array.isArray(value.tasks)) {
    return null;
  }
  return redactReportSnapshot(value) as unknown as CombinedSnapshot;
}

/** 按 report_tasks 的顺序给出任务清单，并标出已被删除、已迁到别的租户的任务。 */
export async function loadCombinedTaskViews(
  report: Pick<Report, 'id' | 'summary' | 'tenantId'>,
): Promise<CombinedTaskView[]> {
  const snapshot = parseCombinedSnapshot(report.summary);
  const links = await prisma.reportTask.findMany({
    where: { reportId: report.id },
    orderBy: { position: 'asc' },
    select: { taskId: true },
  });
  const ids = links.map((l) => l.taskId);
  // 不按租户过滤：任务迁到别的租户后要标「任务已移出本租户」，而不是当成已删除。只读归属，不读内容。
  const live = await prismaUnscoped.evalTask.findMany({
    where: { id: { in: ids } },
    select: { id: true, tenantId: true },
  });
  const tenantOf = new Map(live.map((t) => [t.id, t.tenantId]));
  const byId = new Map((snapshot?.tasks ?? []).map((t) => [t.id, t]));
  return ids.map((id) => {
    const snap = byId.get(id) ?? {
      id,
      name: '未知任务',
      targetName: '—',
      model: '—',
      startedAt: null,
      finishedAt: null,
      totalQuestions: 0,
      passedCount: 0,
      failedCount: 0,
      errorCount: 0,
      passRate: null,
      score: null,
      findingCount: 0,
      riskDistribution: emptyDistribution(),
    };
    const exists = tenantOf.has(id);
    const movedOut = exists && report.tenantId !== null && tenantOf.get(id) !== report.tenantId;
    return { ...snap, deleted: !exists, movedOut };
  });
}

/** 写入报告与任务关联（同一事务）。 */
export async function createCombinedReport(input: {
  title: string;
  snapshot: CombinedSnapshot;
  listSummary: Prisma.InputJsonValue;
  generatedById: string;
}): Promise<Report> {
  const { snapshot } = input;
  return prisma.$transaction(async (tx) => {
    const report = await tx.report.create({
      data: {
        taskId: null,
        evaluatedTargetId: null,
        title: input.title,
        format: 'markdown',
        kind: COMBINED_REPORT_KIND,
        content: combinedMarkdown(input.title, snapshot),
        summary: snapshot as unknown as Prisma.InputJsonValue,
        listSummary: input.listSummary,
        passRate: null,
        totalQuestions: snapshot.totals.totalQuestions,
        riskDistribution: snapshot.riskDistribution as unknown as Prisma.InputJsonValue,
        generatedById: input.generatedById,
      },
    });
    await tx.reportTask.createMany({
      data: snapshot.tasks.map((t, position) => ({ reportId: report.id, taskId: t.id, position })),
    });
    return report;
  });
}
