// 强制结束：终端已接收的任务不能远程中止，但终端管理员可以把它在平台上结束掉（force_closed），
// 让终端继续领后面的任务；之后终端回传的结果一律丢弃。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { FLEET_TARGET_PROVIDER } from '../src/modules/fleet-admin/service.js';
import { noopLimiter } from '../src/modules/fleet-agent/rate-limit.js';

const PREFIX = '__fleet_force_';
const PASSWORD = ['Fleet', 'Force', '123'].join('!');
let app: FastifyInstance;
let adminJwt = '';
let auditorJwt = '';
let auditorId = '';
let otherAuditorJwt = '';
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
  await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
}

async function makeUser(name: string, role: string) {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { name: role } });
  const user = await prisma.user.create({
    data: {
      username: `${PREFIX}${name}`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: name,
      isActive: true,
      roles: { create: { roleId: roleRow.id } },
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: user.username, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  return { id: user.id, jwt: login.json().token as string };
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
  // 审计员只有读取权限，没有终端管理权限。
  ({ id: auditorId, jwt: auditorJwt } = await makeUser('requester', 'auditor'));
  ({ jwt: otherAuditorJwt } = await makeUser('bystander', 'auditor'));
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
    payload: { product: 'codex', reason: `${PREFIX}强制结束` },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; publicId: string; evalTaskId: string };
}

/** 新建一个任务并放到「已下发 / 执行中」（刚领取，远没到回传期限）。 */
async function inFlight(name: string, status: 'DELIVERED' | 'RUNNING' = 'RUNNING') {
  const endpoint = await makeEndpoint(name);
  const created = await createJob(endpoint.id);
  const at = new Date(Date.now() - 60_000);
  const job = await prisma.fleetEvalJob.update({
    where: { id: created.id },
    data: { status, deliveredAt: at, startedAt: status === 'RUNNING' ? at : null },
  });
  await prisma.evalTask.update({
    where: { id: job.evalTaskId! },
    data: {
      status: 'RUNNING',
      description: status === 'RUNNING' ? '终端正在执行' : '终端已接收任务',
    },
  });
  return { endpoint, job, taskId: job.evalTaskId! };
}

const cancel = (jobId: string, jwt: string, payload?: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/api/fleet/eval-jobs/${jobId}/cancel`,
    headers: bearer(jwt),
    ...(payload === undefined ? {} : { payload }),
  });
const agent = (token: string, method: 'GET' | 'POST', path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/agent/v1${path}`,
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const jobRow = (id: string) => prisma.fleetEvalJob.findUniqueOrThrow({ where: { id } });
const taskRow = (id: string) => prisma.evalTask.findUniqueOrThrow({ where: { id } });

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

/** 评估任务的同步有一段是结果回传后的异步钩子，等它落到终态。 */
async function settledTask(taskId: string) {
  for (let i = 0; i < 100; i += 1) {
    const task = await taskRow(taskId);
    if (task.status !== 'RUNNING' && task.status !== 'PENDING') return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return taskRow(taskId);
}

test('终端管理员带 force 结束执行中的任务：置为失败 force_closed，评估任务同步，审计留痕', async () => {
  const { job, taskId } = await inFlight('running');

  const res = await cancel(job.id, adminJwt, { force: true });

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'FAILED');
  assert.equal(res.json().errorCode, 'force_closed');
  assert.match(res.json().errorReason, /已强制结束/);
  const row = await jobRow(job.id);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.errorCode, 'force_closed');
  assert.ok(row.finishedAt);
  const task = await taskRow(taskId);
  assert.equal(task.status, 'FAILED');
  assert.match(task.description ?? '', /已强制结束/);
  assert.ok(!(task.description ?? '').includes('force_closed'), '评估任务描述不出现内部错误码');
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'fleet.eval_job.cancel', targetId: job.id },
  });
  assert.equal((audit?.detail as { force?: boolean } | null)?.force, true);
});

