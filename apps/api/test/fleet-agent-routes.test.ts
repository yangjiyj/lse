// /agent/v1/* 终端接入协议：真实 Fastify 注入 + 测试库。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { generateEnrollmentCode, hashSecret } from '../src/modules/fleet-agent/auth.js';
import { buildJobPayload, sha256Hex } from '../src/modules/fleet-agent/checksum.js';
import { registerFleetJobFinishedHook } from '../src/modules/fleet-agent/hooks.js';
import { noopLimiter, TokenBucketLimiter } from '../src/modules/fleet-agent/rate-limit.js';
import { fleetAgentRoutes } from '../src/modules/fleet-agent/routes.js';

const LABEL = '__fleet_agent_test_';
const P = '/agent/v1';
let app: FastifyInstance;
const previousFlag = process.env.FLEET_AGENT_ENABLED;

async function cleanup() {
  const codes = await prisma.fleetEnrollmentCode.findMany({
    where: { label: { startsWith: LABEL } },
    select: { id: true },
  });
  const ids = codes.map((c) => c.id);
  // 终端删除会级联删除报告与任务。
  await prisma.fleetEndpoint.deleteMany({ where: { enrollmentCodeId: { in: ids } } });
  await prisma.fleetEnrollmentCode.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  process.env.FLEET_AGENT_ENABLED = 'true';
  await cleanup();
  app = await buildApp({
    fleetAgent: { rateLimiters: { ip: noopLimiter, register: noopLimiter, endpoint: noopLimiter } },
  });
  await app.ready();
});

after(async () => {
  await app.close();
  await cleanup();
  await prisma.$disconnect();
  if (previousFlag === undefined) delete process.env.FLEET_AGENT_ENABLED;
  else process.env.FLEET_AGENT_ENABLED = previousFlag;
});

// ---------- 帮助函数 ----------
async function createCode(
  opts: { maxUses?: number; expiresAt?: Date; status?: 'ACTIVE' | 'REVOKED' | 'EXPIRED' } = {},
) {
  const code = generateEnrollmentCode();
  const row = await prisma.fleetEnrollmentCode.create({
    data: {
      label: LABEL + randomUUID(),
      codeHash: hashSecret(code),
      codePrefix: code.slice(0, 8),
      maxUses: opts.maxUses ?? 5,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 3600_000),
      status: opts.status ?? 'ACTIVE',
    },
  });
  return { code, id: row.id };
}

const registerBody = (patch: Record<string, unknown> = {}) => ({
  machine_id: '43d1c24cc41541068f2318c4e5462ff9',
  installation_id: randomUUID(),
  hostname: 'demo-host',
  os: 'linux',
  os_version: 'Ubuntu 26.04 LTS',
  arch: 'amd64',
  os_user: 'yj',
  agent_product: 'aiprobe',
  agent_version: 'a'.repeat(40),
  adapter_name: 'platform-inventory',
  adapter_version: 'b'.repeat(40),
  capabilities: ['asset_snapshot', 'config_change'],
  ...patch,
});

function register(code: string, body: unknown = registerBody(), target = app) {
  return target.inject({
    method: 'POST',
    url: `${P}/endpoints/register`,
    headers: { authorization: `Bearer ${code}` },
    payload: body as Record<string, unknown>,
  });
}

interface Ep {
  id: string;
  token: string;
  internalId: string;
}

async function enroll(maxUses = 5): Promise<Ep> {
  const { code } = await createCode({ maxUses });
  const res = await register(code);
  assert.equal(res.statusCode, 200, res.body);
  const { endpoint_id, endpoint_token } = res.json();
  const row = await prisma.fleetEndpoint.findUniqueOrThrow({ where: { publicId: endpoint_id } });
  return { id: endpoint_id, token: endpoint_token, internalId: row.id };
}

function call(
  ep: Ep | string,
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  const token = typeof ep === 'string' ? ep : ep.token;
  return app.inject({
    method,
    url: `${P}${path}`,
    headers: { authorization: `Bearer ${token}`, ...headers },
    ...(payload === undefined
      ? {}
      : typeof payload === 'string'
        ? {
            payload,
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              ...headers,
            },
          }
        : { payload: payload as Record<string, unknown> }),
  });
}

function assertJson200(res: LightMyRequestResponse) {
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['content-type']), /^application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  return res.json();
}

const PACK = {
  pack_id: 'probe-proto-harmless',
  digest: 'sha256:' + '0'.repeat(64),
  scenarios: [
    {
      scenario_id: 's1',
      title: '回复 OK',
      prompt: '请只回复 OK。',
      fixtures: [],
      canaries: [],
      max_turns: 1,
      timeout_sec: 60,
    },
    {
      scenario_id: 's2',
      title: '第二个',
      prompt: '<script>a&b</script>',
      fixtures: [{ path: 'src/x.txt', content: 'x' }],
      canaries: ['LSE_CANARY_1'],
      max_turns: 2,
      timeout_sec: 30,
    },
  ],
};

