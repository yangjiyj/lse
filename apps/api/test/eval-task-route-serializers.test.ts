import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalTaskRouteSerializersForTest } from '../src/modules/eval-tasks/routes.js';

const baseDate = new Date('2026-06-22T00:00:00.000Z');

function resultWithRaw(rawOutput: Record<string, unknown>) {
  return {
    id: 'result-id',
    questionId: 'question-id',
    controlGroupId: null,
    side: null,
    prompt: 'prompt',
    response: 'response',
    status: 'SUCCESS',
    errorMessage: null,
    usage: null,
    latencyMs: null,
    finalVerdict: null,
    finalScore: null,
    startedAt: null,
    endedAt: null,
    createdAt: baseDate,
    question: { id: 'question-id', content: 'question', type: 'SHOULD_REFUSE', severity: 'HIGH' },
    findings: [],
    engineRuns: [
      {
        engine: 'autonomous-red-team',
        status: 'SUCCESS',
        requestPayload: { side: 'gateway', headName: 'react' },
        rawOutput: JSON.stringify(rawOutput),
        createdAt: baseDate,
      },
    ],
  } as any;
}

test('serializeRedTeamTrace exposes red-layer fields and stealth break status', () => {
  const trace = evalTaskRouteSerializersForTest.serializeRedTeamTrace(
    resultWithRaw({
      gatewayRecognizedRisk: false,
      redLayerReward: 1,
      recording: { brokenLayers: ['intent', 'action'] },
    }),
  );

  assert.deepEqual(trace?.brokenLayers, ['intent', 'action']);
  assert.equal(trace?.recognizedRisk, false);
  assert.equal(trace?.redLayerReward, 1);
  assert.equal(trace?.breakStatus, 'stealth_break');
});

test('serializeRedTeamTrace derives gateway_recognized and clean statuses', () => {
  const recognized = evalTaskRouteSerializersForTest.serializeRedTeamTrace(
    resultWithRaw({
      gatewayRecognizedRisk: true,
      redLayerReward: 0.5,
      recording: { brokenLayers: ['action'] },
    }),
  );
  const clean = evalTaskRouteSerializersForTest.serializeRedTeamTrace(
    resultWithRaw({
      gatewayRecognizedRisk: false,
      redLayerReward: 0,
      recording: { brokenLayers: [] },
    }),
  );

  assert.equal(recognized?.breakStatus, 'gateway_recognized');
  assert.equal(clean?.breakStatus, 'clean');
});

test('serializeRedTeamTrace 透出 liveExfilProven，且 canary 命中计入 breakStatus', () => {
  const proven = evalTaskRouteSerializersForTest.serializeRedTeamTrace(
    resultWithRaw({
      canaryHit: true,
      canaryToken: 'LSE-INTKEY-XYZ',
      gatewayRecognizedRisk: false,
      redLayerReward: 1,
      recording: { brokenLayers: [] },
    }),
  );
  assert.equal(proven?.liveExfilProven, true);
  assert.equal(proven?.canaryToken, 'LSE-INTKEY-XYZ');
  assert.equal(proven?.breakStatus, 'stealth_break');

  // canary 命中即使无 reward/brokenLayers 也绝不算 clean
  const canaryOnly = evalTaskRouteSerializersForTest.serializeRedTeamTrace(
    resultWithRaw({ canaryHit: true, recording: { brokenLayers: [] } }),
  );
  assert.notEqual(canaryOnly?.breakStatus, 'clean');

  // 无 canary 时 liveExfilProven=false
  const none = evalTaskRouteSerializersForTest.serializeRedTeamTrace(
    resultWithRaw({ redLayerReward: 0, recording: { brokenLayers: [] } }),
  );
  assert.equal(none?.liveExfilProven, false);
});

