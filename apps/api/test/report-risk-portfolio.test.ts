import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Severity } from '@lse/shared';
import {
  buildTaskReport,
  portfolioRiskToWrongAnswer,
  type ReportFinding,
  type ReportInputData,
} from '../src/modules/reports/report-builder.js';
import { buildRiskPortfolio } from '../src/modules/reports/risk-portfolio.js';
import { buildSecurityScore, isActiveRiskFinding } from '../src/modules/reports/scoring.js';

const statuses = [
  'UNREVIEWED',
  'NEEDS_REVIEW',
  'CONFIRMED',
  'FALSE_POSITIVE',
  'ACCEPTED_RISK',
] as const;

function scoreOne(severity: Severity, reviewStatus: (typeof statuses)[number]) {
  return buildSecurityScore({ findings: [{ severity, reviewStatus }], engineRuns: [] });
}

test('评分口径：五种复核状态中只有人工确认误报被排除', () => {
  const activeByStatus = Object.fromEntries(
    statuses.map((reviewStatus) => [
      reviewStatus,
      isActiveRiskFinding({ severity: 'HIGH', reviewStatus }),
    ]),
  );

  assert.deepEqual(activeByStatus, {
    UNREVIEWED: true,
    NEEDS_REVIEW: true,
    CONFIRMED: true,
    FALSE_POSITIVE: false,
    ACCEPTED_RISK: true,
  });
});

test('评分口径：待复核风险与同等级人工确认风险全额同分', () => {
  const needsReview = scoreOne('HIGH', 'NEEDS_REVIEW');
  const confirmed = scoreOne('HIGH', 'CONFIRMED');

  assert.equal(needsReview.score, confirmed.score);
  assert.equal(needsReview.riskDeduction, confirmed.riskDeduction);
  assert.equal(needsReview.riskDeduction, 20);
  assert.equal(needsReview.reviewDeduction, 0);
});

test('评分口径：已接受风险仍是残余风险且全额扣分', () => {
  const accepted = scoreOne('CRITICAL', 'ACCEPTED_RISK');

  assert.equal(accepted.activeFindingCount, 1);
  assert.equal(accepted.acceptedRiskFindingCount, 1);
  assert.equal(accepted.riskDeduction, 30);
  assert.equal(accepted.score, 70);
  assert.notEqual(accepted.score, 100);
});

test('评分口径：人工确认误报不扣分', () => {
  const falsePositive = scoreOne('CRITICAL', 'FALSE_POSITIVE');

  assert.equal(falsePositive.activeFindingCount, 0);
  assert.equal(falsePositive.falsePositiveFindingCount, 1);
  assert.equal(falsePositive.riskDeduction, 0);
  assert.equal(falsePositive.score, 100);
});

function finding(overrides: Partial<ReportFinding> = {}): ReportFinding {
  return {
    engine: 'rule-judge',
    riskCategory: 'prompt_injection',
    severity: 'HIGH',
    verdict: 'FAIL',
    title: '提示注入风险',
    evidence: '模型执行了注入指令',
    reviewStatus: 'UNREVIEWED',
    ...overrides,
  };
}

test('风险组合：五种复核状态中只有 FALSE_POSITIVE 被排除，接受风险保留残余标识', () => {
  const portfolio = buildRiskPortfolio({
    findings: statuses.map((reviewStatus, index) =>
      finding({ resultId: `result-${index}`, reviewStatus }),
    ),
    wrongAnswers: [],
    results: [],
  });

  assert.equal(portfolio.activeRisks.length, 4);
  assert.equal(portfolio.excludedRisks.length, 1);
  assert.equal(portfolio.excludedFindings.length, 1);
  assert.equal(
    portfolio.activeRisks.find((risk) => risk.reviewStatus === 'ACCEPTED_RISK')
      ?.acceptedResidualRisk,
    true,
  );
});

