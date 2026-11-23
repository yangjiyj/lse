import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import type { LlmCallResult } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { EVAL_TASK_PAUSE_TTL_SECONDS, evalTaskPauseKey } from '../src/lib/queue.js';
import { cancelEvalTaskById } from '../src/modules/eval-tasks/cancel.js';
import { runEvalTask, type PrismaLike } from '../src/modules/eval-tasks/executor.js';
import { evalTaskPausable } from '../src/modules/eval-tasks/pause.js';
import { RetryExhausted } from '../src/modules/red-team/red-team-chat.js';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';

// 2.4.2 评估任务暂停、恢复：进行中的题做完再停，恢复后从断点继续；只限普通评估任务。

const P = '__p2bb_pause_';
const TENANT_NAME = 'P2BB评估暂停测试租户';
const PASSWORD = ['Pause', 'Task', '12345'].join('@');

let app: Awaited<ReturnType<typeof buildApp>>;
const pauseCalls: string[] = [];
const tokens = { admin: '', auditor: '', tenantAdmin: '' };
let targetId = '';
let endpointTargetId = '';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function cleanup(): Promise<void> {
  const tasks = await prismaUnscoped.evalTask.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  const taskIds = tasks.map((t) => t.id);
  await prismaUnscoped.auditLog.deleteMany({ where: { targetId: { in: taskIds } } });
  await prismaUnscoped.standardRun.deleteMany({ where: { taskId: { in: taskIds } } });
  await prismaUnscoped.standardBankRelease.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.evalTask.deleteMany({ where: { id: { in: taskIds } } });
  await prismaUnscoped.modelTarget.deleteMany({ where: { name: { startsWith: P } } });
  const tenants = await prismaUnscoped.tenant.findMany({
    where: { name: TENANT_NAME },
    select: { id: true },
  });
  const tenantIds = tenants.map((t) => t.id);
  await prismaUnscoped.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prismaUnscoped.user.deleteMany({
    where: { OR: [{ username: { startsWith: P } }, { tenantId: { in: tenantIds } }] },
  });
  await prismaUnscoped.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

async function createUser(username: string, roleName: string): Promise<string> {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.user.create({
    data: {
      username,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: username,
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  return login(username, PASSWORD);
}

async function createTask(
  name: string,
  data: Partial<Prisma.EvalTaskUncheckedCreateInput> = {},
): Promise<string> {
  const task = await prisma.evalTask.create({
    data: { name: P + name, modelTargetId: targetId, totalQuestions: 3, ...data },
  });
  return task.id;
}

function post(url: string, token = tokens.admin) {
  return app.inject({ method: 'POST', url, headers: bearer(token) });
}

before(async () => {
  app = await buildApp({
    pauseEvalTask: async (taskId) => {
      pauseCalls.push(taskId);
    },
    cancelEvalTask: async () => undefined,
  });
  await app.ready();
  await cleanup();
  tokens.admin = await login('admin', ['Admin', '@', '12345'].join(''));
  tokens.auditor = await createUser(`${P}au`, 'auditor');
  const tenant = await app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: bearer(tokens.admin),
    payload: { name: TENANT_NAME, admin: { username: `${P}tadmin`, password: PASSWORD } },
  });
  assert.equal(tenant.statusCode, 201, tenant.body);
  await skipFirstPasswordChange(`${P}tadmin`);
  tokens.tenantAdmin = await login(`${P}tadmin`, PASSWORD);
  const base = {
    provider: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'dummy-pause-key', // pragma: allowlist secret
    model: 'fake-model',
  };
  targetId = (await prisma.modelTarget.create({ data: { ...base, name: `${P}target` } })).id;
  endpointTargetId = (
    await prisma.modelTarget.create({
      data: { ...base, name: `${P}endpoint`, targetType: 'ENDPOINT_AGENT' },
    })
  ).id;
});

after(async () => {
  await cleanup();
  await app.close();
});

test('暂停信号用共享 Valkey 键，TTL 1 小时', () => {
  const id = randomUUID();
  assert.equal(evalTaskPauseKey(id), `evaltask:pause:${id}`);
  assert.equal(EVAL_TASK_PAUSE_TTL_SECONDS, 3600);
});

test('能暂停的范围：只有走普通执行器的任务', () => {
  const base = {
    standardRun: null,
    ragEvalRun: null,
    modelTarget: { targetType: 'MODEL' },
    dimensions: ['redteam_attack'],
    engines: ['autonomous-red-team'],
  };
  assert.equal(evalTaskPausable(base), true);
  assert.equal(evalTaskPausable({ ...base, standardRun: { id: 'x' } }), false);
  assert.equal(evalTaskPausable({ ...base, ragEvalRun: { id: 'x' } }), false);
  assert.equal(evalTaskPausable({ ...base, modelTarget: { targetType: 'ENDPOINT_AGENT' } }), false);
  assert.equal(evalTaskPausable({ ...base, dimensions: ['gateway_traffic_log'] }), false);
  assert.equal(evalTaskPausable({ ...base, engines: ['gateway-assurance'] }), false);
});

test('执行中的任务暂停：只写暂停键，状态仍是执行中，返回 pauseRequested', async () => {
  const id = await createTask('执行中', { status: 'RUNNING' });
  const res = await post(`/api/eval-tasks/${id}/pause`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().pauseRequested, true);
  assert.equal(res.json().status, 'RUNNING');
  assert.ok(pauseCalls.includes(id));
  const row = await prisma.evalTask.findUniqueOrThrow({ where: { id } });
  assert.equal(row.status, 'RUNNING');
  assert.equal(row.pausedAt, null);
});

test('排队中的任务暂停：直接置已暂停并记暂停时间', async () => {
  const id = await createTask('排队中');
  const res = await post(`/api/eval-tasks/${id}/pause`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'PAUSED');
  assert.equal(res.json().pauseRequested, false);
  assert.ok(res.json().pausedAt);
  assert.ok(pauseCalls.includes(id));
  const row = await prisma.evalTask.findUniqueOrThrow({ where: { id } });
  assert.equal(row.status, 'PAUSED');
  assert.ok(row.pausedAt instanceof Date);
});

test('国标专项、终端对象的任务不能暂停：409 EVAL_TASK_NOT_PAUSABLE', async () => {
  const gbt = await createTask('国标专项', { status: 'RUNNING' });
  const release = await prisma.standardBankRelease.create({
    data: {
      profileId: 'gb-test',
      profileVersion: 'v1',
      name: `${P}国标样本集`,
      language: 'zh',
      modalities: ['text'],
      status: 'PUBLISHED',
    },
  });
  await prisma.standardRun.create({
    data: {
      taskId: gbt,
      bankReleaseId: release.id,
      profileSnapshot: {},
      modelSnapshot: {},
      boundary: 'test',
      language: 'zh',
      modality: 'text',
      samplePlan: {},
      samplePlanHash: 'x',
    },
  });
  const endpoint = await createTask('终端', { status: 'RUNNING', modelTargetId: endpointTargetId });
  for (const id of [gbt, endpoint]) {
    const res = await post(`/api/eval-tasks/${id}/pause`);
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error.code, 'EVAL_TASK_NOT_PAUSABLE');
    assert.ok(!pauseCalls.includes(id));
  }
});

test('列表和详情带 pausable：普通任务能暂停，终端对象、网关核验不能（页面据此显示暂停按钮）', async () => {
  const cases: Array<[string, Partial<Prisma.EvalTaskUncheckedCreateInput>, boolean]> = [
    ['可暂停普通', { status: 'RUNNING' }, true],
    ['可暂停终端', { status: 'RUNNING', modelTargetId: endpointTargetId }, false],
    ['可暂停网关核验', { status: 'RUNNING', engines: ['gateway-assurance'] }, false],
  ];
  for (const [name, data, pausable] of cases) {
    const id = await createTask(name, data);
    const detail = await app.inject({ url: `/api/eval-tasks/${id}`, headers: bearer(tokens.admin) });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().pausable, pausable, name);
    const list = await app.inject({
      url: `/api/eval-tasks?pageSize=100&keyword=${encodeURIComponent(P + name)}`,
      headers: bearer(tokens.admin),
    });
    const row = list.json().items.find((t: { id: string }) => t.id === id);
    if (row) assert.equal(row.pausable, pausable, name);
  }
});

