import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeAssuranceRunToEvalTask } from '../src/modules/assurance/eval-task-writeback.js';
import type { AssuranceDryRunResult } from '../src/modules/assurance/runner.js';
import type { AssuranceSamplePlanItem } from '../src/modules/assurance/types.js';

const sample = (index: number): AssuranceSamplePlanItem => ({
  sampleId: `run-1-sample-${index}`,
  policyId: `policy.${index}`,
  category: 'secret',
  prompt: `sample ${index}`,
  traceId: `trace-${index}`,
  evalRunId: 'run-1',
  taskId: 'task-1',
  targetId: 'target-1',
  expectedDecision: 'alert',
  expected: {
    requestLog: true,
    contentLog: true,
    securityEvent: true,
    alert: true,
    block: false,
    uiVisible: true,
    writeback: false,
    outbox: false,
  },
});

function dryRun(failures: string[] = []): AssuranceDryRunResult {
  return {
    status: 'COMPLETED',
    stopReason: null,
    samples: [sample(1), sample(2)],
    artifactManifestPath: '/tmp/assurance/manifest.json',
    evidenceSummaries: [
      {
        sampleId: 'run-1-sample-1',
        policyId: 'policy.1',
        variantId: 'direct',
        traceId: 'trace-1',
        eventCount: 1,
        policyHitCount: 1,
        ruleIds: ['secret_generic_api_key'],
        actions: ['alert'],
        verdicts: ['flagged'],
      },
      {
        sampleId: 'run-1-sample-2',
        policyId: 'policy.2',
        variantId: 'multi_turn',
        traceId: 'trace-2',
        eventCount: failures.length > 0 ? 0 : 2,
        policyHitCount: failures.length > 0 ? 0 : 2,
        ruleIds: failures.length > 0 ? [] : ['prompt_injection_classic_injection'],
        actions: failures.length > 0 ? [] : ['alert'],
        verdicts: failures.length > 0 ? [] : ['flagged'],
      },
    ],
    attributions: [
      { owner: 'none', failureCodes: [] },
      { owner: failures.length > 0 ? 'gateway' : 'none', failureCodes: failures as any },
    ],
  };
}

test('writeAssuranceRunToEvalTask creates one visible daily task and updates it on later runs', async () => {
  const tasks: Array<Record<string, any>> = [];
  const links: Array<Record<string, string>> = [];
  const logs: Array<Record<string, any>> = [];
  const client = {
    modelTarget: { findUnique: async () => ({targetType: 'MODEL'}) },
    evalTask: {
      findFirst: async ({ where }: { where: { name: string; modelTargetId: string } }) =>
        tasks.find(
          (task) => task.name === where.name && task.modelTargetId === where.modelTargetId,
        ) ?? null,
      create: async ({ data }: { data: Record<string, any> }) => {
        const task = { id: `task-${tasks.length + 1}`, ...data };
        tasks.push(task);
        return task;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const task = tasks.find((item) => item.id === where.id);
        assert(task);
        Object.assign(task, data);
        return task;
      },
    },
    evalTaskQuestionSet: {
      upsert: async ({ where, create }: { where: any; create: Record<string, string> }) => {
        const key = where.taskId_questionSetId;
        const existing = links.find(
          (link) => link.taskId === key.taskId && link.questionSetId === key.questionSetId,
        );
        if (!existing) links.push(create);
        return existing ?? create;
      },
    },
    evalTaskLog: {
      create: async ({ data }: { data: Record<string, any> }) => {
        logs.push(data);
        return data;
      },
    },
  };

  const first = await writeAssuranceRunToEvalTask(client, {
    runId: 'auto-20260620-114554',
    modelTargetId: 'model-1',
    questionSetId: 'set-1',
    result: dryRun(),
    artifactManifestPath: '/tmp/assurance/run-1/manifest.json',
    gatewayRef: 'gw-sha',
    lseRef: 'lse-sha',
    now: new Date('2026-06-20T03:51:00Z'),
  });
  const second = await writeAssuranceRunToEvalTask(client, {
    runId: 'auto-20260620-120001',
    modelTargetId: 'model-1',
    questionSetId: 'set-1',
    result: dryRun(['GW_NO_ALERT']),
    artifactManifestPath: '/tmp/assurance/run-2/manifest.json',
    gatewayRef: 'gw-sha-2',
    lseRef: 'lse-sha-2',
    now: new Date('2026-06-20T04:01:00Z'),
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.evalTaskId, second.evalTaskId);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.name, '网关 Assurance 自动闭环 2026-06-20');
  assert.equal(tasks[0]?.status, 'COMPLETED');
  assert.deepEqual(tasks[0]?.engines, ['gateway-assurance']);
  assert.equal(tasks[0]?.totalQuestions, 2);
  assert.equal(tasks[0]?.processedQuestions, 2);
  assert.equal(tasks[0]?.passedCount, 1);
  assert.equal(tasks[0]?.failedCount, 1);
  assert.equal(tasks[0]?.progress, 100);
  assert.match(String(tasks[0]?.description), /auto-20260620-120001/);
  assert.match(String(tasks[0]?.description), /风险 1 条/);
  assert.deepEqual(links, [{ taskId: 'task-1', questionSetId: 'set-1' }]);
  assert.equal(logs.length, 2);
  assert.equal(logs[1]?.level, 'warn');
  assert.deepEqual(logs[1]?.context.failureCodes, ['GW_NO_ALERT']);
  assert.equal(logs[1]?.context.policyHitSamples, 1);
  assert.equal(logs[1]?.context.policyHitTotal, 1);
  assert.equal(logs[1]?.context.multiTurnSamples, 1);
  assert.match(logs[1]?.message, /策略命中 1\/2/);
});