test('风险组合：同一结果的双引擎 Finding 只形成一个题级风险并保留两条证据', () => {
  const portfolio = buildRiskPortfolio({
    findings: [
      finding({
        resultId: 'result-shared',
        engine: 'llm-judge',
        severity: 'MEDIUM',
        evidence: 'LLM 证据',
      }),
      finding({
        resultId: 'result-shared',
        engine: 'rule-judge',
        severity: 'CRITICAL',
        evidence: '规则证据',
      }),
    ],
    wrongAnswers: [],
    results: [],
  });

  assert.equal(portfolio.activeRisks.length, 1);
  assert.equal(portfolio.activeRisks[0]?.findings.length, 2);
  assert.equal(portfolio.activeRisks[0]?.representative.severity, 'CRITICAL');
  assert.equal(portfolio.scoreFindings.length, 1);
  assert.equal(
    buildSecurityScore({ findings: portfolio.scoreFindings, engineRuns: [] }).riskDeduction,
    30,
  );
});

test('风险组合：代表 Finding 缺少证据字段时，结果级风险继承同结果的明确证据边界', () => {
  const portfolio = buildRiskPortfolio({
    findings: [
      finding({
        resultId: 'result-evidence-boundary',
        engine: 'llm-judge',
        severity: 'CRITICAL',
        evidence: '裁判说明',
      }),
      finding({
        resultId: 'result-evidence-boundary',
        engine: 'agent-tool-guard',
        severity: 'HIGH',
        evidence: '回答文本证据；没有工具执行轨迹。',
        evidenceStrength: 'TEXT_OBSERVED',
        executionOutcome: 'NOT_ATTEMPTED',
      }),
    ],
    wrongAnswers: [],
    results: [],
  });

  const wrongAnswer = portfolioRiskToWrongAnswer(portfolio.activeRisks[0]!);
  assert.equal(wrongAnswer.evidenceStrength, 'TEXT_OBSERVED');
  assert.equal(wrongAnswer.executionOutcome, 'NOT_ATTEMPTED');
});

test('风险组合：同一结果混有 FP 与有效 Finding 时整题仍 active 且 FP 不主导代表项', () => {
  const portfolio = buildRiskPortfolio({
    findings: [
      finding({
        resultId: 'result-mixed-review',
        engine: 'ai-infra-guard',
        severity: 'CRITICAL',
        reviewStatus: 'FALSE_POSITIVE',
        evidence: '人工已排除的严重旁证',
      }),
      finding({
        resultId: 'result-mixed-review',
        engine: 'rule-judge',
        severity: 'HIGH',
        reviewStatus: 'NEEDS_REVIEW',
        evidence: '仍待人工复核的有效风险',
      }),
    ],
    wrongAnswers: [],
    results: [],
  });

  assert.equal(portfolio.activeRisks.length, 1);
  assert.equal(portfolio.excludedRisks.length, 0);
  assert.equal(portfolio.excludedFindings.length, 1);
  assert.equal(portfolio.activeRisks[0]?.findings.length, 2);
  assert.equal(portfolio.activeRisks[0]?.activeFindings.length, 1);
  assert.equal(portfolio.activeRisks[0]?.representative.severity, 'HIGH');
  assert.equal(portfolio.activeRisks[0]?.reviewStatus, 'NEEDS_REVIEW');
  const score = buildSecurityScore({ findings: portfolio.scoreFindings, engineRuns: [] });
  assert.equal(score.activeFindingCount, 1);
  assert.equal(score.riskDeduction, 20);
  assert.equal(score.score, 80);
});

