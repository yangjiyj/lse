import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReportConclusionSnapshot,
  legacyReportConclusionSnapshot,
  normalizeReportConclusionSnapshot,
  parseReportConclusionSnapshot,
  reportConclusionScopeKindForReportKind,
  renderReportConclusionStateZh,
  type ReportConclusionBuildInput,
} from '../src/modules/reports/report-conclusion.js';

const completedTask = {
  status: 'COMPLETED',
  engines: ['rule-judge'],
  totalQuestions: 2,
  processedQuestions: 2,
  passedCount: 2,
  failedCount: 0,
  errorCount: 0,
};

const successRun = {
  engine: 'rule-judge',
  status: 'SUCCESS',
  skippedCount: 0,
};

function input(override: Partial<ReportConclusionBuildInput> = {}): ReportConclusionBuildInput {
  return {
    scopeKind: 'TASK',
    activeRiskCount: 0,
    task: completedTask,
    results: [
      { finalVerdict: 'PASS', status: 'SUCCESS', side: null },
      { finalVerdict: 'PASS', status: 'SUCCESS', side: null },
    ],
    engineRuns: [successRun],
    ...override,
  };
}

test('结论三态仅由有效风险和执行完整性决定，评分不属于输入', () => {
  const noRisk = buildReportConclusionSnapshot(input());
  const withRisk = buildReportConclusionSnapshot(input({ activeRiskCount: 1 }));
  const incomplete = buildReportConclusionSnapshot(
    input({ results: [{ finalVerdict: 'UNKNOWN', status: 'SUCCESS', side: null }] }),
  );

  assert.equal(noRisk.state, 'NO_RISK_OBSERVED');
  assert.equal(noRisk.coverageComplete, true);
  assert.equal(withRisk.state, 'RISK_DETECTED');
  assert.deepEqual(withRisk.reasonCodes, ['ACTIVE_RISK_PRESENT']);
  assert.equal(incomplete.state, 'INCOMPLETE');
  assert.equal(incomplete.coverageComplete, false);
  assert.ok(incomplete.reasonCodes.includes('RESULT_UNKNOWN'));
  assert.equal('score' in noRisk, false);
});

test('FAIL 没有对应有效风险时必须标记归因缺口，不能输出未观察到风险', () => {
  const snapshot = buildReportConclusionSnapshot(
    input({
      activeRiskCount: 0,
      task: {
        ...completedTask,
        totalQuestions: 1,
        processedQuestions: 1,
        passedCount: 0,
        failedCount: 1,
      },
      results: [{ finalVerdict: 'FAIL', status: 'SUCCESS', side: null }],
    }),
  );
  assert.equal(snapshot.state, 'INCOMPLETE');
  assert.equal(snapshot.coverageComplete, false);
  assert.ok(snapshot.reasonCodes.includes('UNEXPLAINED_FAIL_RESULT'));
  assert.deepEqual(parseReportConclusionSnapshot(structuredClone(snapshot)), snapshot);

  const forgedNoRisk = {
    ...snapshot,
    state: 'NO_RISK_OBSERVED' as const,
    coverageComplete: true,
    reasonCodes: snapshot.reasonCodes.filter((reason) => reason !== 'UNEXPLAINED_FAIL_RESULT'),
  };
  assert.throws(() => parseReportConclusionSnapshot(forgedNoRisk), /UNEXPLAINED_FAIL_RESULT/i);

  const passSnapshot = buildReportConclusionSnapshot(input());
  assert.throws(() =>
    parseReportConclusionSnapshot({
      ...passSnapshot,
      state: 'INCOMPLETE',
      coverageComplete: false,
      reasonCodes: ['UNEXPLAINED_FAIL_RESULT'],
    }),
  );
});

