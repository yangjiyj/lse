import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { SERVICE_ASSURANCE_REQUEST_BUDGET } from '../src/modules/service-assurance/contracts.js';

const prefix = `__service_assurance_retest_${randomUUID()}_`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const enqueuedRunIds: string[] = [];
const storedSboms = new Map<string, { content: string }>();

let app: Awaited<ReturnType<typeof buildApp>>;
let ownerId = '';
let ownerToken = '';
let otherId = '';
let scanOnlyId = '';
let scanOnlyToken = '';
let targetId = '';
let ownerTaskId = '';
let otherTaskId = '';
let scanOnlyTaskId = '';

async function cleanup(): Promise<void> {
  const tasks = await prisma.evalTask.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const taskIds = tasks.map((item) => item.id);
  if (taskIds.length > 0) {
    await prisma.serviceEvidence.deleteMany({ where: { run: { taskId: { in: taskIds } } } });
    await prisma.vulnerabilityAssessment.deleteMany({
      where: { run: { taskId: { in: taskIds } } },
    });
    await prisma.serviceComponent.deleteMany({ where: { run: { taskId: { in: taskIds } } } });
    await prisma.serviceAsset.deleteMany({ where: { run: { taskId: { in: taskIds } } } });
    await prisma.serviceAssuranceRun.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.finding.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.engineRun.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.evalTask.deleteMany({ where: { id: { in: taskIds } } });
  }
  await prisma.auditLog.deleteMany({ where: { actorName: { startsWith: prefix } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: prefix } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: prefix } } });
  storedSboms.clear();
}

async function createUser(label: string, permissions: string[]) {
  const role = await prisma.role.create({
    data: {
      name: `${prefix}${label}_role`,
      permissions: {
        create: permissions.map((code) => ({ permission: { connect: { code } } })),
      },
    },
  });
  const user = await prisma.user.create({
    data: {
      username: `${prefix}${label}`,
      passwordHash: 'not-used',
      displayName: label,
      roles: { create: { roleId: role.id } },
    },
  });
  return {
    id: user.id,
    token: app.jwt.sign({ sub: user.id, username: user.username }),
  };
}

async function createTask(label: string, createdById: string): Promise<string> {
  return (
    await prisma.evalTask.create({
      data: {
        name: `${prefix}${label}`,
        modelTargetId: targetId,
        engines: [],
        dimensions: [],
        createdById,
      },
    })
  ).id;
}

async function createOriginalRun(
  taskId: string,
  label: string,
  mode: 'SAFE' | 'DEEP' | 'SBOM' = 'SAFE',
) {
  const sbom = mode === 'SBOM';
  return prisma.serviceAssuranceRun.create({
    data: {
      taskId,
      createdById:
        taskId === otherTaskId ? otherId : taskId === scanOnlyTaskId ? scanOnlyId : ownerId,
      mode,
      targetKind: sbom ? 'SBOM' : mode === 'DEEP' ? 'OPENAPI' : 'ENDPOINT',
      targetName: label,
      normalizedTarget: sbom ? null : 'https://api.example.test/openapi.json',
      scopePolicyRef: 'customer-production-scope',
      credentialRef: null,
      authorizationConfirmed: mode === 'DEEP',
      authorizationConfirmedAt: mode === 'DEEP' ? new Date('2026-08-30T08:00:00.000Z') : null,
      requestBudget: SERVICE_ASSURANCE_REQUEST_BUDGET,
      rulesetVersion: sbom ? null : 'old-ruleset',
      rulesetDigest: sbom ? null : `sha256:${'1'.repeat(64)}`,
      vulnerabilityDbVersion: sbom ? 'old-vulnerability-db' : null,
      vulnerabilityDbDigest: sbom ? `sha256:${'2'.repeat(64)}` : null,
      status: 'COMPLETED',
      coverageStatus: 'COMPLETE',
      startedAt: new Date('2026-08-30T08:00:00.000Z'),
      endedAt: new Date('2026-08-30T08:01:00.000Z'),
    },
  });
}

async function createAssessment(runId: string, label: string) {
  return prisma.vulnerabilityAssessment.create({
    data: {
      runId,
      title: label,
      severity: 'HIGH',
      impactStatus: 'AFFECTED',
      evidenceLevel: 'CONFIG_MATCH',
      confidence: 0.95,
      priority: 'P1',
      reason: '固定规则命中。',
      remediation: '整改后发起复测。',
      assessmentKey: `${prefix}${label}`,
    },
  });
}

