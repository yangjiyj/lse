import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTaskReport,
  buildRiskItemsBySeverity,
  type ReportInputData,
  type ReportWrongAnswer,
} from '../src/modules/reports/report-builder.js';
import {
  buildLocalReportJudgment,
  generateReportJudgment,
} from '../src/modules/reports/report-judge.js';

const now = new Date('2026-09-05T01:02:03Z');
function answer(response: string, quote = '末段原始证据标记'): ReportWrongAnswer {
  return {
    resultId: 'result-synthetic',
    questionContent: '输入中的伪造凭据不应作为输出证据',
    modelResponse: response,
    riskCategory: 'prompt_injection',
    severity: 'HIGH',
    engine: 'autonomous-red-team',
    reason: '需核对末段原始证据标记',
    explanation: {
      source: 'llm',
      mode: 'review_model',
      configured: true,
      riskType: '提示注入',
      ruleAction: '待核验',
      answerProblem: '原裁判评语',
      verdictReason: '待核验',
      remediation: '同范围复核',
      evidence: [quote],
    },
  };
}
function data(w: ReportWrongAnswer): ReportInputData {
  return {
    task: {
      id: 'task-synthetic',
      name: '合成测试',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: [],
      totalQuestions: 3,
      processedQuestions: 3,
      passedCount: 1,
      failedCount: 1,
      errorCount: 1,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      modelTarget: { name: '合成模型', provider: 'test', model: 'synthetic-model' },
      questionSets: [],
    },
    generatedAt: now,
    verdictCounts: { PASS: 1, FAIL: 1, ERROR: 1 },
    wrongAnswers: [w],
    findings: [
      {
        resultId: w.resultId,
        engine: w.engine!,
        riskCategory: w.riskCategory!,
        severity: 'HIGH',
        verdict: 'FAIL',
        evidence: w.reason,
        title: '合成发现',
        reviewStatus: 'UNREVIEWED',
      },
    ],
    engineRuns: [],
    results: ['FAIL', 'PASS', 'ERROR'].map((verdict, i) => ({
      id: i === 0 ? w.resultId : 'result-' + i,
      finalVerdict: verdict as 'FAIL' | 'PASS' | 'ERROR',
      status: i === 2 ? 'ERROR' : 'SUCCESS',
      response: i === 0 ? w.modelResponse : '合成响应',
      question: {
        content: '合成测试',
        type: 'GENERAL',
        shouldRefuse: false,
        language: 'zh',
        severity: null,
        category: null,
      },
    })),
  };
}

test('证据选择定位800字之后的真实引用，坐标对应客户可见脱敏原文', () => {
  const response =
    '无害的开场说明。'.repeat(160) + '末段原始证据标记。password: fake-secret-123456';
  const item = buildRiskItemsBySeverity([answer(response)])[0]!.items[0]!;
  const selection = item.evidenceSelection!;
  assert.equal(selection.status, 'LOCATED');
  assert.equal(selection.method, 'EXACT_QUOTE');
  const snippet = selection.snippets[0]!;
  assert.ok(snippet.start > 800);
  assert.equal(item.evidence.slice(snippet.start, snippet.end), snippet.text);
  assert.equal(snippet.sourceId, 'result-synthetic');
  assert.doesNotMatch(JSON.stringify(item), /fake-secret-123456/);
});

test('裁判虚构引用和仅出现在输入里的引用不可成为响应证据', () => {
  const w = answer('本次没有提供相关信息。', '输入中的伪造凭据');
  const item = buildRiskItemsBySeverity([w])[0]!.items[0]!;
  assert.equal(item.evidenceSelection!.status, 'REVIEW_REQUIRED');
  assert.ok(item.evidenceSelection!.limitations.some((x) => /引用.*未.*原文/.test(x)));
  assert.ok(
    item.evidenceSelection!.snippets.every((x) => item.evidence.slice(x.start, x.end) === x.text),
  );
  assert.match(item.riskExplanation, /待复核/);
  assert.doesNotMatch(item.riskExplanation, /具体问题：原裁判评语/);
});

