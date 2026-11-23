import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import {
  encodeExecutionCheck,
  EXECUTION_EVIDENCE_TYPE,
} from '../src/modules/service-assurance/execution-evidence.js';
import { SERVICE_ASSURANCE_REQUEST_BUDGET } from '../src/modules/service-assurance/contracts.js';

const prefix = `__service_assurance_review_${randomUUID()}_`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

let app: Awaited<ReturnType<typeof buildApp>>;
let ownerId = '';
let ownerToken = '';
let otherId = '';
let scannerId = '';
let scannerToken = '';
let targetId = '';
let ownerTaskId = '';
let otherTaskId = '';
let scannerTaskId = '';

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
  const task = await prisma.evalTask.create({
    data: {
      name: `${prefix}${label}`,
      modelTargetId: targetId,
      engines: [],
      dimensions: [],
      createdById,
    },
  });
  return task.id;
}

async function createRun(
  taskId: string,
  label: string,
  options: {
    status?: 'PENDING' | 'RUNNING' | 'COMPLETED';
    coverageStatus?: 'NOT_READY' | 'INCOMPLETE' | 'COMPLETE';
    retestOfRunId?: string;
  } = {},
) {
  const status = options.status ?? 'COMPLETED';
  return prisma.serviceAssuranceRun.create({
    data: {
      taskId,
      createdById:
        taskId === otherTaskId ? otherId : taskId === scannerTaskId ? scannerId : ownerId,
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      targetName: label,
      normalizedTarget: 'https://api.example.test/v1',
      scopePolicyRef: 'customer-lab',
      requestBudget: SERVICE_ASSURANCE_REQUEST_BUDGET,
      rulesetVersion: 'lse-rules-2026.08.30.3',
      rulesetDigest: `sha256:${'a'.repeat(64)}`,
      status,
      coverageStatus:
        options.coverageStatus ?? (status === 'COMPLETED' ? 'COMPLETE' : 'INCOMPLETE'),
      startedAt: status === 'PENDING' ? null : new Date('2026-08-30T08:00:00.000Z'),
      endedAt: status === 'COMPLETED' ? new Date('2026-08-30T08:01:00.000Z') : null,
      retestOfRunId: options.retestOfRunId,
    },
  });
}