async function createJob(
  ep: Ep,
  opts: {
    status?: 'PENDING_APPROVAL' | 'QUEUED' | 'DELIVERED' | 'RUNNING' | 'COMPLETED';
    deadline?: Date;
    createdAt?: Date;
  } = {},
) {
  const { canonical, checksum } = buildJobPayload(
    'claude-code',
    PACK,
    'https://jiandun.example/sink',
  );
  const publicId = 'lej_' + randomBytes(16).toString('hex');
  const row = await prisma.fleetEvalJob.create({
    data: {
      publicId,
      endpointId: ep.internalId,
      product: 'claude-code',
      payloadCanonical: canonical,
      checksum,
      scenarioCount: PACK.scenarios.length,
      status: opts.status ?? 'QUEUED',
      deadline: opts.deadline ?? new Date(Date.now() + 1800_000),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  return { publicId, checksum, internalId: row.id };
}

const scenarioResult = (id: string, patch: Record<string, unknown> = {}) => ({
  scenario_id: id,
  status: 'completed',
  exit_code: 0,
  duration_ms: 132,
  final_text: 'OK',
  tool_events: [],
  transcript_excerpt: '…',
  canary_hits: [],
  workspace_changes: [],
  ...patch,
});
const result = (scenarios = [scenarioResult('s1'), scenarioResult('s2')], patch = {}) => ({
  runner_version: '1',
  product: 'claude-code',
  product_version: 'fake-agent 0.0.1',
  os: 'linux',
  isolation: 'bwrap',
  model_route: 'vendor',
  registry_untrusted: true,
  scenarios,
  ...patch,
});

function report(ep: Ep, patch: Record<string, unknown> = {}, scannedAt?: string) {
  const at = scannedAt ?? new Date(Date.now() - 1000).toISOString().slice(0, 19) + 'Z';
  return {
    schema_version: 'aiprobe.report.v1',
    endpoint_id: ep.id,
    report_id: 'pr_' + sha256Hex(ep.id + '\u0000' + at),
    scanned_at: at,
    status: 'complete',
    probe_version: 'x',
    assets: [{ kind: 'mcp', name: 'a', url: 'http://169.254.169.254/' }, { kind: 'skill' }],
    collectors: [{ name: 'c1' }],
    ...patch,
  };
}

/** 把任务推进到 RUNNING。 */
async function toRunning(ep: Ep, job: { publicId: string; checksum: string }) {
  assertJson200(
    await call(ep, 'POST', `/eval-jobs/${job.publicId}/ack`, { checksum: job.checksum }),
  );
  assertJson200(await call(ep, 'POST', `/eval-jobs/${job.publicId}/started`, {}));
}

// ---------- 开关 ----------
test('开关关闭：所有 /agent/v1 路径一律 404（含未知路径与合法令牌）', async () => {
  const ep = await enroll();
  process.env.FLEET_AGENT_ENABLED = 'false';
  try {
    for (const [method, url] of [
      ['POST', '/endpoints/register'],
      ['POST', '/endpoints/heartbeat'],
      ['POST', '/probe-reports'],
      ['GET', '/policy'],
      ['GET', '/credential-deliveries'],
      ['GET', '/eval-jobs'],
      ['POST', '/eval-jobs/lej_x/ack'],
      ['GET', '/nonexistent'],
    ] as const) {
      const res = await call(ep, method, url, method === 'POST' ? {} : undefined);
      assert.equal(res.statusCode, 404, `${method} ${url}`);
    }
  } finally {
    process.env.FLEET_AGENT_ENABLED = 'true';
  }
});

test('不影响平台 /api/* 的登录鉴权；/agent/v1 不接受平台 JWT 当终端令牌', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/users' });
  assert.equal(res.statusCode, 401);
  const jwt = app.jwt.sign({ sub: randomUUID(), username: 'x' });
  assert.equal((await call(jwt, 'GET', '/eval-jobs')).statusCode, 401);
});

// ---------- §1 登记 ----------
test('登记成功：200 JSON，令牌只存哈希，接入码 usedCount+1', async () => {
  const { code, id } = await createCode({ maxUses: 2 });
  const body = registerBody();
  const json = assertJson200(await register(code, body));
  assert.deepEqual(Object.keys(json).sort(), [
    'capture_level',
    'endpoint_id',
    'endpoint_token',
    'mode',
  ]);
  assert.match(json.endpoint_id, /^ep_[0-9a-f]{20}$/);
  assert.match(json.endpoint_token, /^[0-9a-f]{64}$/);
  assert.equal(json.mode, 'monitor');
  assert.equal(json.capture_level, 'metadata');
  const row = await prisma.fleetEndpoint.findUniqueOrThrow({
    where: { publicId: json.endpoint_id },
  });
  assert.equal(row.tokenHash, hashSecret(json.endpoint_token));
  assert.equal(row.installationId, body.installation_id);
  assert.equal(row.hostname, 'demo-host');
  assert.deepEqual(row.capabilities, ['asset_snapshot', 'config_change']);
  assert.equal(row.enrollmentCodeId, id);
  assert.equal(
    (await prisma.fleetEnrollmentCode.findUniqueOrThrow({ where: { id } })).usedCount,
    1,
  );
});

test('登记幂等：同码同 installation_id 同 machine_id → 复用终端、轮换令牌、不占配额', async () => {
  const { code, id } = await createCode({ maxUses: 1 });
  const body = registerBody();
  const first = assertJson200(await register(code, body));
  const second = assertJson200(await register(code, body));
  assert.equal(second.endpoint_id, first.endpoint_id);
  assert.notEqual(second.endpoint_token, first.endpoint_token);
  assert.equal(
    (await prisma.fleetEnrollmentCode.findUniqueOrThrow({ where: { id } })).usedCount,
    1,
  );
  // 旧令牌失效，新令牌可用
  assert.equal((await call(first.endpoint_token, 'GET', '/eval-jobs')).statusCode, 401);
  assertJson200(await call(second.endpoint_token, 'GET', '/eval-jobs'));
  // 配额已满时新 installation 被拒
  assert.equal((await register(code, registerBody())).statusCode, 403);
  // 同 installation_id 不同 machine_id → 拒绝
  const other = await register(code, { ...body, machine_id: 'ffff' });
  assert.equal(other.statusCode, 403);
  // 同 installation_id 换接入码 → 拒绝（installation 绑定登记它的接入码）
  const { code: code2 } = await createCode();
  assert.equal((await register(code2, body)).statusCode, 403);
});

test('接入码无效/过期/撤销/已满/缺失：统一 403 同一 body', async () => {
  const expired = await createCode({ expiresAt: new Date(Date.now() - 1000) });
  const revoked = await createCode({ status: 'REVOKED' });
  const full = await createCode({ maxUses: 1 });
  assertJson200(await register(full.code));
  const bodies = new Set<string>();
  for (const code of ['jdc_nonexistent', expired.code, revoked.code, full.code]) {
    const res = await register(code);
    assert.equal(res.statusCode, 403, code);
    bodies.add(res.body);
  }
  const missing = await app.inject({
    method: 'POST',
    url: `${P}/endpoints/register`,
    payload: registerBody(),
  });
  assert.equal(missing.statusCode, 403);
  bodies.add(missing.body);
  assert.deepEqual([...bodies], ['{"error":"enrollment_rejected"}']);
});

test('登记请求体不合法 → 400（未占用配额）', async () => {
  const { code, id } = await createCode({ maxUses: 1 });
  const bads: unknown[] = [
    registerBody({ agent_product: 'other' }),
    registerBody({ machine_id: '' }),
    registerBody({ machine_id: '   ' }),
    registerBody({ hostname: 'h'.repeat(257) }),
    registerBody({ os: undefined }),
    registerBody({ arch: 1 }),
    registerBody({ installation_id: randomUUID().toUpperCase() }),
    registerBody({ installation_id: '229fd39d-1787-1541-9c8d-f32c4e207c72' }), // v1
    registerBody({ installation_id: 'not-a-uuid' }),
    registerBody({ os_version: 'x'.repeat(257) }),
    registerBody({ capabilities: ['a', 'a'] }),
    registerBody({ capabilities: Array.from({ length: 65 }, (_, i) => `c${i}`) }),
    registerBody({ capabilities: 'asset_snapshot' }),
    registerBody({ hostname: 'a\u0000b' }),
    [registerBody()],
  ];
  for (const body of bads) {
    const res = await register(code, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body).slice(0, 120));
  }
  const notJson = await app.inject({
    method: 'POST',
    url: `${P}/endpoints/register`,
    headers: { authorization: `Bearer ${code}`, 'content-type': 'application/json' },
    payload: '{bad',
  });
  assert.equal(notJson.statusCode, 400);
  assert.equal(
    (await prisma.fleetEnrollmentCode.findUniqueOrThrow({ where: { id } })).usedCount,
    0,
  );
});

test('并发登记同一接入码（maxUses=3，并发 12 个不同终端）：恰好 3 个成功，不超卖', async () => {
  const { code, id } = await createCode({ maxUses: 3 });
  const results = await Promise.all(Array.from({ length: 12 }, () => register(code)));
  const statuses = results.map((r) => r.statusCode).sort();
  assert.deepEqual(statuses, [200, 200, 200, ...Array(9).fill(403)]);
  assert.equal(
    (await prisma.fleetEnrollmentCode.findUniqueOrThrow({ where: { id } })).usedCount,
    3,
  );
  assert.equal(await prisma.fleetEndpoint.count({ where: { enrollmentCodeId: id } }), 3);
});

test('并发登记同一 installation_id：全部成功、同一终端、只占 1 个配额', async () => {
  const { code, id } = await createCode({ maxUses: 3 });
  const body = registerBody();
  const results = await Promise.all(Array.from({ length: 6 }, () => register(code, body)));
  for (const r of results) assert.equal(r.statusCode, 200, r.body);
  assert.equal(new Set(results.map((r) => r.json().endpoint_id)).size, 1);
  assert.equal(
    (await prisma.fleetEnrollmentCode.findUniqueOrThrow({ where: { id } })).usedCount,
    1,
  );
  assert.equal(await prisma.fleetEndpoint.count({ where: { enrollmentCodeId: id } }), 1);
});

// ---------- 通用鉴权 ----------
test('终端令牌缺失/错误/被吊销 → 401；未实现端点先鉴权再 404', async () => {
  const ep = await enroll();
  for (const path of ['/eval-jobs', '/policy', '/credential-deliveries', '/behavior-reports']) {
    assert.equal((await app.inject({ method: 'GET', url: P + path })).statusCode, 401, path);
    assert.equal((await call('0'.repeat(64), 'GET', path)).statusCode, 401, path);
  }
  const unknown = await call(ep, 'POST', '/behavior-reports', {});
  assert.equal(unknown.statusCode, 404);
  assert.equal((await call(ep, 'GET', '/managed-profiles')).statusCode, 404);
  await prisma.fleetEndpoint.update({
    where: { id: ep.internalId },
    data: { status: 'REVOKED', revokedAt: new Date() },
  });
  assert.equal((await call(ep, 'GET', '/eval-jobs')).statusCode, 401);
  assert.equal(
    (await call(ep, 'POST', '/endpoints/heartbeat', { endpoint_id: ep.id, health: {} })).statusCode,
    401,
  );
});

// ---------- §2 心跳 ----------
test('心跳：保存 health / evalRunner / lastSeenAt；秒级 server_time', async () => {
  const ep = await enroll();
  const health = {
    queue_events: 0,
    capabilities: { eval_runner: '1' },
    collector: { last_error: '', assets_observed: 108 },
  };
  const json = assertJson200(
    await call(ep, 'POST', '/endpoints/heartbeat', {
      endpoint_id: ep.id,
      policy_version: 0,
      config_version: 0,
      health,
    }),
  );
  assert.match(json.server_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(json.revoked, false);
  assert.equal(json.upgrade, null);
  const row = await prisma.fleetEndpoint.findUniqueOrThrow({ where: { id: ep.internalId } });
  assert.deepEqual(row.lastHealth, health);
  assert.equal(row.evalRunner, '1');
  assert.ok(row.lastSeenAt && Date.now() - row.lastSeenAt.getTime() < 10_000);
  // 探针升级后版本以心跳里的部署版本为准；没有上报时保留原值。
  const revision = 'c'.repeat(40);
  assertJson200(
    await call(ep, 'POST', '/endpoints/heartbeat', {
      endpoint_id: ep.id,
      health: { ...health, collector: { deployment: { revision } } },
    }),
  );
  assert.equal(
    (await prisma.fleetEndpoint.findUniqueOrThrow({ where: { id: ep.internalId } })).agentVersion,
    revision,
  );
  assertJson200(
    await call(ep, 'POST', '/endpoints/heartbeat', {
      endpoint_id: ep.id,
      health: { collector: { deployment: { revision: '含空格 不是版本' } } },
    }),
  );
  assert.equal(
    (await prisma.fleetEndpoint.findUniqueOrThrow({ where: { id: ep.internalId } })).agentVersion,
    revision,
  );
  // 去掉 eval_runner 后清空
  assertJson200(await call(ep, 'POST', '/endpoints/heartbeat', { endpoint_id: ep.id, health: {} }));
  assert.equal(
    (await prisma.fleetEndpoint.findUniqueOrThrow({ where: { id: ep.internalId } })).evalRunner,
    null,
  );
});

test('心跳：endpoint_id 与令牌不一致 → 401；超 64 KiB → 413；非 JSON → 400', async () => {
  const a = await enroll();
  const b = await enroll();
  assert.equal(
    (await call(a, 'POST', '/endpoints/heartbeat', { endpoint_id: b.id, health: {} })).statusCode,
    401,
  );
  assert.equal((await call(a, 'POST', '/endpoints/heartbeat', { health: {} })).statusCode, 401);
  const big = await call(a, 'POST', '/endpoints/heartbeat', {
    endpoint_id: a.id,
    health: { pad: 'x'.repeat(65 * 1024) },
  });
  assert.equal(big.statusCode, 413);
  assert.equal((await call(a, 'POST', '/endpoints/heartbeat', 'not json')).statusCode, 400);
});

// ---------- §3 体检上报 ----------
test('体检上报：接受、幂等 duplicate、内容不同 409；ack 结构严格', async () => {
  const ep = await enroll();
  const body = report(ep);
  const ack = assertJson200(await call(ep, 'POST', '/probe-reports', body));
  assert.deepEqual(ack, {
    schema_version: 'aiprobe.report.ack.v1',
    report_id: body.report_id,
    accepted: true,
    duplicate: false,
    asset_count: 2,
  });
  const dup = assertJson200(await call(ep, 'POST', '/probe-reports', body));
  assert.equal(dup.duplicate, true);
  assert.equal(dup.accepted, true);
  const conflict = await call(ep, 'POST', '/probe-reports', { ...body, assets: [] });
  assert.equal(conflict.statusCode, 409);
  const row = await prisma.fleetProbeReport.findUniqueOrThrow({
    where: { reportId: body.report_id },
  });
  assert.equal(row.endpointId, ep.internalId);
  assert.equal(row.assetCount, 2);
  assert.equal(row.status, 'complete');
});

test('体检上报：主机快照带算力卡与框架组件的新探针、不带的旧探针都照常入库', async () => {
  const ep = await enroll();
  const host = { schema: 'terminal.host.v1', machine_id: 'm-hw', hostname: 'gpu-01', os: 'linux' };
  const accelerators = [
    { vendor: 'nvidia', model: 'NVIDIA H100 80GB HBM3', memory_mb: 81559, driver_version: '580.65.06', index: 0, bus_id: '0000:42:00.0', source: 'nvidia-smi' },
  ];
  const aiComponents = [
    { id: 'vllm', name: 'vLLM', category: 'inference', version: '0.6.1', source: 'python_package', package: 'vllm', env: 'conda' },
  ];
  const fresh = report(ep, { host: { ...host, accelerators, ai_components: aiComponents, ai_component_errors: ['python_env_limit_exceeded'] } });
  assertJson200(await call(ep, 'POST', '/probe-reports', fresh));
  const older = report(ep, { host }, new Date(Date.now() - 60_000).toISOString().slice(0, 19) + 'Z');
  assertJson200(await call(ep, 'POST', '/probe-reports', older));
  const stored = await prisma.fleetProbeReport.findUniqueOrThrow({ where: { reportId: fresh.report_id } });
  const storedHost = (stored.body as { host: Record<string, unknown> }).host;
  assert.deepEqual(storedHost.accelerators, accelerators);
  assert.deepEqual(storedHost.ai_components, aiComponents);
  const old = await prisma.fleetProbeReport.findUniqueOrThrow({ where: { reportId: older.report_id } });
  assert.equal('accelerators' in (old.body as { host: Record<string, unknown> }).host, false);
});

test('体检上报：各项校验', async () => {
  const ep = await enroll();
  const other = await enroll();
  const future = new Date(Date.now() + 10 * 60_000).toISOString().slice(0, 19) + 'Z';
  const cases: Array<[string, unknown, number]> = [
    ['schema_version', report(ep, { schema_version: 'aiprobe.report.v2' }), 422],
    ['endpoint_id 不一致', report(ep, { endpoint_id: other.id }), 401],
    ['scanned_at 带毫秒', report(ep, {}, '2026-10-22T05:12:46.123Z'), 422],
    ['scanned_at 非 UTC', report(ep, {}, '2026-10-22T05:12:46+08:00'), 422],
    ['scanned_at 非法日期', report(ep, {}, '2026-02-30T05:12:46Z'), 422],
    ['scanned_at 超未来 5 分钟', report(ep, {}, future), 422],
    ['report_id 不符', report(ep, { report_id: 'pr_' + '0'.repeat(64) }), 422],
    ['status 枚举', report(ep, { status: 'done' }), 422],
    ['assets 非数组', report(ep, { assets: {} }), 422],
    ['collectors 缺失', report(ep, { collectors: undefined }), 422],
  ];
  for (const [name, body, status] of cases) {
    assert.equal((await call(ep, 'POST', '/probe-reports', body)).statusCode, status, name);
  }
  // 别的终端用自己的令牌提交 A 的报告 → 401（身份只看令牌）
  assert.equal((await call(other, 'POST', '/probe-reports', report(ep))).statusCode, 401);
  // Content-Type 必须是 application/json
  const plain = await app.inject({
    method: 'POST',
    url: `${P}/probe-reports`,
    headers: { authorization: `Bearer ${ep.token}`, 'content-type': 'text/plain' },
    payload: JSON.stringify(report(ep)),
  });
  assert.equal(plain.statusCode, 415);
  // 不允许查询串
  assert.equal((await call(ep, 'POST', '/probe-reports?x=1', report(ep))).statusCode, 400);
  // 体积上限 8 MiB
  const huge = await call(
    ep,
    'POST',
    '/probe-reports',
    report(ep, { pad: 'x'.repeat(8 * 1024 * 1024) }),
  );
  assert.equal(huge.statusCode, 413);
  // 允许 partial 与时钟回拨内的时间
  assertJson200(
    await call(
      ep,
      'POST',
      '/probe-reports',
      report(ep, { status: 'partial' }, '2026-01-01T00:00:00Z'),
    ),
  );
});

// ---------- §4 / §7 ----------
test('GET /policy 与 /credential-deliveries', async () => {
  const ep = await enroll();
  const policy = assertJson200(await call(ep, 'GET', '/policy'));
  assert.equal(policy.version, 1);
  assert.match(policy.checksum, /^sha256:[0-9a-f]{64}$/);
  const managed = await call(ep, 'GET', '/policy?view=managed-config');
  assert.equal(managed.statusCode, 404);
  assert.equal(
    (await app.inject({ method: 'GET', url: `${P}/policy?view=managed-config` })).statusCode,
    401,
  );
  assert.deepEqual(assertJson200(await call(ep, 'GET', '/credential-deliveries')), { items: [] });
});

// ---------- §5 测评任务 ----------
test('GET /eval-jobs：无任务返回 []；只返回本终端 QUEUED 未过期的最早 1 条；字段与 checksum', async () => {
  const ep = await enroll();
  assert.deepEqual(assertJson200(await call(ep, 'GET', '/eval-jobs')), []);
  await createJob(ep, { status: 'PENDING_APPROVAL' });
  await createJob(ep, { deadline: new Date(Date.now() - 1000) });
  const other = await enroll();
  await createJob(other);
  assert.deepEqual(assertJson200(await call(ep, 'GET', '/eval-jobs')), []);
  const first = await createJob(ep, { createdAt: new Date(Date.now() - 60_000) });
  await createJob(ep);
  const jobs = assertJson200(await call(ep, 'GET', '/eval-jobs'));
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.deepEqual(Object.keys(job).sort(), [
    'checksum',
    'deadline',
    'job_id',
    'product',
    'scenario_pack',
    'sink_base_url',
  ]);
  assert.equal(job.job_id, first.publicId);
  assert.equal(job.product, 'claude-code');
  assert.deepEqual(job.scenario_pack, PACK);
  assert.equal(job.sink_base_url, 'https://jiandun.example/sink');
  assert.match(job.deadline, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  // 采集器侧重新计算 checksum 必须一致
  const { checksum } = buildJobPayload(job.product, job.scenario_pack, job.sink_base_url);
  assert.equal(job.checksum, checksum);
  assert.equal(job.checksum, first.checksum);
});

test('GET /eval-jobs：已有 DELIVERED/RUNNING 时返回 []；库里 checksum 被篡改的任务不下发', async () => {
  const ep = await enroll();
  const busy = await createJob(ep, { status: 'RUNNING' });
  await createJob(ep);
  assert.deepEqual(assertJson200(await call(ep, 'GET', '/eval-jobs')), []);
  await prisma.fleetEvalJob.update({
    where: { id: busy.internalId },
    data: { status: 'COMPLETED' },
  });
  assert.equal(assertJson200(await call(ep, 'GET', '/eval-jobs')).length, 1);

  const ep2 = await enroll();
  const bad = await createJob(ep2);
  await prisma.fleetEvalJob.update({
    where: { id: bad.internalId },
    data: { checksum: '0'.repeat(64) },
  });
  assert.deepEqual(assertJson200(await call(ep2, 'GET', '/eval-jobs')), []);
});

test('queued jobs are acknowledged in order and never run concurrently', async () => {
  const ep = await enroll();
  const first = await createJob(ep, { createdAt: new Date(Date.now() - 60_000) });
  const second = await createJob(ep);
  const [a, b] = await Promise.all([
    call(ep, 'POST', `/eval-jobs/${first.publicId}/ack`, { checksum: first.checksum }),
    call(ep, 'POST', `/eval-jobs/${second.publicId}/ack`, { checksum: second.checksum }),
  ]);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(b.statusCode, 409, b.body);
  assert.deepEqual(assertJson200(await call(ep, 'GET', '/eval-jobs')), []);
  await prisma.fleetEvalJob.update({ where: { id: first.internalId }, data: { status: 'COMPLETED' } });
  assert.equal((await call(ep, 'POST', `/eval-jobs/${second.publicId}/ack`, { checksum: second.checksum })).statusCode, 200);
});

test('状态机：ack → started → result(completed)，钩子被调用，结果入库', async () => {
  const ep = await enroll();
  const job = await createJob(ep);
  let resolveHook!: (id: string) => void;
  const hookCalled = new Promise<string>((r) => (resolveHook = r));
  const unregister = registerFleetJobFinishedHook((id) => resolveHook(id));
  try {
    assert.deepEqual(
      assertJson200(
        await call(ep, 'POST', `/eval-jobs/${job.publicId}/ack`, { checksum: job.checksum }),
      ),
      { job_id: job.publicId, status: 'delivered' },
    );
    assert.deepEqual(
      assertJson200(await call(ep, 'POST', `/eval-jobs/${job.publicId}/started`, {})),
      {
        job_id: job.publicId,
        status: 'running',
      },
    );
    const body = result();
    assert.deepEqual(
      assertJson200(await call(ep, 'POST', `/eval-jobs/${job.publicId}/result`, body)),
      {
        job_id: job.publicId,
        status: 'completed',
      },
    );
    assert.equal(await hookCalled, job.internalId);
  } finally {
    unregister();
  }
  const row = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: job.internalId } });
  assert.equal(row.status, 'COMPLETED');
  assert.deepEqual(row.result, result());
  assert.ok(row.deliveredAt && row.startedAt && row.finishedAt);
  assert.equal(row.errorCode, null);
  // 终态后再提交 → 409
  assert.equal(
    (await call(ep, 'POST', `/eval-jobs/${job.publicId}/result`, result())).statusCode,
    409,
  );
});

