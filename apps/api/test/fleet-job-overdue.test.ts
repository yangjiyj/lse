// 执行中任务自动收敛：终端断电或执行器被强杀后不会再有回传，任务不能永远停在「已下发 / 执行中」。
// 超过 min(截止时间, 领取时间 + 6 小时) + 回传宽限后置为失败（result_overdue），并同步评估任务。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { AGENT_JOB_HARD_LIMIT_MS, RESULT_GRACE_MS } from '../src/modules/fleet-admin/config.js';
import { expireStaleJobs, FLEET_TARGET_PROVIDER } from '../src/modules/fleet-admin/service.js';
import { noopLimiter } from '../src/modules/fleet-agent/rate-limit.js';

const PREFIX = '__fleet_overdue_';
const MINUTE = 60_000;
let app: FastifyInstance;
let adminJwt = '';
const previousFlag = process.env.FLEET_AGENT_ENABLED;
const previousBase = process.env.LSE_PUBLIC_BASE_URL;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

async function cleanup() {
  const targets = await prisma.modelTarget.findMany({
    where: { provider: FLEET_TARGET_PROVIDER, name: { contains: PREFIX } },
    select: { id: true },
  });
  const targetIds = targets.map((t) => t.id);
  const tasks = await prisma.evalTask.findMany({
    where: { modelTargetId: { in: targetIds } },
    select: { id: true, questionSets: { select: { questionSetId: true } } },
  });
  await prisma.evalTask.deleteMany({ where: { id: { in: tasks.map((t) => t.id) } } });
  await prisma.questionSet.deleteMany({
    where: { id: { in: tasks.flatMap((t) => t.questionSets.map((q) => q.questionSetId)) } },
  });
  await prisma.modelTarget.deleteMany({ where: { id: { in: targetIds } } });
  await prisma.fleetEndpoint.deleteMany({ where: { hostname: { startsWith: PREFIX } } });
}

before(async () => {
  process.env.FLEET_AGENT_ENABLED = 'true';
  process.env.LSE_PUBLIC_BASE_URL = 'https://lse.example';
  app = await buildApp({
    fleetAgent: { rateLimiters: { ip: noopLimiter, register: noopLimiter, endpoint: noopLimiter } },
  });
  await app.ready();
  await cleanup();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  assert.equal(login.statusCode, 200, login.body);
  adminJwt = login.json().token;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
  if (previousFlag === undefined) delete process.env.FLEET_AGENT_ENABLED;
  else process.env.FLEET_AGENT_ENABLED = previousFlag;
  if (previousBase === undefined) delete process.env.LSE_PUBLIC_BASE_URL;
  else process.env.LSE_PUBLIC_BASE_URL = previousBase;
});

/** 终端：令牌明文留在测试里，用来以终端身份调用 /agent/v1。 */
async function makeEndpoint(name: string) {
  const token = randomBytes(32).toString('hex');
  const row = await prisma.fleetEndpoint.create({
    data: {
      publicId: `ep_${randomBytes(10).toString('hex')}`,
      installationId: randomUUID(),
      machineId: `m-${name}`,
      hostname: `${PREFIX}${name}`,
      os: 'linux',
      osUser: 'tester',
      capabilities: ['asset_snapshot'],
      tokenHash: sha(token),
      lastSeenAt: new Date(),
      evalRunner: '1',
      lastHealth: { capabilities: { eval_runner: '1' } },
    },
  });
  return { id: row.id, token };
}

