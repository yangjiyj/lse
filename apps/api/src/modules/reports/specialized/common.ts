import { createHash } from 'node:crypto';
import type { RiskDomain, Severity, Verdict } from '@lse/shared';
import {
  buildRiskEvidencePortfolioSnapshot,
  buildAgentTraceSamples,
  type BuiltReportRiskDistribution,
  type ChartDatum,
  type ReportFinding,
  type ReportEngineRun,
  type ReportEvalResult,
  type ReportInputData,
} from '../report-builder.js';
import {
  buildReportRiskContext,
  classifyReportRiskViewFailDisposition,
  fullReportRiskView,
  type ReportRiskContext,
  type ReportRiskView,
} from '../report-risk-context.js';
import {
  formatDateTime,
  ENGINE_STATUS_LABELS,
  engineLabel,
  riskDomainForCategory,
  riskDomainLabel,
  riskLabel,
  SEVERITY_LABELS,
  SEVERITY_ORDER,
  severityLabel,
  VERDICT_LABELS,
} from '../labels.js';
import {
  REPORT_KIND_LABELS,
  type ReportKind,
  type SpecializedCharts,
  type SpecializedReport,
} from './types.js';
import { buildSecurityScore } from '../scoring.js';
import {
  buildReportConclusionSnapshot,
  renderReportConclusionReasonsZh,
  renderReportConclusionStateZh,
  type DeterministicReportConclusionSnapshot,
  type ReportConclusionScopeKind,
} from '../report-conclusion.js';

export function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function passRateFromVerdicts(
  results: readonly { finalVerdict: Verdict | null }[],
): number | null {
  const valid = results.filter((result) => ['PASS', 'FAIL'].includes(result.finalVerdict ?? ''));
  if (valid.length === 0) return null;
  return valid.filter((result) => result.finalVerdict === 'PASS').length / valid.length;
}

export function passRatePercentFromVerdicts(
  results: readonly { finalVerdict: Verdict | null }[],
): number | null {
  const rate = passRateFromVerdicts(results);
  return rate === null ? null : Math.round(rate * 1000) / 10;
}

export function executionGapCountFromVerdicts(
  results: readonly { finalVerdict: Verdict | null }[],
): number {
  return results.filter(
    (result) =>
      result.finalVerdict === null ||
      result.finalVerdict === 'UNKNOWN' ||
      result.finalVerdict === 'ERROR',
  ).length;
}

export function executionGapCountFromConclusion(
  conclusion: DeterministicReportConclusionSnapshot,
): number {
  return conclusion.counts.error + conclusion.counts.unknown + conclusion.counts.missingVerdict;
}

export function passRatePercentFromConclusion(
  conclusion: DeterministicReportConclusionSnapshot,
): number | null {
  return conclusion.passRate === null ? null : Math.round(conclusion.passRate * 1000) / 10;
}

export function coverageStatusFromConclusion(
  conclusion: DeterministicReportConclusionSnapshot,
): '完整' | '不完整' {
  return conclusion.coverageComplete ? '完整' : '不完整';
}

export function chartFromRecord(
  record: Record<string, number>,
  labeler = (key: string) => key,
): ChartDatum[] {
  return Object.entries(record)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ key, label: labeler(key), value }));
}

/** 专项报告（含终端报告）里一项风险的风险类别。 */
export function specializedFindingDomain(
  finding: Pick<ReportFinding, 'riskCategory' | 'title' | 'evidence'>,
): RiskDomain {
  return riskDomainForCategory(finding.riskCategory, finding.title ?? finding.evidence);
}

export function distributionFromFindings(findings: ReportFinding[]): BuiltReportRiskDistribution {
  const bySeverity: Record<string, number> = {};
  const riskCategoryCounts = new Map<string, number>();
  const byRiskDomain: Record<string, number> = {};
  for (const finding of findings) {
    const severity = finding.severity ?? 'UNKNOWN';
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
    riskCategoryCounts.set(
      finding.riskCategory,
      (riskCategoryCounts.get(finding.riskCategory) ?? 0) + 1,
    );
    const domain = specializedFindingDomain(finding);
    byRiskDomain[domain] = (byRiskDomain[domain] ?? 0) + 1;
  }
  const byRiskCategory = Object.fromEntries(riskCategoryCounts);
  return { bySeverity, byRiskCategory, byRiskDomain };
}