test('风险组合：同题 active Finding 只有全量一致终态才聚合，否则统一待人工复核', () => {
  const aggregate = (...reviewStatuses: string[]) =>
    buildRiskPortfolio({
      findings: reviewStatuses.map((reviewStatus, index) =>
        finding({
          resultId: 'aggregate-result',
          engine: `engine-${index}`,
          reviewStatus,
        }),
      ),
      wrongAnswers: [],
      results: [],
    }).activeRisks[0]?.reviewStatus;

  assert.equal(aggregate('CONFIRMED', 'CONFIRMED'), 'CONFIRMED');
  assert.equal(aggregate('ACCEPTED_RISK', 'ACCEPTED_RISK'), 'ACCEPTED_RISK');
  assert.equal(aggregate('UNREVIEWED', 'UNREVIEWED'), 'UNREVIEWED');
  assert.equal(aggregate('NEEDS_REVIEW', 'CONFIRMED'), 'NEEDS_REVIEW');
  assert.equal(aggregate('CONFIRMED', 'UNREVIEWED'), 'NEEDS_REVIEW');
  assert.equal(aggregate('ACCEPTED_RISK', 'CONFIRMED'), 'NEEDS_REVIEW');
});

test('风险组合：无 resultId 的任务级 Finding 即使内容相同也不会错误合并', () => {
  const portfolio = buildRiskPortfolio({
    findings: [finding(), finding()],
    wrongAnswers: [],
    results: [],
  });

  assert.equal(portfolio.activeRisks.length, 2);
  assert.equal(new Set(portfolio.activeRisks.map((risk) => risk.key)).size, 2);
  assert.equal(portfolio.scoreFindings.length, 2);
});

test('风险组合：stableId 保证完全同文 Finding 的代表项与任务级排序不受输入顺序影响', () => {
  const findingA = finding({
    resultId: 'stable-result',
    stableId: 'finding-a',
    detail: { variant: 'a' },
  });
  const findingB = finding({
    resultId: 'stable-result',
    stableId: 'finding-b',
    detail: { variant: 'b' },
  });
  const forward = buildRiskPortfolio({
    findings: [findingB, findingA],
    wrongAnswers: [],
    results: [],
  });
  const reverse = buildRiskPortfolio({
    findings: [findingA, findingB],
    wrongAnswers: [],
    results: [],
  });

  assert.equal(forward.activeRisks[0]?.representative.stableId, 'finding-a');
  assert.equal(reverse.activeRisks[0]?.representative.stableId, 'finding-a');

  const taskA = finding({ stableId: 'task-a', detail: { variant: 'a' } });
  const taskB = finding({ stableId: 'task-b', detail: { variant: 'b' } });
  const taskForward = buildRiskPortfolio({
    findings: [taskB, taskA],
    wrongAnswers: [],
    results: [],
  });
  const taskReverse = buildRiskPortfolio({
    findings: [taskA, taskB],
    wrongAnswers: [],
    results: [],
  });
  assert.deepEqual(
    taskForward.activeRisks.map((risk) => risk.representative.stableId),
    ['task-a', 'task-b'],
  );
  assert.deepEqual(
    taskReverse.activeRisks.map((risk) => risk.representative.stableId),
    ['task-a', 'task-b'],
  );
});

test('风险组合：无 stableId 时使用 canonical detail 保证代表项稳定', () => {
  const alpha = finding({
    resultId: 'canonical-detail-result',
    detail: { nested: { z: 1, a: 2 }, variant: 'alpha' },
  });
  const omega = finding({
    resultId: 'canonical-detail-result',
    detail: { variant: 'omega', nested: { a: 2, z: 1 } },
  });
  const forward = buildRiskPortfolio({
    findings: [alpha, omega],
    wrongAnswers: [],
    results: [],
  });
  const reverse = buildRiskPortfolio({
    findings: [omega, alpha],
    wrongAnswers: [],
    results: [],
  });

  assert.deepEqual(
    forward.activeRisks[0]?.representative.detail,
    reverse.activeRisks[0]?.representative.detail,
  );
});

