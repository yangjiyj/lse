import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { AppError } from '../src/lib/errors.js';
import {
  buildRetestInfo,
  createFailedRetestTask,
} from '../src/modules/eval-tasks/failed-retest.js';

// 只重跑失败用例：题目 = 父任务 FAIL + ERROR 的题；复制参数快照、关联父任务、回填 Finding。
const PREFIX = `__failed_retest_${randomUUID().slice(0, 8)}_`;
let app!: FastifyInstance;
let token = '';
let adminId = '';
let targetId = '';
let altTargetId = '';
let setId = '';
let q: string[] = [];
let parentId = '';
let cleanParentId = '';
let findingId = '';
const auth = () => ({ authorization: `Bearer ${token}` });

async function cleanup() {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

async function target(name: string) {
  const t = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}${name}`,
      provider: 'openai-compatible',
      targetType: 'MODEL',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-failed-retest-test',
      model: 'fake',
    },
  });
  return t.id;
}

async function parentTask(name: string, verdicts: Array<'PASS' | 'FAIL' | 'ERROR' | 'UNKNOWN'>) {
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}${name}`,
      status: 'COMPLETED',
      modelTargetId: targetId,
      engines: ['keyword'],
      dimensions: ['prompt_injection'],
      concurrency: 3,
      sampleSize: 5,
      sampleSeed: 'parent-seed',
      createdById: adminId,
      finishedAt: new Date(),
      questionSets: { create: [{ questionSetId: setId }] },
    },
  });
  for (const [i, v] of verdicts.entries()) {
    await prisma.evalResult.create({
      data: {
        taskId: task.id,
        questionId: q[i]!,
        modelTargetId: targetId,
        prompt: 'p',
        status: v === 'ERROR' ? 'ERROR' : 'SUCCESS',
        finalVerdict: v,
      },
    });
  }
  return task.id;
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  token = login.json().token;
  adminId = (await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).id;
  targetId = await target('对象');
  altTargetId = await target('网关路由对象');
  const set = await prisma.questionSet.create({
    data: { name: `${PREFIX}样本库`, type: 'PROMPT_INJECTION', source: 'test' },
  });
  setId = set.id;
  for (let i = 0; i < 5; i++) {
    const row = await prisma.question.create({
      data: { questionSetId: setId, content: `${PREFIX}题${i}`, severity: 'HIGH' },
    });
    q.push(row.id);
  }
  parentId = await parentTask('父任务', ['PASS', 'FAIL', 'ERROR', 'UNKNOWN', 'FAIL']);
  cleanParentId = await parentTask('全通过父任务', ['PASS', 'PASS']);
  const result = await prisma.evalResult.findFirstOrThrow({
    where: { taskId: parentId, questionId: q[1]! },
  });
  const f = await prisma.finding.create({
    data: {
      taskId: parentId,
      resultId: result.id,
      questionId: q[1]!,
      engine: 'keyword',
      riskCategory: 'prompt_injection',
      severity: 'HIGH',
      verdict: 'FAIL',
    },
  });
  findingId = f.id;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('createFailedRetestTask：题目=FAIL+ERROR，复制参数快照、关联父任务、跳过抽样，写审计', async () => {
  const out = await createFailedRetestTask(prisma, parentId, { actorId: adminId });
  assert.deepEqual([...out.questionIds].sort(), [q[1]!, q[2]!, q[4]!].sort());
  const task = await prisma.evalTask.findUniqueOrThrow({
    where: { id: out.task.id },
    include: { questionSets: true, pinnedQuestions: true },
  });
  assert.equal(task.parentTaskId, parentId);
  assert.equal(task.retestMode, 'FAILED_ONLY');
  assert.equal(task.status, 'PENDING');
  assert.equal(task.totalQuestions, 3);
  assert.equal(task.modelTargetId, targetId);
  assert.deepEqual(task.engines, ['keyword']);
  assert.deepEqual(task.dimensions, ['prompt_injection']);
  assert.equal(task.concurrency, 3);
  assert.equal(task.sampleSize, null);
  assert.equal(task.createdById, adminId);
  assert.deepEqual(
    task.questionSets.map((s) => s.questionSetId),
    [setId],
  );
  assert.equal(task.pinnedQuestions.length, 3);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'eval_task.retest_failed', targetId: out.task.id },
  });
  assert.ok(audit);
});

test('createFailedRetestTask：targetIdOverride 与 findingId 回填整改复测任务', async () => {
  const out = await createFailedRetestTask(prisma, parentId, {
    actorId: adminId,
    targetIdOverride: altTargetId,
    findingId,
  });
  assert.equal(out.task.modelTargetId, altTargetId);
  assert.equal(out.findingId, findingId);
  const f = await prisma.finding.findUniqueOrThrow({ where: { id: findingId } });
  assert.equal(f.remediationRetestTaskId, out.task.id);
});