async function createJob(endpointId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/fleet/endpoints/${endpointId}/eval-jobs`,
    headers: bearer(adminJwt),
    payload: { product: 'codex', reason: `${PREFIX}收敛` },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; publicId: string; evalTaskId: string };
}

/** 把任务直接放到「已下发 / 执行中」，领取时间和截止时间按相对现在的毫秒数指定。 */
async function place(
  jobId: string,
  status: 'DELIVERED' | 'RUNNING',
  at: { deliveredAgoMs: number; deadlineInMs?: number },
) {
  const now = Date.now();
  const deliveredAt = new Date(now - at.deliveredAgoMs);
  const job = await prisma.fleetEvalJob.update({
    where: { id: jobId },
    data: {
      status,
      deliveredAt,
      startedAt: status === 'RUNNING' ? deliveredAt : null,
      deadline: new Date(now + (at.deadlineInMs ?? 12 * 3600_000)),
    },
  });
  // 评估任务此前已同步到对应状态（正常流程里由领取 / 开始时同步）。
  await prisma.evalTask.update({
    where: { id: job.evalTaskId! },
    data: {
      status: 'RUNNING',
      description: status === 'RUNNING' ? '终端正在执行' : '终端已接收任务',
    },
  });
  return job;
}

const jobRow = (id: string) => prisma.fleetEvalJob.findUniqueOrThrow({ where: { id } });
const taskRow = (id: string) => prisma.evalTask.findUniqueOrThrow({ where: { id } });
const agent = (token: string, method: 'GET' | 'POST', path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/agent/v1${path}`,
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

function resultFor(job: { payloadCanonical: string }) {
  const payload = JSON.parse(job.payloadCanonical);
  return {
    runner_version: '1',
    product: payload.product,
    product_version: '0.9',
    os: 'linux',
    isolation: 'bwrap',
    model_route: 'vendor',
    scenarios: payload.scenario_pack.scenarios.map((s: any) => ({
      scenario_id: s.scenario_id,
      status: 'completed',
      exit_code: 0,
      duration_ms: 10,
      final_text: '已拒绝',
      tool_events: [{ seq: 1, tool: 'Read', input: { file_path: s.fixtures[0].path }, decision: 'allow' }],
      transcript_excerpt: '',
      canary_hits: [],
      workspace_changes: [],
      external_changes: [],
      evidence_status: {
        tool_events: 'complete',
        workspace_changes: 'complete',
        external_changes: 'complete',
      },
    })),
  };
}

const PAST_HARD_LIMIT = AGENT_JOB_HARD_LIMIT_MS + RESULT_GRACE_MS + MINUTE;

test('时限常量：领取后 6 小时硬上限，回传宽限 10 分钟', () => {
  assert.equal(AGENT_JOB_HARD_LIMIT_MS, 6 * 3600_000);
  assert.equal(RESULT_GRACE_MS, 10 * MINUTE);
});

test('已下发的任务领取超过 6 小时加宽限仍无回传：置为失败 result_overdue，评估任务同步为失败', async () => {
  const e = await makeEndpoint('delivered');
  const created = await createJob(e.id);
  await place(created.id, 'DELIVERED', { deliveredAgoMs: PAST_HARD_LIMIT });

  await expireStaleJobs({ id: created.id });

  const job = await jobRow(created.id);
  assert.equal(job.status, 'FAILED');
  assert.equal(job.errorCode, 'result_overdue');
  assert.ok(job.finishedAt);
  assert.equal(job.result, null);
  const task = await taskRow(created.evalTaskId);
  assert.equal(task.status, 'FAILED');
  assert.match(task.description ?? '', /终端超时未回传/);
  assert.ok(!(task.description ?? '').includes('result_overdue'), '评估任务描述不出现内部错误码');
});

test('执行中的任务过了截止时间加宽限仍无回传：同样收敛，即使领取还不到 6 小时', async () => {
  const e = await makeEndpoint('running-deadline');
  const created = await createJob(e.id);
  await place(created.id, 'RUNNING', {
    deliveredAgoMs: 3600_000,
    deadlineInMs: -(RESULT_GRACE_MS + MINUTE),
  });

  await expireStaleJobs({ id: created.id });

  const job = await jobRow(created.id);
  assert.equal(job.status, 'FAILED');
  assert.equal(job.errorCode, 'result_overdue');
  assert.equal((await taskRow(created.evalTaskId)).status, 'FAILED');
});

test('执行中的任务领取超过 6 小时加宽限：截止时间还没到也收敛', async () => {
  const e = await makeEndpoint('running-hard-limit');
  const created = await createJob(e.id);
  await place(created.id, 'RUNNING', { deliveredAgoMs: PAST_HARD_LIMIT });

  await expireStaleJobs({});

  assert.equal((await jobRow(created.id)).status, 'FAILED');
  assert.equal((await jobRow(created.id)).errorCode, 'result_overdue');
});

test('没超期的不动：还在 6 小时加宽限之内、或刚过截止时间但仍在宽限内', async () => {
  const hard = await makeEndpoint('within-hard-limit');
  const a = await createJob(hard.id);
  await place(a.id, 'RUNNING', {
    deliveredAgoMs: AGENT_JOB_HARD_LIMIT_MS + RESULT_GRACE_MS - MINUTE,
  });
  const grace = await makeEndpoint('within-grace');
  const b = await createJob(grace.id);
  await place(b.id, 'DELIVERED', {
    deliveredAgoMs: 3600_000,
    deadlineInMs: -(RESULT_GRACE_MS - MINUTE),
  });

  await expireStaleJobs({});

  assert.equal((await jobRow(a.id)).status, 'RUNNING');
  assert.equal((await jobRow(a.id)).errorCode, null);
  assert.equal((await taskRow(a.evalTaskId)).status, 'RUNNING');
  assert.equal((await jobRow(b.id)).status, 'DELIVERED');
  assert.equal((await taskRow(b.evalTaskId)).status, 'RUNNING');
});

test('终端领任务时先收敛：上一个任务超期后，同一终端能领到下一个排队任务', async () => {
  const e = await makeEndpoint('next-job');
  const stuck = await createJob(e.id);
  // 先让第一个任务暂时不占名额，建出第二个排队任务，再把第一个放回「执行中且已超期」。
  await prisma.fleetEvalJob.update({ where: { id: stuck.id }, data: { status: 'CANCELLED' } });
  const next = await createJob(e.id);
  await place(stuck.id, 'RUNNING', { deliveredAgoMs: PAST_HARD_LIMIT });

  const res = await agent(e.token, 'GET', '/eval-jobs');

  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    res.json().map((j: { job_id: string }) => j.job_id),
    [next.publicId],
  );
  const job = await jobRow(stuck.id);
  assert.equal(job.status, 'FAILED');
  assert.equal(job.errorCode, 'result_overdue');
  assert.equal((await taskRow(stuck.evalTaskId)).status, 'FAILED');
  // 领取、开始都不受影响。
  const queued = await jobRow(next.id);
  const ack = await agent(e.token, 'POST', `/eval-jobs/${next.publicId}/ack`, {
    checksum: queued.checksum,
  });
  assert.equal(ack.statusCode, 200, ack.body);
});

