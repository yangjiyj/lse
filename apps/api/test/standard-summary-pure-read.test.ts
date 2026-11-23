import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  STANDARD_PROFILE_ID,
  STANDARD_PROFILE_VERSION,
  STANDARD_JUDGMENT_RULE_VERSION,
} from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { buildRevisionHash, STANDARD_PROFILE } from '../src/modules/standard-evaluations/core.js';

/**
 * P0-05：GET /standard-evaluations/:id/summary 必须是纯读。
 * 详情页每 5 秒轮询它；以前它会 evalTask.update 写回计数/进度/完成时间，
 * 让只读用户打开页面就在改库，列表排序随之跳动，已取消的任务在「打开前/后」显示两套数字。
 * 计数重算改放到执行器与取消路由；取消路由写回取消当时的 processed/passed/failed/error。
 */

let app!: FastifyInstance;
let token = '';
let actorId = '';
const suffix = randomUUID().slice(0, 8);
const created: {
  taskIds: string[];
  targetIds: string[];
  releaseIds: string[];
  revisionIds: string[];
} = { taskIds: [], targetIds: [], releaseIds: [], revisionIds: [] };

const auth = () => ({ authorization: `Bearer ${token}` });

before(async () => {
  app = await buildApp();
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  token = login.json().token;
  actorId = (await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).id;
});

after(async () => {
  for (const taskId of created.taskIds) {
    const run = await prisma.standardRun.findUnique({ where: { taskId } });
    if (run) {
      const samples = await prisma.standardSample.findMany({
        where: { standardRunId: run.id },
        select: { id: true },
      });
      const sampleIds = samples.map((s) => s.id);
      await prisma.standardJudgment.deleteMany({ where: { sampleId: { in: sampleIds } } });
      await prisma.standardSampleAttempt.deleteMany({ where: { sampleId: { in: sampleIds } } });
      await prisma.standardSample.deleteMany({ where: { standardRunId: run.id } });
      await prisma.standardRun.delete({ where: { id: run.id } });
    }
  }
  await prisma.evalTask.deleteMany({ where: { id: { in: created.taskIds } } });
  await prisma.standardBankReleaseItem.deleteMany({
    where: { releaseId: { in: created.releaseIds } },
  });
  await prisma.standardBankRelease.deleteMany({ where: { id: { in: created.releaseIds } } });
  await prisma.standardQuestionRevision.deleteMany({ where: { id: { in: created.revisionIds } } });
  await prisma.modelTarget.deleteMany({ where: { id: { in: created.targetIds } } });
  await app.close();
  await prisma.$disconnect();
});

interface RunSpec {
  /** 4 条样本各自的响应状态与判定：SAFE→通过，UNSAFE→风险，ERROR→异常，PENDING→未执行 */
  samples: Array<'SAFE' | 'UNSAFE' | 'ERROR' | 'PENDING'>;
  taskStatus: 'RUNNING' | 'CANCELED' | 'COMPLETED';
  /** 任务上当前持久化的（可能是旧的）计数 */
  persisted: { processed: number; passed: number; failed: number; error: number };
  runStatus?: string;
}

