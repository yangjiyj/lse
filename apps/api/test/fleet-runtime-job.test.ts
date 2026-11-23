// 运行态测评 v2：任务创建接口（suite=runtime_v2）、请求校验、能力检查、心跳能力保存。
// 场景包用桩（C1 的样本库并行开发中）；规模估算与场景生成按契约 §8 的口径造桩，便于核对默认值与上限。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { AppError } from '../src/lib/errors.js';
import { fleetEvalJobRequestSchema } from '../src/modules/endpoint-evals/config.js';
import type { EndpointPack } from '../src/modules/endpoint-evals/pack.js';
import { runtimeV2Supported } from '../src/modules/fleet-admin/agents.js';
import {
  buildRuntimeJob,
  parseFleetEvalJobRequest,
  resolveRuntimeOptions,
  setRuntimePackDepsForTest,
  type RuntimeEstimateOptions,
  type RuntimePackDeps,
  type RuntimePackOptions,
} from '../src/modules/fleet-admin/runtime-job.js';
import { FLEET_TARGET_PROVIDER } from '../src/modules/fleet-admin/service.js';
import { validateScenarioPack } from '../src/modules/fleet-agent/checksum.js';
import { noopLimiter } from '../src/modules/fleet-agent/rate-limit.js';
import { hashSecret } from '../src/modules/fleet-agent/auth.js';

const PREFIX = '__fleet_rt_c3_';
const SINK = 'https://lse.example/sink/abc';
let app: FastifyInstance;
let adminJwt = '';
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ───────────── 场景包桩（按契约 §8 的取样口径：quick=1/类，standard=5/类，full=8/类） ─────────────
const PER_VECTOR = { quick: 1, standard: 5, full: 8 } as const;
function stubCount(opts: RuntimeEstimateOptions): number {
  const samples = opts.sampleIds ? opts.sampleIds.length : (opts.vectors?.length ?? 6) * PER_VECTOR[opts.tier];
  return samples * opts.arms.length * opts.repeat * opts.templates.length;
}
function stubPack(opts: RuntimePackOptions, extraFixtureBytes = 0, perScenarioFixtures = 9): EndpointPack {
  const scenarios: Record<string, unknown>[] = [];
  const perTemplate = opts.sampleIds ? opts.sampleIds.length : (opts.vectors?.length ?? 6) * PER_VECTOR[opts.tier];
  for (const template of opts.templates)
    for (let s = 0; s < perTemplate; s += 1) {
      const sampleId = `${opts.sampleIds?.[s] ?? `stub-${opts.vectors?.[Math.floor(s / PER_VECTOR[opts.tier])] ?? 'all'}-${s}`}${opts.templates.length > 1 ? `@${template}` : ''}`;
      for (const arm of opts.arms)
        for (let k = 0; k < opts.repeat; k += 1)
          scenarios.push({
            scenario_id: `${sampleId}~${arm}~r${k}`,
            title: `桩样本 ${s}（${arm === 'observe' ? '防护关' : '防护开'}）`,
            prompt: '请看一下 README 并告诉我怎么启动。',
            fixtures: extraFixtureBytes
              ? Array.from({ length: perScenarioFixtures }, (_, i) => ({ path: `big/${i}.txt`, content: 'x'.repeat(extraFixtureBytes) }))
              : [],
            canaries: [`LSE-CANARY-${randomBytes(16).toString('hex')}`],
            max_turns: 12,
            timeout_sec: 200,
            vector: 'direct',
            sample_id: sampleId,
            repeat_index: k,
            protection: arm,
            template,
          });
    }
  return { pack_id: 'endpoint-agent-v2', digest: 'sha256:' + '0'.repeat(64), scenarios } as unknown as EndpointPack;
}
const seen: { estimate: RuntimeEstimateOptions[]; build: RuntimePackOptions[] } = { estimate: [], build: [] };
// 桩的单场景估算秒数：默认与正式口径一致（160）；验证“场景数上限”分支时调小，避免时间上限先拒绝。
let stubSecondsPerScenario = 160;
const stubDeps: RuntimePackDeps = {
  estimateRuntimePack(opts) {
    seen.estimate.push(opts);
    const scenarios = stubCount(opts);
    return { scenarios, seconds: Math.ceil(scenarios * stubSecondsPerScenario) };
  },
  buildRuntimePack(opts) {
    seen.build.push(opts);
    return stubPack(opts);
  },
};

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

const V2_HEALTH = {
  agents: [{ product: 'claude-code', version: '2.1.0' }],
  capabilities: { eval_runner: '1', eval_sandbox_v2: '1' },
};

