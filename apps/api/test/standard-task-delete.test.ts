import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

/**
 * 国标符合性任务此前被删除保护挡住，而标准专项模块又没有作废入口，
 * 任务和它引用的模型都会永久卡在列表里删不掉。删除任务应当把标准专项
 * 的运行、样本、作答、判定、报告一并带走，模型随后也能正常删除。
 */
async function login(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

test('删除国标符合性任务会连同标准专项证据一起清干净', async () => {
  const app = await buildApp();
  const suffix = randomUUID().slice(0, 8);
  const token = await login(app);

  const target = await prisma.modelTarget.create({
    data: {
      name: `standard-delete-${suffix}`,
      provider: 'openai-compatible',
      targetType: 'MODEL',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-key',
      model: 'test-model',
      isActive: true,
    },
  });

  const created = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks/standard-compliance',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      modelTargetId: target.id,
      seed: `delete-${suffix}`,
      counts: { MANUAL_SAFETY: 2, TECHNICAL_SAFETY: 2, SHOULD_REFUSE: 1, NON_REFUSAL: 1 },
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { taskId, runId } = created.json() as { taskId: string; runId: string };

  // 造一条作答与判定，确认最深一层的证据也能被带走。
  const sample = await prisma.standardSample.findFirstOrThrow({
    where: { standardRunId: runId },
    select: { id: true },
  });
  await prisma.standardSampleAttempt.create({
    data: { sampleId: sample.id, attemptNo: 1, status: 'SUCCESS', response: '测试作答' },
  });
  await prisma.standardJudgment.create({
    data: { sampleId: sample.id, source: 'RULE', ruleVersion: 'test-v1', safetyOutcome: 'PASS' },
  });

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/eval-tasks/${taskId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(removed.statusCode, 200, removed.body);

  assert.equal(await prisma.evalTask.count({ where: { id: taskId } }), 0);
  assert.equal(await prisma.standardRun.count({ where: { id: runId } }), 0);
  assert.equal(await prisma.standardSample.count({ where: { standardRunId: runId } }), 0);
  assert.equal(await prisma.standardSampleAttempt.count({ where: { sampleId: sample.id } }), 0);
  assert.equal(await prisma.standardJudgment.count({ where: { sampleId: sample.id } }), 0);

  // 任务清掉之后，模型不再被引用，删除模型这条路也就通了。
  const removedTarget = await app.inject({
    method: 'DELETE',
    url: `/api/model-targets/${target.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(removedTarget.statusCode, 200, removedTarget.body);
  assert.equal(await prisma.modelTarget.count({ where: { id: target.id } }), 0);
});