test('serializeTaskBase aggregates stealth and recognized red-team counts from results', () => {
  const task = {
    id: 'task-id',
    name: 'task',
    description: null,
    status: 'COMPLETED',
    engines: ['autonomous-red-team'],
    dimensions: ['red_team'],
    concurrency: 1,
    totalQuestions: 3,
    processedQuestions: 3,
    passedCount: 1,
    failedCount: 2,
    errorCount: 0,
    progress: 1,
    startedAt: baseDate,
    finishedAt: baseDate,
    createdAt: baseDate,
    updatedAt: baseDate,
    modelTarget: {
      id: 'target-id',
      name: 'target',
      targetType: 'MODEL',
      provider: 'openai-compatible',
      model: 'model',
    },
    _count: { results: 3, logs: 0, questionSets: 1 },
    results: [
      {
        engineRuns: [
          {
            engine: 'autonomous-red-team',
            rawOutput: JSON.stringify({ redLayerReward: 1, gatewayRecognizedRisk: false }),
          },
        ],
      },
      {
        engineRuns: [
          {
            engine: 'autonomous-red-team',
            rawOutput: JSON.stringify({ redLayerReward: 0.5, gatewayRecognizedRisk: true }),
          },
        ],
      },
      {
        engineRuns: [
          {
            engine: 'autonomous-red-team',
            rawOutput: JSON.stringify({ redLayerReward: 0, gatewayRecognizedRisk: false }),
          },
        ],
      },
    ],
  } as any;

  const serialized = evalTaskRouteSerializersForTest.serializeTaskBase(task);

  assert.equal(serialized.stealthBreakCount, 1);
  assert.equal(serialized.recognizedCount, 1);
});

test('serializeTaskBase 暴露 modelTarget 地址与网关状态，且不外泄凭据和 accessConfig', () => {
  const baseTask = {
    id: 'task-id',
    name: 'task',
    description: null,
    status: 'COMPLETED',
    engines: [],
    dimensions: [],
    concurrency: 1,
    totalQuestions: 1,
    processedQuestions: 1,
    passedCount: 1,
    failedCount: 0,
    errorCount: 0,
    progress: 1,
    startedAt: baseDate,
    finishedAt: baseDate,
    createdAt: baseDate,
    updatedAt: baseDate,
    _count: { results: 0, logs: 0, questionSets: 1 },
    results: [],
  };

  const bound = evalTaskRouteSerializersForTest.serializeTaskBase({
    ...baseTask,
    modelTarget: {
      id: 't1',
      name: 'agent',
      targetType: 'AGENT_API',
      provider: 'custom-agent',
      baseUrl: 'https://agent.example.test/v1',
      model: 'agent-api',
      accessConfig: {
        controlPlaneBaseUrl: 'http://control-plane:8081/admin/v1',
        tenantId: 'tenant_default',
      },
    },
  } as any);
  assert.equal(bound.modelTarget?.targetType, 'AGENT_API');
  assert.equal(bound.modelTarget?.baseUrl, 'https://agent.example.test/v1');
  assert.equal((bound.modelTarget as any)?.gatewayBound, true);
  assert.equal((bound.modelTarget as any)?.accessConfig, undefined);
  assert.equal((bound.modelTarget as any)?.apiKey, undefined);

  const unbound = evalTaskRouteSerializersForTest.serializeTaskBase({
    ...baseTask,
    modelTarget: {
      id: 't2',
      name: 'agent2',
      targetType: 'AGENT_API',
      provider: 'custom-agent',
      baseUrl: 'https://agent-2.example.test/v1',
      model: 'agent-api',
      accessConfig: { authType: 'bearer' },
    },
  } as any);
  assert.equal((unbound.modelTarget as any)?.gatewayBound, false);
});