test('createFailedRetestTask：无失败题、Finding 不属于父任务、父任务运行中 → 明确错误且不建任务', async () => {
  const before = await prisma.evalTask.count({ where: { parentTaskId: { not: null } } });
  await assert.rejects(
    createFailedRetestTask(prisma, cleanParentId, { actorId: adminId }),
    (e: unknown) => e instanceof AppError && e.code === 'RETEST_NO_FAILED_QUESTIONS',
  );
  await assert.rejects(
    createFailedRetestTask(prisma, cleanParentId, { actorId: adminId, findingId }),
    (e: unknown) => e instanceof AppError && e.code === 'RETEST_FINDING_SCOPE_MISMATCH',
  );
  await prisma.evalTask.update({ where: { id: cleanParentId }, data: { status: 'RUNNING' } });
  await assert.rejects(
    createFailedRetestTask(prisma, cleanParentId, { actorId: adminId }),
    (e: unknown) => e instanceof AppError && e.code === 'RETEST_PARENT_NOT_FINISHED',
  );
  await prisma.evalTask.update({ where: { id: cleanParentId }, data: { status: 'COMPLETED' } });
  await assert.rejects(
    createFailedRetestTask(prisma, randomUUID(), { actorId: adminId }),
    (e: unknown) => e instanceof AppError && e.statusCode === 404,
  );
  const afterCount = await prisma.evalTask.count({ where: { parentTaskId: { not: null } } });
  assert.equal(afterCount, before);
});

test('buildRetestInfo：按题目对齐父任务得出 x/y 已修复；父任务给出失败题数与复测列表', async () => {
  const out = await createFailedRetestTask(prisma, parentId, { actorId: adminId });
  // 复测结果：q1 PASS（已修复）、q2 FAIL（仍失败）、q4 暂无结果。
  for (const [qid, v] of [
    [q[1]!, 'PASS'],
    [q[2]!, 'FAIL'],
  ] as const) {
    await prisma.evalResult.create({
      data: {
        taskId: out.task.id,
        questionId: qid,
        modelTargetId: targetId,
        prompt: 'p',
        finalVerdict: v,
      },
    });
  }
  const info = await buildRetestInfo(prisma, out.task.id);
  assert.ok(info.retestOf);
  assert.equal(info.retestOf.parentTaskId, parentId);
  assert.equal(info.retestOf.total, 3);
  assert.equal(info.retestOf.fixed, 1);
  assert.equal(info.retestOf.stillFailing, 1);
  assert.equal(info.retestOf.notRetested, 1);
  const parentInfo = await buildRetestInfo(prisma, parentId);
  assert.equal(parentInfo.retestOf, null);
  assert.equal(parentInfo.failedQuestionCount, 3);
  assert.ok(parentInfo.retestTasks.some((t) => t.id === out.task.id));
});

test('POST /api/eval-tasks/:id/retest-failed：201 建任务；无失败题 409；详情带复测信息', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/eval-tasks/${parentId}/retest-failed`,
    headers: auth(),
    payload: {},
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.equal(body.task.parentTaskId, parentId);
  assert.equal(body.questionIds.length, 3);
  const none = await app.inject({
    method: 'POST',
    url: `/api/eval-tasks/${cleanParentId}/retest-failed`,
    headers: auth(),
    payload: {},
  });
  assert.equal(none.statusCode, 409, none.body);
  assert.equal(none.json().error.code, 'RETEST_NO_FAILED_QUESTIONS');
  const detail = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks/${body.task.id}`,
    headers: auth(),
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().retest.retestOf.parentTaskId, parentId);
  assert.equal(detail.json().retest.retestOf.total, 3);
  const unauth = await app.inject({
    method: 'POST',
    url: `/api/eval-tasks/${parentId}/retest-failed`,
    payload: {},
  });
  assert.equal(unauth.statusCode, 401);
});

test('平台开关关闭时，父任务平台对象和覆盖为平台对象的失败复测均返回 403', async () => {
  const previous = process.env.LSE_PLATFORM_APP_ENABLED;
  process.env.LSE_PLATFORM_APP_ENABLED = 'false';
  const platform = await prisma.modelTarget.create({data:{name:`${PREFIX}platform`,targetType:'PLATFORM_APP',provider:'dify',baseUrl:'https://example.com/v1',apiKey:'app-test',model:'platform-app'}});
  const platformParent = await parentTask('平台父任务',['FAIL']);
  await prisma.evalTask.update({where:{id:platformParent},data:{modelTargetId:platform.id}});
  try {
    const before = await prisma.evalTask.count();
    for (const [id, options] of [[platformParent,{}],[parentId,{targetIdOverride:platform.id}]] as const) {
      await assert.rejects(createFailedRetestTask(prisma,id,{actorId:adminId,...options}), (error: any) => error.statusCode === 403 && error.code === 'PLATFORM_APP_DISABLED');
    }
    assert.equal(await prisma.evalTask.count(),before);
  } finally { if(previous === undefined) delete process.env.LSE_PLATFORM_APP_ENABLED; else process.env.LSE_PLATFORM_APP_ENABLED=previous; }
});
