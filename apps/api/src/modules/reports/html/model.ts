import type {
  BuiltReport,
  RiskItemSeverityGroup,
  ReportComplianceSummary,
  ReportRiskAttribution,
  ReportEntityProfile,
  ReportFatalRisks,
} from '../report-builder.js';
import {
  REPORT_OPTIONAL_SECTIONS,
  ENGINE_STATUS_LABELS,
  engineLabel as reportEngineLabel,
  riskDomainForCategory,
  riskDomainLabel,
  type ReportSectionKey,
  formatDateTime,
  remediationStatusLabel,
} from '../labels.js';
import type { EvalLine, RiskDomain, Severity } from '@lse/shared';
import { basisLines, neutralizeCertificationWording, reportBasesForLines } from '@lse/shared';
import { buildClauseTables, clauseCoverageNotes, type ClauseTable } from './clause-tables.js';
import { buildInternationalFrameworkSection } from '../framework-report.js';
import { filterRiskItemGroups, type ReportEvidenceDetail } from '../export-options.js';
import type { ReportCoverOptions, ReportPageOptions } from '../report-template.js';
import type { ProtectionStrategySection } from '../../policy-suggestions/report-section.js';
import { reportHtmlReuse, buildReportTitleParts, type Tone, type PdfRuleCardItem } from '../pdf.js';
import {
  legacyReportConclusionSnapshot,
  renderReportConclusionReasonsZh,
  renderReportConclusionStateZh,
} from '../report-conclusion.js';
import { reachabilityText } from '../reachability.js';
import { describeStatisticsZh } from '../../../lib/eval-statistics.js';
import { buildReportView, type HtmlReportView } from './report-view.js';
import type { EndpointTaskSummary } from '../../eval-tasks/endpoint-summary.js';

/**
 * HTML 报告视图模型 —— 纯数据，渲染器无关。
 * 由 BuiltReport 推导，复用 pdf.ts 的口径函数；按数据有无条件产出各小节，
 * 因此对全部报告方向（comprehensive / safety_overview / ... ）通用。
 */

export function reportIdentifierForDelivery(kind: string, reportId: string): string {
  return kind === 'service_assurance' ? '' : reportId;
}

export type SevTone = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'pass';

export interface HtmlMetaPair {
  k: string;
  v: string;
}

export interface HtmlVerdict {
  word: string;
  tone: 'good' | 'warn' | 'bad';
  grade: string;
  score: number;
  rationale: string;
  basis: string;
  isGatewayLog: boolean;
  density: string;
  densityDetail: string;
}

export interface HtmlScore {
  grade: string;
  score: number;
  base: number;
  riskDeduction: number;
  coverageDeduction: number;
  note: string;
  gate: string;
  isGatewayLog: boolean;
  density: string;
  densityDetail: string;
}

export interface HtmlKpi {
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
  muted?: boolean;
}

export interface HtmlDistRow {
  label: string;
  count: number;
  total: number;
  tone: SevTone;
}

export interface HtmlDistribution {
  n: number;
  pass: number;
  risk: number;
  error: number;
  rows: HtmlDistRow[];
  waffle: SevTone[];
  smallSample: boolean;
  sentence: string;
}

export interface HtmlEngineRow {
  engine: string;
  fold?: string;
  status: string;
  statusTone: 'ok' | 'skip' | 'warn';
  hits: string;
  duration: string;
  note: string;
}

export interface HtmlFinding {
  id: string;
  title: string;
  severityLabel: string;
  sevTone: SevTone;
  conclusion: string;
  fields: HtmlMetaPair[];
  basis: string;
  business?: string;
  /** 命中“评估沙箱已阻断”类证据时的兜底说明。 */
  sandboxNote?: string;
}

export interface HtmlRtTurn {
  round: string;
  phase: string;
  move: string;
  attacker: string;
  model: string;
  attitudeLabel: string;
  attitudeTone: 'pass' | 'medium' | 'high';
  broke: boolean;
  judgmentLabel?: string;
  wordingNote?: string;
  sourceLabel?: string;
}

export interface HtmlRtArcPoint {
  round: string;
  level: 0 | 1 | 2 | 3;
  breach: boolean;
}

export interface HtmlRtScenario {
  title: string;
  sideLabel: string;
  verdictLabel: string;
  broke: boolean;
  rounds: number;
  stopReason: string;
  movesUsed: string[];
  remediation: string;
  steps: Array<{ n: number; state: 'hold' | 'wob' | 'broke' | 'unknown' }>;
  /** 全量导出也保留未突破场景的逐轮原文。 */
  turns?: HtmlRtTurn[];
  breach?: {
    arc: HtmlRtArcPoint[];
    turns: HtmlRtTurn[];
    illustrative: boolean;
  };
}

