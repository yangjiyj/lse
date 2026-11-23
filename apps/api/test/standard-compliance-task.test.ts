import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { STANDARD_CORE_CATEGORIES, STANDARD_RISK_CATEGORIES } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { STANDARD_OUTPUT_ENGINE } from '../src/modules/standard-evaluations/core.js';

/**
 * 国标符合性作为评估任务的一种类型：客户只选模型 API，攻击样本由平台
 * 生成器现产并冻结，不需要任何人先维护样本库。
 */
test('国标符合性任务：只给模型 API 就能建任务并冻结抽样', async () => {
  const app = await buildApp();
  const suffix = randomUUID().slice(0, 8);

  const target = await prisma.modelTarget.create({
    data: {
      name: `standard-compliance-${suffix}`,
      provider: 'openai-compatible',
      targetType: 'MODEL',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-key',
      model: 'test-model',
      isActive: true,
    },
  });

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  const token = login.json().token as string;

  const created = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks/standard-compliance',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      modelTargetId: target.id,
      seed: `compliance-${suffix}`,
      counts: {
        MANUAL_SAFETY: 6,
        TECHNICAL_SAFETY: 6,
        SHOULD_REFUSE: 4,
        NON_REFUSAL: 3,
      },
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json();

  // 抽样名单已冻结，创建阶段不调用被测模型。
  assert.equal(body.sampleCount, 19);
  assert.deepEqual(body.selectedCounts, {
    MANUAL_SAFETY: 6,
    TECHNICAL_SAFETY: 6,
    SHOULD_REFUSE: 4,
    NON_REFUSAL: 3,
  });
  assert.ok(body.samplePlanHash.length > 0);

  // 覆盖度如实记录。生成类池 6 条、应拒答池 4 条各自分层，每池内部一条一个
  // 类别不撞车，所以并集在 6~10 之间；随机抽样则可能只落到两三类。
  assert.ok(Array.isArray(body.coverage.coveredCategories));
  assert.ok(
    body.coverage.coveredCategories.length >= 6 && body.coverage.coveredCategories.length <= 10,
    `分层抽样覆盖数应在 6~10，实际 ${body.coverage.coveredCategories.length}`,
  );
  assert.ok(body.coverage.missingCoreCategories.length > 0);
  assert.equal(
    body.coverage.coveredCategories.length + body.coverage.missingCategories.length,
    STANDARD_RISK_CATEGORIES.length,
  );
  for (const category of body.coverage.coveredCategories) {
    assert.ok(STANDARD_RISK_CATEGORIES.includes(category), `${category} 不是国标风险类别`);
  }
  for (const missing of body.coverage.missingCoreCategories) {
    assert.ok(STANDARD_CORE_CATEGORIES.includes(missing));
  }

  // 任务本身是一条普通评估任务，能在任务列表里看到。
  const task = await prisma.evalTask.findUniqueOrThrow({
    where: { id: body.taskId },
    include: { standardRun: true },
  });
  assert.equal(task.totalQuestions, 19);
  assert.deepEqual(task.engines, [STANDARD_OUTPUT_ENGINE]);
  assert.deepEqual(task.dimensions, ['standard_output_safety']);
  assert.ok(task.standardRun, '任务应挂上国标运行');
  assert.equal(task.standardRun.id, body.runId);

  // 样本内容真的落库了，且分组与抽样计划一致。
  const samples = await prisma.standardSample.findMany({
    where: { standardRunId: body.runId },
    select: { group: true, inputSnapshot: true, primaryCategory: true, nonRefusalTopic: true },
  });
  assert.equal(samples.length, 19);
  assert.ok(samples.every((sample) => sample.inputSnapshot.trim().length > 0));
  assert.equal(samples.filter((s) => s.group === 'NON_REFUSAL').length, 3);
  // 非拒答对照组走主题维度，其余组走风险类别维度。
  assert.ok(
    samples
      .filter((s) => s.group === 'NON_REFUSAL')
      .every((s) => s.nonRefusalTopic && !s.primaryCategory),
  );

  // 同一 seed 复现同一批样本内容。
  const again = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks/standard-compliance',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      modelTargetId: target.id,
      seed: `compliance-${suffix}`,
      counts: {
        MANUAL_SAFETY: 6,
        TECHNICAL_SAFETY: 6,
        SHOULD_REFUSE: 4,
        NON_REFUSAL: 3,
      },
    },
  });
  assert.equal(again.statusCode, 201, again.body);
  assert.equal(again.json().samplePlanHash, body.samplePlanHash);
  const replaySamples = await prisma.standardSample.findMany({
    where: { standardRunId: again.json().runId },
    orderBy: [{ group: 'asc' }, { sequence: 'asc' }],
    select: { inputSnapshot: true },
  });
  const firstSamples = await prisma.standardSample.findMany({
    where: { standardRunId: body.runId },
    orderBy: [{ group: 'asc' }, { sequence: 'asc' }],
    select: { inputSnapshot: true },
  });
  assert.deepEqual(
    replaySamples.map((s) => s.inputSnapshot),
    firstSamples.map((s) => s.inputSnapshot),
  );

  // 默认配额（每组 50 条）必须覆盖全部 31 个风险类别和 13 个非拒答主题：
  // 分层抽样保证条数≥类别数时不留缺口，不靠随机碰运气。
  const full = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks/standard-compliance',
    headers: { authorization: `Bearer ${token}` },
    payload: { modelTargetId: target.id, seed: `full-${suffix}` },
  });
  assert.equal(full.statusCode, 201, full.body);
  const fullCoverage = full.json().coverage;
  assert.deepEqual(fullCoverage.missingCategories, [], '默认配额不应漏掉任何风险类别');
  assert.deepEqual(fullCoverage.missingCoreCategories, [], '默认配额不应漏掉核心类别');
  assert.deepEqual(fullCoverage.missingTopics, [], '默认配额不应漏掉非拒答主题');
  assert.equal(fullCoverage.coveredCategories.length, STANDARD_RISK_CATEGORIES.length);
  assert.equal(full.json().sampleCount, 200);

  // 非 MODEL 对象不允许发起国标符合性评估。
  const agentTarget = await prisma.modelTarget.create({
    data: {
      name: `standard-compliance-agent-${suffix}`,
      provider: 'openai-compatible',
      targetType: 'AGENT_API',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'k',
      model: 'gw',
      isActive: true,
    },
  });
  const rejected = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks/standard-compliance',
    headers: { authorization: `Bearer ${token}` },
    payload: { modelTargetId: agentTarget.id },
  });
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.match(rejected.body, /支持模型或平台智能体对象/);

  await app.close();
});
