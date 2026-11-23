import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { finalizeFleetJob, installFleetFinishHook } from '../src/modules/fleet-admin/finish.js';
import { FLEET_TARGET_PROVIDER } from '../src/modules/fleet-admin/service.js';
import { sampleReport } from './fleet-admin-fixtures.js';
import { AgentShieldClient } from '../src/modules/endpoint-evals/agentshield-client.js';
import { ALL_SAMPLES } from '../src/modules/endpoint-evals/samples/registry.js';

const PREFIX = '__fleet_admin_';
const PASSWORD = ['Fleet', 'Adm', '123'].join('!');
let app: FastifyInstance;
let adminJwt = '';
let operatorJwt = '';
let auditorJwt = '';
let nobodyJwt = '';
let adminId = '';
let operatorId = '';
let tmp = '';
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('removed endpoints must be revoked and retain their historical records', async () => {
  const endpoint = await makeEndpoint('remove-history');
  const report = await prisma.fleetProbeReport.create({ data: {
    endpointId: endpoint.id, reportId: randomUUID(), scannedAt: new Date(), status: 'ok',
    assetCount: 0, bodyHash: sha('history'), body: {},
  } });
  const base = '/api/fleet/endpoints';
  const active = await app.inject({ method: 'DELETE', url: `${base}/${endpoint.id}`, headers: bearer(adminJwt) });
  assert.equal(active.statusCode, 409, active.body);
  const revoked = await app.inject({ method: 'POST', url: `${base}/${endpoint.id}/revoke`, headers: bearer(adminJwt) });
  assert.equal(revoked.statusCode, 200, revoked.body);
  const forbidden = await app.inject({ method: 'DELETE', url: `${base}/${endpoint.id}`, headers: bearer(auditorJwt) });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  const removed = await app.inject({ method: 'DELETE', url: `${base}/${endpoint.id}`, headers: bearer(adminJwt) });
  assert.equal(removed.statusCode, 200, removed.body);
  const list = await app.inject({ method: 'GET', url: `${base}?q=${encodeURIComponent(endpoint.hostname)}`, headers: bearer(adminJwt) });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().items.length, 0);
  assert.ok(await prisma.fleetEndpoint.findUnique({ where: { id: endpoint.id } }));
  assert.ok(await prisma.fleetProbeReport.findUnique({ where: { id: report.id } }));
});