function reportInput(): ReportInputData {
  const now = new Date('2026-07-11T10:00:00.000Z');
  return {
    task: {
      id: 'task-risk-portfolio',
      name: '统一风险组合测试',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: ['rule-judge', 'llm-judge'],
      totalQuestions: 3,
      processedQuestions: 3,
      passedCount: 0,
      failedCount: 3,
      errorCount: 0,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      modelTarget: { name: '测试模型', provider: 'openai-compatible', model: 'test-model' },
      questionSets: [{ name: '测试题集', type: 'GENERAL' }],
    },
    verdictCounts: { FAIL: 3 },
    findings: [
      finding({
        resultId: 'result-with-wrong',
        severity: 'HIGH',
        title: '风险 A',
        evidence: '证据 A',
        reviewStatus: 'CONFIRMED',
      }),
      finding({
        resultId: 'result-finding-only',
        engine: 'llm-judge',
        severity: 'MEDIUM',
        title: '风险 B',
        evidence: '证据 B',
        reviewStatus: 'NEEDS_REVIEW',
      }),
      finding({
        resultId: 'result-stale',
        severity: 'CRITICAL',
        title: '已排除风险',
        evidence: '旧证据',
        reviewStatus: 'FALSE_POSITIVE',
      }),
    ],
    engineRuns: [],
    wrongAnswers: [
      {
        resultId: 'result-with-wrong',
        questionContent: '真实失败样本 A',
        modelResponse: '真实模型回答 A',
        riskCategory: 'prompt_injection',
        severity: 'HIGH',
        engine: 'rule-judge',
        reason: '样本 A 判定理由',
        explanation: {
          source: 'llm',
          mode: 'review_model',
          configured: true,
          riskType: '模型单证据风险类型',
          ruleAction: '模型单证据判定结果',
          answerProblem: '模型单证据回答问题',
          verdictReason: '模型单证据判定理由',
          remediation: '模型单证据整改建议',
          evidence: ['模型单证据依据'],
        },
      },
      {
        resultId: 'result-stale',
        questionContent: '不应出现的过期失败样本',
        modelResponse: '不应出现的旧回答',
        riskCategory: 'prompt_injection',
        severity: 'CRITICAL',
        engine: 'rule-judge',
        reason: '已由人工确认误报',
      },
    ],
    results: [
      {
        id: 'result-with-wrong',
        prompt: '结果表提示 A',
        response: '结果表回答 A',
        finalVerdict: 'FAIL',
        status: 'COMPLETED',
        question: {
          content: '题库问题 A',
          type: 'GENERAL',
          shouldRefuse: true,
          language: 'zh-CN',
          severity: 'HIGH',
          category: 'prompt_injection',
        },
      },
      {
        id: 'result-finding-only',
        prompt: '从 EvalResult 恢复的原始提示 B',
        response: '从 EvalResult 恢复的模型回答 B',
        finalVerdict: 'FAIL',
        status: 'COMPLETED',
        question: {
          content: '题库问题 B',
          type: 'GENERAL',
          shouldRefuse: true,
          language: 'zh-CN',
          severity: 'MEDIUM',
          category: 'prompt_injection',
        },
      },
      {
        id: 'result-stale',
        prompt: '过期提示',
        response: '过期回答',
        finalVerdict: 'FAIL',
        status: 'COMPLETED',
        question: {
          content: '过期题库问题',
          type: 'GENERAL',
          shouldRefuse: true,
          language: 'zh-CN',
          severity: 'CRITICAL',
          category: 'prompt_injection',
        },
      },
    ],
    generatedAt: now,
  };
}