test('active risk 优先于执行缺口，仍保留全部缺口原因', () => {
  const snapshot = buildReportConclusionSnapshot(
    input({
      activeRiskCount: 2,
      task: { ...completedTask, status: 'FAILED' },
      results: [{ finalVerdict: 'ERROR', status: 'ERROR', side: null }],
      engineRuns: [{ ...successRun, status: 'FAILED' }],
    }),
  );
  assert.equal(snapshot.state, 'RISK_DETECTED');
  assert.equal(snapshot.coverageComplete, false);
  assert.ok(snapshot.reasonCodes.includes('ACTIVE_RISK_PRESENT'));
  assert.ok(snapshot.reasonCodes.includes('TASK_NOT_COMPLETED'));
  assert.ok(snapshot.reasonCodes.includes('RESULT_EXECUTION_ERROR'));
  assert.ok(snapshot.reasonCodes.includes('ENGINE_RUN_FAILED'));
});

test('ERROR/UNKNOWN/null 不进入通过率分母，并单独计执行缺口', () => {
  const snapshot = buildReportConclusionSnapshot(
    input({
      task: {
        ...completedTask,
        totalQuestions: 5,
        processedQuestions: 5,
        passedCount: 1,
        failedCount: 1,
        errorCount: 1,
      },
      results: [
        { finalVerdict: 'PASS', status: 'SUCCESS', side: null },
        { finalVerdict: 'FAIL', status: 'SUCCESS', side: null },
        { finalVerdict: 'ERROR', status: 'ERROR', side: null },
        { finalVerdict: 'UNKNOWN', status: 'SUCCESS', side: null },
        { finalVerdict: null, status: 'SUCCESS', side: null },
      ],
    }),
  );
  assert.equal(snapshot.passRate, 0.5);
  assert.equal(snapshot.validDecisionRate, 0.4);
  assert.deepEqual(
    {
      valid: snapshot.counts.valid,
      error: snapshot.counts.error,
      unknown: snapshot.counts.unknown,
      missingVerdict: snapshot.counts.missingVerdict,
      modelCallError: snapshot.counts.modelCallError,
    },
    { valid: 2, error: 1, unknown: 1, missingVerdict: 1, modelCallError: 1 },
  );
});

test('无 PASS/FAIL 时通过率为 null，并标记 NO_VALID_DECISION', () => {
  const snapshot = buildReportConclusionSnapshot(
    input({
      task: { ...completedTask, totalQuestions: 1, processedQuestions: 1 },
      results: [{ finalVerdict: 'UNKNOWN', status: 'SUCCESS', side: null }],
    }),
  );
  assert.equal(snapshot.passRate, null);
  assert.equal(snapshot.validDecisionRate, 0);
  assert.ok(snapshot.reasonCodes.includes('NO_VALID_DECISION'));
});

test('模型调用 ERROR 即使 finalVerdict 被错误写成 PASS 也必须标记执行错误', () => {
  const snapshot = buildReportConclusionSnapshot(
    input({
      task: { ...completedTask, totalQuestions: 1, processedQuestions: 1, passedCount: 1 },
      results: [{ finalVerdict: 'PASS', status: 'ERROR', side: null }],
    }),
  );
  assert.equal(snapshot.counts.error, 0);
  assert.equal(snapshot.counts.modelCallError, 1);
  assert.equal(snapshot.state, 'INCOMPLETE');
  assert.ok(snapshot.reasonCodes.includes('RESULT_EXECUTION_ERROR'));
});

test('TASK 校验任务状态、结果数量和任务计数器', () => {
  const snapshot = buildReportConclusionSnapshot(
    input({
      task: {
        ...completedTask,
        status: 'RUNNING',
        totalQuestions: 3,
        processedQuestions: 3,
        passedCount: 3,
      },
    }),
  );
  assert.equal(snapshot.state, 'INCOMPLETE');
  assert.ok(snapshot.reasonCodes.includes('TASK_NOT_COMPLETED'));
  assert.ok(snapshot.reasonCodes.includes('RESULT_COUNT_MISMATCH'));
  assert.ok(snapshot.reasonCodes.includes('TASK_COUNTER_MISMATCH'));
  assert.equal(snapshot.counts.unobservedResult, 1);
  assert.equal(snapshot.counts.skippedEvaluation, 0);
});

