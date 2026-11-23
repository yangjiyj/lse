import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskReport, type ReportInputData } from '../src/modules/reports/report-builder.js';
import { buildReportHtmlModel } from '../src/modules/reports/html/model.js';
import { renderReportHtmlString } from '../src/modules/reports/html/render.js';
import { buildReportPdfDoc } from '../src/modules/reports/pdf.js';

function reportFixture(count = 6) {
  const generatedAt = new Date('2026-09-05T01:55:38Z');
  const data = {
    task: {
      id: 'report-regression',
      name: '报告回归',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: ['autonomous-red-team'],
      dimensions: ['redteam_attack'],
      totalQuestions: count,
      processedQuestions: count,
      passedCount: 1,
      failedCount: count - 1,
      errorCount: 0,
      createdAt: generatedAt,
      startedAt: generatedAt,
      finishedAt: generatedAt,
      modelTarget: { name: '测试模型', provider: 'test', model: 'fixture' },
      questionSets: [],
    },
    generatedAt,
    verdictCounts: { PASS: 1, FAIL: count - 1 },
    engineRuns: [],
    wrongAnswers: [],
    findings: Array.from({ length: count - 1 }, (_, i) => ({
      stableId: `finding-${i}`,
      resultId: `result-${i}`,
      engine: 'autonomous-red-team',
      riskCategory: 'prompt_injection',
      severity: 'HIGH',
      verdict: 'FAIL',
      score: 0,
      title: '提示注入',
      evidence: '评估对象执行了外部资料中的指令',
    })),
    results: Array.from({ length: count }, (_, i) => ({
      id: `result-${i}`,
      controlGroupId: `scenario-${i}`,
      side: 'A',
      finalVerdict: i === count - 1 ? 'PASS' : 'FAIL',
      status: 'SUCCESS',
      prompt: `场景${i}提示`,
      response: `场景${i}回复`,
      question: {
        content: `场景${i}测试样本`,
        type: 'SHOULD_REFUSE',
        shouldRefuse: true,
        language: 'zh',
        severity: 'HIGH',
        category: 'prompt_injection',
      },
      redTeamTrace: {
        rounds: 2,
        stopReason: i === count - 1 ? 'max_round' : 'success',
        movesUsed: [],
        transcript: Array.from({ length: 2 }, (_, j) => ({
          index: j,
          move: 'test',
          attackerMessage: `场景${i}第${j + 1}轮原始请求`,
          modelResponse: `场景${i}第${j + 1}轮原始回答`,
          // A scenario verdict is not proof that its final recorded turn changed attitude.
          attitude: 'hard_refuse',
          rationale: '真实逐轮记录',
          successSignal: '未记录',
        })),
      },
    })),
  } as unknown as ReportInputData;
  return buildTaskReport(data);
}

test('当前中文FAIL标签恢复失败场景和逐轮证据，保留真实态度', () => {
  const report = reportFixture(2);
  const m = buildReportHtmlModel(report, { evidenceDetail: 'full' });
  const failed = m.redTeam!.scenarios.find((s) => s.verdictLabel === '未通过')!;
  assert.equal(failed.broke, true);
  assert.ok(failed.breach);
  assert.equal(failed.breach.turns[1]!.attitudeLabel, '拒答');
  assert.equal(failed.breach.turns[1]!.broke, false);
  const html = renderReportHtmlString(m);
  assert.ok(html.includes('场景0第2轮原始回答'));
  assert.ok(html.includes('场景1第2轮原始回答'), 'full也必须包含PASS轨迹');
  assert.ok(!html.includes('第 2 轮发生边界突破'), '不能把场景结论伪造成末轮结论');
});

test('原始判定优先于展示文字，旧中文快照仍可渲染', () => {
  const report = reportFixture(2);
  const sample = report.summary.redTeamSummary!.samples[0]! as any;
  sample.finalVerdict = 'PASS';
  sample.verdictLabel = '风险';
  sample.stopReasonLabel = '已破局';
  assert.equal(buildReportHtmlModel(report).redTeam!.scenarios[0]!.broke, false);
  delete sample.finalVerdict;
  delete sample.stopReason;
  assert.equal(buildReportHtmlModel(report).redTeam!.scenarios[0]!.broke, true);
});

