import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ReportFinding,
  ReportInputData,
  ReportWrongAnswer,
} from '../src/modules/reports/report-builder.js';
import { buildReportRiskContext } from '../src/modules/reports/report-risk-context.js';
import { buildRemediationItemsFromRisks } from '../src/modules/reports/remediation.js';

const now = new Date('2026-07-12T08:30:00.000Z');

function finding(overrides: Partial<ReportFinding> = {}): ReportFinding {
  return {
    resultId: 'result-1',
    engine: 'rule-judge',
    riskCategory: 'prompt_injection',
    severity: 'HIGH',
    verdict: 'FAIL',
    evidence: null,
    title: null,
    reviewStatus: 'CONFIRMED',
    ...overrides,
  };
}

function wrong(overrides: Partial<ReportWrongAnswer> = {}): ReportWrongAnswer {
  return {
    resultId: 'result-1',
    questionContent: '测试题',
    modelResponse: '测试回答',
    riskCategory: 'prompt_injection',
    severity: 'HIGH',
    engine: 'rule-judge',
    reason: 'WrongAnswer reason',
    ...overrides,
  };
}

function data(findings: ReportFinding[], wrongAnswers: ReportWrongAnswer[] = []): ReportInputData {
  const resultIds = [
    ...new Set(findings.flatMap((item) => (item.resultId ? [item.resultId] : []))),
  ];
  return {
    task: {
      id: 'remediation-risk-context',
      name: '整改风险上下文测试',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: ['rule-judge'],
      totalQuestions: resultIds.length,
      processedQuestions: resultIds.length,
      passedCount: 0,
      failedCount: resultIds.length,
      errorCount: 0,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      modelTarget: { name: '测试模型', provider: 'openai-compatible', model: 'test' },
      questionSets: [{ name: '题集', type: 'GENERAL', language: 'zh' }],
    },
    verdictCounts: { FAIL: resultIds.length },
    results: resultIds.map((id) => ({
      id,
      finalVerdict: 'FAIL',
      status: 'SUCCESS',
      question: {
        content: '题目 ' + id,
        type: 'GENERAL',
        shouldRefuse: false,
        language: 'zh',
        severity: 'HIGH',
        category: 'general',
      },
    })),
    findings,
    engineRuns: [],
    wrongAnswers,
    generatedAt: now,
  };
}

function itemsFor(findings: ReportFinding[], wrongAnswers: ReportWrongAnswer[] = []) {
  const context = buildReportRiskContext(data(findings, wrongAnswers));
  return {
    context,
    items: buildRemediationItemsFromRisks(context.activeRisks),
  };
}

test('风险原生整改：同类别 result A/B 不按类别借 A 的 WrongAnswer，且聚合为一条最高等级整改', () => {
  const aReason = 'RESULT_A_WA_REASON_MUST_NOT_BE_BORROWED';
  const { context, items } = itemsFor(
    [
      finding({
        resultId: 'result-a',
        severity: 'HIGH',
        evidence: 'A finding evidence',
      }),
      finding({
        resultId: 'result-b',
        severity: 'CRITICAL',
        evidence: null,
        title: null,
      }),
    ],
    [
      wrong({
        resultId: 'result-a',
        reason: aReason,
      }),
    ],
  );

  assert.equal(context.activeRisks.length, 2);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.priority, 'P0');
  assert.doesNotMatch(items[0]!.evidence, new RegExp(aReason));
  assert.match(items[0]!.evidence, /提示注入/);
});

test('风险原生整改：代表 Finding evidence 优先于严格一对一 WrongAnswer.reason', () => {
  const { items } = itemsFor(
    [
      finding({
        evidence: 'REPRESENTATIVE_FINDING_EVIDENCE',
        title: '代表标题',
      }),
    ],
    [
      wrong({
        reason: 'MATCHED_WA_REASON_SHOULD_BE_SECOND',
      }),
    ],
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]!.evidence, 'REPRESENTATIVE_FINDING_EVIDENCE');
});

test('风险原生整改：仅单 Finding 且 result/category/engine 全等时才可使用 WrongAnswer.reason', () => {
  const { items } = itemsFor(
    [
      finding({
        evidence: '   ',
        title: null,
      }),
    ],
    [
      wrong({
        reason: 'STRICT_ONE_TO_ONE_WA_REASON',
      }),
    ],
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]!.evidence, 'STRICT_ONE_TO_ONE_WA_REASON');
});

test('风险原生整改：同 result 多 Finding 时不借 WrongAnswer.reason', () => {
  const forbidden = 'MULTI_FINDING_WA_REASON_MUST_NOT_BE_USED';
  const { context, items } = itemsFor(
    [
      finding({
        resultId: 'shared-result',
        severity: 'CRITICAL',
        evidence: null,
        title: '多证据代表标题',
      }),
      finding({
        resultId: 'shared-result',
        engine: 'llm-judge',
        severity: 'MEDIUM',
        evidence: '第二条证据',
        title: '第二标题',
      }),
    ],
    [
      wrong({
        resultId: 'shared-result',
        reason: forbidden,
      }),
    ],
  );

  assert.equal(context.activeRisks[0]!.findings.length, 2);
  assert.equal(items.length, 1);
  assert.doesNotMatch(items[0]!.evidence, new RegExp(forbidden));
  assert.equal(items[0]!.evidence, '多证据代表标题');
});

test('风险原生整改：任务级 Finding 无 resultId 时不得借用 WrongAnswer', () => {
  const forbidden = 'TASK_LEVEL_WA_REASON_MUST_NOT_BE_USED';
  const { items } = itemsFor(
    [
      finding({
        resultId: null,
        evidence: null,
        title: '任务级风险标题',
      }),
    ],
    [
      wrong({
        resultId: undefined,
        reason: forbidden,
      }),
    ],
  );

  assert.equal(items.length, 1);
  assert.doesNotMatch(items[0]!.evidence, new RegExp(forbidden));
  assert.equal(items[0]!.evidence, '任务级风险标题');
});

test('风险原生整改：FP-only 不生成，ACCEPTED_RISK 仍生成整改', () => {
  const fp = itemsFor([
    finding({
      reviewStatus: 'FALSE_POSITIVE',
      evidence: '已确认误报',
    }),
  ]);
  assert.equal(fp.context.activeRisks.length, 0);
  assert.deepEqual(fp.items, []);

  const accepted = itemsFor([
    finding({
      reviewStatus: 'ACCEPTED_RISK',
      evidence: '已接受残余风险',
    }),
  ]);
  assert.equal(accepted.context.activeRisks.length, 1);
  assert.equal(accepted.items.length, 1);
  assert.equal(accepted.items[0]!.evidence, '已接受残余风险');
});

for (const category of ['CANARY_UNKNOWN_REMEDIATION_61V', '__proto__', 'constructor']) {
  for (const hasDetails of [true, false]) {
    test(`风险原生整改：${category}（${hasDetails ? '有' : '无'}证据标题）始终返回字符串且不抛错`, () => {
      const { items } = itemsFor([
        finding({
          riskCategory: category,
          evidence: hasDetails ? '已脱敏证据' : null,
          title: hasDetails ? '已脱敏标题' : null,
        }),
      ]);

      assert.equal(items.length, 1);
      assert.equal(typeof items[0]!.riskCategoryLabel, 'string');
      assert.equal(typeof items[0]!.evidence, 'string');
      assert.doesNotMatch(
        `${items[0]!.riskCategoryLabel} ${items[0]!.evidence}`,
        /\[object Object\]|function Object|native code/,
      );
    });
  }
}
