import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTaskReport, type ReportInputData } from '../src/modules/reports/report-builder.js';
import { buildReportHtmlModel } from '../src/modules/reports/html/model.js';
import { renderReportHtmlString } from '../src/modules/reports/html/render.js';
import { buildProtectionStrategySection } from '../src/modules/policy-suggestions/report-section.js';

function report() {
  const at = new Date('2026-09-29T01:00:00Z');
  return buildTaskReport({
    task: {
      id: 'ps-report',
      name: '策略章节',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: ['test-engine'],
      dimensions: ['prompt_injection'],
      totalQuestions: 1,
      processedQuestions: 1,
      passedCount: 1,
      failedCount: 0,
      errorCount: 0,
      createdAt: at,
      startedAt: at,
      finishedAt: at,
      modelTarget: { name: '测试模型', provider: 'test', model: 'fixture' },
      questionSets: [],
    },
    generatedAt: at,
    verdictCounts: { PASS: 1 },
    engineRuns: [],
    wrongAnswers: [],
    findings: [],
    results: [],
  } as unknown as ReportInputData);
}

const base = {
  type: 'prompt_injection',
  action: 'block',
  matcherKind: 'regex',
  matcherValue: '(?i)(?:忽略之前的)',
  estimatedImpact: { description: '在本批证据样本上实测命中 3/3（100%）' },
  status: 'PUBLISHED',
  ruleSetVersion: 'v3',
  preAttackRate: 0.75,
  postAttackRate: 0.25,
  retestError: null,
  sourceFindingIds: ['f1'],
};

test('章节数据：中文标签、对比、驳回的建议不进入报告', () => {
  const section = buildProtectionStrategySection([
    base,
    { ...base, status: 'REJECTED', type: 'sensitive_data' },
    {
      ...base,
      type: 'sensitive_data',
      action: 'mask',
      status: 'PUBLISHED',
      preAttackRate: 1,
      postAttackRate: null,
      retestError: '待复测：复测服务未接入',
    },
  ]);
  assert.equal(section.empty, false);
  assert.equal(section.rows.length, 2);
  assert.deepEqual(section.rows[0]!.slice(0, 2), ['提示词注入拦截', '阻断']);
  assert.equal(section.rows[0]![4], '已发布（规则集版本 v3）');
  assert.equal(section.rows[0]![5], '下发前 75% → 下发后 25%');
  assert.equal(section.rows[1]![5], '下发前 100%；待复测：复测服务未接入');
});

test('HTML 报告：有数据渲染表格，无数据显示暂无数据，未接入时不出章节', () => {
  const r = report();
  const withData = renderReportHtmlString(
    buildReportHtmlModel(r, { protectionStrategy: buildProtectionStrategySection([base]) }),
  );
  assert.match(withData, /推荐防护策略/);
  assert.match(withData, /提示词注入拦截/);
  const empty = renderReportHtmlString(
    buildReportHtmlModel(r, { protectionStrategy: buildProtectionStrategySection([]) }),
  );
  assert.match(empty, /推荐防护策略[\s\S]*暂无数据/);
  const none = renderReportHtmlString(buildReportHtmlModel(r));
  assert.doesNotMatch(none, /推荐防护策略/);
});
