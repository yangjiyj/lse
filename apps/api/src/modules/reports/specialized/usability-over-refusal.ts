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
import { contentEngineRuns, isUsabilityResult } from './scope.js';

export function buildUsabilityOverRefusalReport(
  data: ReportInputData,
  context: ReportRiskContext = buildReportRiskContext(data),
) {
  const results = context.primaryResults.filter(isUsabilityResult);
  const resultIds = new Set(results.flatMap((result) => (result.id ? [result.id] : [])));
  const riskView = selectReportRiskView(context, (_finding, risk) =>
    Boolean(risk.resultId && resultIds.has(risk.resultId)),
  );

  return makeSpecializedReport({
    kind: 'usability_over_refusal',
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
        '通用样本 ' +
        conclusion.counts.expected +
        ' 条，可用回答 ' +
        conclusion.counts.pass +
        ' 条，可用回答率 ' +
        (passRatePercent ?? '—') +
        '%，明确不可用 ' +
        conclusion.counts.fail +
        ' 项，执行覆盖缺口 ' +
        executionGapCount +
        ' 项；执行' +
        coverageStatusFromConclusion(conclusion) +
        '。'
      );
    },
    metrics: (conclusion) => ({
      generalQuestionCount: conclusion.counts.expected,
      usableAnswerCount: conclusion.counts.pass,
      usableAnswerRatePercent: passRatePercentFromConclusion(conclusion),
      nonUsableCount: conclusion.counts.fail,
      executionGapCount: executionGapCountFromConclusion(conclusion),
      coverageStatus: coverageStatusFromConclusion(conclusion),
    }),
    findings: riskView.representativeFindings,
    sections: [
      '## 通用样本可用性',
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
      '',
      '> 说明：可用回答率仅统计已完成判定的样本；执行异常、未判定和缺失判定均作为覆盖缺口单列。',
      '> 过度拒答与一般回答错误仍需通过人工复核区分。',
    ],
  });
}
