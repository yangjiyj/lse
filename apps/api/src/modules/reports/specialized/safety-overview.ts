import { buildTaskReport, type BuiltReport, type ReportInputData } from '../report-builder.js';
import {
  buildReportRiskContext,
  fullReportRiskView,
  type ReportRiskContext,
} from '../report-risk-context.js';
import { sanitizeReportText } from './common.js';
import { scrubSinkUrls, tailorPlatformBaseReport } from './platform-agent.js';
import { isPlatformAgentReport } from './scope.js';
import { REPORT_KIND_LABELS, type SpecializedReport } from './types.js';

export function buildSafetyOverviewReport(
  data: ReportInputData,
  base?: BuiltReport,
  context: ReportRiskContext = buildReportRiskContext(data),
): SpecializedReport {
  const resolvedBase = base ?? buildTaskReport(data, context);
  const platformOnly = isPlatformAgentReport(data);
  const riskView = fullReportRiskView(context);
  const headline = `本次评估覆盖 ${resolvedBase.summary.totalQuestions} 条测试样本，有效判定通过率 ${resolvedBase.summary.charts.passRatePercent ?? '—'}%，识别有效风险 ${riskView.findingCount} 项。`;
  const metrics = {
    totalQuestions: resolvedBase.summary.totalQuestions,
    passRatePercent: resolvedBase.summary.charts.passRatePercent,
    failedCount: resolvedBase.summary.failedCount,
    findingCount: riskView.findingCount,
    wrongAnswerCount: resolvedBase.summary.wrongAnswerCount,
  };
  const summary = {
    ...resolvedBase.summary,
    evidenceFindingCount: riskView.evidenceFindingCount,
    findingCount: riskView.findingCount,
    kind: 'safety_overview' as const,
    headline,
    metrics,
    charts: resolvedBase.summary.charts,
    topFindings: riskView.representativeFindings.slice(0, 5).map((finding) => ({
      title: finding.title ?? finding.riskCategory,
      severity: finding.severity,
      evidence: sanitizeReportText(finding.evidence),
    })),
  };
  return {
    kind: 'safety_overview',
    title: `${REPORT_KIND_LABELS.safety_overview} - ${data.task.name}`,
    format: 'markdown',
    // 单独出总览且是平台智能体任务时，把基础报告里的空占位章节改写成场景明细；
    // 综合报告传入的 base 已由 comprehensive 处理过，这里不再重复。
    content: (platformOnly ? scrubSinkUrls : (text: string) => text)(base ? resolvedBase.content : tailorPlatformBaseReport(resolvedBase.content, data)).replace(
      '# 大模型安全评估报告',
      `# 大模型安全评估报告\n\n## 专项类型：安全评估总览\n\n${headline}`,
    ),
    summary,
    passRate: resolvedBase.passRate,
    totalQuestions: resolvedBase.totalQuestions,
    riskDistribution: resolvedBase.riskDistribution,
  };
}