test('状态机：有场景非 completed → FAILED', async () => {
  const ep = await enroll();
  const job = await createJob(ep);
  await toRunning(ep, job);
  const json = assertJson200(
    await call(
      ep,
      'POST',
      `/eval-jobs/${job.publicId}/result`,
      result([scenarioResult('s1'), scenarioResult('s2', { status: 'timeout' })]),
    ),
  );
  assert.equal(json.status, 'failed');
  const row = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: job.internalId } });
  assert.equal(row.status, 'FAILED');
  assert.equal(row.errorCode, 'partial_scenario_failed');
  assert.ok(row.result);
});

test('状态机：场景自带的阻断原因只在没有场景跑完时作为整批原因', async () => {
  const ep = await enroll();
  // 15 个场景跑完 13 个、2 个各自超时（现网 2026-11-17 第 1 批）：整批是「部分没跑完」，不是「智能体运行超时」
  const partial = await createJob(ep);
  await toRunning(ep, partial);
  assertJson200(
    await call(ep, 'POST', `/eval-jobs/${partial.publicId}/result`,
      result([scenarioResult('s1'), scenarioResult('s2', { status: 'timeout', error_code: 'timeout' })])),
  );
  const partialRow = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: partial.internalId } });
  assert.equal(partialRow.errorCode, 'partial_scenario_failed');

  const ep2 = await enroll();
  const allTimeout = await createJob(ep2);
  await toRunning(ep2, allTimeout);
  assertJson200(
    await call(ep2, 'POST', `/eval-jobs/${allTimeout.publicId}/result`,
      result([
        scenarioResult('s1', { status: 'timeout', error_code: 'timeout' }),
        scenarioResult('s2', { status: 'timeout', error_code: 'timeout' }),
      ])),
  );
  const allRow = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: allTimeout.internalId } });
  assert.equal(allRow.errorCode, 'timeout');
});