export interface HtmlRedTeam {
  stats: { scenarios: number; rounds: number; broken: number; defended: number };
  scenarios: HtmlRtScenario[];
  note: string;
}

export interface HtmlReportModel {
  /** 评估依据：按测评线从标准条款主表取，见 packages/shared/src/standards。 */
  basis: { bases: string[]; references: string[]; statements: string[] };
  /** 标准条款对照表（每条测评线一张）。 */
  clauseTables: ClauseTable[];
  endpointContent?: string;
  /** 终端报告的结构化汇总；有它时导出走客户版版式。 */
  endpointSummary?: EndpointTaskSummary;
  generatedAtIso?: string;
  reachabilityText?: string;
  title: string;
  subtitle: string;
  kindLabel: string;
  classification: string;
  /** 报告模板的封面（标题、抬头、检测单位、委托单位）；不给用默认。 */
  cover?: ReportCoverOptions;
  /** 报告模板的页眉页脚；不给用默认。 */
  page?: ReportPageOptions;
  reportId: string;
  reportDate: string;
  generatedAt: string;
  coverMeta: HtmlMetaPair[];
  docControl: HtmlMetaPair[];
  verdict: HtmlVerdict;
  kpis: HtmlKpi[];
  distributionLead: string;
  score: HtmlScore;
  distribution: HtmlDistribution | null;
  engineRuns: HtmlEngineRow[];
  ruleGuide: PdfRuleCardItem[];
  aiJudgment: {
    posture: string;
    topRisks: string;
    remediationPriority: string;
    focus: string;
    gatewayNote?: string;
    sourceNote: string;
  } | null;
  conclusion: string;
  findings: HtmlFinding[];
  riskItemsBySeverity: RiskItemSeverityGroup[];
  evidenceDetail: ReportEvidenceDetail;
  compliance: ReportComplianceSummary | null;
  /** 按 key/源IP/agent_type 的风险分布归因（仅网关流量日志报告）。 */
  riskAttribution: ReportRiskAttribution | null;
  /** 单实体安全画像（分析被筛到单个 key/IP 时）。 */
  entityProfile: ReportEntityProfile | null;
  /** 致命危险分级 + 降噪三分类（标准锚定）。 */
  fatalRisks: ReportFatalRisks | null;
  /** 本次导出包含的「可选章节」；渲染层据此跳过未选章节。 */
  sectionScope: ReportSectionKey[];
  redTeam: HtmlRedTeam | null;
  remediationRows: string[][] | null;
  /** 推荐防护策略（来自该任务的策略建议；无数据时 empty=true）。 */
  protectionStrategy: ProtectionStrategySection | null;
  handoffRows: string[][];
  nextSteps: string[][];
  appendixScoringNote: string;
  appendixSampleNote: string;
  internationalFrameworkRows: ReturnType<typeof buildInternationalFrameworkSection>;
  /** 新版结构（管理层摘要 / 结果总览 / 整改计划 / 发现清单 / 附录口径）的派生视图。 */
  view: HtmlReportView;
}

const SEV_BY_LABEL: Array<{ re: RegExp; tone: SevTone }> = [
  { re: /严重|critical/i, tone: 'critical' },
  { re: /高危|high/i, tone: 'high' },
  { re: /中危|medium|中/i, tone: 'medium' },
  { re: /低危|low|低/i, tone: 'low' },
];

function sevToneFromLabel(label: string | null | undefined): SevTone {
  if (!label) return 'info';
  for (const m of SEV_BY_LABEL) if (m.re.test(label)) return m.tone;
  return 'info';
}

/** durationMs -> 人类可读（避免裸 1113356）。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

/** 归一化 attitude 标签：兼容原始英文枚举(loosened/soft_refuse/hard_refuse)与已持久化中文标签，存量报告下载也显示中文。 */
function normalizeAttitudeLabel(label: string | null | undefined): string {
  const raw = (label ?? '').trim();
  const v = raw.toLowerCase();
  if (v === 'hard_refuse' || /硬拒/.test(raw) || raw === '拒答') return '拒答';
  if (v === 'soft_refuse' || /软拒/.test(raw)) return '软拒绝';
  if (v === 'loosened' || /松口|配合|loosen|comply|unsafe/i.test(raw)) return '有限配合';
  if (/边界突破|破防|破局|broken/i.test(raw)) return '边界突破';
  return raw || '未记录';
}

function attitudeTone(label: string): 'pass' | 'medium' | 'high' {
  if (/拒/.test(label)) return 'pass';
  if (/有限配合|松口|配合|破/.test(label)) return 'high';
  return 'medium';
}

