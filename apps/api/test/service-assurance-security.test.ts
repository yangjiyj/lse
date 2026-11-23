import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import {
  SERVICE_ASSURANCE_REQUEST_BUDGET,
  serviceAssuranceCreateBodySchema,
} from '../src/modules/service-assurance/contracts.js';
import {
  ScannerScopeError,
  authorizeRedirect,
  resolveAndAuthorizeTarget,
  type ScannerDnsResolver,
  type ScannerScopePolicy,
} from '../src/lib/scanner-scope.js';

const prefix = `__service_assurance_security_${randomUUID()}_`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
let app: Awaited<ReturnType<typeof buildApp>>;
let ownerId = '';
let ownerToken = '';
let otherId = '';
let targetId = '';
let ownerTaskId = '';
let otherTaskId = '';
let cancelNotifications = 0;

const publicPolicy: ScannerScopePolicy = {
  ref: 'customer-public',
  origins: ['https://api.example.test'],
  cidrs: ['93.184.216.0/24'],
  allowPrivate: false,
  allowPublic: true,
};

function resolver(
  records: Record<string, Array<{ address: string; ttl?: number }>>,
): ScannerDnsResolver {
  return async (hostname) => ({ records: records[hostname] ?? [] });
}

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

async function createUser(label: string) {
  const role = await prisma.role.create({
    data: {
      name: `${prefix}${label}_role`,
      permissions: {
        create: ['service_assurance:read', 'service_assurance:scan'].map((code) => ({
          permission: { connect: { code } },
        })),
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

async function createRunningRun(taskId: string, createdById: string, label: string) {
  return prisma.serviceAssuranceRun.create({
    data: {
      taskId,
      createdById,
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      targetName: label,
      normalizedTarget: 'https://api.example.test/v1',
      scopePolicyRef: 'customer-public',
      requestBudget: SERVICE_ASSURANCE_REQUEST_BUDGET,
      rulesetVersion: 'lse-rules-2026.08.30.3',
      rulesetDigest: `sha256:${'a'.repeat(64)}`,
      status: 'RUNNING',
      coverageStatus: 'INCOMPLETE',
      startedAt: new Date('2026-08-30T08:00:00.000Z'),
    },
  });
}

before(async () => {
  await cleanup();
  for (const code of ['service_assurance:read', 'service_assurance:scan']) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, name: code, group: '服务安全核验' },
      update: {},
    });
  }
  app = await buildApp({
    serviceAssurance: {
      requestCancel: async () => {
        cancelNotifications += 1;
      },
      enqueueRun: async () => undefined,
    },
  });
  await app.ready();
  const owner = await createUser('owner');
  ownerId = owner.id;
  ownerToken = owner.token;
  const other = await createUser('other');
  otherId = other.id;
  const target = await prisma.modelTarget.create({
    data: {
      name: `${prefix}target`,
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'security-test-placeholder', // pragma: allowlist secret
      model: 'not-used',
      createdById: ownerId,
    },
  });
  targetId = target.id;
  ownerTaskId = await createTask('owner-task', ownerId);
  otherTaskId = await createTask('other-task', otherId);
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('创建契约严格拒绝用户控制命令、模板、并发、超时和任意额外字段', () => {
  const valid = {
    taskId: randomUUID(),
    mode: 'SAFE',
    targetKind: 'ENDPOINT',
    targetName: '客户 API',
    targetUrl: 'https://api.example.test/v1',
    scopePolicyRef: 'customer-public',
    authorizationConfirmed: false,
  };
  assert.equal(serviceAssuranceCreateBodySchema.safeParse(valid).success, true);
  for (const extra of [
    { command: 'scanner --target metadata' },
    { templatePath: '/tmp/untrusted.yaml' },
    { concurrency: 999 },
    { timeout: 999999 },
    { allowedHosts: ['169.254.169.254'] },
  ]) {
    assert.equal(serviceAssuranceCreateBodySchema.safeParse({ ...valid, ...extra }).success, false);
  }
});

test('DNS、重定向和实际目标每次都重新落在授权 origin 与 CIDR 内', async () => {
  const first = await resolveAndAuthorizeTarget(
    'https://api.example.test/openapi.json',
    publicPolicy,
    {
      resolve: resolver({ 'api.example.test': [{ address: '93.184.216.34', ttl: 60 }] }),
    },
  );
  await assert.rejects(
    () =>
      authorizeRedirect(first, '/moved', publicPolicy, {
        resolve: resolver({ 'api.example.test': [{ address: '127.0.0.1', ttl: 60 }] }),
      }),
    (error: unknown) =>
      error instanceof ScannerScopeError && error.code === 'SCANNER_SCOPE_ADDRESS_DENIED',
  );
  await assert.rejects(
    () =>
      resolveAndAuthorizeTarget('https://api.example.test/openapi.json', publicPolicy, {
        resolve: resolver({ 'api.example.test': [{ address: '93.184.216.34', ttl: 0 }] }),
      }),
    (error: unknown) =>
      error instanceof ScannerScopeError && error.code === 'SCANNER_SCOPE_DNS_REBINDING',
  );
});

test('运行中取消原子进入 CANCELED、只通知队列一次并记录审计', async () => {
  const run = await createRunningRun(ownerTaskId, ownerId, '运行中取消');
  const first = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/runs/${run.id}/cancel`,
    headers: bearer(ownerToken),
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().run.status, 'CANCELED');
  assert.equal(first.json().run.coverageStatus, 'INCOMPLETE');
  assert.equal(cancelNotifications, 1);

  const repeated = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/runs/${run.id}/cancel`,
    headers: bearer(ownerToken),
  });
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal(repeated.json().run.status, 'CANCELED');
  assert.equal(cancelNotifications, 1);

  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stored.status, 'CANCELED');
  assert.ok(stored.canceledAt);
  assert.ok(stored.endedAt);
  assert.equal(
    await prisma.auditLog.count({
      where: {
        actorId: ownerId,
        action: 'service_assurance.run.cancel',
        targetId: run.id,
      },
    }),
    1,
  );
});

test('取消接口通过 run 反查任务拒绝他人对象', async () => {
  const run = await createRunningRun(otherTaskId, otherId, '他人运行');
  const response = await app.inject({
    method: 'POST',
    url: `/api/service-assurance/runs/${run.id}/cancel`,
    headers: bearer(ownerToken),
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(cancelNotifications, 1);
  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stored.status, 'RUNNING');
});