test('TASK observed 超过 expected 时 validDecisionRate 为 null 且 builder 输出可被自身 parser 接受', () => {
  const snapshot = buildReportConclusionSnapshot(
    input({
      task: {
        ...completedTask,
        totalQuestions: 1,
        processedQuestions: 2,
        passedCount: 2,
      },
      results: [
        { finalVerdict: 'PASS', status: 'SUCCESS', side: null },
        { finalVerdict: 'PASS', status: 'SUCCESS', side: null },
      ],
    }),
  );
  assert.ok(snapshot.reasonCodes.includes('RESULT_COUNT_MISMATCH'));
  assert.equal(snapshot.validDecisionRate, null);
  assert.deepEqual(parseReportConclusionSnapshot(structuredClone(snapshot)), snapshot);
});

test('results 缺失仅兼容旧 fixture，必须保守标记详情不可用', () => {
  const snapshot = buildReportConclusionSnapshot(input({ results: undefined }));
  assert.equal(snapshot.state, 'INCOMPLETE');
  assert.ok(snapshot.reasonCodes.includes('RESULT_DETAILS_UNAVAILABLE'));
  assert.notEqual(snapshot.state, 'NO_RISK_OBSERVED');
});

test('红队 A 侧对照不进入最终分母，只统计 B/null', () => {
  const snapshot = buildReportConclusionSnapshot(
    input({
      task: { ...completedTask, totalQuestions: 2, passedCount: 1, failedCount: 1 },
      results: [
        {
          finalVerdict: 'ERROR',
          status: 'ERROR',
          side: 'A',
          controlGroupId: 'red-team-pair',
        },
        {
          finalVerdict: 'PASS',
          status: 'SUCCESS',
          side: 'B',
          controlGroupId: 'red-team-pair',
        },
        { finalVerdict: 'FAIL', status: 'SUCCESS', side: null },
      ],
    }),
  );
  assert.equal(snapshot.counts.observed, 2);
  assert.equal(snapshot.counts.error, 0);
  assert.equal(snapshot.passRate, 0.5);
  assert.equal(snapshot.coverageComplete, false);
  assert.ok(snapshot.reasonCodes.includes('UNEXPLAINED_FAIL_RESULT'));
});

test('引擎矩阵：缺失、非终态、失败、跳过、SUCCESS partial skip 均不完整', () => {
  const cases = [
    { runs: [], reason: 'ENGINE_RUN_MISSING' },
    { runs: [{ ...successRun, status: 'RUNNING' }], reason: 'ENGINE_RUN_NOT_TERMINAL' },
    { runs: [{ ...successRun, status: 'FAILED' }], reason: 'ENGINE_RUN_FAILED' },
    { runs: [{ ...successRun, status: 'SKIPPED' }], reason: 'ENGINE_RUN_SKIPPED' },
    { runs: [{ ...successRun, skippedCount: 1 }], reason: 'ENGINE_RUN_PARTIAL_SKIP' },
  ] as const;
  for (const item of cases) {
    const snapshot = buildReportConclusionSnapshot(input({ engineRuns: [...item.runs] }));
    assert.equal(snapshot.state, 'INCOMPLETE', item.reason);
    assert.ok(snapshot.reasonCodes.includes(item.reason), item.reason);
  }
});

test('红队显式 expectedEngines 以实际执行计划校验，不把启用依赖当缺失引擎', () => {
  const snapshot = buildReportConclusionSnapshot(
    input({
      task: {
        ...completedTask,
        engines: ['rule-judge', 'sensitive-info', 'llm-judge'],
        expectedEngines: ['autonomous-red-team'],
      },
      engineRuns: [
        {
          engine: 'autonomous-red-team',
          status: 'SUCCESS',
          skippedCount: 0,
        },
      ],
    }),
  );
  assert.equal(snapshot.missingEngineRunCount, 0);
  assert.equal(snapshot.coverageComplete, true);
  assert.equal(snapshot.state, 'NO_RISK_OBSERVED');
});

