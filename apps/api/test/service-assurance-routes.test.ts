import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import {
  encodeExecutionCheck,
  EXECUTION_EVIDENCE_TYPE,
} from '../src/modules/service-assurance/execution-evidence.js';
import { SERVICE_ASSURANCE_REQUEST_BUDGET } from '../src/modules/service-assurance/contracts.js';
import { SERVICE_ASSURANCE_SCOPE_SETTING_KEY } from '../src/modules/service-assurance/scope-policies.js';

const prefix = `__service_assurance_routes_${randomUUID()}_`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

let app: Awaited<ReturnType<typeof buildApp>>;
let ownerToken = '';
let otherToken = '';
let scannerToken = '';
let adminToken = '';
let ownerId = '';
let otherId = '';
let scannerId = '';
let targetId = '';
let ownerTaskId = '';
let otherTaskId = '';
let scannerTaskId = '';
const enqueuedRunIds: string[] = [];
const canceledRunIds: string[] = [];
const temporarySboms = new Map<
  string,
  {
    contentType: string;
    content: string;
    parsed: { contentSha256: string; format: string; byteLength: number };
  }
>();
let sbomModeReady = true;

const readyResponse = () => ({
  modes: [
    {
      mode: 'SAFE' as const,
      ready: true,
      message: '安全检查已就绪。',
      baselineUpdatedAt: '2026-08-30T00:00:00.000Z',
    },
    {
      mode: 'DEEP' as const,
      ready: true,
      message: '深度核验已就绪。',
      baselineUpdatedAt: '2026-08-30T00:00:00.000Z',
    },
    {
      mode: 'SBOM' as const,
      ready: sbomModeReady,
      message: sbomModeReady ? '组件清单核验已就绪。' : '组件清单核验尚未就绪。',
      baselineUpdatedAt: sbomModeReady ? '2026-05-22T19:06:39.311Z' : null,
    },
  ],
});