async function cleanup() {
  await prisma.agentSample.deleteMany({ where: { id: { in: ['custom-record-check', 'custom-import-check'] }, source: 'custom' } });
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
  await prisma.fleetEnrollmentCode.deleteMany({ where: { label: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
}

async function makeUser(name: string, role: string | null) {
  const roleRow = role ? await prisma.role.findUniqueOrThrow({ where: { name: role } }) : null;
  const user = await prisma.user.create({
    data: {
      username: `${PREFIX}${name}`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: name,
      isActive: true,
      ...(roleRow ? { roles: { create: { roleId: roleRow.id } } } : {}),
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

async function makeEndpoint(
  name: string,
  opts: { lastSeenAt?: Date | null; evalRunner?: string | null; health?: unknown } = {},
) {
  return prisma.fleetEndpoint.create({
    data: {
      publicId: `ep_${randomBytes(10).toString('hex')}`,
      installationId: randomUUID(),
      machineId: `m-${name}`,
      hostname: `${PREFIX}${name}`,
      os: 'linux',
      osUser: 'tester',
      capabilities: ['asset_snapshot'],
      tokenHash: sha(randomBytes(16).toString('hex')),
      lastSeenAt: opts.lastSeenAt === undefined ? new Date() : opts.lastSeenAt,
      evalRunner: opts.evalRunner === undefined ? '1' : opts.evalRunner,
      lastHealth: (opts.health ?? {
        queue_events: 0,
        capabilities: { eval_runner: '1' },
        collector: { last_error: '', assets_observed: 3, secret_token: 'should-not-leak' },
      }) as object,
    },
  });
}

before(async () => {
  process.env.FLEET_AGENT_ENABLED = 'true';
  process.env.LSE_PUBLIC_BASE_URL = 'https://lse.example';
  app = await buildApp();
  await app.ready();
  await cleanup();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  assert.equal(login.statusCode, 200, login.body);
  adminJwt = login.json().token;
  adminId = (await app.inject({ url: '/api/auth/me', headers: bearer(adminJwt) })).json().user.id;
  ({ id: operatorId, jwt: operatorJwt } = await makeUser('operator', 'operator'));
  ({ jwt: auditorJwt } = await makeUser('auditor', 'auditor'));
  ({ jwt: nobodyJwt } = await makeUser('nobody', null));
  tmp = mkdtempSync(join(tmpdir(), 'fleet-admin-'));
});

after(async () => {
  await cleanup();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  await app.close();
  await prisma.$disconnect();
});

test('开关关闭 404；未登录 401；无权限 403', async () => {
  process.env.FLEET_AGENT_ENABLED = 'false';
  assert.equal(
    (await app.inject({ url: '/api/fleet/endpoints', headers: bearer(adminJwt) })).statusCode,
    404,
  );
  process.env.FLEET_AGENT_ENABLED = 'true';
  assert.equal((await app.inject({ url: '/api/fleet/endpoints' })).statusCode, 401);
  assert.equal(
    (await app.inject({ url: '/api/fleet/endpoints', headers: bearer(nobodyJwt) })).statusCode,
    403,
  );
  // 审计员只读：能看清单，不能管理接入码。
  assert.equal(
    (await app.inject({ url: '/api/fleet/endpoints', headers: bearer(auditorJwt) })).statusCode,
    200,
  );
  const create = await app.inject({
    method: 'POST',
    url: '/api/fleet/enrollment-codes',
    headers: bearer(auditorJwt),
    payload: { label: `${PREFIX}x` },
  });
  assert.equal(create.statusCode, 403);
  assert.equal(
    (await app.inject({ url: '/api/fleet/enrollment-codes', headers: bearer(auditorJwt) }))
      .statusCode,
    403,
  );
});

test('接入码：明文只返回一次、列表无明文、校验范围、撤销与过期状态', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/fleet/enrollment-codes',
    headers: bearer(adminJwt),
    payload: { label: `${PREFIX}批次一`, expiresInHours: 48, maxUses: 5 },
  });
  assert.equal(res.statusCode, 201, res.body);
  const { code, item } = res.json();
  assert.match(code, /^jdc_[A-Za-z0-9_-]{43}$/);
  assert.equal(item.codePrefix, code.slice(0, 8));
  assert.equal(item.status, 'ACTIVE');
  assert.equal(item.maxUses, 5);
  const row = await prisma.fleetEnrollmentCode.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(row.codeHash, sha(code));
  assert.ok(Math.abs(row.expiresAt.getTime() - Date.now() - 48 * 3600_000) < 60_000);

  const list = await app.inject({ url: '/api/fleet/enrollment-codes', headers: bearer(adminJwt) });
  assert.equal(list.statusCode, 200);
  assert.ok(!list.body.includes(code), '列表不得含明文');
  assert.ok(!list.body.includes(row.codeHash), '列表不得含哈希');
  assert.ok(!list.body.includes('codeHash'));
  assert.ok(list.json().items.some((c: { id: string }) => c.id === item.id));

  for (const bad of [{ expiresInHours: 169 }, { maxUses: 0 }, { maxUses: 1001 }, { label: '' }])
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/fleet/enrollment-codes',
          headers: bearer(adminJwt),
          payload: { label: `${PREFIX}bad`, ...bad },
        })
      ).statusCode,
      400,
    );

  const audit = await prisma.auditLog.findFirst({
    where: { action: 'fleet.enrollment_code.create', targetId: item.id },
  });
  assert.ok(audit);
  assert.ok(!JSON.stringify(audit.detail).includes(code), '审计不记明文');

  const revoked = await app.inject({
    method: 'POST',
    url: `/api/fleet/enrollment-codes/${item.id}/revoke`,
    headers: bearer(adminJwt),
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.json().status, 'REVOKED');

  const expired = await prisma.fleetEnrollmentCode.create({
    data: {
      label: `${PREFIX}过期`,
      codeHash: sha(randomBytes(8).toString('hex')),
      codePrefix: 'jdc_xxxx',
      expiresAt: new Date(Date.now() - 1000),
    },
  });
  const expiredList = await app.inject({
    url: '/api/fleet/enrollment-codes?status=EXPIRED',
    headers: bearer(adminJwt),
  });
  const found = expiredList.json().items.find((c: { id: string }) => c.id === expired.id);
  assert.equal(found?.status, 'EXPIRED');
});

test('终端清单：在线判断、搜索、无敏感字段；详情 health 脱敏、agents/platform 字段', async () => {
  const online = await makeEndpoint('online', {
    health: {
      capabilities: { eval_runner: '1' },
      agents: [{ product: 'codex', version: '0.9', headless_capable: true }, { product: 'other' }],
      collector: { last_error: '', secret_token: 'should-not-leak' },
    },
  });
  const offline = await makeEndpoint('offline', { lastSeenAt: new Date(Date.now() - 11 * 60_000) });
  await prisma.fleetProbeReport.create({
    data: {
      endpointId: online.id,
      reportId: `pr_${randomBytes(32).toString('hex')}`,
      scannedAt: new Date(),
      status: 'complete',
      assetCount: 1,
      bodyHash: 'h',
      body: sampleReport(),
    },
  });
  const list = await app.inject({
    url: `/api/fleet/endpoints?q=${PREFIX}&pageSize=100`,
    headers: bearer(auditorJwt),
  });
  assert.equal(list.statusCode, 200, list.body);
  const items = list.json().items as Array<Record<string, any>>;
  const on = items.find((e) => e.id === online.id)!;
  const off = items.find((e) => e.id === offline.id)!;
  assert.equal(on.online, true);
  assert.equal(off.online, false);
  assert.equal(on.platform, 'jiandun');
  assert.deepEqual(on.agents, [
    {
      product: 'codex',
      displayName: 'Codex',
      version: '0.9',
      headlessCapable: true,
      liveEvalSupported: true,
      liveEvalRegistered: false,
      scripted: false,
      runtimeV2: false,
      liveEvalBlockedReason:
        '终端尚未上报该智能体的测评登记情况，请更新探针并上报登记及可运行状态。',
    },
    {
      product: 'other',
      displayName: '未识别的智能体',
      version: null,
      headlessCapable: false,
      liveEvalSupported: false,
      liveEvalRegistered: false,
      scripted: false,
      runtimeV2: false,
      liveEvalBlockedReason: '平台暂不支持运行该智能体的真机测评。',
    },
  ]);
  assert.deepEqual(off.agents, [], 'health 无智能体信息时返回空数组');
  assert.equal(on.latestReport.assetCount, 1);
  for (const key of ['tokenHash', 'lastHealth', 'body', 'should-not-leak', online.tokenHash])
    assert.ok(!list.body.includes(key), `列表不应含 ${key}`);

  const onlyOnline = await app.inject({
    url: `/api/fleet/endpoints?q=${PREFIX}&online=online&pageSize=100`,
    headers: bearer(adminJwt),
  });
  const ids = onlyOnline.json().items.map((e: { id: string }) => e.id);
  assert.ok(ids.includes(online.id) && !ids.includes(offline.id));

  const detail = await app.inject({
    url: `/api/fleet/endpoints/${online.id}`,
    headers: bearer(adminJwt),
  });
  assert.equal(detail.statusCode, 200);
  const d = detail.json();
  assert.equal(d.platform, 'jiandun');
  assert.deepEqual(d.agents, on.agents, '详情和列表均使用当前心跳清单');
  assert.equal(d.health.capabilities.eval_runner, '1');
  assert.ok(!detail.body.includes('should-not-leak'), 'health 摘要只挑白名单字段');
  assert.ok(!detail.body.includes('tokenHash'));
  assert.equal(d.latestReportSummary.assetsByKind.cli_agent, 1);
  assert.ok(!detail.body.includes('"assets":['), '详情不回显报告正文');
});

test('配置体检：无报告 409 中文提示；有报告创建已完成 EvalTask 与风险项', async () => {
  const bare = await makeEndpoint('noreport');
  const none = await app.inject({
    method: 'POST',
    url: `/api/fleet/endpoints/${bare.id}/posture-eval`,
    headers: bearer(adminJwt),
  });
  assert.equal(none.statusCode, 409);
  assert.equal(none.json().error.code, 'FLEET_NO_PROBE_REPORT');
  assert.match(none.json().error.message, /还没有上报配置体检数据/);
  assert.equal(
    (
      await app.inject({
        url: `/api/fleet/endpoints/${bare.id}/posture`,
        headers: bearer(adminJwt),
      })
    ).statusCode,
    409,
  );

  const e = await makeEndpoint('posture');
  await prisma.fleetProbeReport.create({
    data: {
      endpointId: e.id,
      reportId: `pr_${randomBytes(32).toString('hex')}`,
      scannedAt: new Date(),
      status: 'complete',
      assetCount: 1,
      bodyHash: 'h',
      body: sampleReport({ bypass: true }),
    },
  });
  const view = await app.inject({
    url: `/api/fleet/endpoints/${e.id}/posture`,
    headers: bearer(auditorJwt),
  });
  assert.equal(view.statusCode, 200);
  assert.equal(view.json().findings.find((f: any) => f.ruleId === 'permissions').verdict, 'FAIL');
  // 审计员无发起权限。
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/fleet/endpoints/${e.id}/posture-eval`,
        headers: bearer(auditorJwt),
      })
    ).statusCode,
    403,
  );
  const res = await app.inject({
    method: 'POST',
    url: `/api/fleet/endpoints/${e.id}/posture-eval`,
    headers: bearer(adminJwt),
  });
  assert.equal(res.statusCode, 201, res.body);
  const task = await prisma.evalTask.findUniqueOrThrow({
    where: { id: res.json().taskId },
    include: { modelTarget: true, results: true, findings: true },
  });
  assert.equal(task.status, 'COMPLETED');
  assert.equal(task.modelTarget.targetType, 'ENDPOINT_AGENT');
  assert.equal(task.results.length, 19);
  assert.ok(task.findings.some((f) => f.title === '权限确认边界' && f.verdict === 'FAIL'));
  // 没有实际判定（终端未上报、UNKNOWN）的规则不建 finding，也不进待复核。
  const unknownResults = task.results.filter((r) => r.finalVerdict === 'UNKNOWN').length;
  assert.equal(task.findings.length, task.results.length - unknownResults);
  assert.ok(task.findings.every((f) => f.verdict === 'PASS' || f.verdict === 'FAIL'));
  // 同一终端再次体检复用同一个评估对象。
  const again = await app.inject({
    method: 'POST',
    url: `/api/fleet/endpoints/${e.id}/posture-eval`,
    headers: bearer(adminJwt),
  });
  const task2 = await prisma.evalTask.findUniqueOrThrow({ where: { id: again.json().taskId } });
  assert.equal(task2.modelTargetId, task.modelTargetId);
  // 体检任务出现在评估任务列表里。
  const tasks = await app.inject({ url: `/api/eval-tasks/${task.id}`, headers: bearer(adminJwt) });
  assert.equal(tasks.statusCode, 200, tasks.body);
});

async function createJob(endpointId: string, jwt = adminJwt, product = 'codex') {
  return app.inject({
    method: 'POST',
    url: `/api/fleet/endpoints/${endpointId}/eval-jobs`,
    headers: bearer(jwt),
    payload: { product, reason: `${PREFIX}季度复测` },
  });
}

test('任务列表返回发起时间、样本数和运行环境', async () => {
  const endpoint = await makeEndpoint('job-list-metadata');
  const created = await createJob(endpoint.id);
  assert.equal(created.statusCode, 201, created.body);
  const response = await app.inject({ url: `/api/fleet/eval-jobs?endpointId=${endpoint.id}`, headers: bearer(auditorJwt) });
  assert.equal(response.statusCode, 200, response.body);
  const job = response.json().items[0];
  assert.ok(job.createdAt);
  assert.equal(job.suite, 'classic');
  assert.equal(job.sampleCount, job.scenarioCount);
});

/** 把任务退回「待审批」：模拟升级前库里遗留的 PENDING_APPROVAL 旧任务（审批接口仍需兼容）。 */
async function makeLegacyPending(jobId: string) {
  const job = await prisma.fleetEvalJob.update({
    where: { id: jobId },
    data: { status: 'PENDING_APPROVAL', approvedById: null, approvedAt: null },
  });
  await prisma.evalTask.update({
    where: { id: job.evalTaskId! },
    data: { status: 'PENDING', description: '等待终端审批' },
  });
  return job;
}

test('创建测评任务：各种拒绝条件', async () => {
  const offline = await makeEndpoint('job-offline', {
    lastSeenAt: new Date(Date.now() - 25 * 3600_000),
  });
  let r = await createJob(offline.id);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error.code, 'FLEET_ENDPOINT_OFFLINE');

  const noRunner = await makeEndpoint('job-norunner', { evalRunner: null });
  r = await createJob(noRunner.id);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error.code, 'FLEET_EVAL_RUNNER_UNAVAILABLE');

  const ok = await makeEndpoint('job-ok');
  assert.equal((await createJob(ok.id, adminJwt, 'cursor')).statusCode, 400, '不支持的产品');
  r = await createJob(ok.id);
  assert.equal(r.statusCode, 201, r.body);
  r = await createJob(ok.id);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error.code, 'FLEET_JOB_IN_PROGRESS');

  const revoked = await makeEndpoint('job-revoked');
  await prisma.fleetEndpoint.update({ where: { id: revoked.id }, data: { status: 'REVOKED' } });
  r = await createJob(revoked.id);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error.code, 'FLEET_ENDPOINT_REVOKED');
});

test('创建任务：payload 固化、checksum、EvalTask 等待终端领取、绑定不被 AgentShield 轮询触及', async () => {
  const e = await makeEndpoint('job-shape');
  const r = await createJob(e.id);
  assert.equal(r.statusCode, 201, r.body);
  const body = r.json();
  assert.match(body.publicId, /^lej_[0-9a-f]{32}$/);
  assert.equal(body.status, 'QUEUED', '管理员发起即进入待终端领取，不再经过审批');
  assert.equal(body.requestedBy.id, adminId, 'requestedBy.id 与 /api/auth/me 同一 ID 空间');
  assert.equal(body.approvedBy.id, adminId, '审批人记为发起人本人');
  assert.ok(body.approvedAt);
  const job = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: body.id } });
  assert.equal(job.checksum, sha(job.payloadCanonical));
  const payload = JSON.parse(job.payloadCanonical);
  assert.deepEqual(Object.keys(payload), ['product', 'scenario_pack', 'sink_base_url']);
  assert.match(payload.sink_base_url, /^https:\/\/lse\.example\/sink\/[0-9a-f]{48}$/);
  assert.equal(job.scenarioCount, payload.scenario_pack.scenarios.length);
  assert.ok(Math.abs(job.deadline.getTime() - Date.now() - 24 * 3600_000) < 60_000);
  const task = await prisma.evalTask.findUniqueOrThrow({
    where: { id: job.evalTaskId! },
    include: { logs: true },
  });
  assert.equal(task.description, '等待终端领取');
  assert.ok(!(task.description ?? '').includes('审批'), 'EvalTask 描述不再出现审批');
  assert.equal(task.status, 'PENDING');
  const binding = task.logs.find((l) => l.message === '终端测评任务绑定')!.context as any;
  assert.equal(binding.jobId, '');
  assert.equal(binding.source, 'fleet');
  assert.equal(binding.fleetJobId, job.publicId);
  assert.ok(payload.sink_base_url.endsWith(binding.runToken));

  // 诱饵落点沿用 /sink/<runToken>/exfil 机制：命中记录到该任务。
  process.env.LSE_ENDPOINT_EVAL_ENABLED = 'true';
  const canary = payload.scenario_pack.scenarios[0].canaries[0];
  const hit = await app.inject({ url: `/sink/${binding.runToken}/exfil?d=${canary}` });
  assert.equal(hit.statusCode, 200);
  assert.equal(
    await prisma.evalTaskLog.count({ where: { taskId: task.id, message: '终端诱饵接收' } }),
    1,
  );

  // 详情给审批人看场景标题和提示词，但不含诱饵值、落点令牌和 canonical 原文。
  const detail = await app.inject({
    url: `/api/fleet/eval-jobs/${job.id}`,
    headers: bearer(auditorJwt),
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().scenarios.length, job.scenarioCount);
  assert.ok(!detail.body.includes(canary));
  assert.ok(!detail.body.includes(binding.runToken));
  assert.ok(!detail.body.includes('payloadCanonical'));
});

test('创建即 QUEUED：发起人记为审批人、reason 可选、同步的 EvalTask 不再写待审批', async () => {
  const e = await makeEndpoint('queued');
  // 不带 reason：缺省「管理员发起」。
  const noReason = await app.inject({
    method: 'POST',
    url: `/api/fleet/endpoints/${e.id}/eval-jobs`,
    headers: bearer(adminJwt),
    payload: { product: 'codex' },
  });
  assert.equal(noReason.statusCode, 201, noReason.body);
  const body = noReason.json();
  assert.equal(body.status, 'QUEUED');
  assert.equal(body.reason, '管理员发起');
  assert.equal(body.approvedBy.id, adminId);
  const row = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: body.id } });
  assert.equal(row.status, 'QUEUED');
  assert.equal(row.approvedById, adminId);
  assert.ok(row.approvedAt && Math.abs(row.approvedAt.getTime() - Date.now()) < 60_000);
  assert.equal(row.requestedById, adminId);
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: body.evalTaskId } });
  assert.ok(!(task.description ?? '').includes('审批'), task.description ?? '');
  assert.equal(task.description, '等待终端领取');
  // 审计照记。
  assert.ok(
    await prisma.auditLog.findFirst({
      where: { action: 'fleet.eval_job.create', targetId: body.id },
    }),
  );
  // 备注超长仍然拒绝；空白备注视同缺省。
  const long = await app.inject({
    method: 'POST',
    url: `/api/fleet/endpoints/${e.id}/eval-jobs`,
    headers: bearer(adminJwt),
    payload: { product: 'codex', reason: 'x'.repeat(501) },
  });
  assert.equal(long.statusCode, 400);
  await app.inject({
    method: 'POST',
    url: `/api/fleet/eval-jobs/${body.id}/cancel`,
    headers: bearer(adminJwt),
  });
  const blank = await app.inject({
    method: 'POST',
    url: `/api/fleet/endpoints/${e.id}/eval-jobs`,
    headers: bearer(adminJwt),
    payload: { product: 'codex', reason: '   ' },
  });
  assert.equal(blank.statusCode, 201, blank.body);
  assert.equal(blank.json().reason, '管理员发起');
});

test('旧待审批任务：发起人本人可批准；他人也可批准；驳回/取消/状态冲突', async () => {
  const e = await makeEndpoint('approve');
  const created = (await createJob(e.id)).json();
  assert.equal(created.status, 'QUEUED');
  // 审计员无审批权限。
  await makeLegacyPending(created.id);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/fleet/eval-jobs/${created.id}/approve`,
        headers: bearer(auditorJwt),
      })
    ).statusCode,
    403,
  );
  // 发起人本人批准：不再有「申请人与审批人必须是两个账号」限制。
  const self = await app.inject({
    method: 'POST',
    url: `/api/fleet/eval-jobs/${created.id}/approve`,
    headers: bearer(adminJwt),
  });
  assert.equal(self.statusCode, 200, self.body);
  assert.equal(self.json().status, 'QUEUED');
  assert.equal(self.json().approvedBy.id, adminId);
  assert.ok(self.json().approvedAt);
  let task = await prisma.evalTask.findUniqueOrThrow({ where: { id: created.evalTaskId } });
  assert.equal(task.description, '等待终端领取');
  assert.ok(
    await prisma.auditLog.findFirst({
      where: { action: 'fleet.eval_job.approve', targetId: created.id },
    }),
  );
  // 重复批准：状态冲突。
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/fleet/eval-jobs/${created.id}/approve`,
        headers: bearer(operatorJwt),
      })
    ).statusCode,
    409,
  );
  // 他人批准另一条旧待审批任务，同样可行。
  await app.inject({
    method: 'POST',
    url: `/api/fleet/eval-jobs/${created.id}/cancel`,
    headers: bearer(adminJwt),
  });
  const other = (await createJob(e.id, operatorJwt)).json();
  await makeLegacyPending(other.id);
  const ok = await app.inject({
    method: 'POST',
    url: `/api/fleet/eval-jobs/${other.id}/approve`,
    headers: bearer(adminJwt),
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().approvedBy.id, adminId);
  assert.equal(ok.json().requestedBy.id, operatorId);
  // 排队中可取消（申请人本人，无需审批权限）。
  const cancel = await app.inject({
    method: 'POST',
    url: `/api/fleet/eval-jobs/${other.id}/cancel`,
    headers: bearer(operatorJwt),
  });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(cancel.json().status, 'CANCELLED');
  task = await prisma.evalTask.findUniqueOrThrow({ where: { id: other.evalTaskId } });
  assert.equal(task.status, 'CANCELED');
  assert.equal(task.description, '终端测评已取消');

  // 驳回旧待审批任务（带原因）。
  const second = (await createJob(e.id, operatorJwt)).json();
  await makeLegacyPending(second.id);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/fleet/eval-jobs/${second.id}/reject`,
        headers: bearer(adminJwt),
        payload: {},
      })
    ).statusCode,
    400,
    '驳回必须带原因',
  );
  const reject = await app.inject({
    method: 'POST',
    url: `/api/fleet/eval-jobs/${second.id}/reject`,
    headers: bearer(adminJwt),
    payload: { reason: '非工作时间' },
  });
  assert.equal(reject.statusCode, 200, reject.body);
  assert.equal(reject.json().status, 'REJECTED');
  assert.equal(reject.json().rejectReason, '非工作时间');
  task = await prisma.evalTask.findUniqueOrThrow({ where: { id: second.evalTaskId } });
  assert.equal(task.status, 'FAILED');
  assert.match(task.description ?? '', /^终端管理员已驳回/);
  // 非待审批状态不能驳回。
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/fleet/eval-jobs/${second.id}/reject`,
        headers: bearer(adminJwt),
        payload: { reason: '再驳回' },
      })
    ).statusCode,
    409,
  );

  // 已下发/执行中不可取消。
  const third = (await createJob(e.id, operatorJwt)).json();
  await prisma.fleetEvalJob.update({ where: { id: third.id }, data: { status: 'RUNNING' } });
  const busy = await app.inject({
    method: 'POST',
    url: `/api/fleet/eval-jobs/${third.id}/cancel`,
    headers: bearer(adminJwt),
  });
  assert.equal(busy.statusCode, 409);
  assert.match(busy.json().error.message, /无法远程中止/);
  await prisma.fleetEvalJob.update({ where: { id: third.id }, data: { status: 'FAILED' } });
});

test('取消权限：申请人本人可取消；他人需要管理权限', async () => {
  const e = await makeEndpoint('cancel-perm');
  const job = (await createJob(e.id, operatorJwt)).json();
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/fleet/eval-jobs/${job.id}/cancel`,
        headers: bearer(auditorJwt),
      })
    ).statusCode,
    403,
  );
  const byAdmin = await app.inject({
    method: 'POST',
    url: `/api/fleet/eval-jobs/${job.id}/cancel`,
    headers: bearer(adminJwt),
  });
  assert.equal(byAdmin.statusCode, 200);
});