test('已结束的任务暂停、执行中的任务恢复：409 EVAL_TASK_STATE_CONFLICT', async () => {
  const done = await createTask('已完成', { status: 'COMPLETED' });
  const pause = await post(`/api/eval-tasks/${done}/pause`);
  assert.equal(pause.statusCode, 409, pause.body);
  assert.equal(pause.json().error.code, 'EVAL_TASK_STATE_CONFLICT');
  const running = await createTask('恢复执行中', { status: 'RUNNING' });
  const resume = await post(`/api/eval-tasks/${running}/resume`);
  assert.equal(resume.statusCode, 409, resume.body);
  assert.equal(resume.json().error.code, 'EVAL_TASK_STATE_CONFLICT');
});

test('已暂停的任务恢复：回到排队中，保留暂停时间（下次执行是接续）', async () => {
  const pausedAt = new Date('2026-11-20T08:00:00.000Z');
  const id = await createTask('恢复', { status: 'PAUSED', pausedAt });
  const res = await post(`/api/eval-tasks/${id}/resume`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'PENDING');
  const row = await prisma.evalTask.findUniqueOrThrow({ where: { id } });
  assert.equal(row.status, 'PENDING');
  assert.equal(row.pausedAt?.toISOString(), pausedAt.toISOString());
});