async function cleanup(): Promise<void> {
  await prisma.systemSetting.deleteMany({
    where: { key: SERVICE_ASSURANCE_SCOPE_SETTING_KEY },
  });
  const tasks = await prisma.evalTask.findMany({
    where: { name: { startsWith: '__service_assurance_routes_' } },
    select: { id: true, modelTargetId: true },
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
  await prisma.modelTarget.deleteMany({
    where: { name: { startsWith: '__service_assurance_routes_' } },
  });
  await prisma.user.deleteMany({
    where: { username: { startsWith: '__service_assurance_routes_' } },
  });
  await prisma.role.deleteMany({
    where: { name: { startsWith: '__service_assurance_routes_' } },
  });
}

async function createUser(
  label: string,
  permissions: string[],
): Promise<{ id: string; token: string }> {
  const role = await prisma.role.create({
    data: {
      name: `${prefix}${label}_role`,
      description: 'service assurance route test role',
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
  status: 'PENDING' | 'COMPLETED' = 'PENDING',
) {
  return prisma.serviceAssuranceRun.create({
    data: {
      taskId,
      createdById: taskId === scannerTaskId ? scannerId : ownerId,
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      targetName: label,
      normalizedTarget: 'https://api.example.test/v1',
      scopePolicyRef: 'customer-lab',
      requestBudget: SERVICE_ASSURANCE_REQUEST_BUDGET,
      status,
      coverageStatus: status === 'COMPLETED' ? 'COMPLETE' : 'NOT_READY',
      startedAt: status === 'COMPLETED' ? new Date() : null,
      endedAt: status === 'COMPLETED' ? new Date() : null,
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
    'platform_setting:update',
  ]) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, name: code, group: '服务安全核验' },
      update: {},
    });
  }

  app = await buildApp({
    serviceAssurance: {
      getReadiness: async () => readyResponse(),
      resolveScopePolicy: (ref: string) => ({
        ref,
        origins: ['https://api.example.test'],
        cidrs: ['93.184.216.0/24'],
        allowPrivate: false,
        allowPublic: true,
      }),
      resolveTarget: async (rawUrl: string) => ({
        url: new URL(rawUrl),
        hostname: 'api.example.test',
        addresses: ['93.184.216.34'],
        pinnedAddress: '93.184.216.34',
      }),
      baselineForMode: (mode: string) =>
        mode === 'SBOM'
          ? {
              kind: 'VULNERABILITY_DB' as const,
              version: 'trivy-db-2026.05.22',
              digest: `sha256:${'c'.repeat(64)}`,
            }
          : {
              kind: 'RULESET' as const,
              version: 'lse-nuclei-safe-2026.08.30',
              digest: `sha256:${'a'.repeat(64)}`,
            },
      putSbom: async (runId, upload) => {
        temporarySboms.set(runId, upload);
      },
      deleteSbom: async (runId) => {
        temporarySboms.delete(runId);
      },
      enqueueRun: async (runId: string) => {
        enqueuedRunIds.push(runId);
      },
      requestCancel: async (runId: string) => {
        canceledRunIds.push(runId);
      },
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
  otherToken = other.token;
  const scanner = await createUser('scanner', [
    'service_assurance:read',
    'service_assurance:scan',
    'service_assurance:verify',
  ]);
  scannerId = scanner.id;
  scannerToken = scanner.token;
  const admin = await createUser('scope-admin', [
    'service_assurance:read',
    'platform_setting:update',
  ]);
  adminToken = admin.token;

  const target = await prisma.modelTarget.create({
    data: {
      name: `${prefix}target`,
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'route-test-placeholder', // pragma: allowlist secret
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

test('就绪接口要求读取权限且只返回客户字段', async () => {
  const anonymous = await app.inject({ method: 'GET', url: '/api/service-assurance/readiness' });
  assert.equal(anonymous.statusCode, 401);

  const response = await app.inject({
    method: 'GET',
    url: '/api/service-assurance/readiness',
    headers: bearer(ownerToken),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), readyResponse());
  assert.doesNotMatch(
    response.body,
    /nuclei|trivy|zap|container|image|digest|internal|session|path|url/i,
  );
});

test('管理员可在平台保存授权范围，普通核验用户只能读取', async () => {
  const payload = {
    policies: [
      {
        ref: 'customer-public',
        name: '客户公网 API',
        origins: ['https://api.example.test'],
        cidrs: ['93.184.216.34/32'],
        allowPrivate: false,
        allowPublic: true,
        isDefault: true,
      },
    ],
  };
  const denied = await app.inject({
    method: 'PUT',
    url: '/api/service-assurance/scope-policies',
    headers: bearer(ownerToken),
    payload,
  });
  assert.equal(denied.statusCode, 403, denied.body);

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/service-assurance/scope-policies',
    headers: bearer(adminToken),
    payload,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().managedByPlatform, true);
  assert.equal(saved.json().defaultPolicyRef, 'customer-public');

  const listed = await app.inject({
    method: 'GET',
    url: '/api/service-assurance/scope-policies',
    headers: bearer(ownerToken),
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json().policies, payload.policies);

  const audit = await prisma.auditLog.findFirstOrThrow({
    where: {
      action: 'service_assurance.scope_policies.update',
      targetId: SERVICE_ASSURANCE_SCOPE_SETTING_KEY,
    },
  });
  assert.deepEqual(audit.detail, {
    policyCount: 1,
    defaultPolicyRef: 'customer-public',
    policyRefs: ['customer-public'],
  });
});

test('创建安全检查只保存服务端预算和基线并进入独立队列', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/service-assurance/runs',
    headers: bearer(ownerToken),
    payload: {
      taskId: ownerTaskId,
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      targetName: '客户推理服务',
      targetUrl: 'https://api.example.test/v1',
      scopePolicyRef: 'customer-lab',
      authorizationConfirmed: false,
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json() as { run: { runId: string; targetName: string; status: string } };
  assert.equal(body.run.targetName, '客户推理服务');
  assert.equal(body.run.status, 'PENDING');
  assert.ok(enqueuedRunIds.includes(body.run.runId));
  assert.doesNotMatch(
    response.body,
    /nuclei|trivy|zap|container|session|rawOutput|sourceTool|ruleId|digest|internal/i,
  );

  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({
    where: { id: body.run.runId },
  });
  assert.equal(stored.createdById, ownerId);
  assert.deepEqual(stored.scopePolicySnapshot, {
    ref: 'customer-lab',
    origins: ['https://api.example.test'],
    cidrs: ['93.184.216.0/24'],
    allowPrivate: false,
    allowPublic: true,
  });
  assert.match(stored.scopePolicyDigest ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(stored.requestBudget, SERVICE_ASSURANCE_REQUEST_BUDGET);
  assert.equal(stored.rulesetVersion, 'lse-nuclei-safe-2026.08.30');
  assert.match(stored.rulesetDigest ?? '', /^sha256:[a-f0-9]{64}$/);
  const audit = await prisma.auditLog.findFirstOrThrow({
    where: {
      actorId: ownerId,
      action: 'service_assurance.run.create',
      targetId: stored.id,
    },
  });
  assert.doesNotMatch(
    JSON.stringify(audit.detail),
    /api\.example\.test|credential|apiKey|command|template|nuclei/i,
  );
});

test('创建组件清单核验只持久化摘要并把原文放入一次性通道', async () => {
  const original = await readFile(
    new URL('./fixtures/service-assurance/cyclonedx-triton-affected.json', import.meta.url),
    'utf8',
  );
  const document = JSON.parse(original) as Record<string, unknown>;
  document.properties = [
    {
      name: 'integration-sentinel',
      value: 'SENTINEL_SBOM_SECRET_NEVER_STORE',
    },
  ];
  const content = JSON.stringify(document);

  const response = await app.inject({
    method: 'POST',
    url: '/api/service-assurance/runs',
    headers: bearer(ownerToken),
    payload: {
      taskId: ownerTaskId,
      mode: 'SBOM',
      targetKind: 'SBOM',
      targetName: '客户组件清单',
      scopePolicyRef: 'customer-lab',
      authorizationConfirmed: false,
      sbom: {
        contentType: 'application/vnd.cyclonedx+json',
        content,
      },
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json() as { run: { runId: string; status: string } };
  assert.equal(body.run.status, 'PENDING');
  assert.ok(enqueuedRunIds.includes(body.run.runId));
  assert.doesNotMatch(response.body, /SENTINEL_SBOM_SECRET_NEVER_STORE|contentSha256|digest/i);

  const temporary = temporarySboms.get(body.run.runId);
  assert.ok(temporary);
  assert.equal(temporary.content, content);
  assert.match(temporary.parsed.contentSha256, /^[a-f0-9]{64}$/);

  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({
    where: { id: body.run.runId },
  });
  assert.equal(stored.normalizedTarget, null);
  assert.equal(stored.vulnerabilityDbVersion, 'trivy-db-2026.05.22');
  assert.match(stored.vulnerabilityDbDigest ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.equal(stored.rulesetVersion, null);
  assert.equal(stored.rulesetDigest, null);
  assert.doesNotMatch(JSON.stringify(stored), /SENTINEL_SBOM_SECRET_NEVER_STORE|CycloneDX/);

  const audit = await prisma.auditLog.findFirstOrThrow({
    where: {
      actorId: ownerId,
      action: 'service_assurance.run.create',
      targetId: stored.id,
    },
  });
  assert.doesNotMatch(JSON.stringify(audit), /SENTINEL_SBOM_SECRET_NEVER_STORE|CycloneDX/);
  temporarySboms.delete(body.run.runId);
});

test('禁止控制参数、未确认深度核验和未就绪模式均不创建运行', async () => {
  const beforeCount = await prisma.serviceAssuranceRun.count({ where: { taskId: ownerTaskId } });
  const base = {
    taskId: ownerTaskId,
    mode: 'SAFE',
    targetKind: 'ENDPOINT',
    targetName: '严格请求',
    targetUrl: 'https://api.example.test/v1',
    scopePolicyRef: 'customer-lab',
    authorizationConfirmed: false,
  };
  const forbidden = await app.inject({
    method: 'POST',
    url: '/api/service-assurance/runs',
    headers: bearer(ownerToken),
    payload: { ...base, command: 'nuclei -u target' },
  });
  assert.equal(forbidden.statusCode, 400, forbidden.body);

  const deep = await app.inject({
    method: 'POST',
    url: '/api/service-assurance/runs',
    headers: bearer(ownerToken),
    payload: { ...base, mode: 'DEEP', authorizationConfirmed: false },
  });
  assert.equal(deep.statusCode, 400, deep.body);

  sbomModeReady = false;
  const sbom = await app.inject({
    method: 'POST',
    url: '/api/service-assurance/runs',
    headers: bearer(ownerToken),
    payload: {
      taskId: ownerTaskId,
      mode: 'SBOM',
      targetKind: 'SBOM',
      targetName: '未就绪清单',
      scopePolicyRef: 'customer-lab',
      authorizationConfirmed: false,
      sbom: {
        contentType: 'application/vnd.cyclonedx+json',
        content: JSON.stringify({
          bomFormat: 'CycloneDX',
          specVersion: '1.5',
          components: [],
        }),
      },
    },
  });
  sbomModeReady = true;
  assert.equal(sbom.statusCode, 409, sbom.body);
  assert.equal(
    await prisma.serviceAssuranceRun.count({ where: { taskId: ownerTaskId } }),
    beforeCount,
  );
});

test('创建、列表和详情同时执行操作权限与任务对象权限', async () => {
  const deniedCreate = await app.inject({
    method: 'POST',
    url: '/api/service-assurance/runs',
    headers: bearer(otherToken),
    payload: {
      taskId: ownerTaskId,
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      targetName: '越权目标',
      targetUrl: 'https://api.example.test/v1',
      scopePolicyRef: 'customer-lab',
      authorizationConfirmed: false,
    },
  });
  assert.equal(deniedCreate.statusCode, 403, deniedCreate.body);

  const deniedList = await app.inject({
    method: 'GET',
    url: `/api/service-assurance/runs?taskId=${ownerTaskId}`,
    headers: bearer(otherToken),
  });
  assert.equal(deniedList.statusCode, 404, deniedList.body);

  const ownList = await app.inject({
    method: 'GET',
    url: `/api/service-assurance/runs?taskId=${otherTaskId}`,
    headers: bearer(otherToken),
  });
  assert.equal(ownList.statusCode, 200, ownList.body);
});

test('默认详情隔离技术证据，review 端点单独鉴权', async () => {
  const run = await createRun(ownerTaskId, '客户结果', 'COMPLETED');
  const asset = await prisma.serviceAsset.create({
    data: {
      runId: run.id,
      customerName: '推理服务',
      normalizedAddress: 'https://api.example.test',
      protocol: 'https',
      host: 'api.example.test',
      port: 443,
      assetKey: `${prefix}asset`,
    },
  });
  const assessment = await prisma.vulnerabilityAssessment.create({
    data: {
      runId: run.id,
      assetId: asset.id,
      title: '未授权管理状态接口',
      severity: 'HIGH',
      impactStatus: 'AFFECTED',
      evidenceLevel: 'CONFIG_MATCH',
      confidence: 0.9,
      priority: 'P1',
      reason: '目标未授权返回管理状态。',
      remediation: '为管理接口启用身份校验。',
      assessmentKey: `${prefix}assessment`,
    },
  });
  await prisma.serviceEvidence.create({
    data: {
      runId: run.id,
      assessmentId: assessment.id,
      evidenceType: 'RULE_MATCH',
      sourceTool: 'nuclei',
      ruleId: 'lse-admin-status',
      ruleSummary: 'controlled rule',
      matchedLocation: '/admin/status',
      customerSummary: '目标未授权返回管理状态。',
      requestSummary: 'GET /admin/status',
      responseSummary: 'HTTP/1.1 200 OK',
      contentSha256: 'c'.repeat(64),
      visibility: 'TECHNICAL',
    },
  });
  await prisma.serviceEvidence.create({
    data: {
      runId: run.id,
      assessmentId: assessment.id,
      evidenceType: 'INTERNAL_TRACE',
      sourceTool: 'internal',
      customerSummary: 'AUDIT_ONLY_NEVER_RETURN',
      contentSha256: 'd'.repeat(64),
      visibility: 'AUDIT_ONLY',
    },
  });

  const detail = await app.inject({
    method: 'GET',
    url: `/api/service-assurance/runs/${run.id}`,
    headers: bearer(ownerToken),
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.match(detail.body, /未授权管理状态接口/);
  assert.doesNotMatch(
    detail.body,
    /nuclei|RULE_MATCH|sourceTool|ruleId|requestSummary|responseSummary|rawOutput|container/i,
  );

  const technical = await app.inject({
    method: 'GET',
    url: `/api/service-assurance/runs/${run.id}/evidence`,
    headers: bearer(ownerToken),
  });
  assert.equal(technical.statusCode, 200, technical.body);
  assert.equal(technical.json().items[0].contentSha256, 'c'.repeat(64));
  assert.equal(technical.json().items[0].requestSummary, 'GET /admin/status');
  assert.doesNotMatch(technical.body, /nuclei|sourceTool|container|rawOutput/i);
  assert.doesNotMatch(technical.body, /AUDIT_ONLY_NEVER_RETURN|INTERNAL_TRACE/);

  const scannerRun = await createRun(scannerTaskId, '无复核权限结果', 'COMPLETED');
  const denied = await app.inject({
    method: 'GET',
    url: `/api/service-assurance/runs/${scannerRun.id}/evidence`,
    headers: bearer(scannerToken),
  });
  assert.equal(denied.statusCode, 403, denied.body);
});

test('取消接口幂等校验任务对象并写入取消状态', async () => {
  const run = await createRun(ownerTaskId, '待取消');
  const response = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/runs/${run.id}/cancel`,
    headers: bearer(ownerToken),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(canceledRunIds.includes(run.id));
  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stored.status, 'CANCELED');
  assert.ok(stored.canceledAt);

  const repeated = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/runs/${run.id}/cancel`,
    headers: bearer(ownerToken),
  });
  assert.equal(repeated.statusCode, 200, repeated.body);

  const otherRun = await createRun(otherTaskId, '他人待取消');
  const denied = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/runs/${otherRun.id}/cancel`,
    headers: bearer(ownerToken),
  });
  assert.equal(denied.statusCode, 403, denied.body);
});

test('拒绝未实现的 MCP 专项和凭据引用，不创建误导性运行', async () => {
  const beforeCount = await prisma.serviceAssuranceRun.count({ where: { taskId: ownerTaskId } });
  for (const extra of [{ targetKind: 'MCP' }, { credentialRef: 'unused-profile' }]) {
    const result = await app.inject({
      method: 'POST',
      url: '/api/service-assurance/runs',
      headers: bearer(ownerToken),
      payload: {
        taskId: ownerTaskId,
        mode: 'SAFE',
        targetKind: 'ENDPOINT',
        targetName: '能力边界检查',
        targetUrl: 'https://api.example.test/v1',
        scopePolicyRef: 'customer-lab',
        ...extra,
      },
    });
    assert.equal(result.statusCode, 400, result.body);
  }
  assert.equal(
    await prisma.serviceAssuranceRun.count({ where: { taskId: ownerTaskId } }),
    beforeCount,
  );
});

test('零命中详情仍展示实际执行证据，历史缺失不回填为成功', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/service-assurance/runs',
    headers: bearer(ownerToken),
    payload: {
      taskId: ownerTaskId,
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      targetName: '零命中执行证明',
      targetUrl: 'https://api.example.test/v1',
      scopePolicyRef: 'customer-lab',
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const runId = created.json().run.runId as string;
  const fetchDetail = () =>
    app.inject({
      method: 'GET',
      url: `/api/service-assurance/runs/${runId}`,
      headers: bearer(ownerToken),
    });
  const before = (await fetchDetail()).json();
  assert.equal(before.execution.telemetryAvailable, false);
  assert.equal(before.execution.requestCount, null);
  for (const id of ['lse-http-security-headers', 'lse-triton-product-fingerprint']) {
    await prisma.serviceEvidence.create({
      data: {
        runId,
        evidenceType: EXECUTION_EVIDENCE_TYPE,
        sourceTool: 'service-assurance-nuclei',
        ruleId: id,
        customerSummary: '已执行。',
        contentSha256: randomUUID(),
        extractedValue: encodeExecutionCheck({
          id,
          label: id,
          status: 'COMPLETED',
          requestCount: 1,
          detail: '已收到响应。',
        }),
      },
    });
  }
  const after = (await fetchDetail()).json();
  assert.equal(after.results.length, 0);
  assert.equal(after.execution.telemetryAvailable, true);
  assert.equal(after.execution.requestCount, 2);
  assert.equal(after.run.targetAddress, 'https://api.example.test/v1');
});
