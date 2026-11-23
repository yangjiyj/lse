import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { prisma } from '../src/db.js';
import { normalizeNucleiJsonl } from '../src/modules/service-assurance/normalize/nuclei.js';
import {
  readExecutionChecks,
  buildExecutionSummary,
  REQUEST_TOTAL_EVIDENCE_TYPE,
  EXECUTION_EVIDENCE_TYPE,
} from '../src/modules/service-assurance/execution-evidence.js';
import { normalizeZapJson } from '../src/modules/service-assurance/normalize/zap.js';
import {
  persistServiceAssuranceResult,
  persistServiceAssuranceResults,
} from '../src/modules/service-assurance/persist.js';

const prefix = `__service_assurance_persist_${randomUUID()}_`;
const createdTaskIds: string[] = [];
const createdTargetIds: string[] = [];

const fixture = (name: string) =>
  readFile(new URL(`./fixtures/service-assurance/${name}`, import.meta.url), 'utf8');

// Observed sidecar fixture: both fixed SAFE HTTP checks sent one request and
// received a complete response. This is independent of the configured plan size.
function safeExecution() {
  return {
    requestCount: 2,
    checks: [
      {
        id: 'lse-http-security-headers',
        label: '响应类型防护头检查',
        status: 'COMPLETED' as const,
        requestCount: 1,
        detail: '已观察到实际请求及完整响应，检查执行完成。',
      },
      {
        id: 'lse-triton-product-fingerprint',
        label: 'Triton 服务识别',
        status: 'COMPLETED' as const,
        requestCount: 1,
        detail: '已观察到实际请求及完整响应，检查执行完成。',
      },
    ],
  };
}

async function createRun(targetName: string) {
  const target = await prisma.modelTarget.create({
    data: {
      name: `${prefix}${targetName}`,
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'persist-test-placeholder', // pragma: allowlist secret
      model: 'not-used',
    },
  });
  createdTargetIds.push(target.id);
  const task = await prisma.evalTask.create({
    data: {
      name: `${prefix}${targetName}`,
      modelTargetId: target.id,
      engines: [],
      dimensions: [],
    },
  });
  createdTaskIds.push(task.id);
  const run = await prisma.serviceAssuranceRun.create({
    data: {
      taskId: task.id,
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      targetName,
      normalizedTarget: 'https://api.example.test/v1',
      scopePolicyRef: 'customer-lab',
      requestBudget: { maxRequests: 200 },
      status: 'RUNNING',
      coverageStatus: 'NOT_READY',
    },
  });
  const engineRun = await prisma.engineRun.create({
    data: {
      taskId: task.id,
      engine: 'service-assurance-nuclei',
      status: 'RUNNING',
      startedAt: new Date(),
    },
  });
  return { task, run, engineRun };
}

after(async () => {
  if (createdTaskIds.length > 0) {
    await prisma.serviceEvidence.deleteMany({ where: { run: { taskId: { in: createdTaskIds } } } });
    await prisma.vulnerabilityAssessment.deleteMany({
      where: { run: { taskId: { in: createdTaskIds } } },
    });
    await prisma.serviceComponent.deleteMany({
      where: { run: { taskId: { in: createdTaskIds } } },
    });
    await prisma.serviceAsset.deleteMany({ where: { run: { taskId: { in: createdTaskIds } } } });
    await prisma.serviceAssuranceRun.deleteMany({ where: { taskId: { in: createdTaskIds } } });
    await prisma.finding.deleteMany({ where: { taskId: { in: createdTaskIds } } });
    await prisma.engineRun.deleteMany({ where: { taskId: { in: createdTaskIds } } });
    await prisma.evalTask.deleteMany({ where: { id: { in: createdTaskIds } } });
  }
  if (createdTargetIds.length > 0) {
    await prisma.modelTarget.deleteMany({ where: { id: { in: createdTargetIds } } });
  }
  await prisma.$disconnect();
});