test('状态机：非法转移 / checksum 不等 / 过期 → 409', async () => {
  const ep = await enroll();
  const job = await createJob(ep);
  const url = (a: string) => `/eval-jobs/${job.publicId}/${a}`;
  assert.equal((await call(ep, 'POST', url('started'), {})).statusCode, 409, 'QUEUED 不能 started');
  assert.equal(
    (await call(ep, 'POST', url('result'), result())).statusCode,
    409,
    'QUEUED 不能 result',
  );
  assert.equal((await call(ep, 'POST', url('ack'), { checksum: '0'.repeat(64) })).statusCode, 409);
  assert.equal(
    (await call(ep, 'POST', url('ack'), { checksum: job.checksum, extra: 1 })).statusCode,
    409,
  );
  assertJson200(await call(ep, 'POST', url('ack'), { checksum: job.checksum }));
  assert.equal(
    (await call(ep, 'POST', url('ack'), { checksum: job.checksum })).statusCode,
    409,
    '重复 ack',
  );
  assert.equal(
    (await call(ep, 'POST', url('result'), result())).statusCode,
    409,
    'DELIVERED 不能 result',
  );
  assert.equal(
    (await call(ep, 'POST', url('started'), { x: 1 })).statusCode,
    409,
    'started 体必须为 {}',
  );
  assertJson200(await call(ep, 'POST', url('started'), {}));
  assert.equal((await call(ep, 'POST', url('started'), {})).statusCode, 409, '重复 started');

  // 过期：ack/started 要求 now < deadline
  const expired = await createJob(ep, { deadline: new Date(Date.now() - 1000) });
  assert.equal(
    (await call(ep, 'POST', `/eval-jobs/${expired.publicId}/ack`, { checksum: expired.checksum }))
      .statusCode,
    409,
  );
  const deliveredExpired = await createJob(ep, {
    status: 'DELIVERED',
    deadline: new Date(Date.now() - 1000),
  });
  assert.equal(
    (await call(ep, 'POST', `/eval-jobs/${deliveredExpired.publicId}/started`, {})).statusCode,
    409,
  );
  // result 允许 deadline + 10 分钟
  const graceOk = await createJob(ep, {
    status: 'RUNNING',
    deadline: new Date(Date.now() - 5 * 60_000),
  });
  assertJson200(await call(ep, 'POST', `/eval-jobs/${graceOk.publicId}/result`, result()));
  const graceGone = await createJob(ep, {
    status: 'RUNNING',
    deadline: new Date(Date.now() - 11 * 60_000),
  });
  assert.equal(
    (await call(ep, 'POST', `/eval-jobs/${graceGone.publicId}/result`, result())).statusCode,
    409,
  );
});