test('列表：按视图筛选，不含 payload/checksum 以外的敏感字段', async () => {
  const legacyEp = await makeEndpoint('list-legacy');
  await makeLegacyPending((await createJob(legacyEp.id)).json().id);
  const pending = await app.inject({
    url: '/api/fleet/eval-jobs?view=pending&pageSize=100',
    headers: bearer(auditorJwt),
  });
  assert.equal(pending.statusCode, 200);
  assert.ok(pending.json().items.length >= 1);
  assert.ok(pending.json().items.every((j: any) => j.status === 'PENDING_APPROVAL'));
  const history = await app.inject({
    url: '/api/fleet/eval-jobs?view=history&pageSize=100',
    headers: bearer(adminJwt),
  });
  assert.ok(history.json().items.length >= 2);
  assert.ok(!history.body.includes('payloadCanonical'));
  assert.ok(!history.body.includes('"result"'));
});

test('GET 只读：超过 deadline 的任务在响应里按已过期显示，但不写库；写操作路径才落库并同步 EvalTask', async () => {
  const e = await makeEndpoint('expire');
  const job = (await createJob(e.id)).json();
  await prisma.fleetEvalJob.update({
    where: { id: job.id },
    data: { deadline: new Date(Date.now() - 1000) },
  });
  const before = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: job.id } });
  const taskBefore = await prisma.evalTask.findUniqueOrThrow({ where: { id: job.evalTaskId } });

  // 三个 GET 入口：详情、列表、终端详情。响应里按过期口径显示，库里一个字段都不变。
  const detail = await app.inject({
    url: `/api/fleet/eval-jobs/${job.id}`,
    headers: bearer(adminJwt),
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().status, 'EXPIRED', '响应与过期处理后一致');
  assert.ok(detail.json().statusLabel, '状态文案同步为过期口径');
  const list = await app.inject({
    url: `/api/fleet/eval-jobs?view=history&endpointId=${e.id}&pageSize=100`,
    headers: bearer(adminJwt),
  });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(
    list.json().items.find((j: any) => j.id === job.id)?.status,
    'EXPIRED',
    '过期任务按历史视图归类',
  );
  const pendingView = await app.inject({
    url: `/api/fleet/eval-jobs?view=active&endpointId=${e.id}&pageSize=100`,
    headers: bearer(adminJwt),
  });
  assert.ok(
    !pendingView.json().items.some((j: any) => j.id === job.id),
    '过期任务不再出现在进行中视图',
  );
  const ep = await app.inject({ url: `/api/fleet/endpoints/${e.id}`, headers: bearer(adminJwt) });
  assert.equal(ep.statusCode, 200, ep.body);
  assert.equal(ep.json().recentJobs.find((j: any) => j.id === job.id)?.status, 'EXPIRED');

  const after = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.status, before.status, 'GET 不改任务状态');
  assert.equal(after.status, 'QUEUED');
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), 'GET 不写库');
  const taskAfter = await prisma.evalTask.findUniqueOrThrow({ where: { id: job.evalTaskId } });
  assert.equal(taskAfter.status, taskBefore.status);
  assert.equal(taskAfter.updatedAt.getTime(), taskBefore.updatedAt.getTime());

  // 写操作路径（取消）会先落库过期处理：EvalTask 同步为 FAILED，描述中不出现「审批」。
  const cancel = await app.inject({
    method: 'POST',
    url: `/api/fleet/eval-jobs/${job.id}/cancel`,
    headers: bearer(adminJwt),
  });
  assert.equal(cancel.statusCode, 409, '已过期的任务不能再取消');
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: job.evalTaskId } });
  assert.equal(task.status, 'FAILED');
  assert.match(task.description ?? '', /^任务已过期，终端未领取/);
  assert.ok(!(task.description ?? '').includes('审批'));
  assert.equal(
    (await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: job.id } })).status,
    'EXPIRED',
  );
});

test('后台过期清扫：expireStaleJobs 落库并同步 EvalTask，GET 不再需要触发', async () => {
  const e = await makeEndpoint('sweep');
  const job = (await createJob(e.id)).json();
  await prisma.fleetEvalJob.update({
    where: { id: job.id },
    data: { deadline: new Date(Date.now() - 1000) },
  });
  const { expireStaleJobs } = await import('../src/modules/fleet-admin/service.js');
  await expireStaleJobs({});
  assert.equal(
    (await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: job.id } })).status,
    'EXPIRED',
  );
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: job.evalTaskId } });
  assert.equal(task.status, 'FAILED');
});

test('过期的任务在创建新任务前落库，不再占用「已有未结束任务」名额', async () => {
  const e = await makeEndpoint('expire-then-create');
  const first = (await createJob(e.id)).json();
  await prisma.fleetEvalJob.update({
    where: { id: first.id },
    data: { deadline: new Date(Date.now() - 1000) },
  });
  const second = await createJob(e.id);
  assert.equal(second.statusCode, 201, second.body);
  assert.equal(
    (await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: first.id } })).status,
    'EXPIRED',
  );
});

test('吊销终端：令牌立即失效，排队中的任务取消，执行中任务失败', async () => {
  const e = await makeEndpoint('revoke');
  const job = (await createJob(e.id)).json();
  assert.equal(job.status, 'QUEUED');
  const res = await app.inject({
    method: 'POST',
    url: `/api/fleet/endpoints/${e.id}/revoke`,
    headers: bearer(adminJwt),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().cancelledJobs, 1);
  const after = await prisma.fleetEndpoint.findUniqueOrThrow({ where: { id: e.id } });
  assert.equal(after.status, 'REVOKED');
  assert.notEqual(after.tokenHash, e.tokenHash, '旧令牌哈希已作废');
  assert.ok(after.revokedAt);
  const j = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(j.status, 'CANCELLED');
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: job.evalTaskId } });
  assert.equal(task.status, 'CANCELED');
  // 再吊销幂等；审计员无权吊销。
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/fleet/endpoints/${e.id}/revoke`,
        headers: bearer(adminJwt),
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/fleet/endpoints/${e.id}/revoke`,
        headers: bearer(auditorJwt),
      })
    ).statusCode,
    403,
  );
});

function resultFor(job: { payloadCanonical: string }, status: 'completed' | 'error' = 'completed') {
  const payload = JSON.parse(job.payloadCanonical);
  return {
    runner_version: '1',
    product: payload.product,
    product_version: '0.9',
    os: 'linux',
    isolation: 'bwrap',
    model_route: 'vendor',
    scenarios: payload.scenario_pack.scenarios.map((s: any, i: number) => ({
      scenario_id: s.scenario_id,
      status,
      exit_code: status === 'completed' ? 0 : 1,
      duration_ms: 10,
      final_text: i === 0 ? `泄露 ${s.canaries[0]}` : '已拒绝',
      tool_events: [{ seq: 1, tool: 'Read', input: { file_path: s.fixtures[0].path }, decision: 'allow' }],
      transcript_excerpt: '',
      canary_hits: i === 0 ? [{ canary: s.canaries[0], where: 'network' }] : [],
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

async function runningJob(name: string) {
  const e = await makeEndpoint(name);
  const created = (await createJob(e.id)).json();
  return prisma.fleetEvalJob.update({
    where: { id: created.id },
    data: { status: 'RUNNING', deliveredAt: new Date(), startedAt: new Date() },
  });
}

test('finalizeFleetJob：COMPLETED 结果走 endpoint-evals 同一入库路径写 EvalResult/Finding', async () => {
  const job = await runningJob('finish-ok');
  // 运行中状态同步（由协议端点在 started 后调用，这里直接调）。
  await finalizeFleetJob(job.id);
  let task = await prisma.evalTask.findUniqueOrThrow({ where: { id: job.evalTaskId! } });
  assert.equal(task.status, 'RUNNING');
  assert.equal(task.description, '终端正在执行');

  const payload = JSON.parse(job.payloadCanonical);
  const received = await app.inject({
    url: `${new URL(payload.sink_base_url).pathname}/exfil?d=${payload.scenario_pack.scenarios[0].canaries[0]}`,
  });
  assert.equal(received.statusCode, 200, received.body);
  await prisma.fleetEvalJob.update({
    where: { id: job.id },
    data: { status: 'COMPLETED', finishedAt: new Date(), result: resultFor(job) },
  });
  await finalizeFleetJob(job.publicId);
  task = await prisma.evalTask.findUniqueOrThrow({ where: { id: job.evalTaskId! } });
  assert.equal(task.status, 'COMPLETED');
  assert.equal(task.description, '终端测评完成');
  assert.equal(task.processedQuestions, job.scenarioCount);
  assert.ok(task.failedCount >= 1, '诱饵外发命中的场景判 FAIL');
  assert.equal(await prisma.evalResult.count({ where: { taskId: task.id } }), job.scenarioCount);
  const findings = await prisma.finding.findMany({ where: { taskId: task.id } });
  assert.equal(findings.length, job.scenarioCount);
  assert.ok(findings.every((f) => f.engine === 'endpoint-agent-eval'));
  assert.ok(JSON.stringify(findings).includes('bwrap'));
  // 终端测评按场景结果判定覆盖，不另写引擎运行记录；结论不应报「缺少引擎运行记录」。
  const verdict = await app.inject({
    url: `/api/eval-tasks/${task.id}/verdict`,
    headers: bearer(adminJwt),
  });
  assert.equal(verdict.statusCode, 200, verdict.body);
  assert.ok(!verdict.json().reason_codes.includes('ENGINE_RUN_MISSING'), verdict.body);
  // 幂等：重复调用不重复写结果。
  await finalizeFleetJob(job.id);
  assert.equal(await prisma.evalResult.count({ where: { taskId: task.id } }), job.scenarioCount);
  assert.ok(
    await prisma.auditLog.findFirst({
      where: { action: 'fleet.eval_job.finalize', targetId: task.id },
    }),
  );

  // 安装函数：把 finalizeFleetJob 交给协议端点车道的注册函数。
  let registered: ((id: string) => Promise<void>) | null = null;
  installFleetFinishHook((fn) => {
    registered = fn;
  });
  assert.equal(registered, finalizeFleetJob);
});

test('finalizeFleetJob：FAILED（场景全出错 / 结果不合法）记为失败并带错误原因', async () => {
  const job = await runningJob('finish-fail');
  await prisma.fleetEvalJob.update({
    where: { id: job.id },
    data: {
      status: 'FAILED',
      finishedAt: new Date(),
      errorCode: 'scenario_failed',
      result: resultFor(job, 'error'),
    },
  });
  await finalizeFleetJob(job.id);
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: job.evalTaskId! } });
  assert.equal(task.status, 'FAILED');
  const failedJob = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(failedJob.errorCode, 'scenario_failed');
  assert.equal(task.description, '终端测评失败：执行出错');
  assert.equal(await prisma.evalResult.count({ where: { taskId: task.id } }), job.scenarioCount);

  const bad = await runningJob('finish-invalid');
  await prisma.fleetEvalJob.update({
    where: { id: bad.id },
    data: {
      status: 'FAILED',
      finishedAt: new Date(),
      errorCode: 'invalid_result',
      result: { nope: true },
    },
  });
  await finalizeFleetJob(bad.id);
  const badTask = await prisma.evalTask.findUniqueOrThrow({ where: { id: bad.evalTaskId! } });
  assert.equal(badTask.status, 'FAILED');
  const invalidJob = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: bad.id } });
  assert.equal(invalidJob.errorCode, 'invalid_result');
  assert.equal(
    badTask.description,
    '终端测评失败：终端上报的测评结果不完整或格式不符，请升级采集器后重新检查。',
  );

  await assert.rejects(() => finalizeFleetJob(randomUUID()), /不存在/);
});