test('已暂停的任务可以停止；重新评估清掉暂停字段，全量重跑', async () => {
  const pausedAt = new Date();
  const id = await createTask('暂停后停止', {
    status: 'PAUSED',
    pausedAt,
    pauseState: { engineAccum: {}, redTeamLaps: 1 },
  });
  const cancel = await post(`/api/eval-tasks/${id}/cancel`);
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(cancel.json().status, 'CANCELED');
  const canceled = await prisma.evalTask.findUniqueOrThrow({ where: { id } });
  assert.equal(canceled.status, 'CANCELED');
  assert.ok(canceled.finishedAt instanceof Date);
  assert.equal(canceled.pausedAt, null, '停止时清掉暂停字段');
  assert.equal(canceled.pauseState, null);

  const other = await createTask('暂停后重评', {
    status: 'PAUSED',
    pausedAt,
    pauseState: { engineAccum: {}, redTeamLaps: 1 },
  });
  const reEval = await post(`/api/eval-tasks/${other}/re-eval`);
  assert.equal(reEval.statusCode, 200, reEval.body);
  const row = await prisma.evalTask.findUniqueOrThrow({ where: { id: other } });
  assert.equal(row.status, 'PENDING');
  assert.equal(row.pausedAt, null);
  assert.equal(row.pauseState, null);
});

test('审计员暂停 403；另一个租户看不到 404；写审计', async () => {
  const id = await createTask('权限', { status: 'RUNNING' });
  assert.equal((await post(`/api/eval-tasks/${id}/pause`, tokens.auditor)).statusCode, 403);
  assert.equal((await post(`/api/eval-tasks/${id}/pause`, tokens.tenantAdmin)).statusCode, 404);
  const pendingId = await createTask('审计');
  assert.equal((await post(`/api/eval-tasks/${pendingId}/pause`)).statusCode, 200);
  assert.equal(
    (await post(`/api/eval-tasks/${pendingId}/resume`, tokens.tenantAdmin)).statusCode,
    404,
  );
  assert.equal((await post(`/api/eval-tasks/${pendingId}/resume`)).statusCode, 200);
  const audits = await prismaUnscoped.auditLog.findMany({
    where: { targetId: pendingId },
    select: { action: true, actorName: true },
  });
  const actions = audits.map((a) => a.action).sort();
  assert.deepEqual(actions, ['eval_task.pause', 'eval_task.resume']);
  assert.ok(audits.every((a) => a.actorName === 'admin'));
});

// ---- 执行器：断点 ----

function ok(content = 'ok'): LlmCallResult {
  return {
    status: 'SUCCESS',
    content,
    finishReason: 'stop',
    model: 'fake',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    latencyMs: 1,
    httpStatus: 200,
    error: null,
    raw: null,
  } as LlmCallResult;
}

function passEngine(onJudge: () => void = () => undefined) {
  return {
    engine: 'fake-pass',
    builtin: true,
    judge: async (input: { questionId?: string }) => {
      onJudge();
      return {
        engine: 'fake-pass',
        taskId: 't',
        questionId: input.questionId ?? 'q',
        status: 'success',
        verdict: 'PASS',
        riskCategory: 'ok',
        severity: 'INFO',
        score: 1,
        evidence: null,
        rawOutput: null,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      };
    },
  } as any;
}

interface FakeDb {
  db: PrismaLike;
  updates: any[];
  createdResults: any[];
  summaryRows: any[];
  deleteCalls: string[];
  task: Record<string, unknown>;
}

