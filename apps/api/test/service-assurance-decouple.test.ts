// AI 服务安全核验与评估任务解耦：taskId 可选、未关联记录可见性、关联/取消关联、存量兼容。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { SERVICE_ASSURANCE_REQUEST_BUDGET } from '../src/modules/service-assurance/contracts.js';
import { gatherServiceAssuranceReportData } from '../src/modules/reports/service-assurance-data.js';
import { normalizeNucleiJsonl } from '../src/modules/service-assurance/normalize/nuclei.js';
import { persistServiceAssuranceResult } from '../src/modules/service-assurance/persist.js';

const prefix = `__service_assurance_decouple_${randomUUID()}_`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const PERMS = ['service_assurance:read', 'service_assurance:scan', 'service_assurance:verify'];

let app: Awaited<ReturnType<typeof buildApp>>;
const users: Record<'a' | 'b' | 'admin', { id: string; token: string }> = {} as never;
let targetId = '';
let taskA = '';
let taskB = '';

async function cleanup(): Promise<void> {
  const people = await prisma.user.findMany({
    where: { username: { startsWith: prefix } },
    select: { id: true },
  });
  const tasks = await prisma.evalTask.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const runScope = {
    OR: [
      { createdById: { in: people.map((p) => p.id) } },
      { taskId: { in: tasks.map((t) => t.id) } },
    ],
  };
  await prisma.serviceEvidence.deleteMany({ where: { run: runScope } });
  await prisma.vulnerabilityAssessment.deleteMany({ where: { run: runScope } });
  await prisma.serviceComponent.deleteMany({ where: { run: runScope } });
  await prisma.serviceAsset.deleteMany({ where: { run: runScope } });
  await prisma.serviceAssuranceRun.deleteMany({ where: runScope });
  const taskIds = tasks.map((t) => t.id);
  await prisma.finding.deleteMany({ where: { taskId: { in: taskIds } } });
  await prisma.engineRun.deleteMany({ where: { taskId: { in: taskIds } } });
  await prisma.evalTask.deleteMany({ where: { id: { in: taskIds } } });
  await prisma.auditLog.deleteMany({ where: { actorName: { startsWith: prefix } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: prefix } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: prefix } } });
}

async function createUser(label: string, isBuiltin = false) {
  const role = await prisma.role.create({
    data: {
      name: `${prefix}${label}_role`,
      permissions: { create: PERMS.map((code) => ({ permission: { connect: { code } } })) },
    },
  });
  const user = await prisma.user.create({
    data: {
      username: `${prefix}${label}`,
      passwordHash: 'not-used',
      displayName: label,
      isBuiltin,
      roles: { create: { roleId: role.id } },
    },
  });
  return { id: user.id, token: app.jwt.sign({ sub: user.id, username: user.username }) };
}

async function createTask(label: string, createdById: string) {
  const task = await prisma.evalTask.create({
    data: {
      name: `${prefix}${label}`,
      modelTargetId: targetId,
      engines: [],
      dimensions: [],
      createdById,
      status: 'COMPLETED',
    },
  });
  return task.id;
}

/** 已完成、未关联任务、含一条已确认配置风险与一条待核验线索的核验记录。 */
async function createStandaloneRun(createdById: string, label: string) {
  const run = await prisma.serviceAssuranceRun.create({
    data: {
      taskId: null,
      createdById,
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      targetName: label,
      normalizedTarget: 'https://api.example.test/v1',
      scopePolicyRef: 'customer-lab',
      requestBudget: SERVICE_ASSURANCE_REQUEST_BUDGET,
      status: 'COMPLETED',
      coverageStatus: 'COMPLETE',
      startedAt: new Date(),
      endedAt: new Date(),
    },
  });
  const base = {
    runId: run.id,
    title: `${label}-risk`,
    severity: 'HIGH' as const,
    confidence: 0.9,
    reason: 'config evidence',
  };
  await prisma.vulnerabilityAssessment.create({
    data: {
      ...base,
      impactStatus: 'AFFECTED',
      evidenceLevel: 'CONFIG_MATCH',
      assessmentKey: `${label}:affected`,
    },
  });
  await prisma.vulnerabilityAssessment.create({
    data: {
      ...base,
      title: `${label}-lead`,
      impactStatus: 'UNDER_INVESTIGATION',
      evidenceLevel: 'LEAD',
      assessmentKey: `${label}:lead`,
    },
  });
  return run;
}