function attitudeLevel(label: string): 0 | 1 | 2 | 3 {
  if (/破/.test(label)) return 0;
  if (/有限配合|松口|配合/.test(label)) return 1;
  if (/软拒/.test(label)) return 2;
  if (/拒/.test(label)) return 3;
  return 2;
}

function splitMetaPairs(subtitle: string): HtmlMetaPair[] {
  return subtitle
    .split(/[·•]/)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      const idx = seg.search(/[：:]/);
      if (idx < 0) return { k: '', v: seg };
      return { k: seg.slice(0, idx).trim(), v: seg.slice(idx + 1).trim() };
    });
}

/**
 * 命中“评估沙箱已阻断”类证据时，明确评估环境与生产防护的边界。
 */
function sandboxBlockedNote(text: string): string | undefined {
  if (!text) return undefined;
  const blocked =
    /评估沙箱阻断|测评沙箱阻断|沙箱阻断|沙箱拦截|tool boundary blocked|blocked (ssrf|sensitive|run_shell|target|metadata)|human confirmation is required/i.test(
      text,
    );
  if (!blocked) return undefined;
  return '评估沙箱已阻断本次操作，表明模型仍产生了越权调用意图；该结果仅描述评估环境，不代表生产网关已拦截。建议完善工具授权、SSRF 防护、参数校验和最小权限配置后复测。';
}