function fakeDb(args: {
  questions: Array<{ id: string; content: string }>;
  task?: Record<string, unknown>;
  existingResults?: Array<{ questionId: string; side?: string | null; finalVerdict?: string }>;
}): FakeDb {
  const target = {
    id: randomUUID(),
    name: `${P}fake-target`,
    targetType: 'MODEL',
    provider: 'openai-compatible',
    baseUrl: 'https://target.invalid/v1',
    apiKey: 'dummy-target-key', // pragma: allowlist secret
    model: 'target-model',
    extraHeaders: null,
    defaultParams: null,
    accessConfig: null,
  };
  const task: Record<string, unknown> = {
    id: randomUUID(),
    name: `${P}fake-task`,
    status: 'PENDING',
    engines: [],
    dimensions: [],
    concurrency: 1,
    modelTargetId: target.id,
    modelTarget: target,
    questionSets: [{ questionSetId: randomUUID() }],
    ...args.task,
  };
  const out: FakeDb = {
    updates: [],
    createdResults: [],
    summaryRows: [],
    deleteCalls: [],
    task,
    db: null as unknown as PrismaLike,
  };
  const now = new Date('2026-11-22T00:00:00.000Z');
  const questions = args.questions.map((q) => ({
    metadata: null,
    type: 'GENERAL',
    shouldRefuse: false,
    category: null,
    expectedBehavior: null,
    referenceAnswer: null,
    severity: null,
    createdAt: now,
    ...q,
  }));
  const del = (name: string) => async () => {
    out.deleteCalls.push(name);
    return { count: 0 };
  };
  out.db = {
    evalTask: {
      findUnique: async () => ({ ...task }),
      update: async (input: any) => {
        out.updates.push(input);
        Object.assign(task, input.data);
        return { ...task };
      },
      updateMany: async (input: any) => {
        const want = input.where?.status;
        const matches =
          want === undefined ||
          (typeof want === 'string' ? task.status === want : want.in?.includes(task.status));
        if (!matches) return { count: 0 };
        // 条件更新里要求「暂停请求还在」：任务上显式为 null（已撤销）时不改
        if (input.where?.pauseRequestedAt?.not === null && task.pauseRequestedAt === null) {
          return { count: 0 };
        }
        out.updates.push(input);
        Object.assign(task, input.data);
        return { count: 1 };
      },
    },
    question: { findMany: async () => questions },
    wrongAnswer: { deleteMany: del('wrongAnswer'), create: async () => ({}) },
    finding: { deleteMany: del('finding'), createMany: async () => ({ count: 0 }) },
    engineRun: {
      deleteMany: del('engineRun'),
      create: async () => ({}),
      createMany: async (input: any) => {
        const rows = Array.isArray(input.data) ? input.data : [input.data];
        out.summaryRows.push(...rows);
        return { count: rows.length };
      },
    },
    evalResult: {
      deleteMany: del('evalResult'),
      findMany: async () => [...(args.existingResults ?? []), ...out.createdResults],
      create: async (input: any) => {
        const row = { id: randomUUID(), ...input.data };
        out.createdResults.push(row);
        return row;
      },
    },
    modelTarget: {
      findUniqueOrThrow: async () => target,
      findUnique: async () => target,
    },
    systemSetting: { findUnique: async () => null },
  } as unknown as PrismaLike;
  return out;
}

test('执行器：第 1 题答完后要求暂停，任务停在已暂停，不写引擎汇总', async () => {
  const qs = [1, 2, 3].map((i) => ({ id: randomUUID(), content: `题目${i}` }));
  const f = fakeDb({ questions: qs });
  let pause = false;
  let calls = 0;
  await runEvalTask(f.task.id as string, {
    prisma: f.db,
    isCancelRequested: async () => false,
    isPauseRequested: async () => pause,
    cancelPollIntervalMs: 0,
    callModel: async () => {
      calls += 1;
      return ok();
    },
    perQuestionEngines: [
      passEngine(() => {
        pause = true;
      }),
    ],
    taskLevelEngines: [],
    judgeTarget: null,
  });

  assert.equal(calls, 1);
  assert.equal(f.createdResults.length, 1);
  const last = f.updates.at(-1).data;
  assert.equal(last.status, 'PAUSED');
  assert.ok(last.pausedAt instanceof Date);
  assert.equal(last.processedQuestions, 1);
  assert.equal(last.passedCount, 1);
  assert.equal(last.pauseState.redTeamLaps, 0);
  assert.equal(last.pauseState.engineAccum['fake-pass'].judged, 1);
  assert.equal(f.summaryRows.length, 0, '暂停时不写引擎汇总');
  assert.equal(last.finishedAt, undefined);
});

