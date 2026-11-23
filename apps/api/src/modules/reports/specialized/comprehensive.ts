import { buildTaskReport, type BuiltReport, type ReportInputData } from '../report-builder.js';
import { buildReportRiskContext, type ReportRiskContext } from '../report-risk-context.js';
import { formatDateTime } from '../labels.js';
import { buildSafetyOverviewReport } from './safety-overview.js';
import { buildRefusalCapabilityReport } from './refusal-capability.js';
import { buildPromptInjectionResilienceReport } from './prompt-injection-resilience.js';
import { buildComponentVulnerabilityReport } from './component-vulnerability.js';
import { buildServiceAssuranceReport } from './service-assurance.js';
import { buildMultilingualCoverageReport } from './multilingual-coverage.js';
import { buildAgentToolAbuseReport } from './agent-tool-abuse.js';
import { buildUsabilityOverRefusalReport } from './usability-over-refusal.js';
import { applicableReportKinds } from './applicability.js';
import { scrubSinkUrls, tailorPlatformBaseReport } from './platform-agent.js';
import { isPlatformAgentReport } from './scope.js';
import { REPORT_KIND_LABELS, type ReportKind, type SpecializedReport } from './types.js';

function buildSingle(
  kind: Exclude<ReportKind, 'comprehensive'>,
  data: ReportInputData,
  base: BuiltReport,
  context: ReportRiskContext,
): SpecializedReport {
  switch (kind) {
    case 'safety_overview':
      return buildSafetyOverviewReport(data, base, context);
    case 'refusal_capability':
      return buildRefusalCapabilityReport(data, context);
    case 'prompt_injection_resilience':
      return buildPromptInjectionResilienceReport(data, context);
    case 'component_vulnerability':
      return buildComponentVulnerabilityReport(data, context);
    case 'service_assurance':
      return buildServiceAssuranceReport(data);
    case 'multilingual_coverage':
      return buildMultilingualCoverageReport(data, context);
    case 'agent_tool_abuse':
      return buildAgentToolAbuseReport(data, context);
    case 'usability_over_refusal':
      return buildUsabilityOverRefusalReport(data, context);
    case 'gbt45654_content':
      throw new Error('国标报告不经通用报告构建流程生成');
  }
}

function demoteMarkdownHeadings(markdown: string, label: string): string {
  const lines = markdown.split('\n');
  if (lines[0]?.startsWith('# ')) lines.shift();
  const demoted = lines.map((line) => (/^#{2,6}\s/.test(line) ? `#${line}` : line));
  return [`## ${label}`, '', ...demoted].join('\n').trim();
}

function reportCoverageTable(reports: SpecializedReport[]): string {
  const rows = reports.map(
    (report) =>
      `| ${REPORT_KIND_LABELS[report.kind]} | ${String(report.summary.headline).replace(/\|/g, '\\|')} |`,
  );
  return ['| 报告方向 | 摘要 |', '| --- | --- |', ...rows].join('\n');
}

export interface ComprehensiveReportDependencies {
  buildBase?: (data: ReportInputData, context?: ReportRiskContext) => BuiltReport;
  buildContext?: (data: ReportInputData) => ReportRiskContext;
  onContextBuilt?: (context: ReportRiskContext) => void;
}

export function buildComprehensiveReport(
  data: ReportInputData,
  dependencies: ComprehensiveReportDependencies = {},
  providedContext?: ReportRiskContext,
): SpecializedReport {
  const context = providedContext ?? (dependencies.buildContext ?? buildReportRiskContext)(data);
  dependencies.onContextBuilt?.(context);
  const base = dependencies.buildBase
    ? dependencies.buildBase(data, context)
    : buildTaskReport(data, context);
  const includedKinds = applicableReportKinds(data, context) as Exclude<
    ReportKind,
    'comprehensive'
  >[];
  // 平台智能体任务：基础报告里的空占位章节（多轮对抗过程摘要、样本概览、未提供等）瘦身；
  // 场景明细和样本规模说明放在智能体专项里，基础报告不再重复。
  const platformOnly = isPlatformAgentReport(data);
  const tailoredBase = platformOnly
    ? { ...base, content: tailorPlatformBaseReport(base.content, data, { scenarioSection: false }) }
    : base;
  const reports = includedKinds.map((kind) => buildSingle(kind, data, tailoredBase, context));
  const headline = `本报告合并 ${reports.length} 个适用报告方向，统一呈现总览、专项证据、风险解释和整改建议。`;
  const summary = {
    ...base.summary,
    kind: 'comprehensive' as const,
    headline,
    metrics: {
      totalQuestions: base.summary.totalQuestions,
      passRatePercent: base.summary.charts.passRatePercent,
      failedCount: base.summary.failedCount,
      findingCount: base.summary.findingCount,
      wrongAnswerCount: base.summary.wrongAnswerCount,
      includedReportCount: reports.length,
    },
    charts: base.summary.charts,
    topFindings:
      reports.find((report) => report.kind === 'safety_overview')?.summary.topFindings ?? [],
    includedKinds,
    specializedReports: reports.map((report) => ({
      kind: report.kind,
      label: REPORT_KIND_LABELS[report.kind],
      headline: report.summary.headline,
      metrics: report.summary.metrics,
    })),
  };
  const joined = [
    '# 大模型安全评估报告',
    '',
    '## 综合评估报告',
    '',
    `> 任务名称：${data.task.name}`,
    `> 生成时间：${formatDateTime(data.generatedAt)}`,
    '',
    '## 报告覆盖方向',
    '',
    headline,
    '',
    reportCoverageTable(reports),
    '',
    ...reports.flatMap((report) => [
      demoteMarkdownHeadings(report.content, REPORT_KIND_LABELS[report.kind]),
      '',
    ]),
  ].join('\n');
  // 平台智能体任务：报告任何位置都不展示带一次性令牌的受控接收端地址。
  const content = platformOnly ? scrubSinkUrls(joined) : joined;

  return {
    kind: 'comprehensive',
    title: `${REPORT_KIND_LABELS.comprehensive} - ${data.task.name}`,
    format: 'markdown',
    content,
    summary,
    passRate: base.passRate,
    totalQuestions: base.totalQuestions,
    riskDistribution: base.riskDistribution,
  };
}