export function buildReportHtmlModel(
  report: BuiltReport,
  opts: {
    kindLabel?: string;
    reportId?: string;
    classification?: string;
    cover?: ReportCoverOptions;
    page?: ReportPageOptions;
    severityFilter?: Severity[];
    riskDomainFilter?: RiskDomain[];
    evidenceDetail?: ReportEvidenceDetail;
    sections?: ReportSectionKey[];
    protectionStrategy?: ProtectionStrategySection | null;
    /** 报告所属测评线；不传时取报告快照里的 reportContext.evalLines，再不行按内容安全线。 */
    evalLines?: EvalLine[];
    /** 旧快照没有生成时间时的兜底（报告入库时间），避免把下载时间当成生成时间。 */
    generatedAtFallback?: string;
    /** 终端报告旧快照没有测评时间时的兜底（任务结束或开始时间）。 */
    assessedAtFallback?: string;
  } = {},
): HtmlReportModel {
  const R = reportHtmlReuse;
  const summary = report.summary;
  const charts = summary.charts;
  const score = R.securityScoreForSummary(summary);
  const conclusionSnapshot = summary.conclusionSnapshot ?? legacyReportConclusionSnapshot();
  const titleParts = buildReportTitleParts(report);
  const validCount =
    summary.conclusionSnapshot?.counts?.valid ?? summary.passedCount + summary.failedCount;
  const passPct = validCount > 0 ? (summary.passedCount / validCount) * 100 : null;
  const reviewRisks = summary.riskEvidencePortfolio?.activeRisks ?? [];
  const confirmedCount = reviewRisks.filter((r) => r.reviewStatus === 'CONFIRMED').length;
  const acceptedCount = reviewRisks.filter((r) => r.reviewStatus === 'ACCEPTED_RISK').length;
  const pendingCount = Math.max(0, summary.findingCount - confirmedCount - acceptedCount);
  const reviewNote = `人工确认 ${confirmedCount} 项；待复核 ${pendingCount} 项；已接受残余风险 ${acceptedCount} 项。`;
  const n = summary.totalQuestions || 0;
  // 被动网关流量分析不是考试，不给 0-100 分；改主打「风险密度＝命中风险 ÷ 总流量」。
  const isGatewayLog = summary.isGatewayTrafficLog === true;
  const densityPct = n > 0 ? (summary.failedCount / n) * 100 : 0;
  const density = `${densityPct.toFixed(densityPct < 10 ? 2 : 1)}%`;
  const densityDetail = `命中风险 ${summary.failedCount} / 总流量 ${n}`;

  // —— 冻结结论：HTML 只消费报告快照，不根据评分、通过率或风险等级自行推导。——
  const sev = summary.severityDistribution ?? {};
  const criticalCount = (sev.CRITICAL ?? 0) + (sev.critical ?? 0);
  const highCount = (sev.HIGH ?? 0) + (sev.high ?? 0);
  const word = renderReportConclusionStateZh(conclusionSnapshot);
  const vtone: 'good' | 'warn' | 'bad' =
    conclusionSnapshot.state === 'RISK_DETECTED'
      ? 'bad'
      : conclusionSnapshot.state === 'INCOMPLETE'
        ? 'warn'
        : 'good';
  const rationale =
    conclusionSnapshot.state === 'RISK_DETECTED'
      ? `本次 ${n} 个测试项中，${validCount} 项形成有效判定，系统标记 ${conclusionSnapshot.activeRiskCount ?? summary.findingCount} 项风险；${reviewNote}执行异常 ${summary.errorCount} 项。结论仅适用于本次测试范围。`
      : conclusionSnapshot.state === 'INCOMPLETE'
        ? '存在未完成执行、异常、未知判定或覆盖缺口；当前不能形成风险结论，请补齐后复测。'
        : '在本次冻结的评估范围和证据下未观察到有效风险；这不等同于系统绝对安全或合规认证。';
  const coverage = conclusionSnapshot.counts
    ? `预期 ${conclusionSnapshot.counts.expected} 条，观察到 ${conclusionSnapshot.counts.observed} 条，有效判定 ${conclusionSnapshot.counts.valid} 条`
    : '执行范围不可验证';
  const reasonText = renderReportConclusionReasonsZh(conclusionSnapshot).join('；');
  const statisticsText = describeStatisticsZh(summary.statistics);
  const basis = `结论快照：${coverage}。${reasonText ? `结论依据：${reasonText}。` : ''}${statisticsText ? `统计可信度：${statisticsText}` : ''}`;

  // —— KPI ——
  const passText = passPct === null ? '—' : `${passPct.toFixed(1)}%`;
  const kpis: HtmlKpi[] = [
    {
      label: '测试项',
      value: String(n),
      sub: `已处理 ${summary.processedQuestions}`,
      tone: 'neutral',
    },
    {
      label: '有效判定通过率',
      value: passText,
      sub: `${summary.passedCount} / ${validCount} 有效判定通过`,
      tone: 'neutral',
    },
    {
      label: '系统标记风险',
      value: String(summary.findingCount),
      sub:
        criticalCount > 0
          ? `严重 ${criticalCount}`
          : highCount > 0
            ? `高危 ${highCount}`
            : '题级风险',
      tone: summary.findingCount > 0 ? 'bad' : 'good',
    },
    isGatewayLog
      ? {
          label: '风险密度',
          value: density,
          sub: densityDetail,
          tone: summary.failedCount > 0 ? ('bad' as const) : ('good' as const),
        }
      : {
          label: '严重 / 高危',
          value: `${criticalCount} / ${highCount}`,
          sub: '按证据复核并确定整改优先级',
          tone: criticalCount + highCount > 0 ? ('bad' as const) : ('good' as const),
        },
    {
      label: '执行错误',
      value: String(summary.errorCount),
      sub: summary.errorCount > 0 ? '需排查' : '无引擎报错',
      tone: summary.errorCount > 0 ? 'warn' : 'neutral',
      muted: summary.errorCount === 0,
    },
  ];

  // —— 评分推导 + 门禁 ——
  const scoreModel: HtmlScore = {
    grade: score.grade,
    score: score.score,
    base: 100,
    riskDeduction: score.riskDeduction ?? 0,
    coverageDeduction: score.coverageDeduction ?? 0,
    note: `风险扣分：按检出风险严重度加权扣分；覆盖度扣分：未执行引擎按覆盖度扣分。整体风险按最严重项聚合，不取均值。`,
    gate: '',
    isGatewayLog,
    density,
    densityDetail,
  };

  // —— 风险分布（小样本诚实呈现）——
  let distribution: HtmlDistribution | null = null;
  const passN = summary.passedCount;
  const riskN = summary.failedCount;
  const errN = summary.errorCount;
  if (n > 0) {
    const rows: HtmlDistRow[] = [];
    for (const d of charts.severity ?? [])
      rows.push({
        label: `严重度 · ${d.label}`,
        count: d.value,
        total: n,
        tone: sevToneFromLabel(d.label),
      });
    for (const d of charts.verdict ?? [])
      rows.push({
        label: `判定 · ${d.label}`,
        count: d.value,
        total: n,
        tone: /通过|pass/i.test(d.label) ? 'pass' : 'high',
      });
    for (const d of charts.riskDomain ?? [])
      rows.push({ label: `风险域 · ${d.label}`, count: d.value, total: n, tone: 'high' });
    const waffle: SevTone[] = [
      ...Array<SevTone>(Math.max(0, passN)).fill('pass'),
      ...Array<SevTone>(Math.max(0, riskN)).fill('high'),
      ...Array<SevTone>(Math.max(0, errN)).fill('medium'),
    ];
    const nonZero = [
      passN > 0 ? `通过 ${passN}/${n}` : '',
      riskN > 0 ? `风险 ${riskN}/${n}` : '',
      errN > 0 ? `错误 ${errN}/${n}` : '',
    ].filter(Boolean);
    distribution = {
      n,
      pass: passN,
      risk: riskN,
      error: errN,
      rows,
      waffle: waffle.slice(0, 24),
      smallSample: n <= 10,
      sentence: `判定构成：${nonZero.join('、')}。`,
    };
  }
  const distributionLead =
    n > 0 && n <= 4
      ? `本次样本量 n=${n}，不适合用条形图（会把「少量」拉成满格误导观感）。下方以占比条 + 测试项点阵 + 计数表如实呈现，每个数字均带分母。`
      : `下方占比与计数均以「命中 / 总数」形式呈现，每个数字均带分母。`;

  // —— 引擎执行覆盖（去重 + 耗时格式化）——
  const engineRuns: HtmlEngineRow[] = [];
  const runs = charts.engineRuns ?? [];
  if (runs.length > 0) {
    const seen = new Map<string, { row: HtmlEngineRow; count: number }>();
    for (const raw of runs) {
      const d = {
        ...raw,
        engineLabel:
          raw.engineLabel === raw.engine ? reportEngineLabel(raw.engine) : raw.engineLabel,
        statusLabel: ENGINE_STATUS_LABELS[raw.status] ?? raw.statusLabel,
      };
      const key = `${d.engineLabel}|${d.statusLabel}`;
      const existing = seen.get(key);
      if (existing) {
        existing.count += 1;
        if (d.normalizedCount !== null) {
          const cur = Number(existing.row.hits) || 0;
          existing.row.hits = String(cur + d.normalizedCount);
        }
        continue;
      }
      const statusTone: HtmlEngineRow['statusTone'] = /跳过|skip/i.test(d.statusLabel)
        ? 'skip'
        : /失败|异常|error|错/i.test(d.statusLabel)
          ? 'warn'
          : 'ok';
      seen.set(key, {
        count: 1,
        row: {
          engine: d.engineLabel,
          status: d.statusLabel,
          statusTone,
          hits: d.normalizedCount === null ? '—' : String(d.normalizedCount),
          duration: formatDuration(d.durationMs),
          note: statusTone === 'skip' ? '本次未执行；不等于通过' : '记录数不等于风险数',
        },
      });
    }
    for (const { row, count } of seen.values()) {
      if (count > 1) row.fold = `×${count} 次`;
      engineRuns.push(row);
    }
  } else {
    for (const d of charts.engineStatus ?? []) {
      engineRuns.push({
        engine: d.label,
        status: d.label,
        statusTone: /跳过|skip/i.test(d.label) ? 'skip' : 'ok',
        hits: String(d.value),
        duration: '—',
        note: '',
      });
    }
  }

  // —— 规则解读 ——
  const ruleGuide = R.buildRuleGuide(report);

  // —— 总体研判 ——
  const aiJudgment = summary.aiJudgment
    ? {
        posture: isGatewayLog ? summary.aiJudgment.posture : rationale,
        topRisks: summary.aiJudgment.topRisks,
        remediationPriority: summary.aiJudgment.remediationPriority,
        focus: summary.aiJudgment.focus,
        gatewayNote: summary.aiJudgment.gatewayNote ?? undefined,
        sourceNote:
          summary.aiJudgment.source === 'llm'
            ? `整体摘要由模型 ${summary.aiJudgment.modelTargetName ?? '复核模型'} 生成，不等于逐项独立复核或人工确认。${reviewNote}`
            : `本摘要依据确定性统计与规则生成（${summary.aiJudgment.skippedReason ?? '未调用整体摘要模型'}），不代表人工复核。`,
      }
    : null;

  // —— 风险详情（finding 卡）——
  const findings: HtmlFinding[] = (summary.findingSamples ?? []).slice(0, 6).map((f, i) => {
    const basisText = R.riskExplanationForPdf(f);
    return {
      id: `F-${String(i + 1).padStart(3, '0')}`,
      title: R.riskTypeLabelForPdf(f),
      severityLabel: f.severityLabel,
      sevTone: sevToneFromLabel(f.severityLabel),
      conclusion: R.normalizeSandboxActorWording(basisText),
      fields: [
        { k: '风险类型', v: R.riskTypeLabelForPdf(f) },
        { k: '判定结果', v: R.ruleActionLabelForPdf(f) },
        { k: '严重等级', v: f.severityLabel },
        { k: '引擎', v: f.engineLabel },
      ],
      basis: basisText,
      business: f.evidence ? (R.shortInline(f.evidence, 200) ?? undefined) : undefined,
      sandboxNote: sandboxBlockedNote(`${basisText} ${f.evidence ?? ''}`),
    };
  });

  // —— 多轮红队（含破防还原）——
  let redTeam: HtmlRedTeam | null = null;
  const rt = summary.redTeamSummary;
  if (rt && rt.samples.length > 0) {
    const scenarios: HtmlRtScenario[] = rt.samples.map((s) => {
      // 状态来自稳定枚举；兼容旧冻结快照，绝不把中文文案当作唯一业务契约。
      const legacyVerdict = s.verdictLabel.trim();
      const failedLabel = /^(未通过|风险|FAIL)$/i.test(legacyVerdict);
      const otherVerdict = /^(通过|PASS|执行异常|错误|ERROR|未判定|UNKNOWN)$/i.test(legacyVerdict);
      const broke =
        s.finalVerdict != null
          ? s.finalVerdict === 'FAIL'
          : failedLabel ||
            (!otherVerdict &&
              /^(success|verdict|已破局|发生边界突破)$/.test(s.stopReason ?? s.stopReasonLabel));
      const rounds = Math.max(1, s.rounds || s.transcript.length || 1);
      // 场景最终判定不等同于最后一轮态度。只用记录中的态度绘图，不补造拒答或突破。
      const recordedTurns: HtmlRtTurn[] = s.transcript.map((t) => {
        const label = normalizeAttitudeLabel(t.attitudeLabel);
        const judgment = t.roundJudgment;
        const assessed = judgment?.source === 'judge';
        const verdict = assessed ? judgment.verdict : undefined;
        return {
          round: t.roundLabel,
          phase: t.phaseLabel,
          move: t.moveLabel,
          attacker: t.attackerMessage,
          model: t.modelResponse,
          attitudeLabel: label,
          attitudeTone: verdict === 'FAIL' ? 'high' : verdict === 'PASS' ? 'pass' : 'medium',
          broke: verdict === 'FAIL',
          judgmentLabel:
            verdict === 'FAIL'
              ? '该轮裁判：风险'
              : verdict === 'PASS'
                ? '该轮裁判：通过'
                : verdict === 'ERROR'
                  ? '该轮裁判：执行异常'
                  : judgment
                    ? '该轮裁判：未判定'
                    : '该轮内容判定未记录，需复核',
          wordingNote: t.wordingSignals
            ? `措辞信号：${
                [
                  t.wordingSignals.empty ? '响应为空' : '',
                  t.wordingSignals.refusal ? '含拒答措辞' : '',
                  t.wordingSignals.qualification ? '含限定措辞' : '',
                  t.wordingSignals.continuation ? '含继续回答措辞' : '',
                ]
                  .filter(Boolean)
                  .join('；') || '未识别特定措辞'
              }（不代表内容安全判定）`
            : `历史措辞标签：${label}（不代表内容安全判定）`,
          sourceLabel: t.sourceId
            ? `轨迹 ${t.sourceId} · ${t.roundLabel}`
            : `历史轨迹 · ${t.roundLabel}（请求标识未记录）`,
        };
      });
      const steps = recordedTurns.map((turn, idx) => ({
        n: Number(turn.round.match(/\d+/)?.[0] ?? idx + 1),
        state: (turn.broke
          ? 'broke'
          : turn.judgmentLabel === '该轮裁判：通过'
            ? 'hold'
            : 'unknown') as 'hold' | 'wob' | 'broke' | 'unknown',
      }));
      const detail = opts.evidenceDetail ?? 'full';
      const turns = detail === 'full' || (detail === 'summary' && broke) ? recordedTurns : [];
      let breach: HtmlRtScenario['breach'] | undefined;
      if (broke && turns.length > 0) {
        // 缺失/未知态度不能被默认数值伪装成“中性”，也不能跨缺口连成完整曲线。
        const allAttitudesRecorded = turns.every(
          (t) => t.judgmentLabel === '该轮裁判：风险' || t.judgmentLabel === '该轮裁判：通过',
        );
        const arc: HtmlRtArcPoint[] = allAttitudesRecorded
          ? turns.map((t) => ({
              round: t.round,
              level: t.broke ? (0 as const) : (3 as const),
              breach: t.broke,
            }))
          : [];
        breach = { arc, turns, illustrative: false };
      }
      return {
        title: s.scenarioTitle,
        sideLabel: s.sideLabel,
        verdictLabel: s.verdictLabel,
        broke,
        rounds,
        stopReason: s.stopReasonLabel,
        movesUsed: s.movesUsed,
        remediation: R.normalizeSandboxActorWording(s.remediation),
        steps,
        turns,
        breach,
      };
    });
    // 优先展示发生边界突破的场景。
    scenarios.sort((a, b) => Number(b.broke) - Number(a.broke));
    redTeam = {
      stats: {
        scenarios: rt.scenarioCount,
        rounds: rt.totalRounds,
        broken: rt.brokenCount,
        defended: rt.scenarioCount - rt.brokenCount,
      },
      scenarios,
      note:
        R.reportRedTeamEvidenceCoverage(rt) +
        ((opts.evidenceDetail ?? 'full') === 'full'
          ? '当前导出展示快照内全部逐轮记录。场景判定与逐轮态度分别呈现。'
          : '当前模板展示轨迹概览；完整交互请使用全量报告。'),
    };
  }

  // —— 整改 / 责任 / 计划 ——
  const remediationItems = summary.remediationItems ?? [];
  const remediationRows =
    remediationItems.length > 0
      ? remediationItems.map((item) => [
          item.priority,
          R.normalizeSandboxActorWording(item.title),
          item.riskCategoryLabel,
          R.normalizeSandboxActorWording(
            [item.action, item.responsibility ? `责任：${item.responsibility}` : '']
              .filter(Boolean)
              .join('\n'),
          ),
          R.normalizeSandboxActorWording(
            [item.verification, item.verificationScope ? `范围：${item.verificationScope}` : '']
              .filter(Boolean)
              .join('\n'),
          ),
          remediationStatusLabel(item.status),
          item.dueAt ? formatDateTime(new Date(item.dueAt)) : '截止时间待客户补充',
          item.retestTaskId ?? '复测任务待关联',
          R.normalizeSandboxActorWording(item.closureEvidence ?? '关闭证据待补充'),
        ])
      : null;

  // 兼容旧报告快照：早期风险项没有持久化 riskDomain，下载时按统一分类器补齐。
  const normalizedRiskGroups = (summary.riskItemsBySeverity ?? []).map((group) => ({
    ...group,
    items: group.items.map((item) => {
      const storedDomain = (item as { riskDomain?: RiskDomain }).riskDomain;
      const domain =
        storedDomain ??
        riskDomainForCategory(
          item.riskCategoryLabel,
          `${item.questionContent} ${item.riskExplanation}`,
        );
      return {
        ...item,
        riskDomain: domain,
        riskDomainLabel:
          (item as { riskDomainLabel?: string }).riskDomainLabel ?? riskDomainLabel(domain),
      };
    }),
  }));
  const riskItemsBySeverity = filterRiskItemGroups(normalizedRiskGroups, {
    severityFilter: opts.severityFilter,
    riskDomainFilter: opts.riskDomainFilter,
  });

  const context = summary.reportContext;
  const generatedTime = context?.generatedAt ? formatDateTime(new Date(context.generatedAt)) : '';
  const subtitle = generatedTime
    ? titleParts.subtitle.replace(/(?:报告)?生成：[^·]*/, `报告生成：${generatedTime} `).trim()
    : titleParts.subtitle;
  const coverMeta = splitMetaPairs(subtitle);
  coverMeta.push({
    k: '样本规模',
    v: `${n} 个测试项${rt ? ` · ${rt.scenarioCount} 场景 · ${rt.totalRounds} 轮交互` : ''}`,
  });
  const reportId = opts.reportId ?? '';
  const classification = opts.classification?.trim() || '内部使用';
  const generatedMeta = coverMeta.find((p) => /生成/.test(p.k))?.v ?? '';

  const view = buildReportView({
    report,
    allGroups: normalizedRiskGroups,
    shownGroups: riskItemsBySeverity,
    title: neutralizeCertificationWording(titleParts.title),
    reportId,
    classification,
    score: isGatewayLog ? null : { score: score.score, grade: score.grade },
    generatedAtIso: context?.generatedAt,
  });

  const evalLines =
    opts.evalLines ?? (context as { evalLines?: EvalLine[] } | undefined)?.evalLines ?? ['content'];
  const basisList = reportBasesForLines(evalLines);
  const generatedIso = context?.generatedAt ?? opts.generatedAtFallback;
  const endpointSummary = summary.endpointSummary
    ? {
        ...summary.endpointSummary,
        ...(!summary.endpointSummary.assessedAt && opts.assessedAtFallback
          ? { assessedAt: opts.assessedAtFallback }
          : {}),
      }
    : undefined;

  const clauseTables = buildClauseTables(evalLines, summary.standardClauses);
  // 管理层摘要补一句标准覆盖说明，避免小样本报告读成「全面无风险」。
  view.exec.sentences.push(...clauseCoverageNotes(clauseTables));

  return {
    basis: { ...basisLines(basisList), statements: basisList.statements },
    clauseTables,
    ...(endpointSummary ? { endpointContent: report.content, endpointSummary } : {}),
    ...(generatedIso ? { generatedAtIso: new Date(generatedIso).toISOString() } : {}),
    view,
    reachabilityText: reachabilityText(summary.reachability),
    title: neutralizeCertificationWording(titleParts.title),
    subtitle,
    kindLabel: opts.kindLabel ?? '综合评估报告',
    classification,
    ...(opts.cover ? { cover: opts.cover } : {}),
    ...(opts.page ? { page: opts.page } : {}),
    reportId,
    reportDate: (generatedMeta.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/) ?? [''])[0],
    generatedAt: generatedMeta,
    coverMeta,
    docControl: [
      { k: '报告标题', v: report.title },
      { k: '评估范围', v: `共 ${n} 个测试项` + (rt ? `，自主红队 ${rt.scenarioCount} 场景` : '') },
      { k: '报告生成时间', v: generatedMeta || '—' },
      {
        k: '时间含义',
        v: '后端开始汇总本次报告的时间；任务执行时间单独列示。下载已有报告不改变该时间。',
      },
      ...(context
        ? [
            {
              k: '任务开始时间',
              v: context.taskStartedAt ? formatDateTime(new Date(context.taskStartedAt)) : '未记录',
            },
            {
              k: '任务结束时间',
              v: context.taskFinishedAt
                ? formatDateTime(new Date(context.taskFinishedAt))
                : '未记录',
            },
            {
              k: '评估对象',
              v:
                context.targetType === 'RED_TEAM_SINGLE'
                  ? '自主红队：单对象评估'
                  : context.targetType || '未记录',
            },
            { k: '业务场景', v: context.businessScenario || '未提供；需业务负责人确认适用边界' },
            {
              k: '部署方式',
              v:
                (
                  {
                    third_party_api: '调用第三方模型 API',
                    self_hosted_open_weights: '自行部署开放权重模型',
                    self_trained: '自研训练模型',
                    unknown: '未提供；不推断客户拥有模型权重或工具权限',
                  } as Record<string, string>
                )[context.deploymentMode || 'unknown'] || '未提供',
            },
            { k: '可控范围', v: context.controlScope || '未提供；整改措施需与业务和维护方确认' },
          ]
        : []),
      { k: '风险复核状态', v: reviewNote },
      ...(summary.explanationRun
        ? [
            {
              k: '逐项风险解释',
              v: R.reportExplanationRunTextForPdf(summary.explanationRun)!,
            },
          ]
        : []),
      ...(classification ? [{ k: '密级 / 分发', v: classification }] : []),
    ],
    verdict: {
      word,
      tone: vtone,
      grade: score.grade,
      score: score.score,
      rationale,
      basis,
      isGatewayLog,
      density,
      densityDetail,
    },
    kpis,
    distributionLead,
    score: scoreModel,
    distribution,
    engineRuns,
    ruleGuide,
    aiJudgment,
    conclusion: rationale,
    findings,
    riskItemsBySeverity,
    evidenceDetail: opts.evidenceDetail ?? 'full',
    compliance: summary.compliance ?? null,
    internationalFrameworkRows: buildInternationalFrameworkSection([
      ...new Set(
        (summary.riskItemsBySeverity ?? []).flatMap((group) =>
          group.items.map(
            (item) =>
              item.riskDomain ??
              riskDomainForCategory(
                item.riskCategoryLabel,
                `${item.questionContent} ${item.riskExplanation}`,
              ),
          ),
        ),
      ),
    ]),
    riskAttribution: summary.riskAttribution ?? null,
    entityProfile: summary.entityProfile ?? null,
    fatalRisks: summary.fatalRisks ?? null,
    sectionScope: opts.sections ?? [...REPORT_OPTIONAL_SECTIONS],
    redTeam,
    remediationRows,
    protectionStrategy: opts.protectionStrategy ?? null,
    handoffRows: R.buildRemediationHandoffRows(report),
    nextSteps: R.buildNextAnalysisPlan(report),
    appendixScoringNote:
      '结论口径：本报告区分风险标记、未观察到风险和结论不完整；自动检测、逐项解释与人工复核分别列示；风险按严重度（严重/高危/中危/低危）逐条列明并给出整改与复测要求。报告不输出量化评分数字，不作可上线、绝对安全或合规认证结论。',
    appendixSampleNote:
      n > 0 && n <= 10
        ? `样本量声明：本次评估基于 ${n} 个测试项，属小样本探测，分布占比仅作方向性参考；建议扩大样本并复测以形成稳定结论。`
        : '评估结果受测试范围、配置和尝试预算限制；多轮交互不等于独立样本。原始记录按来源和轮次追溯。',
  };
}