test('serializeTaskBase 从任务级关系派生未判定与跳过引擎数量', () => {
  const task = {
    id: 'task-id',
    name: 'task',
    description: null,
    status: 'COMPLETED',
    engines: ['rule-judge', 'python-judge'],
    dimensions: [],
    concurrency: 1,
    totalQuestions: 8,
    processedQuestions: 8,
    passedCount: 4,
    failedCount: 1,
    errorCount: 1,
    progress: 1,
    startedAt: baseDate,
    finishedAt: baseDate,
    createdAt: baseDate,
    updatedAt: baseDate,
    modelTarget: {
      id: 'target-id',
      name: 'target',
      targetType: 'MODEL',
      provider: 'openai-compatible',
      model: 'model',
      accessConfig: null,
    },
    _count: { results: 2, logs: 0, questionSets: 1, engineRuns: 3 },
    results: [{ engineRuns: [] }, { engineRuns: [] }],
  } as any;

  const serialized = evalTaskRouteSerializersForTest.serializeTaskBase(task);

  assert.equal(serialized.unknownCount, 2);
  assert.equal(serialized.skippedEngineCount, 3);
  assert.equal((serialized as any).results, undefined);

  const overCounted = evalTaskRouteSerializersForTest.serializeTaskBase({
    ...task,
    processedQuestions: 1,
    passedCount: 2,
    failedCount: 1,
    errorCount: 1,
  });
  assert.equal(overCounted.unknownCount, 0);
});

test('serializeTaskDetail 同样暴露未判定与跳过引擎数量', () => {
  const serialized = evalTaskRouteSerializersForTest.serializeTaskDetail({
    id: 'task-id',
    name: 'task',
    description: null,
    status: 'COMPLETED',
    engines: [],
    dimensions: [],
    concurrency: 1,
    totalQuestions: 1,
    processedQuestions: 1,
    passedCount: 0,
    failedCount: 0,
    errorCount: 0,
    progress: 1,
    startedAt: baseDate,
    finishedAt: baseDate,
    createdAt: baseDate,
    updatedAt: baseDate,
    modelTarget: {
      id: 'target-id',
      name: 'target',
      targetType: 'MODEL',
      provider: 'openai-compatible',
      model: 'model',
      accessConfig: null,
    },
    _count: { results: 1, logs: 0, questionSets: 1, engineRuns: 1 },
    results: [{ engineRuns: [] }],
    questionSets: [
      {
        questionSet: {
          id: 'set-id',
          name: 'set',
          type: 'GENERAL',
          _count: { questions: 1 },
        },
      },
    ],
  } as any);

  assert.equal(serialized.unknownCount, 1);
  assert.equal(serialized.skippedEngineCount, 1);
});

test('任务列表与详情把部分跳过引擎计入覆盖缺口', () => {
  const serializers = evalTaskRouteSerializersForTest as any;
  const expected = {
    OR: [{ status: 'SKIPPED' }, { skippedCount: { gt: 0 } }],
  };

  assert.deepEqual(serializers.taskListInclude?._count.select.engineRuns.where, expected);
  assert.deepEqual(serializers.taskDetailInclude?._count.select.engineRuns.where, expected);
});

test("智能体发现项 detail 保留 agentInstanceId 与 riskFactors，供平台按实例归属回流", () => {
  const serialize = (evalTaskRouteSerializersForTest as Record<string, unknown>).serializeFindingDetail as
    | ((detail: unknown, finding: Record<string, unknown>) => Record<string, unknown> | null)
    | undefined;
  assert.equal(typeof serialize, "function", "serializeFindingDetail 需要可测试导出");
  const detail = serialize!(
    {
      attackPackId: "tri-product-v1",
      caseId: "tool_poisoning",
      agentInstanceId: "uai_test_instance",
      riskFactors: ["prompt_injection", "data_exfiltration"],
      trace: [],
    },
    { engine: "agent-tool-guard", verdict: "FAIL", severity: "CRITICAL" },
  );
  assert.ok(detail);
  assert.equal(detail!.agentInstanceId, "uai_test_instance");
  assert.deepEqual(detail!.riskFactors, ["prompt_injection", "data_exfiltration"]);
});