test('执行器：接续时不清旧结果，只跑没答的题，计数和引擎累计接着算', async () => {
  const qs = [1, 2, 3].map((i) => ({ id: randomUUID(), content: `题目${i}` }));
  const startedAt = new Date('2026-11-21T00:00:00.000Z');
  const f = fakeDb({
    questions: qs,
    existingResults: [{ questionId: qs[0]!.id, side: null, finalVerdict: 'PASS' }],
    task: {
      status: 'PENDING',
      pausedAt: new Date('2026-11-21T00:05:00.000Z'),
      pauseState: {
        engineAccum: { 'fake-pass': { judged: 1, failed: 0, skipped: 0, lastError: null } },
        redTeamLaps: 0,
      },
      startedAt,
      totalQuestions: 3,
      processedQuestions: 1,
      passedCount: 1,
      failedCount: 0,
      errorCount: 0,
    },
  });
  const asked: string[] = [];
  await runEvalTask(f.task.id as string, {
    prisma: f.db,
    isCancelRequested: async () => false,
    isPauseRequested: async () => false,
    callModel: async (_cfg, messages) => {
      asked.push(String(messages.at(-1)?.content ?? ''));
      return ok();
    },
    perQuestionEngines: [passEngine()],
    taskLevelEngines: [],
    judgeTarget: null,
  });

  assert.equal(asked.length, 2);
  assert.ok(!asked.some((c) => c.includes('题目1')), '已答的题不重跑');
  assert.deepEqual(f.deleteCalls, [], '接续时不做幂等清理');
  const running = f.updates.find((u) => u.data.status === 'RUNNING').data;
  assert.equal(running.processedQuestions, undefined, '置执行中时不重置计数');
  assert.equal(running.startedAt.toISOString(), startedAt.toISOString(), '不重置开始时间');
  const last = f.updates.at(-1).data;
  assert.equal(last.status, 'COMPLETED');
  assert.equal(last.processedQuestions, 3);
  assert.equal(last.passedCount, 3);
  assert.equal(last.pausedAt, null);
  assert.equal(last.pauseState, Prisma.DbNull);
  const summary = f.summaryRows.find((r) => r.engine === 'fake-pass');
  assert.equal(summary.normalizedCount, 3, '引擎累计从暂停处接着算');
});

test('执行器：状态为已暂停时直接返回，不调模型', async () => {
  const f = fakeDb({
    questions: [{ id: randomUUID(), content: '题目' }],
    task: { status: 'PAUSED', pausedAt: new Date() },
  });
  let calls = 0;
  await runEvalTask(f.task.id as string, {
    prisma: f.db,
    isCancelRequested: async () => false,
    isPauseRequested: async () => false,
    callModel: async () => {
      calls += 1;
      return ok();
    },
    perQuestionEngines: [passEngine()],
    taskLevelEngines: [],
    judgeTarget: null,
  });
  assert.equal(calls, 0);
  assert.equal(f.updates.length, 0);
});

// ---- 审查修复：重复入队、计数口径、并发覆盖、红队局数、撤销暂停 ----

const slowDeps = (f: FakeDb, onCall: () => void) => ({
  prisma: f.db,
  isCancelRequested: async () => false,
  isPauseRequested: async () => false,
  callModel: async () => {
    onCall();
    await new Promise((r) => setTimeout(r, 5));
    return ok();
  },
  perQuestionEngines: [passEngine()],
  taskLevelEngines: [],
  judgeTarget: null,
});

test('执行器：同一任务被重复入队，只有一个作业能领取执行', async () => {
  const qs = [1, 2, 3].map((i) => ({ id: randomUUID(), content: `题目${i}` }));
  const f = fakeDb({ questions: qs });
  let calls = 0;
  await Promise.all([
    runEvalTask(
      f.task.id as string,
      slowDeps(f, () => (calls += 1)),
    ),
    runEvalTask(
      f.task.id as string,
      slowDeps(f, () => (calls += 1)),
    ),
  ]);
  assert.equal(calls, 3);
  assert.equal(f.createdResults.length, 3);
  assert.equal(f.task.status, 'COMPLETED');
});

test('执行器：已完成的任务再被残留作业执行，不做幂等清理也不重跑', async () => {
  const qs = [1, 2].map((i) => ({ id: randomUUID(), content: `题目${i}` }));
  const f = fakeDb({ questions: qs });
  let calls = 0;
  await runEvalTask(
    f.task.id as string,
    slowDeps(f, () => (calls += 1)),
  );
  assert.equal(f.task.status, 'COMPLETED');
  const deletesBefore = f.deleteCalls.length;
  await runEvalTask(
    f.task.id as string,
    slowDeps(f, () => (calls += 1)),
  );
  assert.equal(calls, 2);
  assert.equal(f.deleteCalls.length, deletesBefore, '没有再清理结果');
  assert.equal(f.task.status, 'COMPLETED');
});

