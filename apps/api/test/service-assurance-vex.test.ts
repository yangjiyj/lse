import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENVEX_NOT_AFFECTED_JUSTIFICATIONS,
  buildFixedDecision,
  buildNotAffectedDecision,
} from '../src/modules/service-assurance/vex.js';

const originalRun = {
  id: 'run-original',
  taskId: 'task-a',
};

const successfulRetest = {
  id: 'run-retest',
  taskId: 'task-a',
  retestOfRunId: 'run-original',
  status: 'COMPLETED' as const,
  coverageStatus: 'COMPLETE' as const,
  endedAt: new Date('2026-08-30T08:00:00.000Z'),
  remainingAffectedCount: 0,
  originalRiskCheckCompleted: true,
};

test('NOT_AFFECTED 只接受五个 OpenVEX 受控理由并保留客户说明', () => {
  assert.deepEqual(OPENVEX_NOT_AFFECTED_JUSTIFICATIONS, [
    'component_not_present',
    'vulnerable_code_not_present',
    'vulnerable_code_not_in_execute_path',
    'vulnerable_code_cannot_be_controlled_by_adversary',
    'inline_mitigations_already_exist',
  ]);

  for (const justification of OPENVEX_NOT_AFFECTED_JUSTIFICATIONS) {
    const decision = buildNotAffectedDecision({
      justification,
      statement: '已由复核人员确认，并记录可审计依据。',
    });
    assert.equal(decision.impactStatus, 'NOT_AFFECTED');
    assert.equal(decision.justification, justification);
    assert.match(decision.reason, /已由复核人员确认/);
    assert.ok(!decision.reason.includes(justification));
  }
});

test('NOT_AFFECTED 拒绝自由理由、空说明和超长说明', () => {
  assert.throws(
    () =>
      buildNotAffectedDecision({
        justification: 'version_looks_safe' as never,
        statement: '人工判断没问题',
      }),
    /不受影响理由/,
  );
  assert.throws(
    () =>
      buildNotAffectedDecision({
        justification: 'component_not_present',
        statement: '   ',
      }),
    /说明/,
  );
  assert.throws(
    () =>
      buildNotAffectedDecision({
        justification: 'component_not_present',
        statement: '证'.repeat(1001),
      }),
    /1000/,
  );
});

test('FIXED 只接受同任务、正确关联且完整成功的无残留风险复测', () => {
  const decision = buildFixedDecision({
    originalRun,
    retestRun: successfulRetest,
    statement: '整改后复测未再次观察到该风险。',
  });

  assert.deepEqual(decision, {
    impactStatus: 'FIXED',
    fixedByRunId: 'run-retest',
    reason: '整改后复测未再次观察到该风险。',
  });
});

test('FIXED 拒绝跨任务、错误来源、未完成、缺少原项证明、无结束时间和残留风险', () => {
  const invalidRetests = [
    { ...successfulRetest, taskId: 'task-b' },
    { ...successfulRetest, retestOfRunId: 'run-other' },
    { ...successfulRetest, status: 'RUNNING' as const },
    { ...successfulRetest, originalRiskCheckCompleted: false },
    { ...successfulRetest, endedAt: null },
    { ...successfulRetest, remainingAffectedCount: 1 },
  ];

  for (const retestRun of invalidRetests) {
    assert.throws(
      () =>
        buildFixedDecision({
          originalRun,
          retestRun,
          statement: '整改后复测通过。',
        }),
      /复测/,
    );
  }
});

test('其他检查失败不阻塞已取得原问题有效复测证据的关闭', () => {
  const result = buildFixedDecision({
    originalRun,
    retestRun: { ...successfulRetest, status: 'PARTIAL', coverageStatus: 'INCOMPLETE' },
    statement: '原问题对应检查已实际成功执行且未再出现。',
  });
  assert.equal(result.impactStatus, 'FIXED');
});
