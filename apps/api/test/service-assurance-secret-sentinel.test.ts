import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { writeAudit } from '../src/lib/audit.js';
import { normalizeZapJson } from '../src/modules/service-assurance/normalize/zap.js';
import { persistServiceAssuranceResult } from '../src/modules/service-assurance/persist.js';
import { gatherServiceAssuranceReportData } from '../src/modules/reports/service-assurance-data.js';
import { buildServiceAssuranceReport } from '../src/modules/reports/specialized/service-assurance.js';

const prefix = `__service_assurance_sentinel_${randomUUID()}_`;
const sentinel = 'CANARY-SERVICE-ASSURANCE-SECRET-NEVER-PERSIST';
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
let app: Awaited<ReturnType<typeof buildApp>>;
let userId = '';
let userToken = '';
let taskId = '';

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

before(async () => {
  await cleanup();
  for (const code of ['service_assurance:read', 'service_assurance:review']) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, name: code, group: '服务安全核验' },
      update: {},
    });
  }
  app = await buildApp();
  await app.ready();
  const role = await prisma.role.create({
    data: {
      name: `${prefix}role`,
      permissions: {
        create: ['service_assurance:read', 'service_assurance:review'].map((code) => ({
          permission: { connect: { code } },
        })),
      },
    },
  });
  const user = await prisma.user.create({
    data: {
      username: `${prefix}reviewer`,
      passwordHash: 'not-used',
      displayName: '哨兵核验员',
      roles: { create: { roleId: role.id } },
    },
  });
  userId = user.id;
  userToken = app.jwt.sign({ sub: user.id, username: user.username });
  const target = await prisma.modelTarget.create({
    data: {
      name: `${prefix}target`,
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sentinel-test-placeholder', // pragma: allowlist secret
      model: 'not-used',
      createdById: user.id,
    },
  });
  const task = await prisma.evalTask.create({
    data: {
      name: `${prefix}task`,
      modelTargetId: target.id,
      engines: [],
      dimensions: [],
      status: 'COMPLETED',
      createdById: user.id,
    },
  });
  taskId = task.id;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('哨兵密钥不会进入 API、专用表、EngineRun、Finding、AuditLog 或报告', async () => {
  const run = await prisma.serviceAssuranceRun.create({
    data: {
      taskId,
      createdById: userId,
      mode: 'DEEP',
      targetKind: 'OPENAPI',
      targetName: '客户 OpenAPI 服务',
      normalizedTarget: 'https://api.example.test/openapi.json',
      scopePolicyRef: 'customer-lab',
      credentialRef: 'credential-profile-readonly',
      authorizationConfirmed: true,
      authorizationConfirmedAt: new Date('2026-08-30T08:00:00.000Z'),
      requestBudget: { maxRequests: 200 },
      rulesetVersion: 'lse-rules-2026.08.30.3',
      rulesetDigest: `sha256:${'a'.repeat(64)}`,
      status: 'RUNNING',
      coverageStatus: 'INCOMPLETE',
      startedAt: new Date('2026-08-30T08:00:00.000Z'),
    },
  });
  const engineRun = await prisma.engineRun.create({
    data: {
      taskId,
      engine: 'service-assurance-zap',
      status: 'RUNNING',
      startedAt: new Date('2026-08-30T08:00:00.000Z'),
      requestPayload: {
        schemaVersion: 1,
        serviceAssuranceRunId: run.id,
        mode: 'DEEP',
        targetKind: 'OPENAPI',
      },
      rawOutput: null,
    },
  });
  const raw = JSON.parse(
    await readFile(
      new URL('./fixtures/service-assurance/zap-deep-positive.json', import.meta.url),
      'utf8',
    ),
  ) as {
    site: Array<{
      alerts: Array<{
        instances: Array<{ uri: string; evidence: string }>;
      }>;
    }>;
  };
  raw.site[0]!.alerts[0]!.instances[0]!.uri = `https://api.example.test/search?api_key=${sentinel}&page=2`;
  raw.site[0]!.alerts[0]!.instances[0]!.evidence = `Authorization: Bearer ${sentinel}`;
  const normalized = normalizeZapJson(JSON.stringify(raw), {
    mode: 'DEEP',
    authorizationConfirmed: true,
    completed: true,
    rulesetStatus: 'CURRENT',
    allowedActiveRuleIds: ['6', '40012', '40018'],
  });
  assert.doesNotMatch(JSON.stringify(normalized), new RegExp(sentinel));

  await persistServiceAssuranceResult({
    runId: run.id,
    taskId,
    engineRunId: engineRun.id,
    normalized,
    execution: {
      engineName: 'service-assurance-zap' as never,
      baselineKind: 'RULESET',
      completed: true,
      durationMs: 40,
      engineVersion: '2.16.1',
      engineDigest: `sha256:${'c'.repeat(64)}`,
      baselineVersion: 'lse-rules-2026.08.30.3',
      baselineDigest: `sha256:${'a'.repeat(64)}`,
      errorCode: null,
    },
  });
  await writeAudit({
    actorId: userId,
    actorName: `${prefix}reviewer`,
    action: 'service_assurance.sentinel.check',
    targetType: 'service_assurance_run',
    targetId: run.id,
    detail: {
      credential: sentinel,
      request: `Authorization: Bearer ${sentinel}`,
    },
  });

  const apiResponse = await app.inject({
    method: 'GET',
    url: `/api/service-assurance/runs/${run.id}`,
    headers: bearer(userToken),
  });
  assert.equal(apiResponse.statusCode, 200, apiResponse.body);

  const [storedRun, storedEngineRun, evidence, assessments, findings, audits] = await Promise.all([
    prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: run.id } }),
    prisma.engineRun.findUniqueOrThrow({ where: { id: engineRun.id } }),
    prisma.serviceEvidence.findMany({ where: { runId: run.id } }),
    prisma.vulnerabilityAssessment.findMany({ where: { runId: run.id } }),
    prisma.finding.findMany({ where: { taskId } }),
    prisma.auditLog.findMany({
      where: { actorName: { startsWith: prefix } },
      select: { action: true, detail: true },
    }),
  ]);
  const gathered = await gatherServiceAssuranceReportData(prisma, taskId, new Date());
  const report = buildServiceAssuranceReport(gathered.data);
  const surfaces = JSON.stringify({
    api: apiResponse.json(),
    run: storedRun,
    engineRun: storedEngineRun,
    evidence,
    assessments,
    findings,
    audits,
    report,
  });
  assert.doesNotMatch(surfaces, new RegExp(sentinel));
  assert.equal(storedEngineRun.rawOutput, null);
  assert.equal((storedRun.engineVersions as Record<string, unknown>).zap !== undefined, true);
  assert.equal((storedRun.engineVersions as Record<string, unknown>).nuclei, undefined);
});