test('基础报告：混合 WrongAnswer 与 finding-only 时统一输出两项有效风险', () => {
  const report = buildTaskReport(reportInput());
  const detailItems = report.summary.riskItemsBySeverity.flatMap((group) => group.items);

  assert.equal(report.summary.findingCount, 2);
  assert.equal(report.summary.evidenceFindingCount, 2);
  assert.equal(report.summary.securityScore.activeFindingCount, 2);
  assert.equal(report.summary.wrongAnswerCount, 2);
  assert.equal(detailItems.length, 2);
  assert.ok(detailItems.some((item) => item.questionContent.includes('真实失败样本 A')));
  assert.ok(
    detailItems.some((item) => item.questionContent.includes('从 EvalResult 恢复的原始提示 B')),
  );
  assert.ok(detailItems.some((item) => item.evidence.includes('从 EvalResult 恢复的模型回答 B')));
  const customerRiskText = JSON.stringify([
    report.summary.wrongAnswerSamples,
    report.summary.riskItemsBySeverity,
  ]);
  assert.match(customerRiskText, /模型单证据回答问题/);
  assert.doesNotMatch(JSON.stringify(report.summary), /result-stale/);
  assert.deepEqual(
    detailItems.map((item) => item.evidenceSelection?.snippets[0]?.sourceId).sort(),
    ['result-finding-only', 'result-with-wrong'],
  );
});

test('基础报告：Finding 无 evidence 时也不回退旧 WrongAnswer.reason', () => {
  const input = reportInput();
  input.findings[0] = {
    ...input.findings[0]!,
    evidence: null,
    title: '代表 Finding 本地标题',
  };
  input.wrongAnswers[0] = {
    ...input.wrongAnswers[0]!,
    reason: '绝不能继承的旧 WrongAnswer 理由',
    explanation: undefined,
  };

  const report = buildTaskReport(input);
  const customerRiskText = JSON.stringify([
    report.summary.wrongAnswerSamples,
    report.summary.riskItemsBySeverity,
  ]);

  assert.doesNotMatch(customerRiskText, /绝不能继承的旧 WrongAnswer 理由/);
  assert.match(customerRiskText, /代表 Finding 本地标题/);
});

test('基础报告：同一结果多条 Finding 时不挂载结果级模型说明', () => {
  const input = reportInput();
  input.findings.push(
    finding({
      stableId: 'second-finding-for-same-result',
      resultId: 'result-with-wrong',
      engine: 'llm-judge',
      severity: 'MEDIUM',
      title: '同题第二检测证据',
      evidence: '同题第二证据说明',
    }),
  );
  input.wrongAnswers[0] = {
    ...input.wrongAnswers[0]!,
    explanation: {
      ...input.wrongAnswers[0]!.explanation!,
      answerProblem: '绝不能挂载的多证据模型说明',
      verdictReason: '无法关联到具体 Finding',
    },
  };

  const report = buildTaskReport(input);
  const customerRiskText = JSON.stringify([
    report.summary.wrongAnswerSamples,
    report.summary.riskItemsBySeverity,
  ]);

  assert.doesNotMatch(customerRiskText, /绝不能挂载的多证据模型说明/);
  assert.match(customerRiskText, /证据 A/);
});

test('基础报告：仅有 FALSE_POSITIVE Finding 的过期 WrongAnswer 不进入明细和样本', () => {
  const report = buildTaskReport(reportInput());
  const detailText = JSON.stringify(report.summary.riskItemsBySeverity);
  const sampleText = JSON.stringify(report.summary.wrongAnswerSamples);

  assert.doesNotMatch(detailText, /不应出现的过期失败样本|不应出现的旧回答/);
  assert.doesNotMatch(sampleText, /不应出现的过期失败样本|不应出现的旧回答/);
  assert.match(sampleText, /从 EvalResult 恢复的原始提示 B/);
});

test('基础报告：各风险只展示本题引擎，不被其他题的证据引擎污染', () => {
  const report = buildTaskReport(reportInput());
  const engineLabels = report.summary.findingSamples.map((sample) => sample.engineLabel);

  assert.deepEqual(engineLabels, ['规则引擎', '判定模型']);
  assert.ok(engineLabels.every((label) => !label.includes('、')));
});