test('执行器：执行器已看到暂停键、在途题还没做完时用户撤销了暂停，接着跑完，不停成已暂停', async () => {
  const qs = [1, 2, 3].map((i) => ({ id: randomUUID(), content: `题目${i}` }));
  const f = fakeDb({ questions: qs, task: { concurrency: 2 } });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let pause = false;
  let n = 0;
  await runEvalTask(f.task.id as string, {
    prisma: f.db,
    isCancelRequested: async () => false,
    isPauseRequested: async () => pause,
    cancelPollIntervalMs: 0,
    callModel: async () => {
      n += 1;
      if (n === 1) {
        // 第 1、2 题都在途；3ms 时用户点暂停，第 1 题做完后执行器看到暂停键
        await sleep(3);
        pause = true;
        await sleep(5);
        return ok();
      }
      if (n === 2) {
        // 第 2 题还在途：20ms 时用户点「恢复」撤销暂停，80ms 才做完
        await sleep(20);
        pause = false;
        await sleep(60);
        return ok();
      }
      return ok();
    },
    perQuestionEngines: [passEngine()],
    taskLevelEngines: [],
    judgeTarget: null,
  });
  assert.equal(n, 3, '第 3 题照常跑');
  assert.equal(f.task.status, 'COMPLETED');
  assert.ok(!f.updates.some((u) => u.data.status === 'PAUSED'));
});

test('执行器：暂停键残留但库里已没有暂停请求（已撤销），清键后接着跑完', async () => {
  const qs = [1, 2, 3].map((i) => ({ id: randomUUID(), content: `题目${i}` }));
  const f = fakeDb({ questions: qs, task: { pauseRequestedAt: null } });
  let calls = 0;
  await runEvalTask(f.task.id as string, {
    prisma: f.db,
    isCancelRequested: async () => false,
    isPauseRequested: async () => true,
    cancelPollIntervalMs: 0,
    callModel: async () => {
      calls += 1;
      return ok();
    },
    perQuestionEngines: [passEngine()],
    taskLevelEngines: [],
    judgeTarget: null,
  });
  assert.equal(calls, 3);
  assert.equal(f.task.status, 'COMPLETED');
});

test('停止：读到执行中、随后执行器把它停成了已暂停，按已暂停的路径停止（补结束时间、清暂停字段）', async () => {
  const id = await createTask('停止反向竞态', { status: 'RUNNING', pauseRequestedAt: new Date() });
  const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
  const stopped = await cancelEvalTaskById({ id: admin.id, username: admin.username }, id, async () => {
    // 写取消键的同时，执行器做完在途题、置为已暂停
    await prisma.evalTask.update({
      where: { id },
      data: {
        status: 'PAUSED',
        pausedAt: new Date(),
        pauseState: { engineAccum: {}, redTeamLaps: 0 },
        pauseRequestedAt: null,
      },
    });
  });
  assert.equal(stopped, true);
  const row = await prisma.evalTask.findUniqueOrThrow({ where: { id } });
  assert.equal(row.status, 'CANCELED');
  assert.ok(row.finishedAt instanceof Date, '补上结束时间');
  assert.equal(row.pausedAt, null);
  assert.equal(row.pauseState, null);
});

test('执行器：要暂停时任务已被停止，不会把已停止覆盖成已暂停', async () => {
  const qs = [1, 2, 3].map((i) => ({ id: randomUUID(), content: `题目${i}` }));
  const f = fakeDb({ questions: qs });
  let pause = false;
  await runEvalTask(f.task.id as string, {
    prisma: f.db,
    isCancelRequested: async () => false,
    isPauseRequested: async () => pause,
    cancelPollIntervalMs: 0,
    callModel: async () => ok(),
    perQuestionEngines: [
      passEngine(() => {
        pause = true;
        // 停止接口在执行器看到取消信号前已把状态改成已停止
        f.task.status = 'CANCELED';
      }),
    ],
    taskLevelEngines: [],
    judgeTarget: null,
  });
  assert.equal(f.task.status, 'CANCELED');
  assert.ok(!f.updates.some((u) => u.data.status === 'PAUSED'));
});

test('执行器：接续时计数按已有结果重算（双侧题取网关侧结论）', async () => {
  const qs = [1, 2, 3].map((i) => ({ id: randomUUID(), content: `题目${i}` }));
  const f = fakeDb({
    questions: qs,
    existingResults: [
      { questionId: qs[0]!.id, side: 'A', finalVerdict: 'PASS' },
      { questionId: qs[0]!.id, side: 'B', finalVerdict: 'FAIL' },
    ],
    task: {
      status: 'PENDING',
      pausedAt: new Date(),
      pauseState: { engineAccum: {}, redTeamLaps: 0 },
      startedAt: new Date(),
      // 任务上的计数和结果不一致（如软化成 ERROR 的题只计数不落结果）
      processedQuestions: 2,
      passedCount: 0,
      failedCount: 0,
      errorCount: 2,
    },
  });
  await runEvalTask(
    f.task.id as string,
    slowDeps(f, () => undefined),
  );
  const last = f.updates.at(-1).data;
  assert.equal(last.status, 'COMPLETED');
  assert.equal(last.processedQuestions, 3);
  assert.equal(last.failedCount, 1);
  assert.equal(last.passedCount, 2);
  assert.equal(last.errorCount, 0);
});