async function makeRun(spec: RunSpec) {
  const target = await prisma.modelTarget.create({
    data: {
      name: `__std_pure_read_${suffix}_${created.targetIds.length}`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test',
      model: 'fake',
      createdById: actorId,
    },
  });
  created.targetIds.push(target.id);
  const revisions = [];
  for (let i = 0; i < spec.samples.length; i += 1) {
    const content = `std-pure-read-${suffix}-${created.targetIds.length}-${i}`;
    const rev = await prisma.standardQuestionRevision.create({
      data: {
        content,
        expectedBehavior: 'fixture',
        category: 'other_illegal_harmful',
        primaryCategory: 'other_illegal_harmful',
        secondaryCategories: [],
        language: 'zh',
        modality: 'text',
        source: 'TEST_FIXTURE_NOT_FORMAL_BANK',
        standardProfileId: STANDARD_PROFILE_ID,
        standardProfileVersion: STANDARD_PROFILE_VERSION,
        contentHash: buildRevisionHash({
          content,
          expectedBehavior: 'fixture',
          primaryCategory: 'other_illegal_harmful',
          secondaryCategories: [],
          language: 'zh',
          modality: 'text',
        }),
        createdById: actorId,
      },
    });
    revisions.push(rev);
    created.revisionIds.push(rev.id);
  }
  const release = await prisma.standardBankRelease.create({
    data: {
      profileId: STANDARD_PROFILE_ID,
      profileVersion: STANDARD_PROFILE_VERSION,
      name: `__std_pure_read_rel_${suffix}_${created.releaseIds.length}`,
      language: 'zh',
      modalities: ['text'],
      status: 'PUBLISHED',
      counts: { fixture: true },
      validation: { ok: true },
      overallHash: `fx-${suffix}-${created.releaseIds.length}`,
      publishedAt: new Date(),
      publishedById: actorId,
      items: {
        create: revisions.map((rev, index) => ({
          revisionId: rev.id,
          bankType: 'GENERATION_SAFETY',
          primaryCategory: 'other_illegal_harmful',
          position: index,
        })),
      },
    },
    include: { items: { orderBy: { position: 'asc' } } },
  });
  created.releaseIds.push(release.id);
  const task = await prisma.evalTask.create({
    data: {
      name: `__std_pure_read_task_${suffix}_${created.taskIds.length}`,
      modelTargetId: target.id,
      engines: ['standard-output-v1'],
      dimensions: ['standard_output_safety'],
      concurrency: 1,
      status: spec.taskStatus,
      totalQuestions: spec.samples.length,
      processedQuestions: spec.persisted.processed,
      passedCount: spec.persisted.passed,
      failedCount: spec.persisted.failed,
      errorCount: spec.persisted.error,
      progress: spec.persisted.processed / spec.samples.length,
      startedAt: new Date('2026-10-01T00:00:00Z'),
      finishedAt: spec.taskStatus === 'RUNNING' ? null : new Date('2026-10-01T01:00:00Z'),
      createdById: actorId,
    },
  });
  created.taskIds.push(task.id);
  const run = await prisma.standardRun.create({
    data: {
      taskId: task.id,
      bankReleaseId: release.id,
      profileSnapshot: STANDARD_PROFILE,
      modelSnapshot: { id: target.id, name: target.name },
      boundary: 'fixture',
      language: 'zh',
      modality: 'text',
      samplePlan: { MANUAL_SAFETY: spec.samples.length, mode: 'DIAGNOSTIC', seed: 's' },
      samplePlanHash: `fx-${suffix}-${created.taskIds.length}`,
      status: spec.runStatus ?? (spec.taskStatus === 'CANCELED' ? 'CANCELED' : 'RUNNING'),
      createdById: actorId,
      samples: {
        create: spec.samples.map((state, index) => ({
          group: 'MANUAL_SAFETY',
          sequence: index + 1,
          revisionId: revisions[index]!.id,
          releaseItemId: release.items[index]!.id,
          inputSnapshot: revisions[index]!.content,
          primaryCategory: 'other_illegal_harmful',
          responseStatus: state === 'PENDING' ? 'PENDING' : state === 'ERROR' ? 'ERROR' : 'SUCCESS',
          selectedResponse: state === 'SAFE' || state === 'UNSAFE' ? '回答' : null,
        })),
      },
    },
    include: { samples: { orderBy: { sequence: 'asc' } } },
  });
  for (const [index, state] of spec.samples.entries()) {
    if (state !== 'SAFE' && state !== 'UNSAFE') continue;
    await prisma.standardJudgment.create({
      data: {
        sampleId: run.samples[index]!.id,
        source: 'TECHNICAL',
        ruleVersion: STANDARD_JUDGMENT_RULE_VERSION,
        safetyOutcome: state === 'SAFE' ? 'SAFE' : 'UNSAFE',
        reason: 'fixture',
      },
    });
  }
  return { taskId: task.id, runId: run.id };
}

const taskRow = (id: string) =>
  prisma.evalTask.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      processedQuestions: true,
      passedCount: true,
      failedCount: true,
      errorCount: true,
      progress: true,
      finishedAt: true,
      updatedAt: true,
    },
  });
const runRow = (id: string) =>
  prisma.standardRun.findUniqueOrThrow({
    where: { id },
    select: { status: true, conclusion: true, evidenceCompleteness: true, updatedAt: true },
  });