test('skippedEvaluation 只统计引擎 skippedCount，不混入缺失结果数', () => {
  const snapshot = buildReportConclusionSnapshot(
    input({ engineRuns: [{ ...successRun, skippedCount: 3 }] }),
  );
  assert.equal(snapshot.counts.skippedEvaluation, 3);
  assert.equal(snapshot.counts.unobservedResult, 0);
  assert.ok(snapshot.reasonCodes.includes('ENGINE_RUN_PARTIAL_SKIP'));
});

test('ENGINE_RUN_SET 允许成功组件零结果形成完整的未观察到风险结论', () => {
  const snapshot = buildReportConclusionSnapshot({
    scopeKind: 'ENGINE_RUN_SET',
    activeRiskCount: 0,
    results: [],
    engineRuns: [{ ...successRun, engine: 'ai-infra-guard', normalizedCount: 0 }],
  });
  assert.equal(snapshot.state, 'NO_RISK_OBSERVED');
  assert.equal(snapshot.coverageComplete, true);
  assert.equal(snapshot.passRate, null);
  assert.equal(snapshot.validDecisionRate, null);
  assert.deepEqual(snapshot.reasonCodes, []);
});

test('服务核验报告使用 ENGINE_RUN_SET，ERROR 运行必须判为覆盖不完整', () => {
  assert.equal(reportConclusionScopeKindForReportKind('service_assurance'), 'ENGINE_RUN_SET');
  const snapshot = buildReportConclusionSnapshot({
    scopeKind: 'ENGINE_RUN_SET',
    activeRiskCount: 0,
    results: [],
    engineRuns: [{ engine: '安全核验', status: 'ERROR', skippedCount: 0 }],
  });
  assert.equal(snapshot.counts.engineRunFailed, 1);
  assert.equal(snapshot.coverageComplete, false);
  assert.equal(snapshot.state, 'INCOMPLETE');
  assert.ok(snapshot.reasonCodes.includes('ENGINE_RUN_FAILED'));
});

test('RESULT_SET 独立按作用域结果判定，不被全局任务错误计数污染', () => {
  const snapshot = buildReportConclusionSnapshot({
    scopeKind: 'RESULT_SET',
    activeRiskCount: 0,
    results: [{ finalVerdict: 'PASS', status: 'SUCCESS', side: null }],
    engineRuns: [],
  });
  assert.equal(snapshot.state, 'NO_RISK_OBSERVED');
  assert.equal(snapshot.counts.expected, 1);
  assert.equal(snapshot.passRate, 1);
});

test('RESULT_SET 与 ENGINE_RUN_SET 在任务未完成时都必须保持 INCOMPLETE', () => {
  const runningTask = {
    ...completedTask,
    status: 'RUNNING',
    totalQuestions: 100,
    processedQuestions: 1,
    passedCount: 1,
  };
  const resultSet = buildReportConclusionSnapshot({
    scopeKind: 'RESULT_SET',
    activeRiskCount: 0,
    task: runningTask,
    results: [{ finalVerdict: 'PASS', status: 'SUCCESS', side: null }],
    engineRuns: [successRun],
  });
  const engineRunSet = buildReportConclusionSnapshot({
    scopeKind: 'ENGINE_RUN_SET',
    activeRiskCount: 0,
    task: runningTask,
    results: [],
    engineRuns: [{ ...successRun, engine: 'ai-infra-guard' }],
  });

  for (const snapshot of [resultSet, engineRunSet]) {
    assert.equal(snapshot.state, 'INCOMPLETE');
    assert.equal(snapshot.coverageComplete, false);
    assert.ok(snapshot.reasonCodes.includes('TASK_NOT_COMPLETED'));
    assert.ok(!snapshot.reasonCodes.includes('RESULT_COUNT_MISMATCH'));
    assert.ok(!snapshot.reasonCodes.includes('TASK_COUNTER_MISMATCH'));
  }
  assert.equal(resultSet.counts.expected, 1);
  assert.equal(resultSet.passRate, 1);
  assert.equal(engineRunSet.passRate, null);
});