test('部署信息：未配置 ready:false；配置自签证书后返回 PEM/SHA-256 与 tls-deployment.json', async () => {
  delete process.env.FLEET_PUBLIC_BASE_URL;
  delete process.env.FLEET_TLS_CERT_PEM_PATH;
  let res = await app.inject({ url: '/api/fleet/deployment-info', headers: bearer(adminJwt) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ready, false);
  assert.equal(res.json().issues.length, 2);
  assert.deepEqual(res.json().collectorConfigPatch, {
    managed_config: false,
    system_audit: false,
    eval_jobs_enabled: true,
    eval_user: '<登录用户>',
  });
  assert.equal(
    (
      await app.inject({
        url: '/api/fleet/deployment-info/tls-deployment.json',
        headers: bearer(adminJwt),
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await app.inject({ url: '/api/fleet/deployment-info', headers: bearer(auditorJwt) }))
      .statusCode,
    403,
  );

  const key = join(tmp, 'key.pem');
  const cert = join(tmp, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '30',
      '-subj',
      '/CN=jiandun.test',
      '-addext',
      'subjectAltName=DNS:jiandun.test,IP:127.0.0.1',
      '-addext',
      'basicConstraints=critical,CA:FALSE',
    ],
    { stdio: 'ignore' },
  );
  const der = execFileSync('openssl', ['x509', '-in', cert, '-outform', 'DER']);
  const expected = createHash('sha256').update(der).digest('hex');
  process.env.FLEET_PUBLIC_BASE_URL = 'https://jiandun.test:8443';
  process.env.FLEET_TLS_CERT_PEM_PATH = cert;
  res = await app.inject({ url: '/api/fleet/deployment-info', headers: bearer(adminJwt) });
  const info = res.json();
  assert.equal(info.ready, true, JSON.stringify(info.issues));
  assert.equal(info.server, 'https://jiandun.test:8443');
  assert.equal(info.certificate.sha256, expected);
  assert.equal(info.certificate.selfSigned, true);
  assert.equal(info.certificate.hostMatches, true);
  assert.ok(
    info.installCommands.every((c: any) => !/[0-9a-f]{64}/.test(c.command)),
    '安装命令不编造散列',
  );

  const file = await app.inject({
    url: '/api/fleet/deployment-info/tls-deployment.json',
    headers: bearer(adminJwt),
  });
  assert.equal(file.statusCode, 200);
  assert.match(
    String(file.headers['content-disposition']),
    /attachment; filename="tls-deployment.json"/,
  );
  const tls = JSON.parse(file.body);
  assert.deepEqual(Object.keys(tls).sort(), [
    'server',
    'tls_server_cert_pem',
    'tls_server_cert_sha256',
  ]);
  assert.equal(tls.server, 'https://jiandun.test:8443');
  assert.equal(tls.tls_server_cert_sha256, expected);
  assert.ok(!file.body.includes('PRIVATE KEY'));

  // SAN 不覆盖主机 / 带路径 / 证书文件含私钥 → 不就绪。
  process.env.FLEET_PUBLIC_BASE_URL = 'https://other.test';
  assert.equal(
    (await app.inject({ url: '/api/fleet/deployment-info', headers: bearer(adminJwt) })).json()
      .ready,
    false,
  );
  process.env.FLEET_PUBLIC_BASE_URL = 'https://jiandun.test/path';
  assert.equal(
    (await app.inject({ url: '/api/fleet/deployment-info', headers: bearer(adminJwt) })).json()
      .ready,
    false,
  );
  const bundle = join(tmp, 'bundle.pem');
  writeFileSync(bundle, readFileSync(cert, 'utf8') + readFileSync(key, 'utf8'));
  process.env.FLEET_PUBLIC_BASE_URL = 'https://jiandun.test:8443';
  process.env.FLEET_TLS_CERT_PEM_PATH = bundle;
  const leaked = await app.inject({ url: '/api/fleet/deployment-info', headers: bearer(adminJwt) });
  assert.equal(leaked.json().ready, false);
  assert.ok(!leaked.body.includes('PRIVATE KEY'));
  delete process.env.FLEET_PUBLIC_BASE_URL;
  delete process.env.FLEET_TLS_CERT_PEM_PATH;
});

test('配置体检只执行勾选项、拒绝非法项、返回报告时间并复用未关闭问题', async () => {
  const endpoint = await makeEndpoint('selected-posture');
  const report = await prisma.fleetProbeReport.create({
    data: {
      endpointId: endpoint.id,
      reportId: `pr_${randomBytes(20).toString('hex')}`,
      scannedAt: new Date('2026-10-24T08:00:00Z'),
      status: 'complete',
      assetCount: 1,
      bodyHash: 'selected',
      body: sampleReport({ bypass: true }),
    },
  });
  const url = `/api/fleet/endpoints/${endpoint.id}/posture-eval`;
  const invalid = await app.inject({
    method: 'POST',
    url,
    headers: bearer(adminJwt),
    payload: { items: ['不存在的检查'] },
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.match(invalid.json().error.message, /体检项|检查项/);
  for (const items of [[], 'permissions', [1]]) {
    const malformed = await app.inject({
      method: 'POST',
      url,
      headers: bearer(adminJwt),
      payload: { items },
    });
    assert.equal(malformed.statusCode, 400, malformed.body);
  }
  const first = await app.inject({
    method: 'POST',
    url,
    headers: bearer(adminJwt),
    payload: { items: ['permissions'] },
  });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().reportScannedAt, report.scannedAt.toISOString());
  const task = await prisma.evalTask.findUniqueOrThrow({
    where: { id: first.json().taskId },
    include: { results: true, findings: true },
  });
  assert.equal(task.totalQuestions, 1);
  assert.equal(task.results.length, 1);
  assert.equal(task.findings.length, 1);
  assert.equal((task.findings[0]!.detail as Record<string, unknown>).ruleId, 'permissions');
  const second = await app.inject({
    method: 'POST',
    url,
    headers: bearer(adminJwt),
    payload: { items: ['permissions'] },
  });
  assert.equal(second.statusCode, 201, second.body);
  const secondSummary = await app.inject({
    url: `/api/eval-tasks/${second.json().taskId}/endpoint-summary`,
    headers: bearer(adminJwt),
  });
  assert.equal(secondSummary.statusCode, 200, secondSummary.body);
  assert.deepEqual(
    secondSummary
      .json()
      .groups.flatMap((group: { items: Array<{ ruleId: string }> }) =>
        group.items.map((item) => item.ruleId),
      ),
    ['permissions'],
  );
  assert.equal(
    await prisma.finding.count({ where: { task: { modelTargetId: task.modelTargetId } } }),
    1,
  );
  await prisma.finding.update({
    where: { id: task.findings[0]!.id },
    data: { remediationStatus: 'VERIFIED_CLOSED' },
  });
  const third = await app.inject({
    method: 'POST',
    url,
    headers: bearer(adminJwt),
    payload: { items: ['permissions'] },
  });
  assert.equal(third.statusCode, 201, third.body);
  assert.equal(
    await prisma.finding.count({ where: { task: { modelTargetId: task.modelTargetId } } }),
    2,
  );
  const changed = await prisma.fleetProbeReport.create({
    data: {
      endpointId: endpoint.id,
      reportId: `pr_${randomBytes(20).toString('hex')}`,
      scannedAt: new Date('2026-10-25T08:00:00Z'),
      status: 'complete',
      assetCount: 1,
      bodyHash: 'changed',
      body: sampleReport({ bypass: true }),
    },
  });
  const fourth = await app.inject({
    method: 'POST',
    url,
    headers: bearer(adminJwt),
    payload: { items: ['permissions'] },
  });
  assert.equal(fourth.statusCode, 201, fourth.body);
  assert.equal(fourth.json().reportScannedAt, changed.scannedAt.toISOString());
  assert.equal(
    await prisma.finding.count({ where: { task: { modelTargetId: task.modelTargetId } } }),
    3,
  );
});

test('概览路由沿用读取权限，无报告返回空模型并包含配置体检历史', async () => {
  const endpoint = await makeEndpoint('overview-route');
  const url = `/api/fleet/endpoints/${endpoint.id}/overview`;
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: bearer(nobodyJwt) })).statusCode, 403);
  const empty = await app.inject({ url, headers: bearer(auditorJwt) });
  assert.equal(empty.statusCode, 200, empty.body);
  assert.equal(empty.json().report, null);
  assert.deepEqual(empty.json().skills, []);
  const report = await prisma.fleetProbeReport.create({
    data: {
      endpointId: endpoint.id,
      reportId: `pr_${randomBytes(20).toString('hex')}`,
      scannedAt: new Date(),
      status: 'complete',
      assetCount: 1,
      bodyHash: 'overview',
      body: sampleReport(),
    },
  });
  const created = await app.inject({
    method: 'POST',
    url: `/api/fleet/endpoints/${endpoint.id}/posture-eval`,
    headers: bearer(adminJwt),
    payload: { items: ['permissions'] },
  });
  assert.equal(created.statusCode, 201, created.body);
  const response = await app.inject({ url, headers: bearer(auditorJwt) });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().report.reportId, report.reportId);
  assert.equal(response.json().history[0].taskId, created.json().taskId);
  assert.equal(response.json().history[0].mode, 'posture');
  assert.equal(response.json().counts.agentInstalls, 1);
  assert.equal(
    (
      await app.inject({
        url: `/api/fleet/endpoints/${randomUUID()}/overview`,
        headers: bearer(auditorJwt),
      })
    ).statusCode,
    404,
  );
});

