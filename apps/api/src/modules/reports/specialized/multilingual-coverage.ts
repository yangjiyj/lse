import type { ReportEvalResult, ReportInputData } from '../report-builder.js';
import {
  buildReportRiskContext,
  selectReportRiskView,
  type ReportRiskContext,
} from '../report-risk-context.js';
import { contentEngineRuns, isMultilingualResult } from './scope.js';
import {
  chartFromRecord,
  coverageStatusFromConclusion,
  executionGapCountFromConclusion,
  mdTable,
  makeSpecializedReport,
  passRatePercentFromConclusion,
  passRatePercentFromVerdicts,
} from './common.js';

interface LangStats {
  results: ReportEvalResult[];
  total: number;
  pass: number;
  fail: number;
  error: number;
  executionGap: number;
}

export function buildMultilingualCoverageReport(
  data: ReportInputData,
  context: ReportRiskContext = buildReportRiskContext(data),
) {
  const stats: Record<string, LangStats> = {};
  const results = context.primaryResults.filter(isMultilingualResult);
  for (const result of results) {
    const lang = result.question.language || 'unknown';
    stats[lang] ??= {
      results: [],
      total: 0,
      pass: 0,
      fail: 0,
      error: 0,
      executionGap: 0,
    };
    stats[lang].results.push(result);
    stats[lang].total += 1;
    if (result.finalVerdict === 'PASS') stats[lang].pass += 1;
    else if (result.finalVerdict === 'FAIL') stats[lang].fail += 1;
    else if (result.finalVerdict === 'ERROR') stats[lang].error += 1;
    else stats[lang].executionGap += 1;
  }
  const riskView = selectReportRiskView(
    context,
    (_finding, risk) =>
      Boolean(risk.resultId && risk.context.result?.question.language) &&
      Boolean(stats[risk.context.result!.question.language || 'unknown']),
  );
  const countRecord = Object.fromEntries(
    Object.entries(stats).map(([lang, stat]) => [lang, stat.total]),
  );
  const metrics: Record<string, number | string | null> = {
    languageCount: Object.keys(stats).length,
    totalQuestionsWithLanguage: Object.values(stats).reduce((sum, stat) => sum + stat.total, 0),
  };
  for (const [lang, stat] of Object.entries(stats)) {
    metrics[lang + 'PassRatePercent'] = passRatePercentFromVerdicts(stat.results);
  }
  return makeSpecializedReport({
    kind: 'multilingual_coverage',
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
        '覆盖 ' +
        Object.keys(stats).length +
        ' 种语言，语言维度样本 ' +
        conclusion.counts.expected +
        ' 条，总体通过率 ' +
        (passRatePercent ?? '—') +
        '%，执行覆盖缺口 ' +
        executionGapCount +
        ' 条；执行' +
        coverageStatusFromConclusion(conclusion) +
        '。'
      );
    },
    metrics: (conclusion) => ({
      ...metrics,
      passRatePercent: passRatePercentFromConclusion(conclusion),
      executionGapCount: executionGapCountFromConclusion(conclusion),
      coverageStatus: coverageStatusFromConclusion(conclusion),
    }),
    charts: {
      byLanguage: chartFromRecord(countRecord, (lang) => lang),
    },
    findings: riskView.representativeFindings,
    sections: [
      '## 语言覆盖',
      '',
      mdTable(
        ['语言', '样本数', '通过', '未通过', '执行异常', '未判定', '通过率'],
        Object.entries(stats).map(([lang, stat]) => {
          const percent = passRatePercentFromVerdicts(stat.results);
          return [
            lang,
            String(stat.total),
            String(stat.pass),
            String(stat.fail),
            String(stat.error),
            String(stat.executionGap),
            percent == null ? '—' : percent + '%',
          ];
        }),
      ),
    ],
  });
}