before(async () => {
  for (const code of PERMS) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, name: code, group: '服务安全核验' },
      update: {},
    });
  }
  app = await buildApp({
    serviceAssurance: {
      getReadiness: async () => ({
        modes: (['SAFE', 'DEEP', 'SBOM'] as const).map((mode) => ({
          mode,
          ready: true,
          message: 'ready',
          baselineUpdatedAt: null,
        })),
      }),
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
      baselineForMode: () => ({
        kind: 'RULESET' as const,
        version: 'lse-nuclei-safe-2026.08.30',
        digest: `sha256:${'a'.repeat(64)}`,
      }),
      enqueueRun: async () => undefined,
      requestCancel: async () => undefined,
    },
  });
  await app.ready();
  await cleanup();
  users.a = await createUser('a');
  users.b = await createUser('b');
  users.admin = await createUser('admin', true);
  const target = await prisma.modelTarget.create({
    data: {
      name: `${prefix}target`,
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'decouple-test-placeholder', // pragma: allowlist secret
      model: 'not-used',
      createdById: users.a.id,
    },
  });
  targetId = target.id;
  taskA = await createTask('task-a', users.a.id);
  taskB = await createTask('task-b', users.b.id);
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

const listIds = async (token: string, query = '') => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/service-assurance/runs${query}`,
    headers: bearer(token),
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json().items as Array<{ runId: string }>).map((item) => item.runId);
};

test('不传 taskId 也能发起核验，记录归属发起人且写入审计', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/service-assurance/runs',
    headers: bearer(users.a.token),
    payload: {
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      targetName: 'standalone',
      targetUrl: 'https://api.example.test/v1',
      scopePolicyRef: 'customer-lab',
      authorizationConfirmed: false,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json().run;
  assert.equal(body.taskId, null);
  assert.equal(body.taskName, null);
  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: body.runId } });
  assert.equal(stored.taskId, null);
  assert.equal(stored.createdById, users.a.id);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'service_assurance.run.create', targetId: body.runId },
  });
  assert.ok(audit);
});

test('未关联记录仅发起人与管理员可见，他人列表与详情均不可见', async () => {
  const run = await createStandaloneRun(users.a.id, 'visibility');
  assert.ok((await listIds(users.a.token)).includes(run.id));
  assert.ok(!(await listIds(users.b.token)).includes(run.id));
  assert.ok((await listIds(users.admin.token)).includes(run.id));
  const detail = await app.inject({
    method: 'GET',
    url: `/api/service-assurance/runs/${run.id}`,
    headers: bearer(users.b.token),
  });
  assert.equal(detail.statusCode, 404, detail.body);
  const cancel = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/runs/${run.id}/cancel`,
    headers: bearer(users.b.token),
  });
  assert.equal(cancel.statusCode, 403, cancel.body);
});

test('列表支持分页与按目标、状态筛选', async () => {
  await createStandaloneRun(users.a.id, 'filter-keyword-xyz');
  const res = await app.inject({
    method: 'GET',
    url: '/api/service-assurance/runs?keyword=keyword-xyz&status=COMPLETED&page=1&pageSize=5',
    headers: bearer(users.a.token),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.total, 1);
  assert.equal(body.pageSize, 5);
  assert.equal(body.items[0].targetName, 'filter-keyword-xyz');
  const none = await listIds(users.a.token, '?keyword=keyword-xyz&status=RUNNING');
  assert.equal(none.length, 0);
});

test('关联到无写权限的评估任务返回 403 且不改动记录', async () => {
  const run = await createStandaloneRun(users.a.id, 'link-denied');
  const res = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/runs/${run.id}/link-task`,
    headers: bearer(users.a.token),
    payload: { taskId: taskB },
  });
  assert.equal(res.statusCode, 403, res.body);
  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stored.taskId, null);
  assert.equal(await prisma.finding.count({ where: { taskId: taskB } }), 0);
});

test('关联后按任务可列出、报告数据包含；取消关联后回到未关联并移除正式风险', async () => {
  const run = await createStandaloneRun(users.a.id, 'link-ok');
  const linked = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/runs/${run.id}/link-task`,
    headers: bearer(users.a.token),
    payload: { taskId: taskA },
  });
  assert.equal(linked.statusCode, 200, linked.body);
  assert.equal(linked.json().run.taskId, taskA);
  assert.equal(linked.json().run.taskName, `${prefix}task-a`);
  // 仅已确认受影响且证据达到版本级以上的结论生成正式风险；待核验线索不进入 findings。
  assert.equal(linked.json().findingCount, 1);
  assert.ok((await listIds(users.a.token, `?taskId=${taskA}`)).includes(run.id));
  const findings = await prisma.finding.findMany({ where: { taskId: taskA } });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.engine, 'service-assurance');

  const report = await prisma.$transaction((tx) =>
    gatherServiceAssuranceReportData(tx, taskA, new Date()),
  );
  assert.ok(report.data.serviceAssurance!.runs.some((item) => item.targetName === 'link-ok'));

  const again = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/runs/${run.id}/link-task`,
    headers: bearer(users.a.token),
    payload: { taskId: taskA },
  });
  assert.equal(again.statusCode, 409, again.body);

  const unlinked = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/runs/${run.id}/unlink-task`,
    headers: bearer(users.a.token),
  });
  assert.equal(unlinked.statusCode, 200, unlinked.body);
  assert.equal(unlinked.json().run.taskId, null);
  assert.equal(await prisma.finding.count({ where: { taskId: taskA } }), 0);
  const assessments = await prisma.vulnerabilityAssessment.findMany({ where: { runId: run.id } });
  assert.ok(assessments.every((item) => item.findingId === null));
  assert.ok(!(await listIds(users.a.token, `?taskId=${taskA}`)).includes(run.id));
  const afterUnlink = await prisma.$transaction((tx) =>
    gatherServiceAssuranceReportData(tx, taskA, new Date()),
  );
  assert.ok(!afterUnlink.data.serviceAssurance!.runs.some((item) => item.targetName === 'link-ok'));
  for (const action of ['service_assurance.run.link_task', 'service_assurance.run.unlink_task']) {
    assert.equal(await prisma.auditLog.count({ where: { action, targetId: run.id } }), 1);
  }
});