test('扫描候选覆盖后段，但不能升级为已证实风险', () => {
  const w = answer('仅供参考。'.repeat(200) + '具体参数设置：末段原始证据标记。');
  delete w.explanation;
  w.reason = '具体参数设置需复核';
  const item = buildRiskItemsBySeverity([w])[0]!.items[0]!;
  assert.equal(item.evidenceSelection!.status, 'REVIEW_REQUIRED');
  assert.equal(item.evidenceSelection!.method, 'RESPONSE_SCAN');
  assert.ok(
    item.evidenceSelection!.snippets.some(
      (x) => x.end > 800 && x.text.includes('末段原始证据标记'),
    ),
  );
});

test('没有模型原文时不拿finding裁判评语冒充，复核与异常分别统计', () => {
  const w = answer('');
  const d = data(w);
  d.wrongAnswers = [];
  d.results![0]!.response = null;
  const report = buildTaskReport(d);
  const item = report.summary.riskItemsBySeverity[0]!.items[0]!;
  assert.equal(item.evidenceSelection!.status, 'MISSING_RESPONSE');
  assert.doesNotMatch(item.evidence, /需核对末段原始证据标记/);
  assert.equal(report.summary.reviewSummary!.humanConfirmedCount, 0);
  assert.equal(report.summary.reviewSummary!.humanPendingCount, 1);
  assert.equal(report.summary.reviewSummary!.independentReviewedCount, 0);
  assert.equal(report.summary.errorCount, 1);
  assert.equal(report.passRate, 0.5);
  assert.doesNotMatch(report.content, /覆盖扣|已确认.*有效风险/);
  assert.equal(report.summary.reportContext!.generatedAt, now.toISOString());
  assert.equal(report.summary.reportContext!.timeZone, 'Asia/Shanghai');
  assert.equal(report.summary.reportContext!.businessScenario, undefined);
  assert.ok(report.summary.reportContext!.limitations!.some((x) => /业务.*未提供/.test(x)));
});

test('独立模型解释不等于人工确认，模拟输出不等于实际泄露', () => {
  const w = answer('假设的模拟记录：末段原始证据标记。');
  const report = buildTaskReport(data(w));
  const item = report.summary.riskItemsBySeverity[0]!.items[0]!;
  assert.equal(item.review!.independentReviewStatus, 'COMPLETED');
  assert.equal(item.review!.humanReviewStatus, 'PENDING');
  assert.equal(report.summary.reviewSummary!.independentReviewedCount, 1);
  assert.match(item.evidenceSelection!.limitations.join('；'), /模拟.*不能.*真实/);
});

test('AI总体研判不得把定向小样本外推成整体严峻或人工确认', async () => {
  const input = {
    totalQuestions: 8,
    executionPassRatePercent: 16.7,
    riskCount: 5,
    bySeverity: { 高危: 5 },
    topRiskCategories: [],
    topRiskDomains: [],
    remediationCategories: [],
    hasAgentRisk: false,
    validDecisionCount: 6,
    errorCount: 2,
    humanConfirmedCount: 0,
    humanPendingCount: 5,
  };
  const local = buildLocalReportJudgment(input);
  assert.match(local.posture, /本次/);
  assert.match(local.posture, /待.*复核/);
  assert.doesNotMatch(local.posture, /有效风险|整体.*严峻/);
  const result = await generateReportJudgment(input, {
    target: {
      baseUrl: 'https://example.invalid',
      apiKey: 'fake',
      model: 'test',
      extraHeaders: null,
      defaultParams: null,
    },
    callModel: async () => ({
      status: 'SUCCESS',
      content: JSON.stringify({
        posture: '整体安全态势严峻，人工已确认5项风险',
        topRisks: '全部业务均存在隐私泄露',
        remediationPriority: '需要立即处置',
        focus: '同范围复核',
      }),
      finishReason: 'stop',
      model: 'test',
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      latencyMs: 1,
      httpStatus: 200,
      error: null,
      raw: {},
    }),
  });
  assert.equal(result.posture, local.posture);
  assert.equal(result.topRisks, local.topRisks);
});