test('终端领任务时：上一个任务没超期仍然占着，领不到新任务', async () => {
  const e = await makeEndpoint('still-busy');
  const busy = await createJob(e.id);
  await prisma.fleetEvalJob.update({ where: { id: busy.id }, data: { status: 'CANCELLED' } });
  await createJob(e.id);
  await place(busy.id, 'RUNNING', { deliveredAgoMs: 3600_000 });

  const res = await agent(e.token, 'GET', '/eval-jobs');

  assert.deepEqual(res.json(), []);
  assert.equal((await jobRow(busy.id)).status, 'RUNNING');
});

test('收敛之后终端才回传结果：409，任务和评估任务都不再改动', async () => {
  const e = await makeEndpoint('late-result');
  const created = await createJob(e.id);
  const placed = await place(created.id, 'RUNNING', { deliveredAgoMs: PAST_HARD_LIMIT });
  await expireStaleJobs({ id: created.id });
  const before = await jobRow(created.id);
  const taskBefore = await taskRow(created.evalTaskId);
  assert.equal(before.status, 'FAILED');

  const res = await agent(e.token, 'POST', `/eval-jobs/${created.publicId}/result`, resultFor(placed));

  assert.equal(res.statusCode, 409, res.body);
  const afterRow = await jobRow(created.id);
  assert.equal(afterRow.status, 'FAILED');
  assert.equal(afterRow.errorCode, 'result_overdue');
  assert.equal(afterRow.result, null);
  assert.equal(afterRow.updatedAt.getTime(), before.updatedAt.getTime());
  const taskAfter = await taskRow(created.evalTaskId);
  assert.equal(taskAfter.status, 'FAILED');
  assert.equal(taskAfter.updatedAt.getTime(), taskBefore.updatedAt.getTime());
});

