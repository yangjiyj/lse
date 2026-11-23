import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import {
  pendingReviewFindingWhere,
  reviewStatusFindingWhere,
} from '../src/modules/dashboard/review-scope.js';

// 首页「待复核」、我的待办合计、风险处置台默认列表必须是同一个数：
// reviewStatus ∈ {UNREVIEWED, NEEDS_REVIEW}，且排除来自失败/已取消任务的条目。
const PREFIX = `__review_scope_${randomUUID().slice(0, 8)}_`;
let app!: FastifyInstance;
let token = '';
let adminToken = '';
let userId = '';
let roleId = '';
let targetId = '';
const taskIds: Record<string, string> = {};

async function makeTask(label: string, status: 'COMPLETED' | 'FAILED' | 'CANCELED' | 'RUNNING') {
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}${label}`,
      modelTargetId: targetId,
      engines: [],
      dimensions: [],
      status,
    },
  });
  taskIds[label] = task.id;
  return task.id;
}

async function makeFinding(
  taskId: string,
  reviewStatus: 'UNREVIEWED' | 'NEEDS_REVIEW' | 'CONFIRMED' | 'FALSE_POSITIVE',
  severity: 'HIGH' | 'MEDIUM' | 'INFO' = 'MEDIUM',
  title = '样本风险',
) {
  const result = await prisma.evalResult.create({
    data: {
      taskId,
      questionId: (await ensureQuestion()).id,
      modelTargetId: targetId,
      prompt: 'p',
      response: 'r',
      finalVerdict: 'FAIL',
    },
  });
  const finding = await prisma.finding.create({
    data: {
      taskId,
      resultId: result.id,
      questionId: result.questionId,
      engine: 'rule-judge',
      riskCategory: 'test',
      severity,
      verdict: 'FAIL',
      reviewStatus,
      title,
    },
  });
  await prisma.wrongAnswer.create({
    data: {
      taskId,
      resultId: result.id,
      questionId: result.questionId,
      questionContent: `${PREFIX}${title}`,
      severity,
      verdict: 'FAIL',
      riskCategory: 'test',
      engine: 'rule-judge',
      reason: 'r',
    },
  });
  return finding.id;
}

let questionId = '';
async function ensureQuestion() {
  if (!questionId) {
    const set = await prisma.questionSet.create({
      data: { name: `${PREFIX}set`, type: 'GENERAL' },
    });
    const q = await prisma.question.create({
      data: { questionSetId: set.id, content: `${PREFIX}q`, type: 'GENERAL', severity: 'HIGH' },
    });
    questionId = q.id;
  }
  return { id: questionId };
}

async function cleanup() {
  const tasks = await prisma.evalTask.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = tasks.map((t) => t.id);
  if (ids.length) {
    await prisma.wrongAnswer.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.finding.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.evalResult.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.evalTask.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.question.deleteMany({ where: { content: `${PREFIX}q` } });
  await prisma.questionSet.deleteMany({ where: { name: `${PREFIX}set` } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

const get = (url: string, jwt = token) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${jwt}` } });

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const codes = ['eval_task:read', 'remediation:read', 'model_target:read', 'wrong_answer:export'];
  for (const code of codes) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, name: code, group: '测试' },
      update: {},
    });
  }
  const role = await prisma.role.create({
    data: {
      name: `${PREFIX}role`,
      permissions: { create: codes.map((code) => ({ permission: { connect: { code } } })) },
    },
  });
  roleId = role.id;
  const user = await prisma.user.create({
    data: {
      username: `${PREFIX}user`.slice(0, 60),
      passwordHash: 'test-only',
      displayName: 'review scope',
      roles: { create: { roleId: role.id } },
    },
  });
  userId = user.id;
  token = app.jwt.sign({ sub: user.id, username: user.username });
  adminToken = (
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
    })
  ).json().token;

  const target = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}target`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-only',
      model: 'test-model',
      lastTestStatus: 'SUCCESS',
    },
  });
  targetId = target.id;

  // 正常完成的任务：3 条待复核（2 未复核 + 1 待人工复核）、1 条已确认
  const done = await makeTask('done', 'COMPLETED');
  await makeFinding(done, 'UNREVIEWED', 'HIGH', 'A');
  await makeFinding(done, 'UNREVIEWED', 'MEDIUM', 'B');
  await makeFinding(done, 'NEEDS_REVIEW', 'MEDIUM', 'C');
  await makeFinding(done, 'CONFIRMED', 'HIGH', 'D');
  // 运行中任务：也算（已有结果可以先复核）
  const running = await makeTask('running', 'RUNNING');
  await makeFinding(running, 'UNREVIEWED', 'MEDIUM', 'E');
  // 失败 / 已取消任务（被驳回、没有执行）：待复核项必须被排除
  const failed = await makeTask('failed', 'FAILED');
  await makeFinding(failed, 'UNREVIEWED', 'INFO', 'F');
  await makeFinding(failed, 'UNREVIEWED', 'INFO', 'G');
  const canceled = await makeTask('canceled', 'CANCELED');
  await makeFinding(canceled, 'NEEDS_REVIEW', 'INFO', 'H');
});

after(async () => {
  await cleanup();
  await prisma.auditLog.deleteMany({ where: { actorId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.role.deleteMany({ where: { id: roleId } });
  await app.close();
  await prisma.$disconnect();
});

test('待复核口径：排除失败/已取消任务，保留已完成与运行中任务', async () => {
  const rows = await prisma.finding.findMany({
    where: { AND: [pendingReviewFindingWhere(), { task: { name: { startsWith: PREFIX } } }] },
    select: { title: true },
  });
  assert.deepEqual(rows.map((r) => r.title).sort(), ['A', 'B', 'C', 'E']);
});

test('reviewStatusFindingWhere：待复核状态同样排除失败任务，已确认等状态不受限', async () => {
  const pending = await prisma.finding.findMany({
    where: {
      AND: [
        reviewStatusFindingWhere(['UNREVIEWED', 'NEEDS_REVIEW']),
        { task: { name: { startsWith: PREFIX } } },
      ],
    },
    select: { title: true },
  });
  assert.equal(pending.length, 4);
  const mixed = await prisma.finding.findMany({
    where: {
      AND: [
        reviewStatusFindingWhere(['NEEDS_REVIEW', 'CONFIRMED']),
        { task: { name: { startsWith: PREFIX } } },
      ],
    },
    select: { title: true },
  });
  assert.deepEqual(mixed.map((r) => r.title).sort(), ['C', 'D']);
});

test('首页待复核、我的待办合计、风险处置台默认列表三处是同一个数', async () => {
  const todos = (await get('/api/dashboard/todos')).json();
  const posture = (await get('/api/dashboard/posture?range=all')).json();
  const wrong = await get('/api/wrong-answers?reviewStatus=pending&pageSize=1');
  assert.equal(wrong.statusCode, 200, wrong.body);
  const expected = await prisma.finding.count({ where: pendingReviewFindingWhere() });
  assert.equal(todos.review.count, expected);
  assert.equal(posture.facts.pendingReviewTotal, expected);
  assert.equal(posture.facts.pendingReview, expected, 'range=all 时本期待复核等于全库口径');
  // 风险处置台按「待复核」筛选的条数：一个待复核风险项一行，与上面同一个数。
  assert.equal(wrong.json().total, expected);
  // 按任务过滤：已完成任务有 3 条待复核。
  const mine = await get(
    `/api/wrong-answers?reviewStatus=pending&pageSize=200&taskId=${taskIds.done}`,
  );
  assert.equal(mine.json().total, 3);
});

test('风险处置台未传 reviewStatus 时不改变原有范围（含失败任务的样本）', async () => {
  const all = await get(`/api/wrong-answers?taskId=${taskIds.failed}&pageSize=50`);
  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.json().total, 2);
  const pending = await get(`/api/wrong-answers?taskId=${taskIds.failed}&reviewStatus=pending`);
  assert.equal(pending.json().total, 0, '失败任务的样本不进待复核列表');
});

test('待复核列表的行 id 唯一（同一结果下多个风险项不会撞 id）', async () => {
  const result = await prisma.evalResult.findFirstOrThrow({ where: { taskId: taskIds.done } });
  // 同一结果、同一引擎、同一类别再来一个风险项：共用一条样本快照
  await prisma.finding.create({
    data: {
      taskId: taskIds.done!,
      resultId: result.id,
      questionId: result.questionId,
      engine: 'rule-judge',
      riskCategory: 'test',
      severity: 'MEDIUM',
      verdict: 'FAIL',
      reviewStatus: 'UNREVIEWED',
      title: 'DUP',
    },
  });
  const res = await get(
    `/api/wrong-answers?taskId=${taskIds.done}&reviewStatus=pending&pageSize=200`,
  );
  assert.equal(res.statusCode, 200, res.body);
  const ids = (res.json().items as Array<{ id: string }>).map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, '行 id 不重复');
  assert.equal(ids.length, res.json().total);
  await prisma.finding.deleteMany({ where: { title: 'DUP', taskId: taskIds.done } });
});

test('reviewStatus 非法值返回 400；支持逗号多选具体状态', async () => {
  const bad = await get('/api/wrong-answers?reviewStatus=BOGUS');
  assert.equal(bad.statusCode, 400, bad.body);
  const confirmed = await get(
    `/api/wrong-answers?taskId=${taskIds.done}&reviewStatus=CONFIRMED,NEEDS_REVIEW`,
  );
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().total, 2);
});

test('风险处置台默认排序：严重度高在前，同级时间新在前', async () => {
  const res = await get(`/api/wrong-answers?taskId=${taskIds.done}&pageSize=50`);
  assert.equal(res.statusCode, 200, res.body);
  const items = res.json().items as Array<{ severity: string; createdAt: string }>;
  const rank: Record<string, number> = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };
  for (let i = 1; i < items.length; i += 1) {
    const prev = items[i - 1]!;
    const cur = items[i]!;
    const a = rank[prev.severity] ?? 0;
    const b = rank[cur.severity] ?? 0;
    assert.ok(a > b || (a === b && prev.createdAt >= cur.createdAt), '排序违规');
  }
  assert.equal(items[0]!.severity, 'HIGH');
});

test('我的待办：按任务分组，每个任务的数量是真实待复核数，不被截断', async () => {
  // 给已完成任务再补足 12 条，超过原先 take:10 的截断
  for (let i = 0; i < 12; i += 1) await makeFinding(taskIds.done!, 'UNREVIEWED', 'MEDIUM', `X${i}`);
  const body = (await get('/api/dashboard/todos')).json();
  assert.ok(Array.isArray(body.review.tasks), '返回按任务分组的待复核');
  const group = body.review.tasks.find((t: { taskId: string }) => t.taskId === taskIds.done);
  assert.ok(group, '已完成任务出现在分组里');
  assert.equal(group.count, 15, '真实数 = 3 + 12，而不是截断后的数');
  assert.equal(group.topSeverity, 'HIGH');
  assert.equal(group.taskName, `${PREFIX}done`);
  assert.ok(
    !body.review.tasks.some((t: { taskId: string }) => t.taskId === taskIds.failed),
    '失败任务不出现在待办里',
  );
  const sum = body.review.tasks.reduce((a: number, t: { count: number }) => a + t.count, 0);
  assert.equal(sum, body.review.count, '各任务数量之和等于待复核合计');
  assert.ok(Array.isArray(body.review.items), '旧字段 items 保持兼容');
});

test('我的待办：列出全部有待复核的任务并可分页（taskPage / taskPageSize）', async () => {
  const first = (await get('/api/dashboard/todos?reviewTaskPage=1&reviewTaskPageSize=1')).json();
  assert.equal(first.review.tasks.length, 1);
  assert.ok(first.review.taskTotal >= 2, '至少有已完成与运行中两个任务');
  const second = (await get('/api/dashboard/todos?reviewTaskPage=2&reviewTaskPageSize=1')).json();
  assert.equal(second.review.tasks.length, 1);
  assert.notEqual(first.review.tasks[0].taskId, second.review.tasks[0].taskId);
  const all = (await get('/api/dashboard/todos?reviewTaskPageSize=200')).json();
  assert.equal(all.review.tasks.length, all.review.taskTotal);
});

test('打开我的待办/首页不再写审计 dashboard.todos.read，登录审计仍保留', async () => {
  const before = await prisma.auditLog.count({
    where: { actorId: userId, action: 'dashboard.todos.read' },
  });
  const res = await get('/api/dashboard/todos');
  assert.equal(res.statusCode, 200, res.body);
  const after = await prisma.auditLog.count({
    where: { actorId: userId, action: 'dashboard.todos.read' },
  });
  assert.equal(after, before, '读待办不写审计');
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  assert.equal(login.statusCode, 200);
  const loginAudits = await prisma.auditLog.count({ where: { action: 'auth.login' } });
  assert.ok(loginAudits > 0, '登录审计保留');
  void adminToken;
});