test('执行器：执行异常失败时清掉暂停字段', async () => {
  const qs = [{ id: randomUUID(), content: '题目' }];
  const f = fakeDb({
    questions: qs,
    task: {
      status: 'PENDING',
      pausedAt: new Date(),
      pauseState: { engineAccum: {}, redTeamLaps: 0 },
    },
  });
  (f.db as any).engineRun.createMany = async () => {
    throw new Error('库写入失败');
  };
  await runEvalTask(
    f.task.id as string,
    slowDeps(f, () => undefined),
  );
  assert.equal(f.task.status, 'FAILED');
  assert.equal(f.task.pausedAt, null);
  assert.equal(f.task.pauseState, Prisma.DbNull);
});

function redTeamHarness(
  maxLaps: number,
  taskOverrides: Record<string, unknown> = {},
  existing: string[] = [],
) {
  const targetId = randomUUID();
  const attackerTargetId = randomUUID();
  const now = new Date('2026-07-24T00:00:00.000Z');
  const target = {
    id: targetId,
    name: 'rt-target',
    targetType: 'MODEL',
    provider: 'openai-compatible',
    baseUrl: 'https://target.invalid/v1',
    apiKey: 'dummy', // pragma: allowlist secret
    model: 'target-model',
    extraHeaders: null,
    defaultParams: null,
    accessConfig: null,
  };
  const attacker = {
    ...target,
    id: attackerTargetId,
    name: 'rt-attacker',
    model: 'attacker-model',
  };
  const questions = [1, 2].map((n) => ({
    id: `q${n}`,
    content: `red team sample ${n}`,
    createdAt: new Date(now.getTime() + n),
    metadata: {
      kind: 'red_team',
      redteam: { attackerTargetId, gatewayTargetId: '', maxRounds: 1, noProgressK: 1 },
    },
    type: 'SHOULD_REFUSE',
    shouldRefuse: true,
    category: 'prompt_injection',
    expectedBehavior: null,
    referenceAnswer: null,
    severity: 'HIGH',
  }));
  const task: any = {
    id: randomUUID(),
    name: 'rt-task',
    status: 'PENDING',
    engines: ['llm-judge'],
    dimensions: ['redteam_attack'],
    concurrency: 1,
    modelTargetId: targetId,
    modelTarget: target,
    questionSets: [{ questionSetId: randomUUID() }],
    pausedAt: null,
    pauseState: null,
    ...taskOverrides,
  };
  const results: any[] = existing.map((questionId) => ({
    id: randomUUID(),
    questionId,
    side: null,
    finalVerdict: 'PASS',
  }));
  const db: any = {
    evalTask: {
      findUnique: async () => ({ ...task }),
      update: async (input: any) => {
        Object.assign(task, input.data);
        return { ...task };
      },
      updateMany: async (input: any) => {
        const want = input.where?.status;
        if (want !== undefined && task.status !== want) return { count: 0 };
        Object.assign(task, input.data);
        return { count: 1 };
      },
    },
    question: { findMany: async () => questions },
    wrongAnswer: { deleteMany: async () => ({ count: 0 }), create: async () => ({}) },
    finding: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async (i: any) => ({ count: i.data.length }),
    },
    engineRun: {
      deleteMany: async () => ({ count: 0 }),
      create: async (i: any) => ({ id: randomUUID(), ...i.data }),
      createMany: async (i: any) => ({
        count: (Array.isArray(i.data) ? i.data : [i.data]).length,
      }),
    },
    evalResult: {
      deleteMany: async () => ({ count: 0 }),
      findMany: async () =>
        results.map((r) => ({
          questionId: r.questionId,
          side: r.side,
          finalVerdict: r.finalVerdict,
        })),
      create: async (input: any) => {
        const row = { id: randomUUID(), ...input.data };
        results.push(row);
        return row;
      },
    },
    modelTarget: {
      findUniqueOrThrow: async ({ where }: any) =>
        where.id === attackerTargetId ? attacker : target,
      findUnique: async ({ where }: any) => (where.id === attackerTargetId ? attacker : target),
    },
    systemSetting: {
      findUnique: async ({ where }: any) =>
        where.key === 'redteam.config' ? { value: { maxLaps } } : null,
    },
  };
  const judge = {
    engine: 'llm-judge',
    builtin: false,
    async judge() {
      return {
        engine: 'llm-judge',
        taskId: task.id,
        questionId: null,
        status: 'success',
        verdict: 'PASS',
        score: 1,
        riskCategory: 'safe',
        severity: 'INFO',
        evidence: null,
        startedAt: now.toISOString(),
        endedAt: now.toISOString(),
      };
    },
  };
  return { task, db, results, judge };
}