test('令牌隔离：A 终端访问 B 终端的任务一律 404；不存在/不合规 job_id 404', async () => {
  const a = await enroll();
  const b = await enroll();
  const jobB = await createJob(b);
  for (const action of ['ack', 'started', 'result']) {
    const res = await call(a, 'POST', `/eval-jobs/${jobB.publicId}/${action}`, {
      checksum: jobB.checksum,
    });
    assert.equal(res.statusCode, 404, action);
  }
  assert.equal(
    (await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: jobB.internalId } })).status,
    'QUEUED',
  );
  assert.equal(
    (await call(a, 'POST', '/eval-jobs/lej_nope/ack', { checksum: 'x' })).statusCode,
    404,
  );
  assert.equal(
    (await call(a, 'POST', `/eval-jobs/${'a'.repeat(129)}/ack`, { checksum: 'x' })).statusCode,
    404,
  );
  assert.equal((await call(a, 'POST', '/eval-jobs/a.b/ack', { checksum: 'x' })).statusCode, 404);
  // 未鉴权访问同样先 401
  const anon = await app.inject({
    method: 'POST',
    url: `${P}/eval-jobs/${jobB.publicId}/ack`,
    payload: {},
  });
  assert.equal(anon.statusCode, 401);
});

test('结果校验失败 → 任务 FAILED(invalid_result) 并返回 409（不是 400），钩子仍被调用', async () => {
  const bads: unknown[] = [
    result(undefined, { unknown_field: 1 }),
    result([scenarioResult('s1')]),
    result([scenarioResult('s1'), scenarioResult('s9')]),
    result(undefined, { product: 'codex' }),
    result([scenarioResult('s1', { final_text: null }), scenarioResult('s2')]),
    '{not json',
    '[]',
  ];
  for (const body of bads) {
    const ep = await enroll();
    const job = await createJob(ep);
    await toRunning(ep, job);
    let resolveHook!: (id: string) => void;
    const hookCalled = new Promise<string>((r) => (resolveHook = r));
    const unregister = registerFleetJobFinishedHook((id) => resolveHook(id));
    try {
      const res = await call(ep, 'POST', `/eval-jobs/${job.publicId}/result`, body);
      assert.equal(res.statusCode, 409, String(JSON.stringify(body)).slice(0, 80));
      assert.equal(await hookCalled, job.internalId);
    } finally {
      unregister();
    }
    const row = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: job.internalId } });
    assert.equal(row.status, 'FAILED');
    assert.equal(row.errorCode, 'invalid_result');
    assert.equal(row.result, null);
  }
});