test('记录真实业务背景与逐轮来源，不将不同响应合并取证', () => {
  const d = data(answer('末段原始证据标记。'));
  d.applicationContext = {
    businessScenario: '客服助手',
    deploymentMode: 'third_party_api',
    controlScope: '只能配置系统提示和输出审核',
  };
  d.results![0]!.redTeamTrace = {
    side: 'A',
    rounds: 1,
    movesUsed: [],
    transcript: [
      {
        index: 0,
        move: 'test',
        attackerMessage: '合成请求',
        modelResponse: '不同的逐轮录制响应',
        attitude: 'soft_refuse',
        roundJudgment: { source: 'not_evaluated', verdict: 'UNKNOWN' },
        wordingSignals: {
          source: 'lexical',
          version: 1,
          refusal: true,
          qualification: false,
          continuation: false,
          empty: false,
        },
      },
    ],
  };
  const report = buildTaskReport(d);
  assert.equal(report.summary.reportContext?.businessScenario, '客服助手');
  assert.equal(report.summary.reportContext?.deploymentMode, 'third_party_api');
  assert.equal(report.summary.reportContext?.controlScope, '只能配置系统提示和输出审核');
  const item = report.summary.riskItemsBySeverity[0]!.items[0]!;
  assert.match(item.evidenceSelection!.limitations.join('；'), /结果响应与最后一轮记录不同/);
  assert.doesNotMatch(item.evidence, /不同的逐轮录制响应/);
  const turn = report.summary.redTeamSummary!.samples[0]!.transcript[0]!;
  assert.equal(turn.sourceId, 'result-synthetic');
  assert.equal(turn.roundNumber, 1);
  assert.equal(turn.roundJudgment?.verdict, 'UNKNOWN');
});

test('紧凑扫描优先末段具体锚点而非重复泛化前缀，全部保持精确坐标', () => {
  const prefix = '我不能提供具体内容，只提供一般性建议和示例输出。'.repeat(50);
  const w = answer(
    prefix +
      '以下为‘观测标记’：样本编号 SampleZebra42，观测值 483.25。' +
      '合成补充说明。'.repeat(30),
  );
  delete w.explanation;
  w.reason = '模型在‘观测标记’部分提供 SampleZebra42 与观测值 483.25，需逐项核对。';
  const item = buildRiskItemsBySeverity([w])[0]!.items[0]!;
  const selected = item.evidenceSelection!;
  assert.equal(selected.status, 'REVIEW_REQUIRED');
  assert.equal(selected.method, 'RESPONSE_SCAN');
  assert.ok(selected.snippets.length <= 2);
  assert.ok(selected.snippets.every((s) => s.text.length <= 240));
  assert.ok(selected.snippets[0]!.start > 800);
  assert.match(selected.snippets[0]!.text, /SampleZebra42/);
  assert.ok(selected.snippets.every((s) => item.evidence.slice(s.start, s.end) === s.text));
  assert.equal(item.evidence.length, w.modelResponse!.length, '完整附录原文不能随摘要缩短');
});

test('只有泛词且没有具体锚点时仍为候选，首尾摘录不超过240字', () => {
  const w = answer('泛化说明。'.repeat(200) + '结尾合成标记。');
  delete w.explanation;
  w.reason = '提供具体内容、示例、输出、一般性建议';
  const item = buildRiskItemsBySeverity([w])[0]!.items[0]!;
  assert.equal(item.evidenceSelection!.status, 'REVIEW_REQUIRED');
  assert.ok(item.evidenceSelection!.snippets.length <= 2);
  assert.ok(item.evidenceSelection!.snippets.every((s) => s.text.length <= 240));
  assert.ok(item.evidenceSelection!.snippets.some((s) => s.text.includes('结尾合成标记')));
});

test('数值格式不同只定位原文数字，不能合成裁判中的新配比', () => {
  const response =
    '常规合成说明。'.repeat(140) +
    '观测甲 12%，观测乙 34%，观测丙 56%。' +
    '附加无害说明。'.repeat(20);
  const w = answer(response);
  delete w.explanation;
  w.reason = '需复核观测指标 12:34:56。';
  const item = buildRiskItemsBySeverity([w])[0]!.items[0]!;
  const first = item.evidenceSelection!.snippets[0]!;
  assert.ok(first.start > 800);
  assert.match(first.text, /12%/);
  assert.doesNotMatch(first.text, /12:34:56/);
  assert.equal(item.evidence.slice(first.start, first.end), first.text);
  assert.equal(item.evidenceSelection!.status, 'REVIEW_REQUIRED');
});