async function createAssessment(
  runId: string,
  label: string,
  input: {
    impactStatus: 'UNDER_INVESTIGATION' | 'AFFECTED' | 'NOT_AFFECTED' | 'FIXED';
    evidenceLevel: 'LEAD' | 'VERSION_MATCH' | 'CONFIG_MATCH' | 'ACTIVE_VERIFIED';
  },
) {
  return prisma.vulnerabilityAssessment.create({
    data: {
      runId,
      title: label,
      severity: input.evidenceLevel === 'LEAD' ? null : 'HIGH',
      impactStatus: input.impactStatus,
      evidenceLevel: input.evidenceLevel,
      confidence: input.evidenceLevel === 'LEAD' ? 0.35 : 0.95,
      priority: input.evidenceLevel === 'LEAD' ? 'UNKNOWN' : 'P1',
      reason: '自动核验的初始判断。',
      remediation: input.evidenceLevel === 'LEAD' ? null : '限制暴露并补充访问控制。',
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
      enqueueRun: async () => undefined,
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
  const scanner = await createUser('scanner', [
    'service_assurance:read',
    'service_assurance:scan',
    'service_assurance:verify',
  ]);
  scannerId = scanner.id;
  scannerToken = scanner.token;

  const target = await prisma.modelTarget.create({
    data: {
      name: `${prefix}target`,
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'review-test-placeholder', // pragma: allowlist secret
      model: 'not-used',
      createdById: ownerId,
    },
  });
  targetId = target.id;
  ownerTaskId = await createTask('owner-task', ownerId);
  otherTaskId = await createTask('other-task', otherId);
  scannerTaskId = await createTask('scanner-task', scannerId);
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('人工复核同时执行 BFLA 与 assessment 到 task 的 BOLA 授权', async () => {
  const scannerRun = await createRun(scannerTaskId, '扫描员运行');
  const scannerAssessment = await createAssessment(scannerRun.id, '扫描员线索', {
    impactStatus: 'UNDER_INVESTIGATION',
    evidenceLevel: 'LEAD',
  });
  const noOperationPermission = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/assessments/${scannerAssessment.id}/review`,
    headers: bearer(scannerToken),
    payload: {
      impactStatus: 'NOT_AFFECTED',
      justification: 'component_not_present',
      statement: '已核对部署清单，目标中不存在该组件。',
    },
  });
  assert.equal(noOperationPermission.statusCode, 403, noOperationPermission.body);

  const otherRun = await createRun(otherTaskId, '他人运行');
  const otherAssessment = await createAssessment(otherRun.id, '他人判断', {
    impactStatus: 'AFFECTED',
    evidenceLevel: 'CONFIG_MATCH',
  });
  const noObjectPermission = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/assessments/${otherAssessment.id}/review`,
    headers: bearer(ownerToken),
    payload: {
      impactStatus: 'NOT_AFFECTED',
      justification: 'inline_mitigations_already_exist',
      statement: '已有不可绕过的访问控制。',
    },
  });
  assert.equal(noObjectPermission.statusCode, 403, noObjectPermission.body);
});

test('弱线索不能只靠人工按钮升级风险，不受影响必须使用受控理由', async () => {
  const run = await createRun(ownerTaskId, '弱线索运行');
  const assessment = await createAssessment(run.id, '疑似组件', {
    impactStatus: 'UNDER_INVESTIGATION',
    evidenceLevel: 'LEAD',
  });

  const promoted = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/assessments/${assessment.id}/review`,
    headers: bearer(ownerToken),
    payload: {
      impactStatus: 'AFFECTED',
      statement: '人工认为存在风险。',
    },
  });
  assert.equal(promoted.statusCode, 409, promoted.body);
  assert.equal(promoted.json().error.code, 'SERVICE_ASSURANCE_EVIDENCE_INSUFFICIENT');

  const missingJustification = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/assessments/${assessment.id}/review`,
    headers: bearer(ownerToken),
    payload: {
      impactStatus: 'NOT_AFFECTED',
      statement: '已核对部署清单。',
    },
  });
  assert.equal(missingJustification.statusCode, 400, missingJustification.body);

  const reviewed = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/assessments/${assessment.id}/review`,
    headers: bearer(ownerToken),
    payload: {
      impactStatus: 'NOT_AFFECTED',
      justification: 'component_not_present',
      statement: '已核对部署清单，目标中不存在该组件。',
    },
  });
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.equal(reviewed.json().result.impactStatus, 'NOT_AFFECTED');
  assert.doesNotMatch(reviewed.body, /component_not_present|service-assurance|rawOutput/i);

  const stored = await prisma.vulnerabilityAssessment.findUniqueOrThrow({
    where: { id: assessment.id },
  });
  assert.equal(stored.reviewedById, ownerId);
  assert.ok(stored.reviewedAt);
  assert.match(stored.reason, /目标中不存在该组件/);
  assert.equal(stored.reviewNote, '已核对部署清单，目标中不存在该组件。');
});

test('FIXED 使用原问题的有效复测证据，其他风险不阻塞且保留历史 Finding', async () => {
  const originalRun = await createRun(ownerTaskId, '原始风险运行');
  const assessment = await createAssessment(originalRun.id, '已确认配置风险', {
    impactStatus: 'AFFECTED',
    evidenceLevel: 'CONFIG_MATCH',
  });
  const finding = await prisma.finding.create({
    data: {
      taskId: ownerTaskId,
      engine: 'service-assurance',
      riskCategory: 'service_vulnerability',
      severity: 'HIGH',
      verdict: 'FAIL',
      confidence: 0.95,
      reviewStatus: 'NEEDS_REVIEW',
      suppressionKey: `${prefix}finding`,
      title: assessment.title,
      evidence: assessment.reason,
    },
  });
  await prisma.vulnerabilityAssessment.update({
    where: { id: assessment.id },
    data: { findingId: finding.id },
  });
  const retestRun = await createRun(ownerTaskId, '成功复测', {
    status: 'COMPLETED',
    coverageStatus: 'COMPLETE',
    retestOfRunId: originalRun.id,
  });

  await prisma.serviceEvidence.create({
    data: {
      runId: originalRun.id,
      assessmentId: assessment.id,
      evidenceType: 'CONFIG_MATCH',
      sourceTool: 'nuclei',
      ruleId: 'lse-http-security-headers',
      matchedLocation: 'https://api.example.test/v1',
      customerSummary: '响应缺少 nosniff。',
      contentSha256: randomUUID(),
    },
  });
  await prisma.serviceEvidence.create({
    data: {
      runId: retestRun.id,
      evidenceType: EXECUTION_EVIDENCE_TYPE,
      sourceTool: 'service-assurance-nuclei',
      ruleId: 'lse-http-security-headers',
      customerSummary: '该检查已实际完成。',
      contentSha256: randomUUID(),
      extractedValue: encodeExecutionCheck({
        id: 'lse-http-security-headers',
        label: '响应头检查',
        status: 'COMPLETED',
        requestCount: 1,
        detail: '已收到目标响应。',
      }),
    },
  });
  const remaining = await createAssessment(retestRun.id, '另一个尚未修复的问题', {
    impactStatus: 'AFFECTED',
    evidenceLevel: 'CONFIG_MATCH',
  });

  const fixed = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/assessments/${assessment.id}/review`,
    headers: bearer(ownerToken),
    payload: {
      impactStatus: 'FIXED',
      retestRunId: retestRun.id,
      statement: '整改后复测未再次观察到该风险。',
    },
  });
  assert.equal(fixed.statusCode, 200, fixed.body);
  assert.equal(fixed.json().result.impactStatus, 'FIXED');

  const stored = await prisma.vulnerabilityAssessment.findUniqueOrThrow({
    where: { id: assessment.id },
  });
  assert.equal(stored.fixedByRunId, retestRun.id);
  assert.equal(
    (await prisma.vulnerabilityAssessment.findUniqueOrThrow({ where: { id: remaining.id } }))
      .impactStatus,
    'AFFECTED',
  );
  assert.equal(stored.findingId, null);
  assert.equal(stored.legacyFindingId, finding.id);
  assert.ok(await prisma.finding.findUnique({ where: { id: finding.id } }));

  const audit = await prisma.auditLog.findFirstOrThrow({
    where: {
      actorId: ownerId,
      action: 'service_assurance.assessment.review',
      targetId: assessment.id,
    },
  });
  assert.doesNotMatch(JSON.stringify(audit.detail), /retestRunId|credential|rawOutput/i);
});