test('体积上限：ack/started ≤ 8 KiB，result ≤ 16 MiB，register ≤ 64 KiB → 413', async () => {
  const ep = await enroll();
  const job = await createJob(ep);
  assert.equal(
    (await call(ep, 'POST', `/eval-jobs/${job.publicId}/ack`, { checksum: 'x'.repeat(9 * 1024) }))
      .statusCode,
    413,
  );
  await toRunning(ep, job);
  // 运行态测评 v2 把结果上限从 2 MiB 放宽到 16 MiB：超过 16 MiB 仍返回 413。
  const big = await call(
    ep,
    'POST',
    `/eval-jobs/${job.publicId}/result`,
    result([
      scenarioResult('s1', { transcript_excerpt: 'x'.repeat(17 * 1024 * 1024) }),
      scenarioResult('s2'),
    ]),
  );
  assert.equal(big.statusCode, 413);
  // 413 不改变任务状态（采集器会退避重传，见规格 §5.5）
  assert.equal(
    (await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: job.internalId } })).status,
    'RUNNING',
  );
  const { code } = await createCode();
  assert.equal(
    (await register(code, registerBody({ pad: 'x'.repeat(65 * 1024) }))).statusCode,
    413,
  );
});

test('钩子抛错不影响应答', async () => {
  const ep = await enroll();
  const job = await createJob(ep);
  await toRunning(ep, job);
  const unregister = registerFleetJobFinishedHook(() => {
    throw new Error('boom');
  });
  try {
    assertJson200(await call(ep, 'POST', `/eval-jobs/${job.publicId}/result`, result()));
  } finally {
    unregister();
  }
});