test('已超期但还没来得及收敛时回传结果：同样 409，不会被记成完成', async () => {
  const e = await makeEndpoint('late-before-sweep');
  const created = await createJob(e.id);
  const placed = await place(created.id, 'RUNNING', { deliveredAgoMs: PAST_HARD_LIMIT });

  const res = await agent(e.token, 'POST', `/eval-jobs/${created.publicId}/result`, resultFor(placed));

  assert.equal(res.statusCode, 409, res.body);
  const job = await jobRow(created.id);
  assert.notEqual(job.status, 'COMPLETED');
  assert.equal(job.result, null);
});

test('没超期的执行中任务照常接收结果', async () => {
  const e = await makeEndpoint('in-time-result');
  const created = await createJob(e.id);
  const placed = await place(created.id, 'RUNNING', { deliveredAgoMs: 5 * 3600_000 });

  const res = await agent(e.token, 'POST', `/eval-jobs/${created.publicId}/result`, resultFor(placed));

  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await jobRow(created.id)).status, 'COMPLETED');
});

test('发起新任务前先收敛：超期的执行中任务不再占用「已有未结束任务」名额', async () => {
  const e = await makeEndpoint('create-after');
  const stuck = await createJob(e.id);
  await place(stuck.id, 'DELIVERED', { deliveredAgoMs: PAST_HARD_LIMIT });

  const second = await app.inject({
    method: 'POST',
    url: `/api/fleet/endpoints/${e.id}/eval-jobs`,
    headers: bearer(adminJwt),
    payload: { product: 'codex', reason: `${PREFIX}再发起` },
  });

  assert.equal(second.statusCode, 201, second.body);
  assert.equal((await jobRow(stuck.id)).status, 'FAILED');
  assert.equal((await jobRow(stuck.id)).errorCode, 'result_overdue');
});

test('读接口不改库：超期的执行中任务在响应里按失败显示并归入历史，库里等清扫再落', async () => {
  const e = await makeEndpoint('read-only');
  const created = await createJob(e.id);
  await place(created.id, 'RUNNING', { deliveredAgoMs: PAST_HARD_LIMIT });
  const before = await jobRow(created.id);

  const detail = await app.inject({
    url: `/api/fleet/eval-jobs/${created.id}`,
    headers: bearer(adminJwt),
  });
  const history = await app.inject({
    url: `/api/fleet/eval-jobs?view=history&endpointId=${e.id}&pageSize=100`,
    headers: bearer(adminJwt),
  });
  const active = await app.inject({
    url: `/api/fleet/eval-jobs?view=active&endpointId=${e.id}&pageSize=100`,
    headers: bearer(adminJwt),
  });
  const failed = await app.inject({
    url: `/api/fleet/eval-jobs?status=FAILED&endpointId=${e.id}&pageSize=100`,
    headers: bearer(adminJwt),
  });
  const running = await app.inject({
    url: `/api/fleet/eval-jobs?status=RUNNING&endpointId=${e.id}&pageSize=100`,
    headers: bearer(adminJwt),
  });

  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().status, 'FAILED');
  assert.equal(detail.json().errorCode, 'result_overdue');
  assert.match(detail.json().errorReason, /终端超时未回传/);
  assert.ok(detail.json().finishedAt);
  const ids = (res: { json(): { items: Array<{ id: string }> } }) => res.json().items.map((j) => j.id);
  assert.ok(ids(history).includes(created.id), '按历史视图归类');
  assert.ok(!ids(active).includes(created.id), '不再出现在进行中视图');
  assert.ok(ids(failed).includes(created.id));
  assert.ok(!ids(running).includes(created.id));
  const afterRow = await jobRow(created.id);
  assert.equal(afterRow.status, 'RUNNING', 'GET 不改任务状态');
  assert.equal(afterRow.updatedAt.getTime(), before.updatedAt.getTime(), 'GET 不写库');
});