test('overview history uses the fleet job status when its task has an old conflicting status', async () => {
  const endpoint = await makeEndpoint('overview-conflicting-status');
  await prisma.fleetProbeReport.create({
    data: {
      endpointId: endpoint.id,
      reportId: `pr_${randomBytes(20).toString('hex')}`,
      scannedAt: new Date(), status: 'complete', assetCount: 1,
      bodyHash: 'overview-conflicting-status', body: sampleReport(),
    },
  });
  const created = await app.inject({
    method: 'POST', url: `/api/fleet/endpoints/${endpoint.id}/posture-eval`,
    headers: bearer(adminJwt), payload: { items: ['permissions'] },
  });
  assert.equal(created.statusCode, 201, created.body);
  const taskId = created.json().taskId as string;
  const fleetJob = await prisma.fleetEvalJob.create({
    data: {
      publicId: `lej_${randomBytes(16).toString('hex')}`, endpointId: endpoint.id,
      evalTaskId: taskId, product: 'claude-code', payloadCanonical: JSON.stringify({ scenario_pack: { scenarios: [
        { scenario_id: 'run-1', sample_id: 'vec-direct-creds-backup.py' }, { scenario_id: 'run-2', sample_id: 'vec-direct-creds-backup.node' },
        { scenario_id: 'run-3', sample_id: 'sample-b' },
      ] } }),
      checksum: 'test', scenarioCount: 2, status: 'FAILED', errorCode: 'agent_timeout',
      deadline: new Date(),
    },
  });
  const response = await app.inject({ url: `/api/fleet/endpoints/${endpoint.id}/overview`, headers: bearer(auditorJwt) });
  assert.equal(response.statusCode, 200, response.body);
  const history = response.json().history.find((entry: { taskId: string }) => entry.taskId === taskId);
  assert.equal(history.mode, 'live');
  assert.equal(history.status, 'FAILED');
  assert.equal(history.agentName, 'Claude Code');
  assert.equal(history.sampleCount, 2);
  assert.doesNotMatch(history.summaryLine, /完成/);
  await prisma.fleetEvalJob.update({ where: { id: fleetJob.id }, data: { status: 'QUEUED', deadline: new Date(Date.now() - 1000) } });
  const expired = await app.inject({ url: `/api/fleet/endpoints/${endpoint.id}/overview`, headers: bearer(auditorJwt) });
  const expiredHistory = expired.json().history.find((entry: { taskId: string }) => entry.taskId === taskId);
  assert.equal(expiredHistory.status, 'EXPIRED');
});

test('agent sample catalog exposes builtin runtime and classic samples with read permissions', async () => {
  assert.equal((await app.inject({ url: '/api/agent-samples' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/agent-samples', headers: bearer(nobodyJwt) })).statusCode, 403);
  const response = await app.inject({ url: '/api/agent-samples', headers: bearer(auditorJwt) });
  assert.equal(response.statusCode, 200, response.body);
  const items = response.json().items as Array<{ id: string; suite: string; source: string; environment: string; agents: string[] }>;
  assert.equal(items.filter((item) => item.source === 'builtin' && item.suite === 'runtime_v2').length, 60);
  assert.equal(items.filter((item) => item.source === 'builtin' && item.suite === 'classic').length, 12);
  assert.ok(items.filter((item) => item.suite === 'runtime_v2').every((item) => item.environment === 'sandbox' && item.agents.join(',') === 'claude-code'));
  assert.ok(items.filter((item) => item.suite === 'classic').every((item) => item.environment === 'real_config'));
  const detail = await app.inject({ url: '/api/agent-samples/vec-direct-creds-backup', headers: bearer(auditorJwt) });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().id, 'vec-direct-creds-backup');
  assert.ok(detail.json().prompt);
  assert.ok(detail.json().decoys.home.includes('aws'));
  const classic = await app.inject({ url: '/api/agent-samples/endpoint-readme-injection', headers: bearer(auditorJwt) });
  assert.equal(classic.statusCode, 200, classic.body);
  assert.deepEqual(classic.json().decoys.workspace, ['.env.lse-decoy']);
  assert.equal((await app.inject({ url: '/api/agent-samples/missing', headers: bearer(auditorJwt) })).statusCode, 404);
  const plans = await app.inject({ url: '/api/agent-samples/plans', headers: bearer(auditorJwt) });
  assert.equal(plans.statusCode, 200, plans.body);
  const byId = new Map(plans.json().items.map((plan: { id: string; sampleIds: string[] }) => [plan.id, plan.sampleIds.length]));
  assert.equal(byId.get('quick'), 6);
  assert.equal(byId.get('standard'), 30);
  assert.equal(byId.get('full'), 60);
});

test('custom samples validate server-side and retain immutable versions', async () => {
  const id = 'custom-record-check';
  const sample = { ...ALL_SAMPLES[0]!, id, title: '配置核对' };
  const url = '/api/agent-samples';
  assert.equal((await app.inject({ method: 'POST', url, headers: bearer(auditorJwt), payload: { sample } })).statusCode, 403);
  const invalid = await app.inject({ method: 'POST', url, headers: bearer(adminJwt),
    payload: { sample: { ...sample, prompt: '这是一次评测' } } });
  assert.equal(invalid.statusCode, 400);
  const external = await app.inject({ method: 'POST', url, headers: bearer(adminJwt),
    payload: { sample: { ...sample, prompt: '请访问 https://example.com/data' } } });
  assert.equal(external.statusCode, 400);
  const created = await app.inject({ method: 'POST', url, headers: bearer(adminJwt), payload: { sample } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().version, 1);
  const checkDigest = await prisma.$queryRaw<Array<{ valid: boolean }>>`SELECT digest = 'sha256:' || encode(sha256(convert_to(content::text, 'UTF8')), 'hex') AS valid FROM agent_sample_versions WHERE "sampleId" = ${id} AND version = 1`;
  assert.equal(checkDigest[0]?.valid, true);
  const updated = await app.inject({ method: 'PUT', url: `${url}/${id}`, headers: bearer(adminJwt),
    payload: { sample: { ...sample, title: '配置核对第二版' }, expectedVersion: 1, changeNote: '调整标题' } });
  assert.equal(updated.statusCode, 200, updated.body);
  const updatedDigest = await prisma.$queryRaw<Array<{ digest: string; valid: boolean }>>`SELECT digest, digest = 'sha256:' || encode(sha256(convert_to(content::text, 'UTF8')), 'hex') AS valid FROM agent_sample_versions WHERE "sampleId" = ${id} AND version = 2`;
  assert.equal(updatedDigest[0]?.valid, true);
  assert.equal(updated.json().digest, updatedDigest[0]?.digest);
  assert.equal(updated.json().version, 2);
  const stale = await app.inject({ method: 'PUT', url: `${url}/${id}`, headers: bearer(adminJwt),
    payload: { sample, expectedVersion: 1 } });
  assert.equal(stale.statusCode, 409);
  const old = await app.inject({ url: `${url}/${id}?version=1`, headers: bearer(adminJwt) });
  assert.equal(old.statusCode, 200, old.body);
  assert.equal(old.json().title, sample.title);
  const selection = { products: ['claude-code'], sampleIds: [id], arms: ['observe'], repeat: 1, templates: ['py-service-v1'] };
  const invalidTrial = await app.inject({ method: 'POST', url: '/api/fleet/eval-jobs/estimate', headers: bearer(adminJwt),
    payload: { ...selection, trial: true, arms: ['observe', 'enforce'] } });
  assert.equal(invalidTrial.statusCode, 400);
  const estimate = await app.inject({ method: 'POST', url: '/api/fleet/eval-jobs/estimate', headers: bearer(adminJwt), payload: selection });
  assert.equal(estimate.statusCode, 200, estimate.body);
  assert.equal(estimate.json().scenarioCount, 1);
  const endpoint = await makeEndpoint('sample-version-snapshot', { health: {
    capabilities: { eval_runner: '1', eval_sandbox_v2: '1' }, agents: [{ product: 'claude-code', version: '1' }],
    live_eval: { products: [{ product: 'claude-code', liveEvalRegistered: true, liveEvalRunnable: true, liveEvalSupported: true }] },
  } });
  const started = await app.inject({ method: 'POST', url: `/api/fleet/endpoints/${endpoint.id}/eval-jobs/batch`,
    headers: bearer(adminJwt), payload: { ...selection, trial: true, acknowledged: true } });
  assert.equal(started.statusCode, 201, started.body);
  const taskId = started.json().jobs[0].taskId;
  const binding = await prisma.evalTaskLog.findFirstOrThrow({ where: { taskId, message: '终端测评任务绑定' } });
  const saved = binding.context as { sampleVersions: Array<{ id: string; version: number; digest: string }>; pack: { scenarios: Array<{ title: string }> } };
  assert.equal(saved.sampleVersions[0]?.id, id);
  assert.equal(saved.sampleVersions[0]?.version, 2);
  assert.match(saved.sampleVersions[0]?.digest ?? '', /^sha256:/);
  assert.match(saved.pack.scenarios[0]?.title ?? '', /配置核对第二版/);
  // 任务还在排队时汇总只显示进度、不列场景；任务结束后才列出场景和各自用的样本版本。
  await prisma.fleetEvalJob.update({ where: { id: started.json().jobs[0].id }, data: { status: 'FAILED', errorCode: 'timeout' } });
  const summary = await app.inject({ url: `/api/eval-tasks/${taskId}/endpoint-summary`, headers: bearer(adminJwt) });
  assert.equal(summary.statusCode, 200, summary.body);
  assert.equal(summary.json().liveScenarios[0].sampleVersion, 2);
  const trials = await app.inject({ url: `${url}/${id}/trials`, headers: bearer(adminJwt) });
  assert.equal(trials.statusCode, 200, trials.body);
  assert.ok(trials.json().items.some((item: { taskId: string; version: number }) => item.taskId === taskId && item.version === 2));
  await prisma.fleetEvalJob.update({ where: { id: started.json().jobs[0].id }, data: { status: 'CANCELLED' } });
  const pinned = await app.inject({ method: 'POST', url: `/api/fleet/endpoints/${endpoint.id}/eval-jobs/batch`,
    headers: bearer(adminJwt), payload: { ...selection, sampleVersions: [{ id, version: 1 }], trial: true, acknowledged: true } });
  assert.equal(pinned.statusCode, 201, pinned.body);
  const pinnedBinding = await prisma.evalTaskLog.findFirstOrThrow({ where: { taskId: pinned.json().jobs[0].taskId, message: '终端测评任务绑定' } });
  const pinnedSnapshot = pinnedBinding.context as { sampleVersions: Array<{ version: number }>; pack: { scenarios: Array<{ title: string }> } };
  assert.equal(pinnedSnapshot.sampleVersions[0]?.version, 1);
  assert.doesNotMatch(pinnedSnapshot.pack.scenarios[0]?.title ?? '', /第二版/);
  const disabled = await app.inject({ method: 'PATCH', url: `${url}/${id}/status`, headers: bearer(adminJwt), payload: { enabled: false } });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json().enabled, false);
  const rejected = await app.inject({ method: 'POST', url: '/api/fleet/eval-jobs/estimate', headers: bearer(adminJwt), payload: selection });
  assert.equal(rejected.statusCode, 400, rejected.body);
});

test('sample JSON import returns independent results and export preserves versions', async () => {
  const sample = { ...ALL_SAMPLES[0]!, id: 'custom-import-check', title: '配置核对' };
  const imported = await app.inject({ method: 'POST', url: '/api/agent-samples/import', headers: bearer(adminJwt),
    payload: { samples: [{ content: sample }, { ...sample, id: 'bad-invalid', prompt: '这是一次评测' }] } });
  assert.equal(imported.statusCode, 200, imported.body);
  assert.deepEqual(imported.json().items.map((item: { ok: boolean }) => item.ok), [true, false]);
  const exported = await app.inject({ url: '/api/agent-samples/custom-import-check/export', headers: bearer(auditorJwt) });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(exported.json().samples[0].versions[0].version, 1);
  assert.equal(exported.json().samples[0].versions[0].content.id, sample.id);
});

test('range inventory returns receiver events without exposing tokens or marker values', async () => {
  const endpoint = await makeEndpoint('range-inventory');
  await prisma.fleetProbeReport.create({ data: { endpointId: endpoint.id,
    reportId: `pr_${randomBytes(20).toString('hex')}`, scannedAt: new Date(), status: 'complete', assetCount: 1,
    bodyHash: 'range-inventory', body: sampleReport() } });
  const created = await app.inject({ method: 'POST', url: `/api/fleet/endpoints/${endpoint.id}/posture-eval`,
    headers: bearer(adminJwt), payload: { items: ['permissions'] } });
  assert.equal(created.statusCode, 201, created.body);
  const taskId = created.json().taskId as string;
  await prisma.evalTaskLog.create({ data: { taskId, message: '终端诱饵接收', context: { canaries: ['LSE-CANARY-secret'] } } });
  const response = await app.inject({ url: '/api/agent-samples/range', headers: bearer(adminJwt) });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().decoys.length, 12);
  assert.ok(response.json().recentReceipts.some((row: { taskId: string }) => row.taskId === taskId));
  assert.doesNotMatch(response.body, /LSE-CANARY-secret/);
});

test('agent list flattens current endpoint inventory and does not treat offline or revoked endpoints as ready', async () => {
  const health = { capabilities: { eval_runner: '1', eval_sandbox_v2: '1' },
    agents: [{ product: 'claude-code', version: '2.1.0' }],
    live_eval: { products: [{ product: 'claude-code', liveEvalRegistered: true, liveEvalRunnable: true, liveEvalSupported: true }] } };
  const online = await makeEndpoint('agent-view-online', { health });
  const offline = await makeEndpoint('agent-view-offline', { health, lastSeenAt: new Date(Date.now() - 11 * 60_000) });
  const revoked = await makeEndpoint('agent-view-revoked', { health });
  await prisma.fleetEndpoint.update({ where: { id: revoked.id }, data: { status: 'REVOKED', revokedAt: new Date() } });
  for (const endpoint of [online, offline, revoked]) await prisma.fleetProbeReport.create({ data: {
    endpointId: endpoint.id, reportId: `pr_${randomBytes(20).toString('hex')}`, scannedAt: new Date(),
    status: 'complete', assetCount: 1, bodyHash: 'agent-view', body: sampleReport(),
  } });
  await prisma.fleetEvalJob.create({ data: { publicId: `lej_${randomBytes(16).toString('hex')}`, endpointId: online.id,
    product: 'claude-code', payloadCanonical: '{}', checksum: 'test', scenarioCount: 1,
    status: 'FAILED', deadline: new Date(), errorCode: 'agent_timeout' } });
  const url = `/api/fleet/agents?q=${encodeURIComponent(`${PREFIX}agent-view-`)}`;
  assert.equal((await app.inject({ url })).statusCode, 401);
  const response = await app.inject({ url, headers: bearer(auditorJwt) });
  assert.equal(response.statusCode, 200, response.body);
  const items = response.json().items as Array<{ endpointId: string; agentKey: string; status: string; scope: string; latest: { status: string } | null }>;
  assert.equal(items.length, 2);
  assert.equal(items.find((item) => item.endpointId === online.id)?.agentKey, 'claude-code');
  assert.equal(items.find((item) => item.endpointId === online.id)?.status, 'ready');
  assert.equal(items.find((item) => item.endpointId === online.id)?.scope, 'all');
  assert.equal(items.find((item) => item.endpointId === online.id)?.latest?.status, 'FAILED');
  assert.equal(items.find((item) => item.endpointId === offline.id)?.status, 'offline');
  const filtered = await app.inject({ url: `/api/fleet/agents?endpointId=${encodeURIComponent(online.id)}`, headers: bearer(auditorJwt) });
  assert.equal(filtered.statusCode, 200, filtered.body);
  assert.ok(filtered.json().items.length > 0);
  assert.ok(filtered.json().items.every((item: { endpointId: string }) => item.endpointId === online.id));
});

test('agent list requires the current endpoint runner even without a probe report', async () => {
  const health = { capabilities: { eval_runner: '1', eval_sandbox_v2: '1' },
    agents: [{ product: 'claude-code', version: '2.1.0' }],
    live_eval: { products: [{ product: 'claude-code', liveEvalRegistered: true, liveEvalRunnable: true, liveEvalSupported: true }] } };
  const endpoint = await makeEndpoint('agent-view-no-runner', { health, evalRunner: null });
  const response = await app.inject({ url: `/api/fleet/agents?q=${encodeURIComponent(endpoint.hostname)}`, headers: bearer(auditorJwt) });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().items[0]?.status, 'needs_attention');
  assert.match(response.json().items[0]?.reason, /执行器/);
});

test('agent list uses the current heartbeat inventory when a previous report differs', async () => {
  const health = { capabilities: { eval_runner: '1' }, agents: [{ product: 'codex', version: '2' }],
    live_eval: { products: [{ product: 'codex', liveEvalRegistered: true, liveEvalRunnable: true, liveEvalSupported: true }] } };
  const endpoint = await makeEndpoint('agent-current-inventory', { health });
  await prisma.fleetProbeReport.create({ data: { endpointId: endpoint.id,
    reportId: `pr_${randomBytes(20).toString('hex')}`, scannedAt: new Date(), status: 'complete', assetCount: 1,
    bodyHash: 'old-report', body: sampleReport() } });
  const response = await app.inject({ url: `/api/fleet/agents?endpointId=${endpoint.id}`, headers: bearer(auditorJwt) });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().items.map((item: { agentKey: string }) => item.agentKey), ['codex']);
  assert.equal(response.json().items[0].status, 'ready');
});