test('已下发还没开始的任务同样可以强制结束', async () => {
  const { job, taskId } = await inFlight('delivered', 'DELIVERED');

  const res = await cancel(job.id, adminJwt, { force: true });

  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await jobRow(job.id)).errorCode, 'force_closed');
  assert.equal((await taskRow(taskId)).status, 'FAILED');
});

test('不带 force 维持现状：执行中的任务不能取消，库里不变', async () => {
  const { job } = await inFlight('no-force');

  const plain = await cancel(job.id, adminJwt);
  const explicit = await cancel(job.id, adminJwt, { force: false });

  for (const res of [plain, explicit]) {
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error.code, 'FLEET_JOB_NOT_CANCELLABLE');
  }
  assert.equal((await jobRow(job.id)).status, 'RUNNING');
});

test('没有终端管理权限的申请人带 force 也维持现状；既不是申请人也没有权限的人 403', async () => {
  const { job, taskId } = await inFlight('permission');
  await prisma.fleetEvalJob.update({ where: { id: job.id }, data: { requestedById: auditorId } });

  const requester = await cancel(job.id, auditorJwt, { force: true });
  const bystander = await cancel(job.id, otherAuditorJwt, { force: true });

  assert.equal(requester.statusCode, 409, requester.body);
  assert.equal(requester.json().error.code, 'FLEET_JOB_NOT_CANCELLABLE');
  assert.equal(bystander.statusCode, 403, bystander.body);
  const row = await jobRow(job.id);
  assert.equal(row.status, 'RUNNING');
  assert.equal(row.errorCode, null);
  assert.equal((await taskRow(taskId)).status, 'RUNNING');
});

test('force 不改变其他状态的行为：排队中仍是普通取消，已结束的不能再结束', async () => {
  const endpoint = await makeEndpoint('other-states');
  const queued = await createJob(endpoint.id);

  const cancelled = await cancel(queued.id, adminJwt, { force: true });
  const again = await cancel(queued.id, adminJwt, { force: true });

  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().status, 'CANCELLED');
  assert.equal((await jobRow(queued.id)).errorCode, null);
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().error.code, 'FLEET_JOB_STATE');
});

test('force 必须是布尔值', async () => {
  const { job } = await inFlight('bad-body');

  const res = await cancel(job.id, adminJwt, { force: 'yes' });

  assert.equal(res.statusCode, 400, res.body);
  assert.equal((await jobRow(job.id)).status, 'RUNNING');
});

test('强制结束之后终端回传结果：409，任务和评估任务都不再改动', async () => {
  const { endpoint, job, taskId } = await inFlight('late-result');
  assert.equal((await cancel(job.id, adminJwt, { force: true })).statusCode, 200);
  const before = await jobRow(job.id);
  const taskBefore = await taskRow(taskId);

  const res = await agent(endpoint.token, 'POST', `/eval-jobs/${job.publicId}/result`, resultFor(job));

  assert.equal(res.statusCode, 409, res.body);
  const row = await jobRow(job.id);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.errorCode, 'force_closed');
  assert.equal(row.result, null);
  assert.equal(row.updatedAt.getTime(), before.updatedAt.getTime());
  const task = await taskRow(taskId);
  assert.equal(task.status, 'FAILED');
  assert.equal(task.updatedAt.getTime(), taskBefore.updatedAt.getTime());
});

test('强制结束之后同一终端能领到下一个排队任务', async () => {
  const { endpoint, job } = await inFlight('next-job');
  assert.deepEqual((await agent(endpoint.token, 'GET', '/eval-jobs')).json(), []);
  assert.equal((await cancel(job.id, adminJwt, { force: true })).statusCode, 200);
  const next = await createJob(endpoint.id);

  const res = await agent(endpoint.token, 'GET', '/eval-jobs');

  assert.deepEqual(
    res.json().map((j: { job_id: string }) => j.job_id),
    [next.publicId],
  );
});