test('基础报告：冻结全部多引擎证据和排除证据，不暴露内部标识', () => {
  const input = reportInput();
  const ruleEvidence = '规则引擎完整证据-'.repeat(120);
  const llmEvidence = '判定模型完整证据-'.repeat(120);
  input.findings = [
    finding({
      stableId: 'finding-internal-rule',
      resultId: 'result-shared-internal',
      engine: 'rule-judge',
      severity: 'CRITICAL',
      title: '共享风险高危代表项',
      evidence: ruleEvidence,
      confidence: 0.91,
      reviewStatus: 'NEEDS_REVIEW',
      reviewReason: '规则证据待人工复核',
    }),
    finding({
      stableId: 'finding-internal-llm',
      resultId: 'result-shared-internal',
      engine: 'llm-judge',
      severity: 'HIGH',
      title: '共享风险 LLM 旁证',
      evidence: llmEvidence,
      confidence: 0.82,
      reviewStatus: 'CONFIRMED',
      reviewReason: 'LLM 证据已人工确认',
    }),
    finding({
      stableId: 'finding-internal-accepted',
      engine: 'rule-judge',
      severity: 'MEDIUM',
      title: '已接受的残余风险',
      evidence: '残余风险完整证据',
      reviewStatus: 'ACCEPTED_RISK',
      reviewReason: '风险责任人已接受',
    }),
    finding({
      stableId: 'finding-internal-fp',
      resultId: 'result-excluded-internal',
      engine: 'rule-judge',
      severity: 'LOW',
      title: '人工排除的误报',
      evidence: '误报处置完整证据',
      reviewStatus: 'FALSE_POSITIVE',
      reviewReason: '人工核验为误报',
    }),
  ];
  input.wrongAnswers = [
    {
      resultId: 'result-shared-internal',
      questionContent: '共享风险原始问题',
      modelResponse: '共享风险模型回答',
      riskCategory: 'prompt_injection',
      severity: 'CRITICAL',
      engine: 'rule-judge',
      reason: '失败样本补充说明',
    },
  ];
  input.results = [
    {
      id: 'result-shared-internal',
      prompt: '共享风险原始问题',
      response: '共享风险模型回答',
      finalVerdict: 'FAIL',
      status: 'COMPLETED',
      question: {
        content: '共享风险题库问题',
        type: 'GENERAL',
        shouldRefuse: true,
        language: 'zh-CN',
        severity: 'CRITICAL',
        category: 'prompt_injection',
      },
    },
  ];

  const report = buildTaskReport(input);
  const snapshot = report.summary.riskEvidencePortfolio;
  assert.ok(snapshot);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.activeRisks.length, 2);
  assert.equal(snapshot.excludedRisks.length, 1);

  const sharedRisk = snapshot.activeRisks.find(
    (risk) => risk.representative.title === '共享风险高危代表项',
  );
  assert.ok(sharedRisk);
  assert.equal(sharedRisk.reviewStatus, 'NEEDS_REVIEW');
  assert.equal(sharedRisk.evidence.length, 2);
  assert.deepEqual(
    sharedRisk.evidence.map((item) => item.engineLabel),
    ['规则引擎', '判定模型'],
  );
  assert.equal(sharedRisk.evidence[0]?.evidence, ruleEvidence);
  assert.equal(sharedRisk.evidence[1]?.evidence, llmEvidence);
  assert.equal(sharedRisk.evidence[0]?.reviewReason, '规则证据待人工复核');
  assert.equal(
    snapshot.activeRisks.find((risk) => risk.reviewStatus === 'ACCEPTED_RISK')
      ?.acceptedResidualRisk,
    true,
  );
  assert.equal(snapshot.excludedRisks[0]?.evidence[0]?.reviewStatus, 'FALSE_POSITIVE');
  assert.equal(snapshot.excludedRisks[0]?.evidence[0]?.evidence, '误报处置完整证据');

  const frozenJson = JSON.stringify(snapshot);
  assert.doesNotMatch(
    frozenJson,
    /result-shared-internal|result-excluded-internal|finding-internal|stableId|resultId/,
  );
});
