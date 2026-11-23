import type { ReportInputData } from '../report-builder.js';
import {
  buildReportRiskContext,
  selectReportRiskView,
  type ReportRiskContext,
} from '../report-risk-context.js';
import {
  coverageStatusFromConclusion,
  executionGapCountFromConclusion,
  mdTable,
  makeSpecializedReport,
  passRatePercentFromConclusion,
} from './common.js';
import { VERDICT_LABELS, severityLabel } from '../labels.js';
import {
  contentEngineRuns,
  isRefusalFinding,
  isRefusalResult,
  scopedRiskPredicate,
} from './scope.js';

export function buildRefusalCapabilityReport(
  data: ReportInputData,
  context: ReportRiskContext = buildReportRiskContext(data),
) {
  const results = context.primaryResults.filter(isRefusalResult);
  const riskView = selectReportRiskView(
    context,
    scopedRiskPredicate({
      findingMatches: isRefusalFinding,
      resultMatches: isRefusalResult,
    }),
  );
  const findings = riskView.representativeFindings;
  const unrefusedRiskCount = riskView.findingCount;
  return makeSpecializedReport({
    kind: 'refusal_capability',
    conclusionScopeKind: 'RESULT_SET',
    data,
    context,
    riskView,
    results,
    engineRuns: contentEngineRuns(data, riskView, results),
    headline: (conclusion) => {
      const passRatePercent = passRatePercentFromConclusion(conclusion);
      const executionGapCount = executionGapCountFromConclusion(conclusion);
      return (
        '应拒答样本 ' +
        conclusion.counts.expected +
        ' 条，通过 ' +
        conclusion.counts.pass +
        ' 条，通过率 ' +
        (passRatePercent ?? '—') +
        '%，执行覆盖缺口 ' +
        executionGapCount +
        ' 条，未拒答风险 ' +
        unrefusedRiskCount +
        ' 项；执行' +
        coverageStatusFromConclusion(conclusion) +
        '。'
      );
    },
    metrics: (conclusion) => ({
      refusalQuestionCount: conclusion.counts.expected,
      refusalPassRatePercent: passRatePercentFromConclusion(conclusion),
      unrefusedRiskCount,
      highestSeverity: findings[0] ? severityLabel(findings[0].severity) : null,
      executionGapCount: executionGapCountFromConclusion(conclusion),
      coverageStatus: coverageStatusFromConclusion(conclusion),
    }),
    findings,
    sections: [
      '## 应拒答样本',
      '',
      mdTable(
        ['测试样本', '语言', '执行判定'],
        results
          .slice(0, 10)
          .map((result) => [
            result.question.content,
            result.question.language,
            result.finalVerdict ? VERDICT_LABELS[result.finalVerdict] : '未判定',
          ]),
      ),
    ],
  });
}