test('严格 parser 重建白名单并拒绝额外字段、自由文本、Infinity 与状态矛盾', () => {
  const valid = buildReportConclusionSnapshot(input());
  assert.deepEqual(parseReportConclusionSnapshot(structuredClone(valid)), valid);

  for (const malicious of [
    { ...valid, narrative: '可直接上线' },
    { ...valid, recommendation: '模型表现合规' },
    { ...valid, policyVersion: 'report-conclusion-v2' },
    { ...valid, counts: { ...valid.counts, pass: Infinity } },
    { ...valid, counts: { ...valid.counts, pass: -1 } },
    { ...valid, state: 'RISK_DETECTED' },
    { ...valid, reasonCodes: ['UNKNOWN_REASON'] },
  ]) {
    assert.throws(() => parseReportConclusionSnapshot(malicious));
  }
});

test('strict parser 拒绝删除 RESULT_UNKNOWN 后伪造的 NO_RISK 快照', () => {
  const snapshot = buildReportConclusionSnapshot({
    scopeKind: 'RESULT_SET',
    activeRiskCount: 0,
    results: [
      { finalVerdict: 'PASS', status: 'SUCCESS', side: null },
      { finalVerdict: 'UNKNOWN', status: 'SUCCESS', side: null },
    ],
    engineRuns: [],
  });
  assert.deepEqual(snapshot.reasonCodes, ['RESULT_UNKNOWN']);

  const forged = {
    ...snapshot,
    state: 'NO_RISK_OBSERVED',
    coverageComplete: true,
    reasonCodes: [],
  };
  assert.throws(() => parseReportConclusionSnapshot(forged), /reason/i);
  assert.equal(normalizeReportConclusionSnapshot(forged).source, 'LEGACY_FALLBACK');
});

test('strict parser 拒绝删除 partial-skip reason 或伪造 partial/skippedEvaluation 计数', () => {
  const snapshot = buildReportConclusionSnapshot({
    scopeKind: 'ENGINE_RUN_SET',
    activeRiskCount: 0,
    results: [],
    engineRuns: [
      {
        engine: 'ai-infra-guard',
        status: 'SUCCESS',
        skippedCount: 2,
        normalizedCount: 1,
      },
    ],
  });
  assert.deepEqual(snapshot.reasonCodes, ['ENGINE_RUN_PARTIAL_SKIP']);

  const missingReason = {
    ...snapshot,
    state: 'NO_RISK_OBSERVED',
    coverageComplete: true,
    reasonCodes: [],
  };
  assert.throws(() => parseReportConclusionSnapshot(missingReason), /reason/i);
  assert.equal(normalizeReportConclusionSnapshot(missingReason).source, 'LEGACY_FALLBACK');

  for (const counts of [
    { ...snapshot.counts, engineRunPartialSkip: 0 },
    { ...snapshot.counts, skippedEvaluation: 0 },
  ]) {
    assert.throws(
      () => parseReportConclusionSnapshot({ ...snapshot, counts }),
      /counts|partial|skipped/i,
    );
  }
});

test('strict parser 拒绝与 scope 不可能同时成立的计数和冻结 signals', () => {
  const taskSnapshot = buildReportConclusionSnapshot(input());
  assert.equal(taskSnapshot.taskCompleted, true);
  assert.equal(taskSnapshot.resultDetailsAvailable, true);
  assert.equal(taskSnapshot.taskCountersMatch, true);
  assert.throws(
    () =>
      parseReportConclusionSnapshot({
        ...taskSnapshot,
        taskCountersMatch: null,
      }),
    /coverage signals|taskCountersMatch/i,
  );

  const resultSetSnapshot = buildReportConclusionSnapshot({
    scopeKind: 'RESULT_SET',
    activeRiskCount: 0,
    results: [{ finalVerdict: 'PASS', status: 'SUCCESS', side: null }],
    engineRuns: [],
  });
  assert.throws(
    () =>
      parseReportConclusionSnapshot({
        ...resultSetSnapshot,
        counts: { ...resultSetSnapshot.counts, expected: 2, unobservedResult: 1 },
        validDecisionRate: 0.5,
      }),
    /counts|scope|coverage signals/i,
  );
});