test('并发：强制结束与终端回传结果同时到达，只有一个生效', async () => {
  const winners = new Set<string>();
  for (let round = 0; round < 6; round += 1) {
    const { endpoint, job, taskId } = await inFlight(`race-${round}`);
    const body = resultFor(job);
    // 交替先后顺序，尽量两种胜负都出现；无论谁赢，结论都必须自洽。
    const calls = [
      () => cancel(job.id, adminJwt, { force: true }),
      () => agent(endpoint.token, 'POST', `/eval-jobs/${job.publicId}/result`, body),
    ];
    const [first, second] = round % 2 ? [calls[1]!, calls[0]!] : [calls[0]!, calls[1]!];
    const [a, b] = await Promise.all([first(), second()]);
    const [force, result] = round % 2 ? [b, a] : [a, b];

    assert.deepEqual(
      [force.statusCode, result.statusCode].sort(),
      [200, 409],
      `第 ${round} 轮：强制结束 ${force.statusCode}，回传 ${result.statusCode}`,
    );
    const row = await jobRow(job.id);
    const task = await settledTask(taskId);
    if (force.statusCode === 200) {
      winners.add('force');
      assert.equal(row.status, 'FAILED');
      assert.equal(row.errorCode, 'force_closed');
      assert.equal(row.result, null, '被丢弃的结果不入库');
      assert.equal(task.status, 'FAILED');
    } else {
      winners.add('result');
      assert.equal(row.status, 'COMPLETED');
      assert.equal(row.errorCode, null);
      assert.ok(row.result);
      assert.equal(task.status, 'COMPLETED');
    }
  }
  assert.ok(winners.size >= 1);
});

test('并发：同一个任务被两次强制结束，只有一次成功', async () => {
  const { job, taskId } = await inFlight('double');

  const responses = await Promise.all([
    cancel(job.id, adminJwt, { force: true }),
    cancel(job.id, adminJwt, { force: true }),
  ]);

  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal((await jobRow(job.id)).errorCode, 'force_closed');
  assert.equal(
    await prisma.evalTaskLog.count({
      where: { taskId, message: '终端测评状态', context: { path: ['status'], equals: 'failed' } },
    }),
    1,
  );
});

// ---------- 评估任务同步失败不能挡住强制结束 ----------

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

test('评估任务同步失败时强制结束仍然生效：任务置为失败，终端能领到下一个任务，之后回传 409', async () => {
  const { endpoint, job, taskId } = await inFlight('sync-broken');
  await breakTaskSync(taskId);

  const res = await cancel(job.id, adminJwt, { force: true });

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'FAILED');
  assert.equal(res.json().errorCode, 'force_closed');
  const row = await jobRow(job.id);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.errorCode, 'force_closed');
  assert.ok(row.finishedAt);
  const next = await createJob(endpoint.id);
  assert.deepEqual(
    (await agent(endpoint.token, 'GET', '/eval-jobs')).json().map((j: { job_id: string }) => j.job_id),
    [next.publicId],
  );
  const late = await agent(endpoint.token, 'POST', `/eval-jobs/${job.publicId}/result`, resultFor(job));
  assert.equal(late.statusCode, 409, late.body);
  assert.equal((await jobRow(job.id)).result, null);
});

test('评估任务同步失败时并发两次强制结束，仍只有一次成功', async () => {
  const { job, taskId } = await inFlight('sync-broken-double');
  await breakTaskSync(taskId);

  const responses = await Promise.all([
    cancel(job.id, adminJwt, { force: true }),
    cancel(job.id, adminJwt, { force: true }),
  ]);

  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal((await jobRow(job.id)).errorCode, 'force_closed');
});

test('评估任务同步失败时，不带 force 的取消和无权限的人仍按原样被拒绝', async () => {
  const { job, taskId } = await inFlight('sync-broken-guard');
  await breakTaskSync(taskId);

  const plain = await cancel(job.id, adminJwt);
  const bystander = await cancel(job.id, otherAuditorJwt, { force: true });

  assert.equal(plain.statusCode, 409, plain.body);
  assert.equal(plain.json().error.code, 'FLEET_JOB_NOT_CANCELLABLE');
  assert.equal(bystander.statusCode, 403, bystander.body);
  assert.equal((await jobRow(job.id)).status, 'RUNNING');
});
