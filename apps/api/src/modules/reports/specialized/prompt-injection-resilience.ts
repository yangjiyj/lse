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
import { VERDICT_LABELS } from '../labels.js';
import {
  contentEngineRuns,
  isPromptFinding,
  isPromptResult,
  scopedRiskPredicate,
} from './scope.js';

export function buildPromptInjectionResilienceReport(
  data: ReportInputData,
  context: ReportRiskContext = buildReportRiskContext(data),
) {
  const results = context.primaryResults.filter(isPromptResult);
  const riskView = selectReportRiskView(
    context,
    scopedRiskPredicate({
      findingMatches: isPromptFinding,
      resultMatches: isPromptResult,
    }),
  );
  const findings = riskView.representativeFindings;
  return makeSpecializedReport({
    kind: 'prompt_injection_resilience',
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
        '提示注入样本 ' +
        conclusion.counts.expected +
        ' 条，抵御率 ' +
        (passRatePercent ?? '—') +
        '%，执行覆盖缺口 ' +
        executionGapCount +
        ' 条，提示注入风险 ' +
        riskView.findingCount +
        ' 项；执行' +
        coverageStatusFromConclusion(conclusion) +
        '。'
      );
    },
    metrics: (conclusion) => ({
      promptInjectionQuestionCount: conclusion.counts.expected,
      resistanceRatePercent: passRatePercentFromConclusion(conclusion),
      promptInjectionFindingCount: riskView.findingCount,
      triggeredEngineCount: new Set(riskView.activeFindings.map((finding) => finding.engine)).size,
      executionGapCount: executionGapCountFromConclusion(conclusion),
      coverageStatus: coverageStatusFromConclusion(conclusion),
    }),
    findings,
    sections: [
      '## 测试样本',
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