test('正式配置风险事务化持久化且重复执行不产生重复记录', async () => {
  const { task, run, engineRun } = await createRun('正式风险');
  const normalized = normalizeNucleiJsonl(await fixture('nuclei-safe-positive.jsonl'), {
    mode: 'SAFE',
    authorizationConfirmed: false,
    completed: true,
    rulesetStatus: 'CURRENT',
    execution: safeExecution(),
  });
  const input = {
    runId: run.id,
    taskId: task.id,
    engineRunId: engineRun.id,
    normalized,
    execution: {
      engineName: 'service-assurance-nuclei',
      baselineKind: 'RULESET',
      completed: true,
      durationMs: 50,
      engineVersion: '3.9.0',
      engineDigest: `sha256:${'b'.repeat(64)}`,
      baselineVersion: 'lse-nuclei-safe-2026.08.30',
      baselineDigest: `sha256:${'a'.repeat(64)}`,
      errorCode: null,
    },
  } as const;

  await persistServiceAssuranceResult(input);
  await persistServiceAssuranceResult(input);

  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({
    where: { id: run.id },
    include: { assets: true, components: true, assessments: true, evidence: true },
  });
  assert.equal(stored.status, 'COMPLETED');
  assert.equal(stored.coverageStatus, 'COMPLETE');
  assert.equal(stored.assets.length, 1);
  assert.equal(stored.components.length, 0);
  assert.equal(stored.assessments.length, 1);
  assert.equal(stored.evidence.filter((item) => item.assessmentId !== null).length, 1);
  assert.equal(
    stored.evidence.filter((item) => item.evidenceType === EXECUTION_EVIDENCE_TYPE).length,
    2,
  );
  assert.deepEqual(
    readExecutionChecks(stored.evidence).sort((a, b) => a.id.localeCompare(b.id)),
    normalized.execution!.checks.sort((a, b) => a.id.localeCompare(b.id)),
  );
  const totals = stored.evidence.filter(
    (item) => item.evidenceType === REQUEST_TOTAL_EVIDENCE_TYPE,
  );
  assert.equal(totals.length, 1, '重复持久化不能重复累计请求总数');
  assert.equal(buildExecutionSummary('SAFE', 'ENDPOINT', stored.evidence).requestCount, 2);
  assert.ok(stored.assessments[0]?.findingId);
  assert.equal(
    await prisma.finding.count({
      where: { taskId: task.id, engine: 'service-assurance' },
    }),
    1,
  );

  const storedEngineRun = await prisma.engineRun.findUniqueOrThrow({ where: { id: engineRun.id } });
  assert.equal(storedEngineRun.status, 'SUCCESS');
  assert.equal(storedEngineRun.rawOutput, null);
  assert.equal(storedEngineRun.normalizedCount, 1);
});

test('弱组件线索只写专用表而不生成 Finding', async () => {
  const { task, run, engineRun } = await createRun('弱线索');
  const normalized = normalizeNucleiJsonl(await fixture('nuclei-triton-lead.jsonl'), {
    mode: 'SAFE',
    authorizationConfirmed: false,
    completed: true,
    rulesetStatus: 'CURRENT',
    execution: safeExecution(),
  });

  await persistServiceAssuranceResult({
    runId: run.id,
    taskId: task.id,
    engineRunId: engineRun.id,
    normalized,
    execution: {
      engineName: 'service-assurance-nuclei',
      baselineKind: 'RULESET',
      completed: true,
      durationMs: 20,
      engineVersion: '3.9.0',
      engineDigest: `sha256:${'b'.repeat(64)}`,
      baselineVersion: 'lse-nuclei-safe-2026.08.30',
      baselineDigest: `sha256:${'a'.repeat(64)}`,
      errorCode: null,
    },
  });

  const assessment = await prisma.vulnerabilityAssessment.findFirstOrThrow({
    where: { runId: run.id },
  });
  const component = await prisma.serviceComponent.findFirstOrThrow({
    where: { runId: run.id },
  });
  assert.equal(component.name, 'NVIDIA Triton 推理服务');
  assert.equal(component.version, null);
  assert.equal(assessment.impactStatus, 'UNDER_INVESTIGATION');
  assert.equal(assessment.evidenceLevel, 'LEAD');
  assert.equal(assessment.findingId, null);
  assert.equal(await prisma.finding.count({ where: { taskId: task.id } }), 0);
});