test('他人不能对不属于自己的未关联记录发起关联', async () => {
  const run = await createStandaloneRun(users.a.id, 'link-foreign');
  const res = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/runs/${run.id}/link-task`,
    headers: bearer(users.b.token),
    payload: { taskId: taskB },
  });
  assert.equal(res.statusCode, 403, res.body);
});

test('存量带 taskId 的记录仍按任务权限可见，他人不可见', async () => {
  const legacy = await prisma.serviceAssuranceRun.create({
    data: {
      taskId: taskB,
      createdById: users.b.id,
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      targetName: 'legacy',
      scopePolicyRef: 'customer-lab',
      requestBudget: SERVICE_ASSURANCE_REQUEST_BUDGET,
      status: 'COMPLETED',
      coverageStatus: 'COMPLETE',
    },
  });
  assert.ok((await listIds(users.b.token)).includes(legacy.id));
  assert.ok((await listIds(users.b.token, `?taskId=${taskB}`)).includes(legacy.id));
  assert.ok(!(await listIds(users.a.token)).includes(legacy.id));
  const denied = await app.inject({
    method: 'GET',
    url: `/api/service-assurance/runs?taskId=${taskB}`,
    headers: bearer(users.a.token),
  });
  assert.equal(denied.statusCode, 404, denied.body);
});

test('未关联任务的执行结果只写核验自身表，不写 Finding / EngineRun', async () => {
  const run = await prisma.serviceAssuranceRun.create({
    data: {
      taskId: null,
      createdById: users.a.id,
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      targetName: 'persist-standalone',
      normalizedTarget: 'https://api.example.test/v1',
      scopePolicyRef: 'customer-lab',
      requestBudget: SERVICE_ASSURANCE_REQUEST_BUDGET,
      status: 'RUNNING',
      coverageStatus: 'NOT_READY',
    },
  });
  const normalized = normalizeNucleiJsonl(
    await readFile(
      new URL('./fixtures/service-assurance/nuclei-safe-positive.jsonl', import.meta.url),
      'utf8',
    ),
    { mode: 'SAFE', authorizationConfirmed: false, completed: true, rulesetStatus: 'CURRENT' },
  );
  const findingsBefore = await prisma.finding.count();
  await persistServiceAssuranceResult({
    runId: run.id,
    taskId: null,
    engineRunId: null,
    normalized,
    execution: {
      engineName: 'service-assurance-nuclei',
      baselineKind: 'RULESET',
      completed: true,
      durationMs: 10,
      engineVersion: null,
      engineDigest: null,
      baselineVersion: 'lse-nuclei-safe-2026.08.30',
      baselineDigest: `sha256:${'a'.repeat(64)}`,
      errorCode: null,
    },
  });
  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({
    where: { id: run.id },
    include: { assessments: true },
  });
  assert.equal(stored.status, 'COMPLETED');
  assert.ok(stored.assessments.length > 0);
  assert.ok(stored.assessments.every((item) => item.findingId === null));
  assert.equal(await prisma.finding.count(), findingsBefore);
});
