// 2.7.3 禁用样本库的拦截补全：计划触发、计划编辑、多模态、红队、综合评估回归、批量评估都不能再用禁用的库。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import { triggerEvalPlan } from '../src/modules/eval-plans/service.js';
import type { PlanScheduler } from '../src/modules/eval-plans/scheduler.js';
import { adminToken, bearer } from './helpers/w4-fixtures.js';

const P = 'w4qsdisabled_';
let app!: FastifyInstance;
let admin = '';
let enabledSetId = '';
let disabledSetId = '';
let modelId = '';
let attackerId = '';

const fakeScheduler: PlanScheduler = {
  async sync() {},
  async remove() {},
};

async function cleanup(): Promise<void> {
  await prisma.evalPlan.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.batchEvaluation.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: P } } });
}

async function createSet(name: string, enabled: boolean): Promise<string> {
  const set = await prisma.questionSet.create({
    data: {
      tenantId: PLATFORM_TENANT_ID,
      name,
      type: 'SHOULD_REFUSE',
      tags: ['red-team-seed'],
      enabled,
      questions: {
        create: [
          { content: `${name} 问题一`, type: 'SHOULD_REFUSE', shouldRefuse: true },
          { content: `${name} 问题二`, type: 'SHOULD_REFUSE', shouldRefuse: true },
        ],
      },
    },
  });
  return set.id;
}

async function createPlan(name: string, questionSetIds: string[]) {
  return prisma.evalPlan.create({
    data: {
      tenantId: PLATFORM_TENANT_ID,
      name,
      targetId: modelId,
      templateParams: { questionSetIds, engines: ['rule-judge'], concurrency: 2 },
      cron: '0 2 * * *',
      timezone: 'Asia/Shanghai',
      enabled: true,
      minIntervalMinutes: 60,
    },
  });
}

const expectDisabled = (res: { statusCode: number; body: string; json(): unknown }) => {
  assert.equal(res.statusCode, 400, res.body);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'QUESTION_SET_DISABLED');
};

before(async () => {
  app = await buildApp({ evalPlanScheduler: fakeScheduler });
  await app.ready();
  await cleanup();
  admin = await adminToken(app);
  const model = await prisma.modelTarget.create({
    data: {
      tenantId: PLATFORM_TENANT_ID,
      name: `${P}被测模型`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-dummy',
      model: 'fake-model',
      supportsVision: true,
      isGlobal: true,
    },
  });
  modelId = model.id;
  const attacker = await prisma.modelTarget.create({
    data: {
      tenantId: PLATFORM_TENANT_ID,
      name: `${P}攻击模型`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-dummy',
      model: 'fake-attacker',
    },
  });
  attackerId = attacker.id;
  enabledSetId = await createSet(`${P}启用`, true);
  disabledSetId = await createSet(`${P}禁用`, false);
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('计划手动触发遇到禁用的样本库：跳过并记原因，不建任务', async () => {
  const plan = await createPlan(`${P}手动`, [enabledSetId, disabledSetId]);
  const res = await app.inject({
    method: 'POST',
    url: `/api/eval-plans/${plan.id}/trigger`,
    headers: bearer(admin),
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().status, 'skipped');
  assert.equal(res.json().reason, '样本库已禁用，请编辑计划');
  const saved = await prisma.evalPlan.findUniqueOrThrow({ where: { id: plan.id } });
  assert.equal(saved.lastSkipReason, '样本库已禁用，请编辑计划');
  assert.equal(await prisma.evalTask.count({ where: { planId: plan.id } }), 0);
});

test('计划定时触发遇到禁用的样本库：同样跳过', async () => {
  const plan = await createPlan(`${P}定时`, [disabledSetId]);
  const result = await triggerEvalPlan(prisma, plan.id, { triggeredBy: 'schedule', actorId: null });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, '样本库已禁用，请编辑计划');
  assert.equal(await prisma.evalTask.count({ where: { planId: plan.id } }), 0);
});

test('编辑计划：保留已禁用的库也能改名、能取消勾选；新勾选禁用的库返回 400', async () => {
  const plan = await createPlan(`${P}编辑`, [enabledSetId, disabledSetId]);
  const template = {
    questionSetIds: [enabledSetId, disabledSetId],
    engines: ['rule-judge'],
    concurrency: 2,
  };
  const rename = await app.inject({
    method: 'PATCH',
    url: `/api/eval-plans/${plan.id}`,
    headers: bearer(admin),
    payload: { name: `${P}编辑改名`, templateParams: template },
  });
  assert.equal(rename.statusCode, 200, rename.body);
  assert.equal(rename.json().name, `${P}编辑改名`);

  const uncheck = await app.inject({
    method: 'PATCH',
    url: `/api/eval-plans/${plan.id}`,
    headers: bearer(admin),
    payload: { templateParams: { ...template, questionSetIds: [enabledSetId] } },
  });
  assert.equal(uncheck.statusCode, 200, uncheck.body);

  const addDisabled = await app.inject({
    method: 'PATCH',
    url: `/api/eval-plans/${plan.id}`,
    headers: bearer(admin),
    payload: { templateParams: template },
  });
  expectDisabled(addDisabled);
});

test('多模态越狱复用禁用的样本库返回 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks/multimodal',
    headers: bearer(admin),
    payload: {
      name: `${P}多模态`,
      modelTargetId: modelId,
      questionSetId: disabledSetId,
      attackTypes: ['typographic'],
      sampleCount: 1,
    },
  });
  expectDisabled(res);
});

test('红队对抗用禁用的攻击样本库返回 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks/red-team',
    headers: bearer(admin),
    payload: {
      name: `${P}红队`,
      bareTargetId: modelId,
      attackerTargetId: attackerId,
      questionSetId: disabledSetId,
      sampleCount: 1,
    },
  });
  expectDisabled(res);
});

test('综合评估的样本回归用禁用的样本库返回 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks/comprehensive',
    headers: bearer(admin),
    payload: {
      name: `${P}综合`,
      modelTargetId: modelId,
      modules: ['sample_regression'],
      regressionQuestionSetIds: [enabledSetId, disabledSetId],
    },
  });
  expectDisabled(res);
});

test('批量评估用禁用的样本库返回 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/batch-evaluations',
    headers: bearer(admin),
    payload: {
      name: `${P}批量`,
      targetIds: [modelId],
      questionSetIds: [disabledSetId],
      sampleCount: 1,
      seed: 'w4-seed',
      judgeMode: 'RULES',
    },
  });
  expectDisabled(res);
});