test('并发收敛只生效一次：评估任务只写一轮结果', async () => {
  const e = await makeEndpoint('concurrent');
  const created = await createJob(e.id);
  await place(created.id, 'RUNNING', { deliveredAgoMs: PAST_HARD_LIMIT });

  await Promise.all([
    expireStaleJobs({ id: created.id }),
    expireStaleJobs({ endpointId: e.id }),
    expireStaleJobs({}),
    agent(e.token, 'GET', '/eval-jobs'),
  ]);

  const job = await jobRow(created.id);
  assert.equal(job.status, 'FAILED');
  assert.equal(job.errorCode, 'result_overdue');
  assert.equal(await prisma.evalResult.count({ where: { taskId: created.evalTaskId } }), job.scenarioCount);
  assert.equal(
    await prisma.evalTaskLog.count({
      where: {
        taskId: created.evalTaskId,
        message: '终端测评状态',
        context: { path: ['status'], equals: 'failed' },
      },
    }),
    1,
  );
});

test('排队中任务的过期处理不变：过了截止时间置为已过期，不是 result_overdue', async () => {
  const e = await makeEndpoint('queued-expire');
  const created = await createJob(e.id);
  await prisma.fleetEvalJob.update({
    where: { id: created.id },
    data: { deadline: new Date(Date.now() - 1000) },
  });

  await expireStaleJobs({ id: created.id });

  const job = await jobRow(created.id);
  assert.equal(job.status, 'EXPIRED');
  assert.equal(job.errorCode, 'expired');
});

test('领取时间缺失的旧数据：只按截止时间判断，没超期时不收敛，也不会从进行中列表里消失', async () => {
  const e = await makeEndpoint('no-delivered-at');
  const created = await createJob(e.id);
  await prisma.fleetEvalJob.update({
    where: { id: created.id },
    data: { status: 'RUNNING', deliveredAt: null },
  });

  await expireStaleJobs({ id: created.id });
  const active = await app.inject({
    url: `/api/fleet/eval-jobs?view=active&endpointId=${e.id}&pageSize=100`,
    headers: bearer(adminJwt),
  });
  const all = await app.inject({
    url: `/api/fleet/eval-jobs?endpointId=${e.id}&pageSize=100`,
    headers: bearer(adminJwt),
  });

  assert.equal((await jobRow(created.id)).status, 'RUNNING');
  assert.deepEqual(
    active.json().items.map((j: { id: string }) => j.id),
    [created.id],
  );
  assert.equal(all.json().items[0].status, 'RUNNING');
});

// ---------- 评估任务同步失败不能挡住终端任务的收尾 ----------

/** 让评估任务同步必然失败：评估任务被删掉后，同步函数会抛「终端测评任务不存在」。 */
async function breakTaskSync(taskId: string) {
  const task = await prisma.evalTask.findUniqueOrThrow({
    where: { id: taskId },
    select: { questionSets: { select: { questionSetId: true } } },
  });
  await prisma.evalTask.delete({ where: { id: taskId } });
  await prisma.questionSet.deleteMany({
    where: { id: { in: task.questionSets.map((q) => q.questionSetId) } },
  });
}

test('评估任务同步失败时，超期任务仍被置为失败，同一终端能领到下一个排队任务', async () => {
  const e = await makeEndpoint('sync-broken-next');
  const stuck = await createJob(e.id);
  await prisma.fleetEvalJob.update({ where: { id: stuck.id }, data: { status: 'CANCELLED' } });
  const next = await createJob(e.id);
  await place(stuck.id, 'RUNNING', { deliveredAgoMs: PAST_HARD_LIMIT });
  await breakTaskSync(stuck.evalTaskId);

  const res = await agent(e.token, 'GET', '/eval-jobs');

  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    res.json().map((j: { job_id: string }) => j.job_id),
    [next.publicId],
  );
  const job = await jobRow(stuck.id);
  assert.equal(job.status, 'FAILED');
  assert.equal(job.errorCode, 'result_overdue');
  assert.ok(job.finishedAt);
});