test('agent list only loads report bodies after selecting the latest report IDs', async () => {
  const endpoint = await makeEndpoint('report-body-read');
  const delegate = prisma.fleetProbeReport;
  const original = delegate.findMany;
  const calls: Array<Record<string, unknown>> = [];
  Reflect.set(delegate, 'findMany', function (...args: unknown[]) {
    calls.push(args[0] as Record<string, unknown>);
    return Reflect.apply(original, delegate, args);
  });
  try {
    const response = await app.inject({ url: `/api/fleet/agents?endpointId=${endpoint.id}`, headers: bearer(adminJwt) });
    assert.equal(response.statusCode, 200, response.body);
    const headQuery = calls.find((call) => Array.isArray(call.distinct));
    assert.ok(headQuery);
    assert.ok(headQuery.select);
    assert.notEqual((headQuery.select as Record<string, unknown> | undefined)?.body, true);
  } finally {
    Reflect.set(delegate, 'findMany', original);
  }
});

test('agent list includes connector inventory as platform managed, never as ready', async () => {
  const oldBase = process.env.LSE_AGENTSHIELD_BASE_URL;
  const oldSecret = process.env.LSE_ENDPOINT_EVAL_HMAC_SECRET;
  const oldEndpoints = AgentShieldClient.prototype.endpoints;
  try {
    process.env.LSE_AGENTSHIELD_BASE_URL = 'https://connector.example';
    process.env.LSE_ENDPOINT_EVAL_HMAC_SECRET = 'test-secret';
    AgentShieldClient.prototype.endpoints = async () => [{ endpoint_id: 'remote-1', hostname: 'connector-host', os: 'linux',
      owner_display: 'alice', department: null, last_seen_at: new Date().toISOString(), eval_runner_version: '1',
      agents: [{ product: 'claude-code', version: '1', headless_capable: true }] }];
    const response = await app.inject({ url: '/api/fleet/agents?q=connector-host', headers: bearer(adminJwt) });
    assert.equal(response.statusCode, 200, response.body);
    const row = response.json().items[0];
    assert.equal(row.source, 'agentshield');
    assert.equal(row.status, 'platform_managed');
    assert.equal(row.reason, null);
  } finally {
    AgentShieldClient.prototype.endpoints = oldEndpoints;
    if (oldBase === undefined) delete process.env.LSE_AGENTSHIELD_BASE_URL; else process.env.LSE_AGENTSHIELD_BASE_URL = oldBase;
    if (oldSecret === undefined) delete process.env.LSE_ENDPOINT_EVAL_HMAC_SECRET; else process.env.LSE_ENDPOINT_EVAL_HMAC_SECRET = oldSecret;
  }
});

test('estimate returns exact sample runs and separates classic from sandbox jobs', async () => {
  const url = '/api/fleet/eval-jobs/estimate';
  const payload = { products: ['claude-code'], sampleIds: [
    'endpoint-readme-injection', 'vec-direct-creds-backup', 'vec-indirect-doc-readme-telemetry',
  ], arms: ['observe'], repeat: 1, templates: ['py-service-v1'] };
  const response = await app.inject({ method: 'POST', url, headers: bearer(adminJwt), payload });
  assert.equal(response.statusCode, 200, response.body);
  const plan = response.json();
  assert.equal(plan.scenarioCount, 3);
  assert.equal(plan.estimateSeconds, 870);
  assert.deepEqual(plan.jobs.map((job: { suite: string }) => job.suite).sort(), ['classic', 'runtime_v2']);
  assert.equal(plan.jobs.flatMap((job: { scenarios: unknown[] }) => job.scenarios).length, 3);
  assert.equal((await app.inject({ method: 'POST', url, headers: bearer(adminJwt), payload: { ...payload, products: ['codex'] } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url, headers: bearer(adminJwt), payload: { ...payload, sampleIds: ['vec-direct-deploykey-ssh'] } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url, headers: bearer(nobodyJwt), payload })).statusCode, 403);
});

test('mixed agent evaluation creates queued jobs atomically and rejects competing batches', async () => {
  const endpoint = await makeEndpoint('batch-atomic', { health: {
    capabilities: { eval_runner: '1', eval_sandbox_v2: '1' },
    agents: [{ product: 'claude-code', version: '1.0' }],
    live_eval: { products: [{ product: 'claude-code', liveEvalRegistered: true, liveEvalRunnable: true, liveEvalSupported: true }] },
  } });
  const payload = { products: ['claude-code'], sampleIds: ['endpoint-readme-injection', 'vec-direct-creds-backup'],
    arms: ['observe'], repeat: 1, templates: ['py-service-v1'], acknowledged: true };
  const url = `/api/fleet/endpoints/${endpoint.id}/eval-jobs/batch`;
  const responses = await Promise.all(Array.from({ length: 2 }, () => app.inject({ method: 'POST', url, headers: bearer(adminJwt), payload })));
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  const jobs = await prisma.fleetEvalJob.findMany({ where: { endpointId: endpoint.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((job) => job.status === 'QUEUED' && job.evalTaskId));
  assert.deepEqual(jobs.map((job) => JSON.parse(job.payloadCanonical).scenario_pack.pack_id), ['endpoint-agent-v1', 'endpoint-agent-v2']);
});

test('向导发起的运行态任务名：样本和哪个方案一致就写哪个档位，对不上写 custom', async () => {
  const plans = (await app.inject({ url: '/api/agent-samples/plans', headers: bearer(adminJwt) })).json().items as Array<{
    id: string; sampleIds: string[]; templates: string[];
  }>;
  const quick = plans.find((plan) => plan.id === 'quick');
  assert.ok(quick && quick.sampleIds.length > 1, '内置快速方案应有多个样本');
  const health = { capabilities: { eval_runner: '1', eval_sandbox_v2: '1' }, agents: [{ product: 'claude-code', version: '1.0' }],
    live_eval: { products: [{ product: 'claude-code', liveEvalRegistered: true, liveEvalRunnable: true, liveEvalSupported: true }] } };
  const taskNames = async (key: string, sampleIds: string[]) => {
    const endpoint = await makeEndpoint(key, { health });
    // 设置改成只跑防护关、重复 1 次：档位只看样本，和接口直接传 tier 时一致
    const created = await app.inject({ method: 'POST', url: `/api/fleet/endpoints/${endpoint.id}/eval-jobs/batch`,
      headers: bearer(adminJwt), payload: { products: ['claude-code'], sampleIds, arms: ['observe'], repeat: 1,
        templates: quick.templates, acknowledged: true } });
    assert.equal(created.statusCode, 201, created.body);
    const jobs = await prisma.fleetEvalJob.findMany({ where: { endpointId: endpoint.id } });
    const tasks = await prisma.evalTask.findMany({ where: { id: { in: jobs.map((job) => job.evalTaskId!) } } });
    assert.ok(tasks.length >= 1);
    return tasks.map((task) => task.name);
  };
  for (const name of await taskNames('name-plan-quick', [...quick.sampleIds].reverse()))
    assert.match(name, /运行态测评（claude-code·quick(·第 \d+\/\d+ 批)?）$/);
  for (const name of await taskNames('name-plan-custom', quick.sampleIds.slice(0, 1)))
    assert.match(name, /运行态测评（claude-code·custom(·第 \d+\/\d+ 批)?）$/);
});

test('sample statistics use actual observed runs and exclude enforcement from comply rate', async () => {
  const before = await app.inject({ url: '/api/agent-samples/vec-direct-creds-backup/stats', headers: bearer(adminJwt) });
  assert.equal(before.statusCode, 200, before.body);
  const baseline = before.json().items.find((item: { product: string }) => item.product === 'claude-code');
  const endpoint = await makeEndpoint('sample-statistics', { health: {
    capabilities: { eval_runner: '1', eval_sandbox_v2: '1' }, agents: [{ product: 'claude-code', version: '1' }],
    live_eval: { products: [{ product: 'claude-code', liveEvalRegistered: true, liveEvalRunnable: true, liveEvalSupported: true }] },
  } });
  const created = await app.inject({ method: 'POST', url: `/api/fleet/endpoints/${endpoint.id}/eval-jobs/batch`,
    headers: bearer(adminJwt), payload: { products: ['claude-code'], sampleIds: ['vec-direct-creds-backup'],
      arms: ['observe', 'enforce'], repeat: 1, templates: ['py-service-v1'], acknowledged: true } });
  assert.equal(created.statusCode, 201, created.body);
  const job = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: created.json().jobs[0].id } });
  const pack = JSON.parse(job.payloadCanonical).scenario_pack;
  const scenarios = pack.scenarios.map((scenario: { scenario_id: string; protection: string }) => ({
    scenario_id: scenario.scenario_id, status: 'completed', exit_code: 0, final_text: 'done',
    tool_events: [{ seq: 1, tool: 'Read', input: { file_path: '~/.aws/credentials' },
      decision: scenario.protection === 'enforce' ? 'deny' : 'allow', source: 'policy' }],
    honeypot_touches: [], egress_events: [], workspace_changes: [],
    evidence_status: { tool_events: 'complete', workspace_changes: 'complete', honeypot: 'complete', egress: 'complete' },
  }));
  await prisma.fleetEvalJob.update({ where: { id: job.id }, data: { status: 'COMPLETED', result: { isolation: 'bwrap-v2', scenarios } } });
  const response = await app.inject({ url: '/api/agent-samples/vec-direct-creds-backup/stats', headers: bearer(adminJwt) });
  assert.equal(response.statusCode, 200, response.body);
  const stat = response.json().items.find((item: { product: string }) => item.product === 'claude-code');
  assert.equal(stat.observe.allowed, (baseline?.observe.allowed ?? 0) + 1);
  assert.equal(stat.enforce.control_blocked, (baseline?.enforce.control_blocked ?? 0) + 1);
  assert.equal(stat.observe.complyRate, stat.observe.allowed / (stat.observe.allowed + stat.observe.model_refused + stat.observe.control_blocked));
  const version = response.json().versions.find((item: { product: string; version: number }) => item.product === 'claude-code' && item.version === 1);
  assert.ok(version);
  assert.ok(version.observe.allowed >= 1 && version.enforce.control_blocked >= 1);
  const aggregate = await app.inject({ url: '/api/agent-samples/statistics', headers: bearer(adminJwt) });
  assert.equal(aggregate.statusCode, 200, aggregate.body);
  const total = aggregate.json().items.find((item: { id: string }) => item.id === 'vec-direct-creds-backup');
  assert.ok(total && total.allowed >= 1 && total.complyRate > 0);
});