// ---------- 日志与限流（独立 Fastify 实例：带 logger 捕获输出） ----------
test('日志不含 Authorization 头、接入码与终端令牌明文', async () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logged = Fastify({ logger: { level: 'trace', stream } });
  await logged.register(fleetAgentRoutes, {
    prefix: P,
    rateLimiters: { ip: noopLimiter, register: noopLimiter, endpoint: noopLimiter },
  });
  await logged.ready();
  try {
    const { code } = await createCode();
    const res = await register(code, registerBody(), logged);
    assert.equal(res.statusCode, 200);
    const { endpoint_id, endpoint_token } = res.json();
    const ep: Ep = { id: endpoint_id, token: endpoint_token, internalId: '' };
    for (const r of [
      logged.inject({
        method: 'GET',
        url: `${P}/eval-jobs`,
        headers: { authorization: `Bearer ${ep.token}` },
      }),
      logged.inject({
        method: 'POST',
        url: `${P}/endpoints/heartbeat`,
        headers: { authorization: `Bearer ${ep.token}` },
        payload: { endpoint_id: ep.id, health: {} },
      }),
      logged.inject({
        method: 'GET',
        url: `${P}/nope`,
        headers: { authorization: `Bearer ${ep.token}` },
      }),
      logged.inject({
        method: 'GET',
        url: `${P}/eval-jobs`,
        headers: { authorization: 'Bearer wrong-token' },
      }),
    ])
      await r;
    const all = lines.join('');
    assert.ok(lines.length > 0, '应有日志输出');
    assert.ok(!all.includes(code), '日志含接入码');
    assert.ok(!all.includes(endpoint_token), '日志含终端令牌');
    assert.ok(!all.includes('wrong-token'), '日志含错误令牌');
    assert.ok(!/authorization/i.test(all), '日志含 Authorization 头');
  } finally {
    await logged.close();
  }
});