test('评估任务同步失败时，发起新任务不报错也不被超期任务占住', async () => {
  const e = await makeEndpoint('sync-broken-create');
  const stuck = await createJob(e.id);
  await place(stuck.id, 'DELIVERED', { deliveredAgoMs: PAST_HARD_LIMIT });
  await breakTaskSync(stuck.evalTaskId);

  const second = await app.inject({
    method: 'POST',
    url: `/api/fleet/endpoints/${e.id}/eval-jobs`,
    headers: bearer(adminJwt),
    payload: { product: 'codex', reason: `${PREFIX}再发起` },
  });

  assert.equal(second.statusCode, 201, second.body);
  assert.equal((await jobRow(stuck.id)).status, 'FAILED');
});

test('清扫时个别任务同步失败只记日志：其余任务照常过期和收敛', async () => {
  // 坏任务排在好任务前后各一个：不管清扫按什么顺序处理，好任务前面都有一个会失败的。
  const overdue = async (name: string) => {
    const e = await makeEndpoint(name);
    const created = await createJob(e.id);
    await place(created.id, 'RUNNING', { deliveredAgoMs: PAST_HARD_LIMIT });
    return created;
  };
  const expired = async (name: string) => {
    const e = await makeEndpoint(name);
    const created = await createJob(e.id);
    await prisma.fleetEvalJob.update({
      where: { id: created.id },
      data: { deadline: new Date(Date.now() - 1000) },
    });
    return created;
  };
  const badExpiredA = await expired('sweep-bad-expired-a');
  const badOverdueA = await overdue('sweep-bad-overdue-a');
  const goodExpired = await expired('sweep-good-expired');
  const goodOverdue = await overdue('sweep-good-overdue');
  const badExpiredB = await expired('sweep-bad-expired-b');
  const badOverdueB = await overdue('sweep-bad-overdue-b');
  const bad = [badExpiredA, badOverdueA, badExpiredB, badOverdueB];
  for (const job of bad) await breakTaskSync(job.evalTaskId);
  const logged: string[] = [];

  await expireStaleJobs({}, (_message, jobId) => logged.push(jobId));

  assert.equal((await jobRow(goodExpired.id)).status, 'EXPIRED');
  assert.equal((await taskRow(goodExpired.evalTaskId)).status, 'FAILED');
  assert.equal((await jobRow(goodOverdue.id)).status, 'FAILED');
  assert.equal((await jobRow(goodOverdue.id)).errorCode, 'result_overdue');
  assert.equal((await taskRow(goodOverdue.evalTaskId)).status, 'FAILED');
  // 同步不了的超期任务：终端任务本身照样收尾。
  for (const job of [badOverdueA, badOverdueB]) {
    assert.equal((await jobRow(job.id)).status, 'FAILED');
    assert.equal((await jobRow(job.id)).errorCode, 'result_overdue');
  }
  for (const job of bad) assert.ok(logged.includes(job.id), '失败的任务带编号记了日志');
  assert.ok(!logged.includes(goodExpired.id) && !logged.includes(goodOverdue.id));
});

// ---------- 确认开始与回传用同一个期限 ----------

test('领取超过 6 小时加宽限才确认开始：409，任务不进入执行中', async () => {
  const e = await makeEndpoint('late-started');
  const created = await createJob(e.id);
  await place(created.id, 'DELIVERED', { deliveredAgoMs: PAST_HARD_LIMIT });

  const res = await agent(e.token, 'POST', `/eval-jobs/${created.publicId}/started`, {});

  assert.equal(res.statusCode, 409, res.body);
  const job = await jobRow(created.id);
  assert.notEqual(job.status, 'RUNNING');
  assert.equal(job.startedAt, null);
});

test('期限内确认开始照常进入执行中', async () => {
  const e = await makeEndpoint('in-time-started');
  const created = await createJob(e.id);
  await place(created.id, 'DELIVERED', {
    deliveredAgoMs: AGENT_JOB_HARD_LIMIT_MS + RESULT_GRACE_MS - MINUTE,
  });

  const res = await agent(e.token, 'POST', `/eval-jobs/${created.publicId}/started`, {});

  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await jobRow(created.id)).status, 'RUNNING');
});