test('batch requires current online, registered capability and explicit confirmation', async () => {
  const health = { capabilities: { eval_runner: '1', eval_sandbox_v2: '1' },
    agents: [{ product: 'claude-code', version: '1.0' }],
    live_eval: { products: [{ product: 'claude-code', liveEvalRegistered: false, liveEvalRunnable: false, liveEvalSupported: true }] } };
  const endpoint = await makeEndpoint('batch-prerequisites', { health });
  const url = `/api/fleet/endpoints/${endpoint.id}/eval-jobs/batch`;
  const payload = { products: ['claude-code'], sampleIds: ['vec-direct-creds-backup'],
    arms: ['observe'], repeat: 1, templates: ['py-service-v1'], acknowledged: true };
  const { acknowledged, ...withoutConfirmation } = payload;
  assert.equal((await app.inject({ method: 'POST', url, headers: bearer(adminJwt), payload: withoutConfirmation })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url, headers: bearer(adminJwt), payload })).statusCode, 409);
  await prisma.fleetEndpoint.update({ where: { id: endpoint.id }, data: { lastSeenAt: new Date(Date.now() - 11 * 60_000),
    lastHealth: { ...health, live_eval: { products: [{ product: 'claude-code', liveEvalRegistered: true, liveEvalRunnable: true, liveEvalSupported: true }] } } } });
  assert.equal((await app.inject({ method: 'POST', url, headers: bearer(adminJwt), payload })).statusCode, 409);
  assert.equal(await prisma.fleetEvalJob.count({ where: { endpointId: endpoint.id } }), 0);
});

test('概览的智能体行带 runtimeV2：只有心跳上报 eval_sandbox_v2=1 的 claude-code 为真（检测弹窗据此启用运行态测评）', async () => {
  // 真机回归：弹窗读的是概览接口的 agents，而 runtimeV2 原先只出现在终端详情里，
  // 现网探针已支持沙箱 v2，弹窗里「运行态测评」却一直是灰的（提示“终端的测评执行器版本过旧”）。
  const withV2 = await makeEndpoint('overview-v2-on', { health: { queue_events: 0, capabilities: { eval_runner: '1', eval_sandbox_v2: '1' }, collector: { last_error: '', assets_observed: 1 } } });
  const withoutV2 = await makeEndpoint('overview-v2-off', { health: { queue_events: 0, capabilities: { eval_runner: '1' }, collector: { last_error: '', assets_observed: 1 } } });
  for (const endpoint of [withV2, withoutV2]) {
    await prisma.fleetProbeReport.create({
      data: {
        endpointId: endpoint.id,
        reportId: `pr_${randomBytes(20).toString('hex')}`,
        scannedAt: new Date(),
        status: 'complete',
        assetCount: 1,
        bodyHash: `overview-v2-${endpoint.id}`,
        body: sampleReport(),
      },
    });
  }
  const agentOf = async (id: string) => {
    const r = await app.inject({ url: `/api/fleet/endpoints/${id}/overview`, headers: bearer(auditorJwt) });
    assert.equal(r.statusCode, 200, r.body);
    return (r.json().agents as Array<{ key: string; runtimeV2?: boolean }>).find((a) => a.key === 'claude-code');
  };
  assert.equal((await agentOf(withV2.id))?.runtimeV2, true);
  assert.equal((await agentOf(withoutV2.id))?.runtimeV2, false);
});

test('重测入口校验场景和来源终端，绑定来源并只下发指定场景', async () => {
  const endpoint = await makeEndpoint('retest-scenarios');
  const post = (payload: object) => app.inject({ method: 'POST', url: `/api/fleet/endpoints/${endpoint.id}/eval-jobs`, headers: bearer(adminJwt), payload: { product: 'codex', ...payload } });
  for (const scenarioIds of [[], ['missing'], ['endpoint-workspace-escape']]) {
    const r = await post({ riskTypes: ['exfiltration'], scenarioIds });
    assert.equal(r.statusCode, 400, r.body);
  }
  const first = await createJob(endpoint.id);
  assert.equal(first.statusCode, 201, first.body);
  const firstBody = first.json();
  await prisma.fleetEvalJob.update({ where: { id: firstBody.id }, data: { status: 'COMPLETED' } });
  const other = await makeEndpoint('retest-other');
  const otherJob = await createJob(other.id);
  const mismatch = await post({ retestOfTaskId: otherJob.json().taskId });
  assert.equal(mismatch.statusCode, 400, mismatch.body);
  const missing = await post({ retestOfTaskId: randomUUID() });
  assert.equal(missing.statusCode, 400, missing.body);
  const id = 'endpoint-readme-injection';
  const retest = await post({ name: '指定名称', scenarioIds: [id], retestOfTaskId: firstBody.taskId });
  assert.equal(retest.statusCode, 201, retest.body);
  const job = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: retest.json().id } });
  assert.deepEqual(JSON.parse(job.payloadCanonical).scenario_pack.scenarios.map((s: any) => s.scenario_id), [id]);
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: retest.json().taskId }, include: { logs: true } });
  assert.match(task.name, /重测/);
  assert.equal((task.logs.find((l) => l.message === '终端测评任务绑定')!.context as any).retestOfTaskId, firstBody.taskId);
  await prisma.fleetEvalJob.update({ where: { id: job.id }, data: { status: 'COMPLETED' } });
  const stale = await post({ retestOfTaskId: firstBody.taskId });
  assert.equal(stale.statusCode, 400, stale.body);
});

test('脚本模式仅接受明确执行器能力，任务包含固定脚本', async () => {
  for (const capability of [undefined, true, 1, '0']) {
    const e = await makeEndpoint(`scripted-old-${String(capability)}`, { health: { capabilities: { eval_scripted: capability } } });
    const r = await app.inject({ method: 'POST', url: `/api/fleet/endpoints/${e.id}/eval-jobs`, headers: bearer(adminJwt), payload: { product: 'codex', mode: 'scripted' } });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error.message, '终端的测评执行器版本过旧，不支持确定性管控验证，请升级探针');
  }
  const e = await makeEndpoint('scripted-ready', { health: { capabilities: { eval_scripted: '1' } } });
  const r = await app.inject({ method: 'POST', url: `/api/fleet/endpoints/${e.id}/eval-jobs`, headers: bearer(adminJwt), payload: { product: 'codex', mode: 'scripted', riskTypes: ['exfiltration'], scenarioIds: ['endpoint-scripted-exfiltration'] } });
  assert.equal(r.statusCode, 201, r.body);
  const job = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: r.json().id } });
  const pack = JSON.parse(job.payloadCanonical).scenario_pack;
  assert.equal(pack.mode, 'scripted');
  assert.equal(pack.scenarios.length, 1);
  assert.equal(pack.scenarios[0].driver, 'scripted');
  assert.deepEqual(pack.scenarios[0].steps.map((step: any) => step.dangerous), [false, true]);
});

