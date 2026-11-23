import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = '__component_security_';

let app!: FastifyInstance;
let token = '';
let targetId = '';

async function cleanup(): Promise<void> {
  const tasks = await prisma.evalTask.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const taskIds = tasks.map((t) => t.id);
  const runs = await prisma.serviceAssuranceRun.findMany({
    where: { taskId: { in: taskIds } },
    select: { id: true },
  });
  const runIds = runs.map((r) => r.id);
  await prisma.vulnerabilityAssessment.deleteMany({ where: { runId: { in: runIds } } });
  await prisma.serviceComponent.deleteMany({ where: { runId: { in: runIds } } });
  await prisma.serviceAssuranceRun.deleteMany({ where: { id: { in: runIds } } });
  await prisma.evalTask.deleteMany({ where: { id: { in: taskIds } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

async function stats() {
  const res = await app.inject({
    method: 'GET',
    url: '/api/dashboard/component-security',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as {
    componentCount: number;
    vulnerabilityCount: number;
    baselineIssueCount: number;
    runCount: number;
  };
}

async function seedRun(suffix: string) {
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}${suffix}`,
      status: 'COMPLETED',
      engines: [],
      dimensions: [],
      modelTargetId: targetId,
    },
  });
  return prisma.serviceAssuranceRun.create({
    data: {
      taskId: task.id,
      mode: 'SBOM',
      targetKind: 'SBOM',
      targetName: `${PREFIX}${suffix}`,
      scopePolicyRef: 'component-security-test',
      status: 'COMPLETED',
      coverageStatus: 'COMPLETE',
      requestBudget: { maxRequests: 0 },
    },
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
  const target = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}target`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-dummy',
      model: 'fake-model',
    },
  });
  targetId = target.id;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('未登录访问组件安全统计返回 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/dashboard/component-security' });
  assert.equal(res.statusCode, 401);
});

test('组件数按 componentKey 去重，漏洞数与基线问题数按口径区分', async () => {
  const beforeStats = await stats();
  const key = `${PREFIX}${Date.now()}`;
  const runA = await seedRun('a');
  const runB = await seedRun('b');
  const component = (runId: string, componentKey: string) =>
    prisma.serviceComponent.create({
      data: {
        runId,
        name: 'openssl',
        source: 'SBOM',
        evidenceLevel: 'VERSION_MATCH',
        componentKey,
      },
    });
  // 同一组件在两次核验中出现只计一次，另有一个新组件
  await component(runA.id, `${key}-openssl`);
  await component(runB.id, `${key}-openssl`);
  await component(runB.id, `${key}-nginx`);

  const assessment = (
    runId: string,
    assessmentKey: string,
    data: {
      advisoryId: string | null;
      evidenceLevel: 'LEAD' | 'VERSION_MATCH' | 'CONFIG_MATCH' | 'ACTIVE_VERIFIED';
      impactStatus: 'AFFECTED' | 'UNDER_INVESTIGATION' | 'NOT_AFFECTED' | 'FIXED';
    },
  ) =>
    prisma.vulnerabilityAssessment.create({
      data: { runId, assessmentKey, title: 't', reason: 'r', ...data },
    });
  await assessment(runA.id, 'cve-affected', {
    advisoryId: 'CVE-2026-0001',
    evidenceLevel: 'VERSION_MATCH',
    impactStatus: 'AFFECTED',
  });
  await assessment(runA.id, 'cve-fixed', {
    advisoryId: 'CVE-2026-0002',
    evidenceLevel: 'VERSION_MATCH',
    impactStatus: 'FIXED',
  });
  await assessment(runB.id, 'config', {
    advisoryId: null,
    evidenceLevel: 'CONFIG_MATCH',
    impactStatus: 'AFFECTED',
  });
  await assessment(runB.id, 'lead', {
    advisoryId: null,
    evidenceLevel: 'LEAD',
    impactStatus: 'UNDER_INVESTIGATION',
  });

  const afterStats = await stats();
  assert.equal(afterStats.componentCount - beforeStats.componentCount, 2);
  assert.equal(afterStats.vulnerabilityCount - beforeStats.vulnerabilityCount, 1);
  assert.equal(afterStats.baselineIssueCount - beforeStats.baselineIssueCount, 1);
  assert.equal(afterStats.runCount - beforeStats.runCount, 2);
});