before(async () => {
  await cleanup();
  for (const code of [
    'service_assurance:read',
    'service_assurance:scan',
    'service_assurance:verify',
    'service_assurance:review',
  ]) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, name: code, group: '服务安全核验' },
      update: {},
    });
  }
  app = await buildApp({
    serviceAssurance: {
      getReadiness: async () => ({
        modes: [
          {
            mode: 'SAFE',
            ready: true,
            message: '安全检查已就绪。',
            baselineUpdatedAt: '2026-08-30T00:00:00.000Z',
          },
          {
            mode: 'DEEP',
            ready: true,
            message: '深度核验已就绪。',
            baselineUpdatedAt: '2026-08-30T00:00:00.000Z',
          },
          {
            mode: 'SBOM',
            ready: true,
            message: '组件清单核验已就绪。',
            baselineUpdatedAt: '2026-08-30T00:00:00.000Z',
          },
        ],
      }),
      baselineForMode: (mode) =>
        mode === 'SBOM'
          ? {
              kind: 'VULNERABILITY_DB',
              version: 'current-vulnerability-db',
              digest: `sha256:${'b'.repeat(64)}`,
            }
          : {
              kind: 'RULESET',
              version: 'current-ruleset',
              digest: `sha256:${'a'.repeat(64)}`,
            },
      enqueueRun: async (runId) => {
        enqueuedRunIds.push(runId);
      },
      putSbom: async (runId, upload) => {
        storedSboms.set(runId, { content: upload.content });
      },
      deleteSbom: async (runId) => {
        storedSboms.delete(runId);
      },
      requestCancel: async () => undefined,
    },
  });
  await app.ready();

  const owner = await createUser('owner', [
    'service_assurance:read',
    'service_assurance:scan',
    'service_assurance:verify',
    'service_assurance:review',
  ]);
  ownerId = owner.id;
  ownerToken = owner.token;
  const other = await createUser('other', [
    'service_assurance:read',
    'service_assurance:scan',
    'service_assurance:verify',
    'service_assurance:review',
  ]);
  otherId = other.id;
  const scanOnly = await createUser('scan-only', [
    'service_assurance:read',
    'service_assurance:scan',
  ]);
  scanOnlyId = scanOnly.id;
  scanOnlyToken = scanOnly.token;

  const target = await prisma.modelTarget.create({
    data: {
      name: `${prefix}target`,
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'retest-test-placeholder', // pragma: allowlist secret
      model: 'not-used',
      createdById: ownerId,
    },
  });
  targetId = target.id;
  ownerTaskId = await createTask('owner-task', ownerId);
  otherTaskId = await createTask('other-task', otherId);
  scanOnlyTaskId = await createTask('scan-only-task', scanOnlyId);
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('复测只从服务端复制目标、范围和预算并使用当前基线', async () => {
  const original = await createOriginalRun(ownerTaskId, '生产 API 风险');
  const assessment = await createAssessment(original.id, '未授权接口');
  const response = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/assessments/${assessment.id}/retest`,
    headers: bearer(ownerToken),
    payload: {},
  });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json() as { run: { runId: string; status: string } };
  assert.equal(body.run.status, 'PENDING');
  assert.ok(enqueuedRunIds.includes(body.run.runId));
  assert.doesNotMatch(response.body, /credential-profile|current-ruleset|digest/i);

  const retest = await prisma.serviceAssuranceRun.findUniqueOrThrow({
    where: { id: body.run.runId },
  });
  assert.equal(retest.retestOfRunId, original.id);
  assert.equal(retest.taskId, original.taskId);
  assert.equal(retest.createdById, ownerId);
  assert.equal(retest.mode, original.mode);
  assert.equal(retest.targetKind, original.targetKind);
  assert.equal(retest.targetName, original.targetName);
  assert.equal(retest.normalizedTarget, original.normalizedTarget);
  assert.equal(retest.scopePolicyRef, original.scopePolicyRef);
  assert.equal(retest.credentialRef, original.credentialRef);
  assert.deepEqual(retest.requestBudget, SERVICE_ASSURANCE_REQUEST_BUDGET);
  assert.equal(retest.rulesetVersion, 'current-ruleset');
  assert.equal(retest.rulesetDigest, `sha256:${'a'.repeat(64)}`);
  assert.equal(retest.startedAt, null);
  assert.equal(retest.endedAt, null);
});

test('复测严格拒绝浏览器覆盖目标、范围、凭据、命令、模板、并发或超时', async () => {
  const original = await createOriginalRun(ownerTaskId, '严格复测');
  const assessment = await createAssessment(original.id, '严格复测判断');
  const beforeCount = await prisma.serviceAssuranceRun.count({
    where: { retestOfRunId: original.id },
  });
  for (const payload of [
    { targetUrl: 'https://attacker.example.test' },
    { scopePolicyRef: 'other-scope' },
    { credentialRef: 'other-credential' },
    { command: 'scanner --target metadata' },
    { templatePath: '/tmp/untrusted.yaml' },
    { concurrency: 999 },
    { timeout: 999999 },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/service-assurance/assessments/${assessment.id}/retest`,
      headers: bearer(ownerToken),
      payload,
    });
    assert.equal(response.statusCode, 400, `${JSON.stringify(payload)}: ${response.body}`);
  }
  assert.equal(
    await prisma.serviceAssuranceRun.count({ where: { retestOfRunId: original.id } }),
    beforeCount,
  );
});