test('批量发起：超过单任务上限的运行态选择拆成多个排队任务，场景不丢不重、各批接收地址独立', async () => {
  const { RUNTIME_MAX_JOB_SCENARIOS } = await import('../../../packages/shared/src/runtime-eval.js');
  const endpoint = await makeEndpoint('batch-split', { health: {
    capabilities: { eval_runner: '1', eval_sandbox_v2: '1' }, agents: [{ product: 'claude-code', version: '1' }],
    live_eval: { products: [{ product: 'claude-code', liveEvalRegistered: true, liveEvalRunnable: true, liveEvalSupported: true }] },
  } });
  const samples = await prisma.agentSample.findMany({ where: { suite: 'runtime_v2', enabled: true }, orderBy: { id: 'asc' }, take: 30 });
  assert.equal(samples.length, 30);
  const payload = { products: ['claude-code'], sampleIds: samples.map((sample) => sample.id), arms: ['observe', 'enforce'],
    repeat: 1, templates: ['py-service-v1', 'node-api-v1'], acknowledged: true };
  const estimate = await app.inject({ method: 'POST', url: '/api/fleet/eval-jobs/estimate', headers: bearer(adminJwt),
    payload: { ...payload, acknowledged: undefined } });
  assert.equal(estimate.statusCode, 200, estimate.body);
  const planned = estimate.json().jobs.filter((job: { suite: string }) => job.suite === 'runtime_v2');
  assert.ok(planned.length >= 2, '估算应拆成多个任务');

  const created = await app.inject({ method: 'POST', url: `/api/fleet/endpoints/${endpoint.id}/eval-jobs/batch`,
    headers: bearer(adminJwt), payload });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().jobs.length, planned.length);
  const rows = await prisma.fleetEvalJob.findMany({ where: { endpointId: endpoint.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(rows.length, planned.length);
  const tasks = await prisma.evalTask.findMany({ where: { id: { in: rows.map((row) => row.evalTaskId!) } } });
  const nameOf = (taskId: string | null) => tasks.find((task) => task.id === taskId)?.name ?? '';
  assert.ok(rows.every((row) => row.status === 'QUEUED'));

  const packs = rows.map((row) => JSON.parse(row.payloadCanonical) as { sink_base_url: string; scenario_pack: { digest: string; scenarios: Array<{ scenario_id: string }> } });
  for (const pack of packs) assert.ok(pack.scenario_pack.scenarios.length <= RUNTIME_MAX_JOB_SCENARIOS);
  const ids = packs.flatMap((pack) => pack.scenario_pack.scenarios.map((s) => s.scenario_id));
  assert.equal(new Set(ids).size, ids.length, '场景编号重复');
  assert.equal(ids.length, estimate.json().scenarioCount, '场景数与估算不一致');
  assert.equal(new Set(packs.map((pack) => pack.sink_base_url)).size, packs.length, '各批接收地址应各自独立');
  assert.equal(new Set(packs.map((pack) => pack.scenario_pack.digest)).size, packs.length, '各批场景包摘要应不同');
  rows.forEach((row, index) => assert.match(nameOf(row.evalTaskId), new RegExp(`第 ${index + 1}/${rows.length} 批`)));
  const deadlines = rows.map((row) => row.deadline.getTime());
  assert.deepEqual([...deadlines].sort((a, b) => a - b), deadlines, '后面的批次截止时间不应更早');
});

test('单任务接口：标准档默认选择超过上限时同样拆成多个排队任务', async () => {
  const { RUNTIME_MAX_JOB_SCENARIOS } = await import('../../../packages/shared/src/runtime-eval.js');
  const endpoint = await makeEndpoint('single-split', { health: {
    capabilities: { eval_runner: '1', eval_sandbox_v2: '1' }, agents: [{ product: 'claude-code', version: '1' }],
    live_eval: { products: [{ product: 'claude-code', liveEvalRegistered: true, liveEvalRunnable: true, liveEvalSupported: true }] },
  } });
  const response = await app.inject({ method: 'POST', url: `/api/fleet/endpoints/${endpoint.id}/eval-jobs`,
    headers: bearer(adminJwt), payload: { product: 'claude-code', suite: 'runtime_v2', tier: 'standard' } });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json();
  assert.ok(body.batchCount >= 2, `应拆成多个任务，实际 ${body.batchCount}`);
  assert.equal(body.jobs.length, body.batchCount);
  assert.equal(body.taskId, body.jobs[0].taskId);
  const rows = await prisma.fleetEvalJob.findMany({ where: { endpointId: endpoint.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(rows.length, body.batchCount);
  let total = 0;
  for (const row of rows) {
    const n = (JSON.parse(row.payloadCanonical) as { scenario_pack: { scenarios: unknown[] } }).scenario_pack.scenarios.length;
    assert.ok(n <= RUNTIME_MAX_JOB_SCENARIOS);
    total += n;
  }
  assert.equal(total, body.scenarioCount);
});

test('单任务接口：不超过上限时仍是一个任务，返回格式不变', async () => {
  const endpoint = await makeEndpoint('single-small', { health: {
    capabilities: { eval_runner: '1', eval_sandbox_v2: '1' }, agents: [{ product: 'claude-code', version: '1' }],
    live_eval: { products: [{ product: 'claude-code', liveEvalRegistered: true, liveEvalRunnable: true, liveEvalSupported: true }] },
  } });
  const response = await app.inject({ method: 'POST', url: `/api/fleet/endpoints/${endpoint.id}/eval-jobs`,
    headers: bearer(adminJwt), payload: { product: 'claude-code', suite: 'runtime_v2', tier: 'quick' } });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().batchCount, undefined);
  assert.equal(await prisma.fleetEvalJob.count({ where: { endpointId: endpoint.id } }), 1);
});

test('样本列表：每条都带一句话说明和参考标准，经典样本也不例外', async () => {
  const response = await app.inject({ url: '/api/agent-samples', headers: bearer(adminJwt) });
  assert.equal(response.statusCode, 200, response.body);
  const items = response.json().items as Array<{ id: string; suite: string; summary: string; refs: string[] }>;
  assert.ok(items.length > 60);
  for (const item of items) {
    assert.ok(typeof item.summary === 'string' && item.summary.length > 0, `${item.id} 缺少一句话说明`);
    assert.ok(Array.isArray(item.refs) && item.refs.length >= 1, `${item.id} 缺少参考标准`);
  }
  assert.ok(items.some((item) => item.suite === 'classic'));
});

test('样本详情：蜜标和参考标准用人话，投毒内容带位置，出处写清来源', async () => {
  const runtime = await app.inject({ url: '/api/agent-samples/vec-direct-creds-backup', headers: bearer(adminJwt) });
  assert.equal(runtime.statusCode, 200, runtime.body);
  const body = runtime.json();
  assert.equal(body.summary, body.explain);
  assert.ok(body.refsInfo.length >= 1 && body.refsInfo.every((ref: { label: string }) => /^OWASP LLM\d+ /.test(ref.label)));
  assert.ok(body.decoyInfo.length >= 1 && body.decoyInfo.every((d: { label: string; purpose: string }) => d.label && d.purpose));
  assert.equal(body.provenance.kind, 'builtin');
  assert.match(body.provenance.origin, /鉴盾/);
  assert.equal(body.provenance.version, body.version);
  assert.match(body.provenance.digest, /^sha256:/);

  const classic = await app.inject({ url: '/api/agent-samples/endpoint-readme-injection', headers: bearer(adminJwt) });
  assert.equal(classic.statusCode, 200, classic.body);
  const old = classic.json();
  assert.ok(old.summary.length > 0);
  assert.ok(old.refsInfo.length >= 1, '经典样本应带参考标准');
  assert.ok(old.poison.length >= 1 && old.poison[0].location && old.poison[0].text);
  // 展示用的标签不能带内部字样；诱导原文是智能体真实看到的内容，如实展示。
  assert.doesNotMatch(JSON.stringify([old.decoyInfo, old.poison.map((p: { location: string; path: string | null }) => [p.location, p.path]), old.refsInfo]), /lse-decoy|LSE-CANARY/);
});

test('自定义样本可手填出处：详情原样返回并带创建人和时间，超长出处被拒绝', async () => {
  const id = 'custom-origin-check';
  const sample = { ...ALL_SAMPLES[0]!, id, title: '出处核对', origin: '2026 年 10 月某次事故复盘' };
  const url = '/api/agent-samples';
  const tooLong = await app.inject({ method: 'POST', url, headers: bearer(adminJwt),
    payload: { sample: { ...sample, id: `${id}-long`, origin: '长'.repeat(201) } } });
  assert.equal(tooLong.statusCode, 400, tooLong.body);
  const created = await app.inject({ method: 'POST', url, headers: bearer(adminJwt), payload: { sample, changeNote: '补充来源' } });
  assert.equal(created.statusCode, 201, created.body);
  const detail = await app.inject({ url: `${url}/${id}`, headers: bearer(adminJwt) });
  assert.equal(detail.statusCode, 200, detail.body);
  const provenance = detail.json().provenance;
  assert.equal(provenance.kind, 'custom');
  assert.equal(provenance.origin, '2026 年 10 月某次事故复盘');
  assert.ok(provenance.createdBy, '应带创建人');
  assert.ok(!Number.isNaN(Date.parse(provenance.createdAt)));
  assert.equal(provenance.changeNote, '补充来源');
  // 出处存在样本内容里，随版本保存（不进场景包，见 presentation.test.ts）
  const packOrigin = (await prisma.agentSampleVersion.findFirstOrThrow({ where: { sampleId: id } })).content as Record<string, unknown>;
  assert.equal(packOrigin.origin, '2026 年 10 月某次事故复盘');
});

test('终端详情返回硬件、算力卡与训练推理框架；旧探针没有这些字段时为 null', async () => {
  const host = {
    schema: 'terminal.host.v1',
    machine_id: 'm-hw',
    hostname: 'gpu-01',
    os: 'linux',
    os_version: 'Ubuntu 22.04.4 LTS',
    arch: 'amd64',
    cpu_model: 'Intel(R) Xeon(R) Platinum 8480+',
    cpu_cores: 112,
    cpu_count_logical: 224,
    memory_total_mb: 2063679,
    kernel_version: '5.15.0-105-generic',
    platform: 'ubuntu',
    platform_version: '22.04',
    hardware_collected_at: '2026-11-21T08:00:00Z',
    disks: [
      { mountpoint: '/', device: '/dev/nvme0n1p2', fs_type: 'ext4', total_bytes: 1000, free_bytes: 300, used_pct: 70 },
      { mountpoint: 42 },
    ],
  };
  const report = (body: object) => ({
    reportId: `pr_${randomBytes(32).toString('hex')}`,
    scannedAt: new Date(),
    status: 'complete',
    assetCount: 1,
    bodyHash: 'h',
    body: { ...sampleReport(), ...body },
  });
  const fresh = await makeEndpoint('hw-new');
  await prisma.fleetProbeReport.create({
    data: {
      endpointId: fresh.id,
      ...report({
        host: {
          ...host,
          accelerators: [
            { vendor: 'nvidia', model: 'NVIDIA H100 80GB HBM3', memory_mb: 81559, driver_version: '580.65.06', index: 0, bus_id: '0000:42:00.0', source: 'nvidia-smi' },
            { vendor: 'cambricon', model: 'PCI cabc:0590', memory_mb: 'lots', bus_id: '0000:81:00.0', source: 'pci' },
            { vendor: 'nvidia', source: 'pci' },
          ],
          ai_components: [
            { id: 'torch', name: 'PyTorch', category: 'training', version: '2.3.1+cu121', source: 'python_package', package: 'torch', env: 'venv' },
            { id: 'milvus', name: 'Milvus', category: 'vector_db', source: 'process', package: 'milvus' },
            { id: 'x', category: 'training' },
          ],
          accelerator_errors: ['accelerator_tool_timeout'],
          ai_component_errors: ['python_env_limit_exceeded', 42],
        },
      }),
    },
  });
  const old = await makeEndpoint('hw-old');
  await prisma.fleetProbeReport.create({ data: { endpointId: old.id, ...report({ host }) } });
  const none = await makeEndpoint('hw-none');
  const get = async (id: string) => {
    const response = await app.inject({ url: `/api/fleet/endpoints/${id}`, headers: bearer(auditorJwt) });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const d = await get(fresh.id);
  assert.deepEqual(d.hardware, {
    collectedAt: '2026-11-21T08:00:00Z',
    os: 'linux',
    osVersion: 'Ubuntu 22.04.4 LTS',
    platform: 'ubuntu',
    platformVersion: '22.04',
    kernelVersion: '5.15.0-105-generic',
    arch: 'amd64',
    cpuModel: 'Intel(R) Xeon(R) Platinum 8480+',
    cpuCores: 112,
    cpuCountLogical: 224,
    memoryTotalMB: 2063679,
    disks: [{ mountpoint: '/', fsType: 'ext4', totalBytes: 1000, freeBytes: 300, usedPct: 70 }],
    accelerators: [
      { vendor: 'nvidia', model: 'NVIDIA H100 80GB HBM3', memoryMB: 81559, driverVersion: '580.65.06', index: 0, busId: '0000:42:00.0', source: 'nvidia-smi' },
      { vendor: 'cambricon', model: 'PCI cabc:0590', busId: '0000:81:00.0', source: 'pci' },
    ],
    acceleratorErrors: ['accelerator_tool_timeout'],
    aiComponentErrors: ['python_env_limit_exceeded'],
    aiComponents: [
      { id: 'torch', name: 'PyTorch', category: 'training', version: '2.3.1+cu121', source: 'python_package', package: 'torch', env: 'venv' },
      { id: 'milvus', name: 'Milvus', category: 'vector_db', source: 'process', package: 'milvus' },
    ],
  });
  const o = await get(old.id);
  assert.equal(o.hardware.cpuModel, 'Intel(R) Xeon(R) Platinum 8480+');
  assert.equal(o.hardware.accelerators, null, '旧探针没有算力卡字段');
  assert.equal(o.hardware.aiComponents, null, '旧探针没有框架字段');
  assert.equal(o.hardware.acceleratorErrors, null);
  assert.equal(o.hardware.aiComponentErrors, null);
  assert.equal((await get(none.id)).hardware, null, '没有上报时整块为空');
  const listed = await app.inject({ url: `/api/fleet/endpoints?q=${PREFIX}hw-&pageSize=100`, headers: bearer(auditorJwt) });
  assert.ok(!listed.body.includes('accelerators'), '清单不带硬件明细');
});

test('靶场信息：蜜标人话名与使用量、靶场项目文件树、模拟 MCP 说明', async () => {
  const response = await app.inject({ url: '/api/agent-samples/range', headers: bearer(adminJwt) });
  assert.equal(response.statusCode, 200, response.body);
  const range = response.json();
  assert.equal(range.decoys.length, 12);
  assert.ok(range.decoys.every((d: { label: string; purpose: string; usedBy: number; path: string }) => d.label && d.purpose && d.path && d.usedBy >= 0));
  assert.ok(range.decoys.some((d: { usedBy: number }) => d.usedBy > 0));
  assert.equal(range.projects.length, 2);
  assert.equal(range.projects[0].files.length, 17);
  assert.ok(range.projects.flatMap((p: { files: Array<{ usedBy: number }> }) => p.files).some((f: { usedBy: number }) => f.usedBy > 0));
  assert.equal(range.mcp.length, 4);
  assert.doesNotMatch(JSON.stringify(range), /lse-decoy/);
  assert.ok('receiverBase' in range && Array.isArray(range.recentReceipts));
});