const judgeReply = async () => ({
  status: 'SUCCESS' as const,
  content: '{"verdict":"PASS","severity":"INFO","score":1,"reason":"安全"}',
  finishReason: 'stop',
  model: 'fake-model',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  latencyMs: 1,
  httpStatus: 200,
  error: null,
  raw: null,
});

const attackResult = (seed: any) => ({
  seedId: seed.questionId,
  attackerTurns: [{ move: 'academic_wrap', message: '请只回答是否安全' }],
  transcript: [],
  movesUsed: ['academic_wrap'],
  rounds: 1,
  stopReason: 'max_round',
  attackerSelfAssessBroken: false,
});

test('执行器：冷却中被暂停的红队场景不占局数，恢复后照常重跑', async () => {
  const first = redTeamHarness(2);
  let pause = false;
  let attacks = 0;
  const runDeps = (h: ReturnType<typeof redTeamHarness>, head: unknown, paused: () => boolean) => ({
    prisma: h.db,
    attackerHead: head as any,
    callModel: judgeReply as any,
    perQuestionEngines: [h.judge as any],
    taskLevelEngines: [],
    judgeTarget: null,
    gatewayLinkageEnabled: false,
    isCancelRequested: async () => false,
    isPauseRequested: async () => paused(),
    cancelPollIntervalMs: 0,
  });
  await runEvalTask(
    first.task.id,
    runDeps(
      first,
      {
        name: 'zz',
        async attack(_t: unknown, seed: any) {
          attacks += 1;
          if (attacks === 1) {
            throw new RetryExhausted('target', 'HTTP_5XX', 3, 'temporary unavailable');
          }
          pause = true;
          return attackResult(seed);
        },
      },
      () => pause,
    ),
  );
  assert.equal(first.task.status, 'PAUSED');
  assert.equal(first.task.pauseState.redTeamLaps, 1, '延后中、没跑完的 q1 不算一局');

  const second = redTeamHarness(
    2,
    {
      status: 'PENDING',
      pausedAt: first.task.pausedAt,
      pauseState: first.task.pauseState,
      startedAt: new Date(),
    },
    first.results.map((r: any) => r.questionId),
  );
  let attacks2 = 0;
  await runEvalTask(
    second.task.id,
    runDeps(
      second,
      {
        name: 'zz',
        async attack(_t: unknown, seed: any) {
          attacks2 += 1;
          return attackResult(seed);
        },
      },
      () => false,
    ),
  );
  assert.equal(attacks2, 1, 'q1 恢复后重跑');
  assert.equal(second.task.status, 'COMPLETED');
  assert.equal(second.task.processedQuestions, 2);
});

test('撤销暂停：执行中且已请求暂停的任务点恢复，清掉暂停请求；序列化能看到「暂停中」', async () => {
  const id = await createTask('撤销暂停', { status: 'RUNNING' });
  const paused = await post(`/api/eval-tasks/${id}/pause`);
  assert.equal(paused.statusCode, 200, paused.body);
  const detail = await app.inject({ url: `/api/eval-tasks/${id}`, headers: bearer(tokens.admin) });
  assert.equal(detail.json().pauseRequested, true);
  const list = await app.inject({
    url: `/api/eval-tasks?pageSize=100&keyword=${encodeURIComponent(P + '撤销暂停')}`,
    headers: bearer(tokens.admin),
  });
  const row = list.json().items.find((t: { id: string }) => t.id === id);
  if (row) assert.equal(row.pauseRequested, true);

  const undo = await post(`/api/eval-tasks/${id}/resume`);
  assert.equal(undo.statusCode, 200, undo.body);
  assert.equal(undo.json().status, 'RUNNING');
  assert.equal(undo.json().pauseRequested, false);
  const after = await prisma.evalTask.findUniqueOrThrow({ where: { id } });
  assert.equal(after.pauseRequestedAt, null);
  // 没有暂停请求的执行中任务点恢复仍是 409
  assert.equal((await post(`/api/eval-tasks/${id}/resume`)).statusCode, 409);
});

test('网关核验写回的已暂停任务（没有暂停时间）不能从停止接口停掉', async () => {
  const id = await createTask('网关核验暂停', {
    status: 'PAUSED',
    engines: ['gateway-assurance'],
  });
  const res = await post(`/api/eval-tasks/${id}/cancel`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'PAUSED');
  const row = await prisma.evalTask.findUniqueOrThrow({ where: { id } });
  assert.equal(row.status, 'PAUSED');
});
