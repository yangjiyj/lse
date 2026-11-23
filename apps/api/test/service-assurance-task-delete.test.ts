import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

/**
 * 服务核验的运行、资产、组件、评估、证据同样挂在 Restrict 外键上，而删除
 * 任务的接口对它一个字都没提，撞上去只会抛出外键错误。跑过服务核验的任务
 * 也应当能删干净。
 */
test('删除跑过服务核验的任务会连同核验证据一起清干净', async () => {
  const app = await buildApp();
  const suffix = randomUUID().slice(0, 8);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  const token = login.json().token as string;

  const target = await prisma.modelTarget.create({
    data: {
      name: `assurance-delete-${suffix}`,
      provider: 'openai-compatible',
      targetType: 'MODEL',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-key',
      model: 'test-model',
      isActive: true,
    },
  });

  const task = await prisma.evalTask.create({
    data: {
      name: `服务核验删除-${suffix}`,
      modelTargetId: target.id,
      engines: [],
      dimensions: [],
      status: 'COMPLETED',
    },
  });

  const run = await prisma.serviceAssuranceRun.create({
    data: {
      taskId: task.id,
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      targetName: `svc-${suffix}`,
      scopePolicyRef: 'policy/test',
      requestBudget: { maxRequests: 1 },
    },
  });

  const asset = await prisma.serviceAsset.create({
    data: {
      runId: run.id,
      customerName: `资产-${suffix}`,
      normalizedAddress: 'https://127.0.0.1:9',
      assetKey: `asset-${suffix}`,
    },
  });

  const component = await prisma.serviceComponent.create({
    data: {
      runId: run.id,
      assetId: asset.id,
      name: 'openssl',
      source: 'test',
      evidenceLevel: 'VERSION_MATCH',
      componentKey: `component-${suffix}`,
    },
  });

  const assessment = await prisma.vulnerabilityAssessment.create({
    data: {
      runId: run.id,
      assetId: asset.id,
      componentId: component.id,
      title: '测试漏洞',
      impactStatus: 'UNDER_INVESTIGATION',
      evidenceLevel: 'LEAD',
      reason: '测试构造',
      assessmentKey: `assessment-${suffix}`,
    },
  });

  await prisma.serviceEvidence.create({
    data: {
      runId: run.id,
      assessmentId: assessment.id,
      componentId: component.id,
      evidenceType: 'TEST',
      sourceTool: 'test',
      customerSummary: '测试证据',
      contentSha256: randomUUID().replace(/-/g, ''),
    },
  });

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/eval-tasks/${task.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(removed.statusCode, 200, removed.body);

  assert.equal(await prisma.evalTask.count({ where: { id: task.id } }), 0);
  assert.equal(await prisma.serviceAssuranceRun.count({ where: { id: run.id } }), 0);
  assert.equal(await prisma.serviceEvidence.count({ where: { runId: run.id } }), 0);
  assert.equal(await prisma.vulnerabilityAssessment.count({ where: { runId: run.id } }), 0);
  assert.equal(await prisma.serviceComponent.count({ where: { runId: run.id } }), 0);
  assert.equal(await prisma.serviceAsset.count({ where: { runId: run.id } }), 0);

  // 核验数据清掉后，模型不再被引用，删除模型这条路同样通了。
  const removedTarget = await app.inject({
    method: 'DELETE',
    url: `/api/model-targets/${target.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(removedTarget.statusCode, 200, removedTarget.body);
});