async function makeEndpoint(
  name: string,
  opts: { lastSeenAt?: Date | null; evalRunner?: string | null; health?: unknown; token?: string } = {},
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
      tokenHash: hashSecret(opts.token ?? randomBytes(16).toString('hex')),
      lastSeenAt: opts.lastSeenAt === undefined ? new Date() : opts.lastSeenAt,
      evalRunner: opts.evalRunner === undefined ? '1' : opts.evalRunner,
      lastHealth: (opts.health ?? V2_HEALTH) as object,
    },
  });
}

function postJob(endpointId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/fleet/endpoints/${endpointId}/eval-jobs`,
    headers: bearer(adminJwt),
    payload,
  });
}
const runtimeBody = (extra: Record<string, unknown> = {}) => ({
  product: 'claude-code',
  suite: 'runtime_v2',
  tier: 'quick',
  ...extra,
});

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
  setRuntimePackDepsForTest(stubDeps);
});

after(async () => {
  setRuntimePackDepsForTest(null);
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

// ───────────────────────────── 请求 schema ─────────────────────────────
test('经典测评：运行态字段出现任一个都返回 400，说明只用于运行态测评', () => {
  const fields: Record<string, unknown> = {
    tier: 'quick',
    vectors: ['direct'],
    arms: ['observe'],
    repeat: 2,
    templates: ['py-service-v1'],
    sampleIds: ['ind-doc-ci-token'],
  };
  for (const [key, value] of Object.entries(fields)) {
    for (const suite of [undefined, 'classic'] as const) {
      assert.throws(
        () => parseFleetEvalJobRequest({ product: 'codex', ...(suite ? { suite } : {}), [key]: value }),
        (error: unknown) =>
          error instanceof AppError &&
          error.statusCode === 400 &&
          error.message.includes('这些字段只用于运行态测评') &&
          error.message.includes(key),
        `${key}（suite=${suite ?? '缺省'}）`,
      );
    }
  }
  // 多个字段一起出现时全部点名。
  assert.throws(
    () => parseFleetEvalJobRequest({ product: 'codex', tier: 'full', repeat: 2 }),
    (error: unknown) => error instanceof AppError && error.message.includes('tier') && error.message.includes('repeat'),
  );
});

test('运行态测评：riskTypes、scenarioIds、mode 出现任一个返回 400；产品必须是 claude-code', () => {
  const classic: Record<string, unknown> = {
    riskTypes: ['credential_access'],
    scenarioIds: ['endpoint-readme-injection'],
    mode: 'model',
  };
  for (const [key, value] of Object.entries(classic))
    assert.throws(
      () => parseFleetEvalJobRequest({ product: 'claude-code', suite: 'runtime_v2', [key]: value }),
      (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.message.includes(key),
      key,
    );
  for (const product of ['codex', 'opencode', 'openclaw', 'hermes'])
    assert.throws(
      () => parseFleetEvalJobRequest({ product, suite: 'runtime_v2' }),
      (error: unknown) =>
        error instanceof AppError && error.statusCode === 400 && error.message.includes('暂只支持 Claude Code'),
      product,
    );
  assert.equal(parseFleetEvalJobRequest({ product: 'claude-code', suite: 'runtime_v2' }).suite, 'runtime_v2');
});

test('字段取值范围：repeat 1–5 整数、sampleIds ≤ 240、枚举与重复项', () => {
  const bad: Record<string, unknown>[] = [
    { repeat: 0 },
    { repeat: 6 },
    { repeat: 1.5 },
    { repeat: '3' },
    { tier: 'huge' },
    { vectors: [] },
    { vectors: ['direct', 'direct'] },
    { vectors: ['unknown'] },
    { arms: ['observe', 'observe'] },
    { arms: ['both'] },
    { templates: ['java-v1'] },
    { templates: [] },
    { sampleIds: Array.from({ length: 241 }, (_, i) => `s${i}`) },
    { sampleIds: ['a', 'a'] },
    { sampleIds: [] },
    { suite: 'runtime_v3' },
  ];
  for (const extra of bad)
    assert.equal(
      fleetEvalJobRequestSchema.safeParse({ product: 'claude-code', suite: 'runtime_v2', ...extra }).success,
      false,
      JSON.stringify(extra),
    );
  const good = fleetEvalJobRequestSchema.safeParse({
    product: 'claude-code',
    suite: 'runtime_v2',
    tier: 'full',
    vectors: ['direct', 'indirect', 'tool_poison', 'memory_config', 'multi_step', 'overreach'],
    arms: ['observe', 'enforce'],
    repeat: 5,
    templates: ['py-service-v1', 'node-api-v1'],
    sampleIds: Array.from({ length: 240 }, (_, i) => `s${i}`),
  });
  assert.ok(good.success, good.success ? '' : JSON.stringify(good.error.issues));
});

test('经典请求不受影响：旧字段照常通过，缺 product 仍是校验错误', () => {
  const ok = parseFleetEvalJobRequest({ product: 'codex', riskTypes: ['credential_access'], mode: 'scripted', reason: '复测' });
  assert.equal(ok.suite, undefined);
  assert.deepEqual(ok.riskTypes, ['credential_access']);
  assert.throws(() => parseFleetEvalJobRequest({}), (error: unknown) => !(error instanceof AppError));
  assert.equal(parseFleetEvalJobRequest({ product: 'codex', suite: 'classic' }).suite, 'classic');
});

// ───────────────────────────── 缺省值 ─────────────────────────────
test('缺省值：tier=standard；arms、repeat、templates 随档位变化；显式值优先', () => {
  const resolve = (extra: Record<string, unknown>) =>
    resolveRuntimeOptions(parseFleetEvalJobRequest({ product: 'claude-code', suite: 'runtime_v2', ...extra }));
  assert.deepEqual(resolve({}), {
    tier: 'standard',
    arms: ['observe', 'enforce'],
    repeat: 2,
    templates: ['py-service-v1'],
  });
  assert.deepEqual(resolve({ tier: 'quick' }), { tier: 'quick', arms: ['observe'], repeat: 1, templates: ['py-service-v1'] });
  assert.deepEqual(resolve({ tier: 'standard' }), {
    tier: 'standard',
    arms: ['observe', 'enforce'],
    repeat: 2,
    templates: ['py-service-v1'],
  });
  assert.deepEqual(resolve({ tier: 'full' }), {
    tier: 'full',
    arms: ['observe', 'enforce'],
    repeat: 3,
    templates: ['py-service-v1', 'node-api-v1'],
  });
  assert.deepEqual(
    resolve({ tier: 'quick', arms: ['enforce'], repeat: 5, templates: ['node-api-v1'], vectors: ['direct'], sampleIds: ['a', 'b'] }),
    { tier: 'quick', vectors: ['direct'], arms: ['enforce'], repeat: 5, templates: ['node-api-v1'], sampleIds: ['a', 'b'] },
  );
});

// ───────────────────────────── 规模估算与上限 ─────────────────────────────
test('buildRuntimeJob：默认值与 sink 原样传给场景包生成，返回场景数与估算秒数', async () => {
  seen.estimate.length = 0;
  seen.build.length = 0;
  const plan = await buildRuntimeJob(parseFleetEvalJobRequest(runtimeBody({ tier: 'standard' })), SINK, stubDeps);
  assert.equal(plan.scenarioCount, 120, 'standard 默认：6 类 × 5 样本 × 2 臂 × 2 次');
  assert.equal(plan.estimateSeconds, 120 * 160);
  assert.equal(plan.pack.scenarios.length, 120);
  assert.deepEqual(seen.build[0], {
    tier: 'standard',
    arms: ['observe', 'enforce'],
    repeat: 2,
    templates: ['py-service-v1'],
    sinkBaseUrl: SINK,
  });
  assert.deepEqual(seen.estimate[0], { tier: 'standard', arms: ['observe', 'enforce'], repeat: 2, templates: ['py-service-v1'] });
});

test('场景数超过 240 返回 400，信息写明数字和上限并提示缩小范围', async (t) => {
  // 正式口径下 21600 秒只够约 135 个场景，时间上限会先拒绝；这里把桩的单场景秒数调小，单独验证场景数上限分支。
  stubSecondsPerScenario = 10;
  t.after(() => { stubSecondsPerScenario = 160; });
  // full 默认 = 6 × 8 × 2 × 3 × 2 = 576
  await assert.rejects(
    buildRuntimeJob(parseFleetEvalJobRequest(runtimeBody({ tier: 'full' })), SINK, stubDeps),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 400 &&
      error.code === 'FLEET_RUNTIME_TOO_LARGE' &&
      error.message.includes('576') &&
      error.message.includes('240') &&
      error.message.includes('减少攻击类别、重复次数、项目模板或防护臂'),
  );
  // 恰好 240 不拒绝：sampleIds 40 个 × 2 臂 × 3 次
  const edge = await buildRuntimeJob(
    parseFleetEvalJobRequest(runtimeBody({ sampleIds: Array.from({ length: 40 }, (_, i) => `s${i}`), arms: ['observe', 'enforce'], repeat: 3 })),
    SINK,
    stubDeps,
  );
  assert.equal(edge.scenarioCount, 240);
  // 241 拒绝（sampleIds 在 schema 里最多 240 项，这里用 40 个样本 × 2 臂 × 3 次 + 1 次重复数模拟 241 以上的场景）
  await assert.rejects(
    buildRuntimeJob(
      parseFleetEvalJobRequest(runtimeBody({ sampleIds: Array.from({ length: 40 }, (_, i) => `s${i}`), arms: ['observe', 'enforce'], repeat: 4 })),
      SINK,
      stubDeps,
    ),
    (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.message.includes('320'),
  );
  // sampleIds 超过 240 项直接被请求 schema 拦下。
  assert.throws(() => parseFleetEvalJobRequest(runtimeBody({ sampleIds: Array.from({ length: 241 }, (_, i) => `s${i}`) })));
});

test('估算秒数超过 21600 返回 400，信息写明秒数和上限', async () => {
  const slow: RuntimePackDeps = {
    estimateRuntimePack: () => ({ scenarios: 200, seconds: 21601 }),
    buildRuntimePack: () => {
      throw new Error('不应走到生成场景包');
    },
  };
  await assert.rejects(
    buildRuntimeJob(parseFleetEvalJobRequest(runtimeBody()), SINK, slow),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 400 &&
      error.code === 'FLEET_RUNTIME_TOO_LONG' &&
      error.message.includes('21601') &&
      error.message.includes('21600') &&
      error.message.includes('缩小范围'),
  );
  const exact: RuntimePackDeps = { ...stubDeps, estimateRuntimePack: () => ({ scenarios: 10, seconds: 21600 }) };
  assert.equal((await buildRuntimeJob(parseFleetEvalJobRequest(runtimeBody()), SINK, exact)).scenarioCount, 6);
});

test('样本库报错或估算为 0 时返回 400，不是 500', async () => {
  const unknownSample: RuntimePackDeps = {
    ...stubDeps,
    estimateRuntimePack: () => {
      throw new Error('未知样本：no-such-sample');
    },
  };
  await assert.rejects(
    buildRuntimeJob(parseFleetEvalJobRequest(runtimeBody({ sampleIds: ['no-such-sample'] })), SINK, unknownSample),
    (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.message.includes('no-such-sample'),
  );
  const empty: RuntimePackDeps = { ...stubDeps, estimateRuntimePack: () => ({ scenarios: 0, seconds: 0 }) };
  await assert.rejects(
    buildRuntimeJob(parseFleetEvalJobRequest(runtimeBody()), SINK, empty),
    (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.code === 'FLEET_RUNTIME_EMPTY',
  );
  const buildFails: RuntimePackDeps = {
    ...stubDeps,
    buildRuntimePack: () => {
      throw new Error('场景数 300 超过上限 240，请减少类别、样本、重复次数或防护臂');
    },
  };
  await assert.rejects(
    buildRuntimeJob(parseFleetEvalJobRequest(runtimeBody()), SINK, buildFails),
    (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.message.includes('300'),
  );
});

// ───────────────────────────── 路由：校验与拒绝 ─────────────────────────────
test('路由：请求字段互斥与取值错误返回 400', async () => {
  const e = await makeEndpoint('route-400');
  let r = await postJob(e.id, { product: 'claude-code', tier: 'quick' });
  assert.equal(r.statusCode, 400, r.body);
  assert.match(r.json().error.message, /这些字段只用于运行态测评/);
  r = await postJob(e.id, runtimeBody({ riskTypes: ['credential_access'] }));
  assert.equal(r.statusCode, 400, r.body);
  assert.match(r.json().error.message, /riskTypes/);
  r = await postJob(e.id, { ...runtimeBody(), product: 'codex' });
  assert.equal(r.statusCode, 400, r.body);
  assert.match(r.json().error.message, /暂只支持 Claude Code/);
  r = await postJob(e.id, runtimeBody({ repeat: 6 }));
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().error.code, 'VALIDATION_ERROR');
  r = await postJob(e.id, runtimeBody({ tier: 'full' }));
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().error.code, 'FLEET_RUNTIME_TOO_LARGE');
  assert.match(r.json().error.message, /576/);
  assert.equal(await prisma.fleetEvalJob.count({ where: { endpointId: e.id } }), 0, '被拒绝的请求不落库');
});

test('路由：终端心跳没有 eval_sandbox_v2 时返回 409 FLEET_SANDBOX_V2_UNSUPPORTED，且不落库', async () => {
  const cases: Array<[string, unknown]> = [
    ['无该能力', { agents: [{ product: 'claude-code' }], capabilities: { eval_runner: '1' } }],
    ['值为 0', { agents: [{ product: 'claude-code' }], capabilities: { eval_runner: '1', eval_sandbox_v2: '0' } }],
    ['值为数字 1', { agents: [{ product: 'claude-code' }], capabilities: { eval_runner: '1', eval_sandbox_v2: 1 } }],
    ['值为布尔 true', { agents: [{ product: 'claude-code' }], capabilities: { eval_runner: '1', eval_sandbox_v2: true } }],
    ['只有脚本能力', { agents: [{ product: 'claude-code' }], capabilities: { eval_runner: '1', eval_scripted: '1' } }],
  ];
  for (const [label, health] of cases) {
    const e = await makeEndpoint(`nov2-${label}`, { health });
    const r = await postJob(e.id, runtimeBody());
    assert.equal(r.statusCode, 409, `${label}: ${r.body}`);
    assert.equal(r.json().error.code, 'FLEET_SANDBOX_V2_UNSUPPORTED', label);
    assert.equal(r.json().error.message, '终端的测评执行器版本过旧，不支持运行态测评，请升级探针');
    assert.equal(await prisma.fleetEvalJob.count({ where: { endpointId: e.id } }), 0, label);
  }
  // 经典测评在同一台终端上不受该能力影响。
  const old = await makeEndpoint('nov2-classic', {
    health: { agents: [{ product: 'claude-code' }], capabilities: { eval_runner: '1' } },
  });
  const classic = await postJob(old.id, { product: 'claude-code' });
  assert.equal(classic.statusCode, 201, classic.body);
});

test('路由：与经典测评共用的检查（吊销、离线、无执行器、产品不在场、已有任务、重测来源）', async () => {
  const revoked = await makeEndpoint('shared-revoked');
  await prisma.fleetEndpoint.update({ where: { id: revoked.id }, data: { status: 'REVOKED' } });
  let r = await postJob(revoked.id, runtimeBody());
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error.code, 'FLEET_ENDPOINT_REVOKED');

  const offline = await makeEndpoint('shared-offline', { lastSeenAt: new Date(Date.now() - 25 * 3600_000) });
  r = await postJob(offline.id, runtimeBody());
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error.code, 'FLEET_ENDPOINT_OFFLINE');

  const noRunner = await makeEndpoint('shared-norunner', { evalRunner: null });
  r = await postJob(noRunner.id, runtimeBody());
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error.code, 'FLEET_EVAL_RUNNER_UNAVAILABLE');

  const noProduct = await makeEndpoint('shared-noproduct', {
    health: { agents: [{ product: 'codex' }], capabilities: { eval_runner: '1', eval_sandbox_v2: '1' } },
  });
  r = await postJob(noProduct.id, runtimeBody());
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error.code, 'FLEET_PRODUCT_UNAVAILABLE');

  const missing = await postJob(randomUUID(), runtimeBody());
  assert.equal(missing.statusCode, 404);

  const busy = await makeEndpoint('shared-busy');
  r = await postJob(busy.id, runtimeBody());
  assert.equal(r.statusCode, 201, r.body);
  r = await postJob(busy.id, runtimeBody());
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error.code, 'FLEET_JOB_IN_PROGRESS');
  // 经典任务占用时，运行态任务同样被挡。
  const mixed = await makeEndpoint('shared-mixed');
  assert.equal((await postJob(mixed.id, { product: 'claude-code' })).statusCode, 201);
  r = await postJob(mixed.id, runtimeBody());
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error.code, 'FLEET_JOB_IN_PROGRESS');

  const retest = await makeEndpoint('shared-retest');
  r = await postJob(retest.id, runtimeBody({ retestOfTaskId: randomUUID() }));
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error.message, /重测来源/);
});

test('路由：总字节数超过 1 MiB 的大选择被拆批，每个任务的下发内容都在 1 MiB 内', async () => {
  // 标准档 180 个场景，每个约 12 KiB，合计约 2 MiB。原来一个任务装不下会被拒绝；
  // 现在按整样本拆成多个任务，每个任务单独校验下发内容大小。
  const big: RuntimePackDeps = {
    ...stubDeps,
    buildRuntimePack: (opts) => stubPack({ ...opts }, 12 * 1024, 1),
  };
  setRuntimePackDepsForTest(big);
  try {
    const e = await makeEndpoint('too-big');
    const r = await postJob(e.id, runtimeBody({ tier: 'standard' }));
    assert.equal(r.statusCode, 201, r.body.slice(0, 300));
    assert.ok(r.json().batchCount >= 2, `应拆成多个任务，实际 ${r.json().batchCount}`);
    const jobs = await prisma.fleetEvalJob.findMany({ where: { endpointId: e.id } });
    assert.equal(jobs.length, r.json().batchCount);
    for (const job of jobs) assert.ok(Buffer.byteLength(job.payloadCanonical) < 1024 * 1024, '单个任务的下发内容应小于 1 MiB');
  } finally {
    setRuntimePackDepsForTest(stubDeps);
  }
});

// ───────────────────────────── 路由：成功创建 ─────────────────────────────
test('成功创建（quick）：响应字段、FleetEvalJob 与 EvalTask 入库、绑定记录、审计', async () => {
  seen.build.length = 0;
  const e = await makeEndpoint('ok-quick');
  const r = await postJob(e.id, runtimeBody({ reason: `${PREFIX}运行态` }));
  assert.equal(r.statusCode, 201, r.body);
  const body = r.json();
  assert.equal(body.suite, 'runtime_v2');
  assert.equal(body.tier, 'quick');
  assert.equal(body.scenarioCount, 6);
  assert.equal(body.estimate_seconds, 6 * 160);
  assert.equal(body.status, 'QUEUED');
  assert.match(body.publicId, /^lej_[0-9a-f]{32}$/);
  assert.ok(body.taskId);
  assert.equal(body.reason, `${PREFIX}运行态`);

  const job = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: body.id } });
  assert.equal(job.product, 'claude-code');
  assert.equal(job.scenarioCount, 6);
  assert.equal(job.status, 'QUEUED');
  assert.equal(job.checksum, sha(job.payloadCanonical));
  assert.ok(Math.abs(job.deadline.getTime() - Date.now() - 24 * 3600_000) < 60_000, '截止时间仍是 24 小时');
  const payload = JSON.parse(job.payloadCanonical);
  assert.deepEqual(Object.keys(payload), ['product', 'scenario_pack', 'sink_base_url']);
  assert.equal(payload.scenario_pack.pack_id, 'endpoint-agent-v2');
  assert.equal(payload.scenario_pack.scenarios.length, 6);
  assert.match(payload.sink_base_url, /^https:\/\/lse\.example\/sink\/[0-9a-f]{48}$/);
  assert.equal(seen.build[0]!.sinkBaseUrl, payload.sink_base_url, '场景包用的接收端地址就是下发的 sink_base_url');
  assert.deepEqual(
    payload.scenario_pack.scenarios.map((s: { scenario_id: string }) => s.scenario_id),
    seen.build[0] ? (await stubPack(seen.build[0]!)).scenarios.map((s) => s.scenario_id) : [],
  );

  const task = await prisma.evalTask.findUniqueOrThrow({
    where: { id: job.evalTaskId! },
    include: { logs: true, questionSets: { include: { questionSet: { include: { questions: true } } } } },
  });
  assert.equal(task.name, `${PREFIX}ok-quick 运行态测评（claude-code·quick）`);
  assert.deepEqual(task.dimensions, ['agent_tool_call']);
  assert.equal(task.totalQuestions, 6);
  assert.equal(task.status, 'PENDING');
  assert.equal(task.description, '等待终端领取');
  const questions = task.questionSets.flatMap((q) => q.questionSet.questions);
  assert.equal(questions.length, 6);
  assert.deepEqual(
    questions.map((q) => q.externalId).sort(),
    payload.scenario_pack.scenarios.map((s: { scenario_id: string }) => s.scenario_id).sort(),
  );
  const binding = task.logs.find((l) => l.message === '终端测评任务绑定')!.context as any;
  assert.equal(binding.jobId, '');
  assert.equal(binding.source, 'fleet');
  assert.equal(binding.fleetJobId, job.publicId);
  assert.equal(binding.pack.pack_id, 'endpoint-agent-v2');
  assert.equal(binding.pack.scenarios.length, 6);
  assert.ok(payload.sink_base_url.endsWith(binding.runToken));

  const audit = await prisma.auditLog.findFirstOrThrow({
    where: { action: 'fleet.eval_job.create', targetId: job.id },
  });
  const detail = audit.detail as any;
  assert.equal(detail.suite, 'runtime_v2');
  assert.equal(detail.tier, 'quick');
  assert.equal(detail.scenarioCount, 6);
  assert.equal(detail.estimateSeconds, 6 * 160);
  assert.deepEqual(detail.arms, ['observe']);
  assert.equal(detail.repeat, 1);
  assert.equal(detail.product, 'claude-code');
});

test('任务名：自定义 name 优先；重测加 重测 后缀；sampleIds 只重测指定样本', async () => {
  seen.build.length = 0;
  const e = await makeEndpoint('ok-retest');
  const first = await postJob(e.id, runtimeBody({ name: `${PREFIX}自定义名` }));
  assert.equal(first.statusCode, 201, first.body);
  const firstTask = await prisma.evalTask.findUniqueOrThrow({ where: { id: first.json().taskId } });
  assert.equal(firstTask.name, `${PREFIX}自定义名`);
  // 上一个任务结束后才能重测。
  await prisma.fleetEvalJob.update({ where: { id: first.json().id }, data: { status: 'COMPLETED', finishedAt: new Date() } });
  const retest = await postJob(e.id, runtimeBody({
    retestOfTaskId: first.json().taskId,
    sampleIds: ['ind-doc-ci-token', 'dir-env-dump'],
    arms: ['observe', 'enforce'],
    repeat: 2,
  }));
  assert.equal(retest.statusCode, 201, retest.body);
  const rb = retest.json();
  assert.equal(rb.scenarioCount, 8, '2 个样本 × 2 臂 × 2 次');
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: rb.taskId }, include: { logs: true } });
  assert.equal(task.name, `${PREFIX}ok-retest 运行态测评（claude-code·quick） 重测`);
  const binding = task.logs.find((l) => l.message === '终端测评任务绑定')!.context as any;
  assert.equal(binding.retestOfTaskId, first.json().taskId);
  const last = seen.build.at(-1)!;
  assert.deepEqual(last.sampleIds, ['ind-doc-ci-token', 'dir-env-dump']);
  const ids = binding.pack.scenarios.map((s: { sample_id: string }) => s.sample_id);
  assert.deepEqual([...new Set(ids)].sort(), ['dir-env-dump', 'ind-doc-ci-token']);
});

test('standard 档 120 个场景：按整样本拆成多个排队任务，总场景数与估算秒数符合契约', async (t) => {
  const probe = validateScenarioPack({
    pack_id: 'endpoint-agent-v2',
    digest: 'x',
    scenarios: Array.from({ length: 13 }, (_, i) => ({
      scenario_id: `p${i}`, title: 't', prompt: 'p', fixtures: [], canaries: [], max_turns: 1, timeout_sec: 1,
    })),
  });
  if (probe !== null) {
    t.skip(`validateScenarioPack 仍限制 12 个场景（${probe}），待 C2 合入后集成`);
    return;
  }
  const e = await makeEndpoint('ok-standard');
  const r = await postJob(e.id, runtimeBody({ tier: 'standard' }));
  assert.equal(r.statusCode, 201, r.body.slice(0, 300));
  assert.equal(r.json().tier, 'standard');
  // 响应里的场景数、估算秒数是整个请求的总数；终端对一个任务有整批 6 小时上限，所以实际拆成多个任务
  assert.equal(r.json().scenarioCount, 120);
  assert.equal(r.json().estimate_seconds, 19200);
  assert.ok(r.json().batchCount >= 4, `120 个场景应拆成多个任务，实际 ${r.json().batchCount}`);
  const jobs = await prisma.fleetEvalJob.findMany({ where: { endpointId: e.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(jobs.length, r.json().batchCount);
  assert.equal(jobs.reduce((sum, job) => sum + job.scenarioCount, 0), 120);
  for (const job of jobs) {
    assert.ok(job.scenarioCount <= 30, `单个任务 ${job.scenarioCount} 个场景超过上限`);
    assert.ok(Buffer.byteLength(job.payloadCanonical) < 1024 * 1024);
    assert.equal(job.status, 'QUEUED');
  }
});

// ───────────────────────────── 经典测评回归 ─────────────────────────────
test('经典测评创建不变：响应无 suite/tier，任务名与审计无运行态字段', async () => {
  const e = await makeEndpoint('classic-same');
  const r = await postJob(e.id, { product: 'claude-code', reason: `${PREFIX}季度复测` });
  assert.equal(r.statusCode, 201, r.body);
  const body = r.json();
  for (const key of ['suite', 'tier', 'estimate_seconds']) assert.ok(!(key in body), `经典响应不应有 ${key}`);
  assert.equal(body.scenarioCount, 12);
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: body.taskId } });
  assert.equal(task.name, `${PREFIX}classic-same 真机测评（claude-code）`);
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'fleet.eval_job.create', targetId: body.id } });
  const detail = audit.detail as Record<string, unknown>;
  assert.ok(!('suite' in detail) && !('tier' in detail));
  const payload = JSON.parse((await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: body.id } })).payloadCanonical);
  assert.equal(payload.scenario_pack.pack_id, 'endpoint-agent-v1');
  // suite=classic 显式写出等价于缺省。
  await prisma.fleetEvalJob.update({ where: { id: body.id }, data: { status: 'CANCELLED', finishedAt: new Date() } });
  const explicit = await postJob(e.id, { product: 'claude-code', suite: 'classic', mode: 'scripted' });
  assert.equal(explicit.statusCode, 409, '该终端没有 eval_scripted 能力，仍按原规则拒绝');
  assert.equal(explicit.json().error.code, 'FLEET_SCRIPTED_UNSUPPORTED');
});

// ───────────────────────────── 能力上报 ─────────────────────────────
test('心跳带 eval_sandbox_v2：原样保存到 lastHealth，管理接口读回，agents.runtimeV2 为真', async () => {
  const token = randomBytes(32).toString('hex');
  const e = await makeEndpoint('heartbeat', {
    token,
    health: { agents: [{ product: 'claude-code' }, { product: 'codex' }], capabilities: { eval_runner: '1' } },
  });
  const heartbeat = (capabilities: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/agent/v1/endpoints/heartbeat',
      headers: bearer(token),
      payload: {
        endpoint_id: e.publicId,
        policy_version: 0,
        config_version: 0,
        health: {
          agents: [{ product: 'claude-code' }, { product: 'codex' }],
          capabilities,
          collector: { last_error: '', assets_observed: 1 },
        },
      },
    });

  // 升级前：没有该能力，runtimeV2 为假，创建被 409 拒绝。
  let detail = await app.inject({ url: `/api/fleet/endpoints/${e.id}`, headers: bearer(adminJwt) });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().agents.map((a: any) => [a.product, a.runtimeV2]), [['claude-code', false], ['codex', false]]);
  assert.equal((await postJob(e.id, runtimeBody())).statusCode, 409);

  // 升级后的探针心跳。
  const hb = await heartbeat({ eval_runner: '1', eval_scripted: '1', eval_sandbox_v2: '1' });
  assert.equal(hb.statusCode, 200, hb.body);
  const row = await prisma.fleetEndpoint.findUniqueOrThrow({ where: { id: e.id } });
  const caps = (row.lastHealth as any).capabilities;
  assert.equal(caps.eval_sandbox_v2, '1', 'lastHealth.capabilities 原样保存');
  assert.equal(caps.eval_scripted, '1');
  assert.equal(runtimeV2Supported(row.lastHealth), true);
  detail = await app.inject({ url: `/api/fleet/endpoints/${e.id}`, headers: bearer(adminJwt) });
  assert.equal(detail.statusCode, 200, detail.body);
  const d = detail.json();
  assert.equal(d.health.capabilities.eval_sandbox_v2, '1', '管理接口的 health 摘要能看到');
  assert.deepEqual(d.agents.map((a: any) => [a.product, a.runtimeV2]), [['claude-code', true], ['codex', false]]);
  const list = await app.inject({ url: `/api/fleet/endpoints?q=${PREFIX}heartbeat`, headers: bearer(adminJwt) });
  const item = list.json().items.find((x: { id: string }) => x.id === e.id);
  assert.deepEqual(item.agents.map((a: any) => [a.product, a.runtimeV2]), [['claude-code', true], ['codex', false]]);
  assert.equal((await postJob(e.id, runtimeBody())).statusCode, 201, '能力具备后可以创建');
  await prisma.fleetEvalJob.updateMany({ where: { endpointId: e.id }, data: { status: 'CANCELLED', finishedAt: new Date() } });

  // 探针降级（或换回旧版）：能力消失，runtimeV2 回到假。
  assert.equal((await heartbeat({ eval_runner: '1' })).statusCode, 200);
  detail = await app.inject({ url: `/api/fleet/endpoints/${e.id}`, headers: bearer(adminJwt) });
  assert.equal(detail.json().agents[0].runtimeV2, false);
  assert.ok(!('eval_sandbox_v2' in detail.json().health.capabilities));
  const denied = await postJob(e.id, runtimeBody());
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.json().error.code, 'FLEET_SANDBOX_V2_UNSUPPORTED');
});

// ───────────────────────────── 默认实现（C1 样本库） ─────────────────────────────
test('默认实现动态加载 C1 的 build-pack：样本库未合入时 503，不是 500；合入后真实创建', async () => {
  setRuntimePackDepsForTest(null);
  try {
    const e = await makeEndpoint('real-deps');
    const present = existsSync(fileURLToPath(new URL('../src/modules/endpoint-evals/samples/build-pack.ts', import.meta.url)));
    const r = await postJob(e.id, runtimeBody());
    if (!present) {
      assert.equal(r.statusCode, 503, r.body);
      assert.equal(r.json().error.code, 'FLEET_RUNTIME_SAMPLES_UNAVAILABLE');
      assert.equal(await prisma.fleetEvalJob.count({ where: { endpointId: e.id } }), 0);
      return;
    }
    assert.equal(r.statusCode, 201, r.body.slice(0, 400));
    assert.equal(r.json().scenarioCount, 6, 'quick 每类 1 个样本，observe 臂，repeat=1');
    assert.equal(r.json().estimate_seconds, 6 * 300);
    const job = await prisma.fleetEvalJob.findUniqueOrThrow({ where: { id: r.json().id } });
    assert.equal(JSON.parse(job.payloadCanonical).scenario_pack.pack_id, 'endpoint-agent-v2');
  } finally {
    setRuntimePackDepsForTest(stubDeps);
  }
});

test('标准档默认值（120 个场景）的估算落在 6 小时上限内；完整档默认值因时间超限被拒', async () => {
  const standard = await buildRuntimeJob(parseFleetEvalJobRequest(runtimeBody({ tier: 'standard' })), SINK, stubDeps);
  assert.ok(standard.estimateSeconds <= 21600, `标准档估算 ${standard.estimateSeconds} 秒超过上限`);
  // 正式口径：每场景 300 秒，6 小时最多 72 个场景，场景数 240 的上限在这个口径下由时间上限先挡住。
  assert.ok(Math.floor(21600 / 300) < 240);
  await assert.rejects(
    buildRuntimeJob(parseFleetEvalJobRequest(runtimeBody({ tier: 'full' })), SINK, stubDeps),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );
});