test('strict parser 以冻结 signals 双向校验四类不可由 counts 推导的覆盖原因', () => {
  const cases = [
    {
      reason: 'TASK_NOT_COMPLETED' as const,
      signalKey: 'taskCompleted' as const,
      signalValue: false,
      tamperedSignal: true,
      snapshot: buildReportConclusionSnapshot({
        scopeKind: 'RESULT_SET',
        activeRiskCount: 0,
        task: {
          ...completedTask,
          status: 'RUNNING',
          totalQuestions: 100,
          processedQuestions: 1,
          passedCount: 1,
        },
        results: [{ finalVerdict: 'PASS', status: 'SUCCESS', side: null }],
        engineRuns: [successRun],
      }),
    },
    {
      reason: 'RESULT_DETAILS_UNAVAILABLE' as const,
      signalKey: 'resultDetailsAvailable' as const,
      signalValue: false,
      tamperedSignal: true,
      snapshot: buildReportConclusionSnapshot(
        input({
          task: {
            ...completedTask,
            totalQuestions: 0,
            processedQuestions: 0,
            passedCount: 0,
          },
          results: undefined,
        }),
      ),
    },
    {
      reason: 'TASK_COUNTER_MISMATCH' as const,
      signalKey: 'taskCountersMatch' as const,
      signalValue: false,
      tamperedSignal: true,
      snapshot: buildReportConclusionSnapshot(
        input({ task: { ...completedTask, passedCount: 1 } }),
      ),
    },
    {
      reason: 'ENGINE_RUN_MISSING' as const,
      signalKey: 'missingEngineRunCount' as const,
      signalValue: 1,
      tamperedSignal: 0,
      snapshot: buildReportConclusionSnapshot(input({ engineRuns: [] })),
    },
  ];

  for (const item of cases) {
    assert.ok(item.snapshot.reasonCodes.includes(item.reason));
    const remainingReasons = item.snapshot.reasonCodes.filter((reason) => reason !== item.reason);
    const coverageComplete = remainingReasons.length === 0;
    const forged = {
      ...item.snapshot,
      reasonCodes: remainingReasons,
      coverageComplete,
      state: coverageComplete ? ('NO_RISK_OBSERVED' as const) : item.snapshot.state,
    };
    assert.throws(() => parseReportConclusionSnapshot(forged), new RegExp(item.reason, 'i'));
    assert.equal(item.snapshot[item.signalKey], item.signalValue);
    assert.throws(() =>
      parseReportConclusionSnapshot({
        ...item.snapshot,
        [item.signalKey]: item.tamperedSignal,
      }),
    );
  }
});

test('legacy fallback 永远是 INCOMPLETE，且畸形历史快照统一降级', () => {
  const fallback = legacyReportConclusionSnapshot();
  assert.equal(fallback.source, 'LEGACY_FALLBACK');
  assert.equal(fallback.state, 'INCOMPLETE');
  assert.equal(fallback.basis, null);
  assert.equal(fallback.counts, null);
  assert.equal(fallback.activeRiskCount, null);
  assert.deepEqual(fallback.reasonCodes, ['LEGACY_SNAPSHOT_MISSING']);
  assert.deepEqual(normalizeReportConclusionSnapshot({ score: 100 }), fallback);
});

test('中文 renderer 仅由固定枚举生成，不消费自由文本', () => {
  assert.equal(
    renderReportConclusionStateZh(buildReportConclusionSnapshot(input())),
    '本次评估范围内未观察到风险',
  );
  assert.equal(
    renderReportConclusionStateZh(buildReportConclusionSnapshot(input({ activeRiskCount: 1 }))),
    '本次评估范围内标记风险，需结合复核状态确认',
  );
  assert.equal(renderReportConclusionStateZh(legacyReportConclusionSnapshot()), '评估结论不完整');
});