const SENSITIVE_TEXT_RE = /\b(?:authorization|token|secret|password|canary|api[_\s-]*key|key)\b/i;
const AUTH_BEARER_RE = /Authorization:\s*Bearer\s+([^\s,;]+)/gi;
const BEARER_RE = /Bearer\s+([^\s,;]+)/gi;
const SECRET_VALUE_RE = /(sk-[a-z0-9_-]+|tok-[a-z0-9_-]+|canary-[a-z0-9_-]+|CANARY[-_A-Z0-9]+)/gi;

function hashSensitive(value: string): string {
  return `hash:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

export function sanitizeReportText(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  const redacted = value
    .replace(AUTH_BEARER_RE, (_match, secret: string) => `Authorization: ${hashSensitive(secret)}`)
    .replace(BEARER_RE, (_match, secret: string) => `Bearer ${hashSensitive(secret)}`)
    .replace(SECRET_VALUE_RE, (secret) => hashSensitive(secret));
  return SENSITIVE_TEXT_RE.test(redacted) ? hashSensitive(redacted) : redacted;
}

export function topFindings(findings: ReportFinding[], limit = 5) {
  const order: Record<Severity, number> = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };
  return [...findings]
    .sort((a, b) => (b.severity ? order[b.severity] : 0) - (a.severity ? order[a.severity] : 0))
    .slice(0, limit)
    .map((finding) => ({
      title: finding.title ?? riskLabel(finding.riskCategory),
      severity: finding.severity,
      evidence: sanitizeReportText(finding.evidence),
    }));
}

function cell(v: unknown): string {
  const text = String(v ?? '—')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
  return text || '—';
}

export function mdTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.length
    ? rows.map((row) => `| ${row.map(cell).join(' | ')} |`).join('\n')
    : `| ${headers.map(() => '—').join(' | ')} |`;
  return `${head}\n${sep}\n${body}`;
}

const METRIC_LABELS: Record<string, string> = {
  totalQuestions: '样本总数',
  passRatePercent: '通过率（%）',
  failedCount: '执行未通过数',
  riskCount: '风险项数量',
  refusalQuestionCount: '应拒答样本数',
  refusalPassRatePercent: '拒答通过率（%）',
  unrefusedRiskCount: '未拒答风险项',
  promptInjectionQuestionCount: '提示注入样本数',
  resistanceRatePercent: '提示注入抵御率（%）',
  promptInjectionFindingCount: '提示注入风险项',
  triggeredEngineCount: '触发风险的检测引擎数',
  componentFindingCount: '组件风险项',
  scanRunCount: '组件扫描次数',
  failedRunCount: '扫描失败次数',
  coverageStatus: '执行完整性',
  normalizedCount: '归一化结果数',
  languageCount: '覆盖语言数',
  zhPassRatePercent: '中文样本通过率（%）',
  enPassRatePercent: '英文样本通过率（%）',
  agentSampleCount: '智能体工具调用样本数',
  agentPassRatePercent: '智能体样本通过率（%）',
  agentRiskCount: '工具调用风险项',
  agentRiskTypeCount: '聚合风险类型数',
  agentTraceCount: '工具调用轨迹数',
  observedToolCallCount: '平台真实工具调用数',
  observedRiskToolCallCount: '平台事后观测风险调用数',
  endpointToolCallCount: '终端真实工具事件数',
  allowedRiskToolCallCount: '放行的危险工具调用数',
  blockedToolCallCount: '评估沙箱阻断高风险工具调用数',
  gatewayPolicySuggestionCount: '网关策略建议数',
  generalQuestionCount: '通用样本数',
  usableAnswerCount: '可用回答数',
  usableAnswerRatePercent: '可用回答率(%)',
  nonUsableCount: '明确不可用样本数',
  executionGapCount: '执行覆盖缺口',
  highestSeverity: '最高严重等级',
};

function metricRows(metrics: Record<string, number | string | null>): string[][] {
  return Object.entries(metrics).map(([key, value]) => [
    key === 'blockedToolCallCount' && 'endpointToolCallCount' in metrics
      ? '终端防护拦截危险尝试数'
      : METRIC_LABELS[key] ?? key,
    value == null ? '—' : String(value),
  ]);
}

function topFindingRows(findings: ReturnType<typeof topFindings>): string[][] {
  return findings.map((finding, index) => [
    String(index + 1),
    finding.title,
    severityLabel(finding.severity),
    finding.evidence ?? '—',
  ]);
}

/** 键序固定为 PASS/FAIL/ERROR/UNKNOWN，与结论快照一致；写入前的快照比对按字符串比较，顺序不同会被判为不一致。 */
function scopedVerdictDistribution(results: readonly ReportEvalResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    if (!result.finalVerdict) continue;
    counts[result.finalVerdict] = (counts[result.finalVerdict] ?? 0) + 1;
  }
  return Object.fromEntries(
    (['PASS', 'FAIL', 'ERROR', 'UNKNOWN'] as const).flatMap((verdict) =>
      counts[verdict] ? [[verdict, counts[verdict]]] : [],
    ),
  );
}

function scopedScoreFindings(riskView: ReportRiskView) {
  return [
    ...riskView.risks.map((risk) => ({
      ...risk.representative,
      reviewStatus: risk.reviewStatus,
    })),
    ...riskView.excludedRisks.map((risk) => ({
      ...risk.representative,
      reviewStatus: 'FALSE_POSITIVE' as const,
    })),
  ];
}

export function makeSpecializedReport(args: {
  kind: ReportKind;
  conclusionScopeKind: ReportConclusionScopeKind;
  data: ReportInputData;
  headline: string | ((conclusion: DeterministicReportConclusionSnapshot) => string);
  metrics:
    | Record<string, number | string | null>
    | ((
        conclusion: DeterministicReportConclusionSnapshot,
      ) => Record<string, number | string | null>);
  charts?: Partial<Pick<SpecializedCharts, 'byLanguage'>>;
  findings?: ReportFinding[];
  results?: ReportEvalResult[];
  engineRuns?: ReportEngineRun[];
  riskDistribution?: BuiltReportRiskDistribution;
  context?: ReportRiskContext;
  riskView?: ReportRiskView;
  sections: string[];
}): SpecializedReport {
  const context = args.context ?? buildReportRiskContext(args.data);
  const riskView = args.riskView ?? fullReportRiskView(context);
  const results = args.results ?? context.primaryResults;
  const engineRuns = args.engineRuns ?? args.data.engineRuns;
  const label = REPORT_KIND_LABELS[args.kind];
  const findings = args.findings ?? riskView.representativeFindings;
  const riskDistribution = args.riskDistribution ?? distributionFromFindings(findings);
  const top = topFindings(findings);
  const verdictDistribution = scopedVerdictDistribution(results);
  const conclusionSnapshot = buildReportConclusionSnapshot({
    scopeKind: args.conclusionScopeKind,
    task: args.data.task,
    activeRiskCount: riskView.findingCount,
    results,
    engineRuns,
    failDisposition: classifyReportRiskViewFailDisposition(results, riskView),
  });
  const headline =
    typeof args.headline === 'function' ? args.headline(conclusionSnapshot) : args.headline;
  const metrics =
    typeof args.metrics === 'function' ? args.metrics(conclusionSnapshot) : args.metrics;
  const passRate = conclusionSnapshot.passRate;
  const byEngineStatus: Record<string, number> = {};
  for (const run of engineRuns) {
    byEngineStatus[run.status] = (byEngineStatus[run.status] ?? 0) + 1;
  }
  const securityScore = buildSecurityScore({
    findings: scopedScoreFindings(riskView),
    engineRuns,
    coverageIncomplete: !conclusionSnapshot.coverageComplete,
  });
  const charts: SpecializedCharts = {
    severity: [
      ...SEVERITY_ORDER.filter((severity) => (riskDistribution.bySeverity[severity] ?? 0) > 0).map(
        (severity) => ({
          key: severity,
          label: SEVERITY_LABELS[severity],
          value: riskDistribution.bySeverity[severity] ?? 0,
        }),
      ),
      ...((riskDistribution.bySeverity.UNKNOWN ?? 0) > 0
        ? [
            {
              key: 'UNKNOWN',
              label: severityLabel(null),
              value: riskDistribution.bySeverity.UNKNOWN ?? 0,
            },
          ]
        : []),
    ],
    verdict: Object.entries(verdictDistribution).map(([verdict, value]) => ({
      key: verdict,
      label: VERDICT_LABELS[verdict as Verdict] ?? verdict,
      value,
    })),
    riskCategory: chartFromRecord(riskDistribution.byRiskCategory, riskLabel),
    riskDomain: chartFromRecord(riskDistribution.byRiskDomain, riskDomainLabel),
    engineStatus: Object.entries(byEngineStatus).map(([status, value]) => ({
      key: status,
      label: ENGINE_STATUS_LABELS[status] ?? status,
      value,
    })),
    engineRuns: engineRuns.map((run) => ({
      engine: run.engine,
      engineLabel: engineLabel(run.engine),
      status: run.status,
      statusLabel: ENGINE_STATUS_LABELS[run.status] ?? run.status,
      normalizedCount: run.normalizedCount,
      skippedCount: run.skippedCount,
      durationMs: run.durationMs,
    })),
    passRatePercent: passRate === null ? null : Math.round(passRate * 1000) / 10,
    ...(args.charts ?? {}),
  };
  const summary = {
    totalQuestions: conclusionSnapshot.counts.expected,
    processedQuestions: conclusionSnapshot.counts.observed,
    passedCount: conclusionSnapshot.counts.pass,
    failedCount: conclusionSnapshot.counts.fail,
    errorCount: conclusionSnapshot.counts.error,
    wrongAnswerCount: riskView.risks.filter((risk) => Boolean(risk.context.wrongAnswer)).length,
    evidenceFindingCount: riskView.evidenceFindingCount,
    findingCount: riskView.findingCount,
    riskEvidencePortfolio: buildRiskEvidencePortfolioSnapshot({
      activeRisks: riskView.risks,
      excludedRisks: riskView.excludedRisks,
    }),
    securityScore,
    conclusionSnapshot,
    ...(args.data.task.assessmentTarget
      ? { assessmentTarget: args.data.task.assessmentTarget }
      : {}),
    verdictDistribution,
    severityDistribution: riskDistribution.bySeverity,
    charts,
    findingSamples: [],
    wrongAnswerSamples: [],
    riskItemsBySeverity: [],
    agentTraceSamples: buildAgentTraceSamples(riskView.activeFindings, engineRuns),
    remediationItems: [],
    kind: args.kind,
    headline,
    metrics,
    topFindings: top,
  };
  const content = [
    '# ' + label,
    '',
    '> 任务名称：' + args.data.task.name,
    ...(args.data.task.assessmentTarget
      ? [
          '> ' +
            (args.data.task.assessmentTarget.mode === 'RED_TEAM_PROTECTED'
              ? '主评估对象（防护后）：'
              : '评估对象：') +
            args.data.task.assessmentTarget.evaluatedTarget.displayName +
            '（' +
            args.data.task.assessmentTarget.evaluatedTarget.provider +
            ' / ' +
            args.data.task.assessmentTarget.evaluatedTarget.model +
            '）',
          ...(args.data.task.assessmentTarget.baselineTarget
            ? [
                '> 基线对象（未接入防护）：' +
                  args.data.task.assessmentTarget.baselineTarget.displayName +
                  '（' +
                  args.data.task.assessmentTarget.baselineTarget.provider +
                  ' / ' +
                  args.data.task.assessmentTarget.baselineTarget.model +
                  '）',
                '> 评估口径：主结论以防护后对象结果为准；基线对象仅用于效果对照。',
              ]
            : []),
        ]
      : []),
    '> 生成时间：' + formatDateTime(args.data.generatedAt),
    '',
    '## 评估结论',
    '',
    `**${renderReportConclusionStateZh(conclusionSnapshot)}**`,
    '',
    `结论依据：${renderReportConclusionReasonsZh(conclusionSnapshot).join('；') || '当前范围内未发现影响结论的异常。'}`,
    '',
    '> 结论仅适用于本次评估对象、样本范围、检测配置和执行时间，不代表绝对安全或合规认证。',
    '',
    '## 结果摘要',
    '',
    headline,
    '',
    '## 关键指标',
    '',
    mdTable(['指标', '值'], metricRows(metrics)),
    '',
    ...args.sections,
    '',
    '## 重点风险',
    '',
    mdTable(['序号', '风险', '等级', '证据'], topFindingRows(top)),
    '',
  ].join('\n');

  return {
    kind: args.kind,
    title: label + ' - ' + args.data.task.name,
    format: 'markdown',
    content,
    summary,
    passRate,
    totalQuestions: conclusionSnapshot.counts.expected,
    riskDistribution,
  };
}

export function matchesAny(text: string | null | undefined, patterns: RegExp[]): boolean {
  const value = text ?? '';
  return patterns.some((pattern) => pattern.test(value));
}