test('小任务保存全部6场景及稳定判定字段，大任务有界', () => {
  const small = reportFixture(6).summary.redTeamSummary!;
  assert.equal(small.samples.length, 6);
  assert.equal((small.samples[0] as any).finalVerdict, 'FAIL');
  assert.equal((small.samples[0] as any).stopReason, 'success');
  const large = reportFixture(55).summary.redTeamSummary!;
  assert.equal(large.scenarioCount, 55);
  assert.ok(large.samples.length >= 6 && large.samples.length <= 50);
});

test('旧冻结快照的场景与轮次缺口在PDF中明确披露', () => {
  const report = reportFixture(6);
  report.summary.redTeamSummary!.samples = report.summary.redTeamSummary!.samples.slice(0, 5);
  report.summary.redTeamSummary!.totalRounds = 15;
  report.summary.redTeamSummary!.samples[0]!.transcript.push(
    ...Array.from({ length: 3 }, () => ({
      ...report.summary.redTeamSummary!.samples[0]!.transcript[0]!,
    })),
  );
  const html = renderReportHtmlString(buildReportHtmlModel(report));
  assert.ok(/5\s*\/\s*6\s*个场景/.test(html), '应披露5/6个场景');
  assert.ok(/13\s*\/\s*15\s*轮/.test(html), '应披露13/15轮');
});

test('规则指南按唯一风险计数，不累计同一风险的两种样本视图', () => {
  const report = reportFixture(6);
  const model = buildReportHtmlModel(report);
  assert.equal(
    model.ruleGuide.reduce((sum, item) => sum + item.count, 0),
    5,
  );
});

test('零候选复核必须说明未执行，不输出完成分析0条', () => {
  const report = reportFixture(2);
  report.summary.explanationRun = {
    mode: 'review_model',
    label: '独立模型复核分析',
    attemptedCount: 0,
    llmCount: 0,
    fallbackCount: 0,
    skippedReasons: [],
    modelTargetName: '复核模型',
  };
  const pdf = buildReportPdfDoc(report);
  const text = JSON.stringify(pdf);
  assert.ok(text.includes('逐项风险解释未执行'));
  assert.ok(!text.includes('分析 0 条风险样本'));
});

test('缺失逐轮判定不以措辞伪造曲线，原文与未记录标注仍保留', () => {
  const report = reportFixture(2);
  report.summary.redTeamSummary!.samples[0]!.transcript[0]!.attitudeLabel = '未记录';
  const model = buildReportHtmlModel(report);
  const failed = model.redTeam!.scenarios.find((s) => s.broke)!;
  assert.equal(failed.breach!.arc.length, 0);
  const html = renderReportHtmlString(model);
  assert.ok(html.includes('部分轮次未保存独立内容判定'));
  assert.ok(html.includes('场景0第1轮原始回答'));
});

test('摘要模板与无证据模板不意外输出全量PASS原文', () => {
  const report = reportFixture(2);
  const none = renderReportHtmlString(buildReportHtmlModel(report, { evidenceDetail: 'none' }));
  assert.ok(!none.includes('场景0第1轮原始回答'));
  const summary = renderReportHtmlString(
    buildReportHtmlModel(report, { evidenceDetail: 'summary' }),
  );
  assert.ok(summary.includes('场景0第1轮原始回答'));
  assert.ok(!summary.includes('场景1第1轮原始回答'));
});

test('报告已知引擎与异常状态使用中文并保留警示色', () => {
  const report = reportFixture(2);
  report.summary.charts.engineRuns = ['autonomous-red-team', 'agent-llm-judge'].map((engine) => ({
    engine,
    engineLabel: engine,
    status: 'ERROR',
    statusLabel: 'ERROR',
    normalizedCount: 0,
    skippedCount: 0,
    durationMs: 0,
  }));
  const rows = buildReportHtmlModel(report).engineRuns;
  assert.deepEqual(
    rows.map((row) => row.engine),
    ['自主红队评估', '智能体判定模型'],
  );
  assert.ok(rows.every((row) => row.status === '执行异常' && row.statusTone === 'warn'));
});