test('GET summary 纯读：任务与运行记录的任何字段（含 updatedAt）都不变，连续轮询结果稳定', async () => {
  // 已取消，持久化的是「取消那一刻」的旧计数（处理 2：1 通过 1 风险）；样本现状更多。
  const { taskId, runId } = await makeRun({
    samples: ['SAFE', 'UNSAFE', 'SAFE', 'PENDING'],
    taskStatus: 'CANCELED',
    persisted: { processed: 2, passed: 1, failed: 1, error: 0 },
  });
  const taskBefore = await taskRow(taskId);
  const runBefore = await runRow(runId);

  const bodies: unknown[] = [];
  for (let i = 0; i < 3; i += 1) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/standard-evaluations/${runId}/summary`,
      headers: auth(),
    });
    assert.equal(res.statusCode, 200, res.body);
    bodies.push(res.json());
  }
  assert.deepEqual(bodies[1], bodies[0]);
  assert.deepEqual(bodies[2], bodies[0]);
  assert.equal(
    (bodies[0] as { status: string }).status,
    'CANCELED',
    '已取消的运行不会被刷回 RUNNING',
  );

  assert.deepEqual(await taskRow(taskId), taskBefore, 'GET summary 不得改写评估任务');
  assert.deepEqual(await runRow(runId), runBefore, 'GET summary 不得改写标准运行');
  assert.ok(
    (await taskRow(taskId)).updatedAt.getTime() === taskBefore.updatedAt.getTime(),
    'updatedAt 不变，任务列表排序不跳动',
  );
});

test('GET summary 纯读：运行中的任务也不被补写计数或完成时间', async () => {
  const { taskId, runId } = await makeRun({
    samples: ['SAFE', 'SAFE', 'ERROR', 'PENDING'],
    taskStatus: 'RUNNING',
    persisted: { processed: 0, passed: 0, failed: 0, error: 0 },
  });
  const before = await taskRow(taskId);
  const res = await app.inject({
    method: 'GET',
    url: `/api/standard-evaluations/${runId}/summary`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(await taskRow(taskId), before);
  // 响应里的进度仍按样本实况计算（只读计算，不落库）。
  const body = res.json() as { progress: { processed: number; total: number } };
  assert.equal(body.progress.total, 4);
  assert.equal(body.progress.processed, 3);
});

test('取消路由写回取消当时的 processed/passed/failed/error 计数', async () => {
  // 取消前任务上的计数还是 0（执行器的计数滞后）；样本实况：通过 2、风险 1、异常 1、未执行 1。
  const { taskId, runId } = await makeRun({
    samples: ['SAFE', 'SAFE', 'UNSAFE', 'ERROR', 'PENDING'],
    taskStatus: 'RUNNING',
    persisted: { processed: 0, passed: 0, failed: 0, error: 0 },
    runStatus: 'RUNNING',
  });
  const res = await app.inject({
    method: 'POST',
    url: `/api/standard-evaluations/${runId}/cancel`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const task = await taskRow(taskId);
  assert.equal(task.status, 'CANCELED');
  assert.equal(task.processedQuestions, 4, '已处理 = 非 PENDING 的 4 条');
  assert.equal(task.passedCount, 2);
  assert.equal(task.failedCount, 1);
  assert.equal(task.errorCount, 1);
  assert.ok(task.finishedAt);
  assert.ok(Math.abs(task.progress - 4 / 5) < 1e-9);

  // 之后无论怎么轮询 summary，数字都保持取消时的样子（不再「打开后才自愈」）。
  const before = await taskRow(taskId);
  for (let i = 0; i < 2; i += 1)
    await app.inject({
      method: 'GET',
      url: `/api/standard-evaluations/${runId}/summary`,
      headers: auth(),
    });
  assert.deepEqual(await taskRow(taskId), before);

  // 任务列表里该任务显示取消时的计数，不是「发现风险」之外的另一套数字。
  const list = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks?keyword=${encodeURIComponent('__std_pure_read_task_')}&pageSize=100`,
    headers: auth(),
  });
  const item = (list.json().items as Array<Record<string, unknown>>).find((t) => t.id === taskId)!;
  assert.equal(item.status, 'CANCELED');
  assert.equal(item.processedQuestions, 4);
  assert.equal(item.failedCount, 1);
  assert.equal(item.evalScore, null, '已取消的任务不出分');
});

test('执行与技术判定路径仍负责重算：technical-judge 之后计数与样本一致', async () => {
  const { taskId, runId } = await makeRun({
    samples: ['SAFE', 'SAFE', 'PENDING', 'PENDING'],
    taskStatus: 'RUNNING',
    persisted: { processed: 0, passed: 0, failed: 0, error: 0 },
    runStatus: 'RUNNING',
  });
  const res = await app.inject({
    method: 'POST',
    url: `/api/standard-evaluations/${runId}/technical-judge`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const task = await taskRow(taskId);
  assert.equal(task.processedQuestions, 2);
  assert.equal(task.passedCount, 2);
});