test('部分解析结果保留已完成证据并把运行标记为覆盖不完整', async () => {
  const { task, run, engineRun } = await createRun('部分结果');
  const positive = await fixture('nuclei-safe-positive.jsonl');
  const normalized = normalizeNucleiJsonl(`${positive}\n{broken-json`, {
    mode: 'SAFE',
    authorizationConfirmed: false,
    completed: true,
    rulesetStatus: 'CURRENT',
    execution: safeExecution(),
  });

  await persistServiceAssuranceResult({
    runId: run.id,
    taskId: task.id,
    engineRunId: engineRun.id,
    normalized,
    execution: {
      engineName: 'service-assurance-nuclei',
      baselineKind: 'RULESET',
      completed: true,
      durationMs: 30,
      engineVersion: '3.9.0',
      engineDigest: `sha256:${'b'.repeat(64)}`,
      baselineVersion: 'lse-nuclei-safe-2026.08.30',
      baselineDigest: `sha256:${'a'.repeat(64)}`,
      errorCode: null,
    },
  });

  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stored.status, 'COMPLETED');
  assert.equal(stored.coverageStatus, 'INCOMPLETE');
  assert.equal(
    await prisma.serviceEvidence.count({
      where: { runId: run.id, assessmentId: { not: null } },
    }),
    1,
  );
});

test('多引擎结果在同一终结事务中合并且不覆盖 engineVersions', async () => {
  const { task, run, engineRun } = await createRun('多引擎合并');
  const zapEngineRun = await prisma.engineRun.create({
    data: {
      taskId: task.id,
      engine: 'service-assurance-zap',
      status: 'RUNNING',
      startedAt: new Date(),
    },
  });
  const nuclei = normalizeNucleiJsonl(await fixture('nuclei-safe-positive.jsonl'), {
    mode: 'SAFE',
    authorizationConfirmed: false,
    completed: true,
    rulesetStatus: 'CURRENT',
    execution: safeExecution(),
  });
  const zap = normalizeZapJson(await fixture('zap-safe.json'), {
    mode: 'SAFE',
    authorizationConfirmed: false,
    completed: true,
    rulesetStatus: 'CURRENT',
    allowedActiveRuleIds: [],
  });
  // The orchestrator can prove the process ended, but not which ZAP rules ran.
  zap.execution = {
    requestCount: 5, // Gateway observed five requests; phase attribution remains unknown.
    checks: [
      {
        id: 'zap-api-passive',
        label: '接口描述与被动响应检查',
        status: 'UNKNOWN',
        requestCount: null,
        detail: '扫描进程已结束，但未取得逐规则执行证据。',
      },
    ],
  };
  zap.coverageStatus = 'INCOMPLETE';
  zap.customerSummary.incomplete = true;
  zap.customerSummary.statusMessage = '接口检查缺少逐项执行证据，请查看执行记录。';

  await persistServiceAssuranceResults([
    {
      runId: run.id,
      taskId: task.id,
      engineRunId: engineRun.id,
      normalized: nuclei,
      execution: {
        engineName: 'service-assurance-nuclei',
        baselineKind: 'RULESET',
        completed: true,
        durationMs: 50,
        engineVersion: '3.9.0',
        engineDigest: `sha256:${'b'.repeat(64)}`,
        baselineVersion: 'lse-nuclei-safe-2026.08.30',
        baselineDigest: `sha256:${'a'.repeat(64)}`,
        errorCode: null,
      },
    },
    {
      runId: run.id,
      taskId: task.id,
      engineRunId: zapEngineRun.id,
      normalized: zap,
      execution: {
        engineName: 'service-assurance-zap',
        baselineKind: 'RULESET',
        completed: true,
        durationMs: 35,
        engineVersion: '2.16.1',
        engineDigest: `sha256:${'e'.repeat(64)}`,
        baselineVersion: 'lse-nuclei-safe-2026.08.30',
        baselineDigest: `sha256:${'a'.repeat(64)}`,
        errorCode: null,
      },
    },
  ]);

  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stored.status, 'COMPLETED');
  assert.equal(stored.coverageStatus, 'INCOMPLETE');
  const versions = stored.engineVersions as Record<string, unknown>;
  assert.ok(versions.nuclei);
  assert.ok(versions.zap);
  const checks = readExecutionChecks(
    await prisma.serviceEvidence.findMany({ where: { runId: run.id } }),
  );
  assert.equal(checks.length, 3);
  assert.equal(checks.find((check) => check.id === 'zap-api-passive')?.status, 'UNKNOWN');
  assert.equal(checks.find((check) => check.id === 'zap-api-passive')?.requestCount, null);
  assert.equal(
    buildExecutionSummary(
      'SAFE',
      'OPENAPI',
      await prisma.serviceEvidence.findMany({ where: { runId: run.id } }),
    ).requestCount,
    7,
  );

  assert.equal(
    await prisma.serviceEvidence.count({
      where: { runId: run.id, assessmentId: { not: null } },
    }),
    2,
  );
});