test('跨任务或覆盖不完整的运行不能把原风险写成已修复', async () => {
  const originalRun = await createRun(ownerTaskId, '拒绝错误复测');
  const assessment = await createAssessment(originalRun.id, '原始正式风险', {
    impactStatus: 'AFFECTED',
    evidenceLevel: 'VERSION_MATCH',
  });
  const partialRetest = await createRun(ownerTaskId, '不完整复测', {
    status: 'RUNNING',
    coverageStatus: 'INCOMPLETE',
    retestOfRunId: originalRun.id,
  });
  const response = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/assessments/${assessment.id}/review`,
    headers: bearer(ownerToken),
    payload: {
      impactStatus: 'FIXED',
      retestRunId: partialRetest.id,
      statement: '尚未完成却尝试关闭风险。',
    },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, 'SERVICE_ASSURANCE_RETEST_NOT_SUCCESSFUL');

  const stored = await prisma.vulnerabilityAssessment.findUniqueOrThrow({
    where: { id: assessment.id },
  });
  assert.equal(stored.impactStatus, 'AFFECTED');
  assert.equal(stored.fixedByRunId, null);
});

test('整体完成但缺少原检查执行证据时不能关闭风险', async () => {
  const original = await createRun(ownerTaskId, '缺少执行证明原运行');
  const risk = await createAssessment(original.id, '缺少执行证明', {
    impactStatus: 'AFFECTED',
    evidenceLevel: 'CONFIG_MATCH',
  });
  const retest = await createRun(ownerTaskId, '只有成功状态', { retestOfRunId: original.id });
  const result = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/assessments/${risk.id}/review`,
    headers: bearer(ownerToken),
    payload: {
      impactStatus: 'FIXED',
      retestRunId: retest.id,
      statement: '任务成功但未取得逐项证据。',
    },
  });
  assert.equal(result.statusCode, 409, result.body);
});