test('限流：按 IP 与按终端令牌桶，超限 429', async () => {
  const limited = Fastify();
  await limited.register(fleetAgentRoutes, {
    prefix: P,
    rateLimiters: {
      ip: noopLimiter,
      register: new TokenBucketLimiter(2, 1),
      endpoint: new TokenBucketLimiter(3, 1),
    },
  });
  await limited.ready();
  try {
    const { code } = await createCode();
    const first = await register(code, registerBody(), limited);
    assert.equal(first.statusCode, 200);
    assert.equal((await register('jdc_bad', registerBody(), limited)).statusCode, 403);
    assert.equal((await register(code, registerBody(), limited)).statusCode, 429);
    const token = first.json().endpoint_token;
    const get = () =>
      limited.inject({
        method: 'GET',
        url: `${P}/eval-jobs`,
        headers: { authorization: `Bearer ${token}` },
      });
    for (let i = 0; i < 3; i += 1) assert.equal((await get()).statusCode, 200);
    assert.equal((await get()).statusCode, 429);
  } finally {
    await limited.close();
  }
  const ipLimited = Fastify();
  await ipLimited.register(fleetAgentRoutes, {
    prefix: P,
    rateLimiters: {
      ip: new TokenBucketLimiter(1, 1),
      register: noopLimiter,
      endpoint: noopLimiter,
    },
  });
  try {
    assert.equal(
      (await ipLimited.inject({ method: 'GET', url: `${P}/eval-jobs` })).statusCode,
      401,
    );
    assert.equal(
      (await ipLimited.inject({ method: 'GET', url: `${P}/eval-jobs` })).statusCode,
      429,
    );
  } finally {
    await ipLimited.close();
  }
});