test('已取消运行不会被后到扫描结果覆盖', async () => {
  const { task, run, engineRun } = await createRun('取消后到结果');
  const canceledAt = new Date();
  await prisma.serviceAssuranceRun.update({
    where: { id: run.id },
    data: {
      status: 'CANCELED',
      coverageStatus: 'INCOMPLETE',
      canceledAt,
      endedAt: canceledAt,
    },
  });
  const normalized = normalizeNucleiJsonl(await fixture('nuclei-safe-positive.jsonl'), {
    mode: 'SAFE',
    authorizationConfirmed: false,
    completed: true,
    rulesetStatus: 'CURRENT',
    execution: safeExecution(),
  });

  await persistServiceAssuranceResult({
    runId: run.id,
    taskId: task.id,
    engineRunId: engineRun.id,
    normalized,
    execution: {
      engineName: 'service-assurance-nuclei',
      baselineKind: 'RULESET',
      completed: true,
      durationMs: 50,
      engineVersion: '3.9.0',
      engineDigest: `sha256:${'b'.repeat(64)}`,
      baselineVersion: 'lse-nuclei-safe-2026.08.30',
      baselineDigest: `sha256:${'a'.repeat(64)}`,
      errorCode: null,
    },
  });

  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stored.status, 'CANCELED');
  assert.equal(stored.canceledAt?.toISOString(), canceledAt.toISOString());
  assert.equal(
    await prisma.serviceEvidence.count({
      where: { runId: run.id, assessmentId: { not: null } },
    }),
    0,
  );
  assert.equal(await prisma.finding.count({ where: { taskId: task.id } }), 0);
  const storedEngineRun = await prisma.engineRun.findUniqueOrThrow({ where: { id: engineRun.id } });
  assert.equal(storedEngineRun.status, 'SKIPPED');
});

test('拒绝覆盖同任务的旧引擎运行证据', async () => {
  const { task, run } = await createRun('旧引擎隔离');
  const historicalRawOutput = '{"historical":"preserved"}';
  const legacyEngineRun = await prisma.engineRun.create({
    data: {
      taskId: task.id,
      engine: 'ai-infra-guard',
      status: 'SUCCESS',
      startedAt: new Date(),
      endedAt: new Date(),
      rawOutput: historicalRawOutput,
    },
  });
  const normalized = normalizeNucleiJsonl(await fixture('nuclei-safe-positive.jsonl'), {
    mode: 'SAFE',
    authorizationConfirmed: false,
    completed: true,
    rulesetStatus: 'CURRENT',
    execution: safeExecution(),
  });

  await assert.rejects(
    persistServiceAssuranceResult({
      runId: run.id,
      taskId: task.id,
      engineRunId: legacyEngineRun.id,
      normalized,
      execution: {
        engineName: 'service-assurance-nuclei',
        baselineKind: 'RULESET',
        completed: true,
        durationMs: 10,
        engineVersion: '3.9.0',
        engineDigest: `sha256:${'b'.repeat(64)}`,
        baselineVersion: 'lse-nuclei-safe-2026.08.30',
        baselineDigest: `sha256:${'a'.repeat(64)}`,
        errorCode: null,
      },
    }),
    /运行与评估任务不匹配/,
  );

  const preserved = await prisma.engineRun.findUniqueOrThrow({
    where: { id: legacyEngineRun.id },
  });
  assert.equal(preserved.rawOutput, historicalRawOutput);
});