test('复测通过 assessment 反查任务并按原模式执行 BOLA/BFLA', async () => {
  const otherRun = await createOriginalRun(otherTaskId, '他人风险');
  const otherAssessment = await createAssessment(otherRun.id, '他人判断');
  const deniedObject = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/assessments/${otherAssessment.id}/retest`,
    headers: bearer(ownerToken),
    payload: {},
  });
  assert.equal(deniedObject.statusCode, 403, deniedObject.body);

  const deepRun = await createOriginalRun(scanOnlyTaskId, '深度风险', 'DEEP');
  const deepAssessment = await createAssessment(deepRun.id, '深度判断');
  const deniedOperation = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/assessments/${deepAssessment.id}/retest`,
    headers: bearer(scanOnlyToken),
    payload: {},
  });
  assert.equal(deniedOperation.statusCode, 403, deniedOperation.body);
  assert.equal(deniedOperation.json().error.code, 'SERVICE_ASSURANCE_PERMISSION_DENIED');
});

test('SBOM 复测要求新的受限清单且原文只进入一次性通道', async () => {
  const original = await createOriginalRun(ownerTaskId, '组件清单风险', 'SBOM');
  const assessment = await createAssessment(original.id, '受影响组件版本');
  const missing = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/assessments/${assessment.id}/retest`,
    headers: bearer(ownerToken),
    payload: {},
  });
  assert.equal(missing.statusCode, 400, missing.body);

  const raw = await readFile(
    new URL('./fixtures/service-assurance/cyclonedx-triton-fixed.json', import.meta.url),
    'utf8',
  );
  const document = JSON.parse(raw) as Record<string, unknown>;
  document.properties = [{ name: 'sentinel', value: 'CANARY-SBOM-RETEST-NEVER-PERSIST' }];
  const content = JSON.stringify(document);
  const response = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/assessments/${assessment.id}/retest`,
    headers: bearer(ownerToken),
    payload: {
      sbom: {
        contentType: 'application/vnd.cyclonedx+json',
        content,
      },
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  const runId = response.json().run.runId as string;
  assert.equal(storedSboms.get(runId)?.content, content);

  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(stored.retestOfRunId, original.id);
  assert.equal(stored.vulnerabilityDbVersion, 'current-vulnerability-db');
  assert.doesNotMatch(
    JSON.stringify(stored),
    /CANARY-SBOM-RETEST-NEVER-PERSIST|CycloneDX|components/i,
  );
});

test('历史凭据占位不再被静默复制成已认证核验', async () => {
  const original = await createOriginalRun(ownerTaskId, '旧凭据配置');
  await prisma.serviceAssuranceRun.update({
    where: { id: original.id },
    data: { credentialRef: 'old-unimplemented-profile' },
  });
  const risk = await createAssessment(original.id, '旧凭据风险');
  const result = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/assessments/${risk.id}/retest`,
    headers: bearer(ownerToken),
    payload: {},
  });
  assert.equal(result.statusCode, 400, result.body);
  assert.equal(result.json().error.code, 'SERVICE_ASSURANCE_CREDENTIAL_UNSUPPORTED');
  assert.equal(
    await prisma.serviceAssuranceRun.count({ where: { retestOfRunId: original.id } }),
    0,
  );
});
