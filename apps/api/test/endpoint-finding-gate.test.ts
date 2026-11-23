import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { signRequest } from '../src/modules/endpoint-evals/agentshield-client.js';

/**
 * P0-02：失败 / 被驳回 / 已取消 / 过期的终端任务根本没有执行，不能在每个场景下生成「待复核」finding，
 * 否则用户被要求复核一个不存在的结果，真实风险被稀释。
 * 规则（不加迁移，不改枚举）：只有任务 COMPLETED、且该场景有实际判定（PASS/FAIL，
 * 或终端确实回传了该场景的观测）时才创建 finding；评估结果（eval_results）照常保留。
 */

const PREFIX = '__endpoint_finding_gate_';
let app: FastifyInstance;
let token = '';
let targetId = '';
let lastJob: Record<string, any>;
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  res.setHeader('content-type', 'application/json');
  if (req.url?.startsWith('/connectors/lse/endpoints'))
    return res.end(
      JSON.stringify([
        {
          endpoint_id: 'endpoint',
          hostname: '测试终端',
          os: 'linux',
          eval_runner_version: '1',
          agents: [{ product: 'codex', headless_capable: true }],
        },
      ]),
    );
  if (req.url === '/connectors/lse/eval-jobs' && req.method === 'POST') {
    lastJob = JSON.parse(raw);
    return res.end(JSON.stringify({ job_id: lastJob.lse_task_id, status: 'pending_approval' }));
  }
  res.end(JSON.stringify({ status: 'running' }));
});

const auth = () => ({ authorization: `Bearer ${token}` });

async function cleanup() {
  await prisma.evalTask.deleteMany({
    where: {
      OR: [{ name: { startsWith: PREFIX } }, { modelTarget: { name: { startsWith: PREFIX } } }],
    },
  });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.LSE_ENDPOINT_EVAL_ENABLED = 'true';
  process.env.LSE_ENDPOINT_EVAL_HMAC_SECRET = 'route-secret';
  process.env.LSE_AGENTSHIELD_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.LSE_TARGET_EGRESS_ALLOWLIST = process.env.LSE_AGENTSHIELD_BASE_URL;
  process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = 'true';
  process.env.LSE_PUBLIC_BASE_URL = 'https://lse.example';
  await cleanup();
  app = await buildApp();
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  token = login.json().token;
  const target = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: `${PREFIX}target`,
      targetType: 'ENDPOINT_AGENT',
      provider: 'agentshield',
      accessConfig: {
        agentshieldBaseUrl: process.env.LSE_AGENTSHIELD_BASE_URL,
        endpointId: 'endpoint',
        endpointLabel: '测试终端',
        product: 'codex',
      },
    },
  });
  assert.equal(target.statusCode, 201, target.body);
  targetId = target.json().id;
});

after(async () => {
  await cleanup();
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});

async function startRun(riskTypes?: string[]) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/endpoint-evals/run',
    headers: auth(),
    payload: { modelTargetId: targetId, name: `${PREFIX}run`, ...(riskTypes ? { riskTypes } : {}) },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().taskId as string;
}

function callback(taskId: string, status: string, result: unknown, error?: unknown) {
  const payload = { job_id: taskId, lse_task_id: taskId, status, result, error };
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return app.inject({
    method: 'POST',
    url: '/api/endpoint-evals/callback',
    headers: {
      'content-type': 'application/json',
      'X-LSE-Timestamp': timestamp,
      'X-LSE-Signature': signRequest(
        'route-secret',
        timestamp,
        'POST',
        '/api/endpoint-evals/callback',
        body,
      ),
    },
    payload: body,
  });
}

function resultWith(scenarioStatus: string) {
  return {
    runner_version: '1',
    product: 'codex',
    product_version: '1',
    os: 'linux',
    isolation: 'hook-only',
    model_route: 'vendor',
    scenarios: lastJob.scenario_pack.scenarios.map((s: any) => ({
      scenario_id: s.scenario_id,
      status: scenarioStatus,
      exit_code: scenarioStatus === 'completed' ? 0 : 1,
      duration_ms: 1,
      final_text: '',
      // 读取了各自的诱导源且无诱饵命中：判 PASS；没读到诱导源或没有有效事件则判 UNKNOWN（无效）
      tool_events:
        scenarioStatus === 'completed'
          ? [{ seq: 1, tool: 'Read', input: { file_path: s.fixtures?.[0]?.path ?? 'README.md' }, decision: 'allow' }]
          : [],
      transcript_excerpt: '',
      canary_hits: [],
      workspace_changes: [],
      external_changes: [],
      evidence_status: { tool_events: 'complete', workspace_changes: 'complete', external_changes: 'complete' },
    })),
  };
}

async function snapshot(taskId: string) {
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } });
  const findings = await prisma.finding.count({ where: { taskId } });
  const results = await prisma.evalResult.count({ where: { taskId } });
  const pending = await prisma.finding.count({
    where: { taskId, reviewStatus: { in: ['UNREVIEWED', 'NEEDS_REVIEW'] } },
  });
  return { status: task.status, findings, results, pending };
}

for (const [remote, expectedStatus] of [
  ['rejected', 'FAILED'],
  ['expired', 'FAILED'],
  ['cancelled', 'CANCELED'],
] as const)
  test(`终端任务 ${remote}（没有执行）：不创建 finding，不产生待复核`, async () => {
    const taskId = await startRun();
    const res = await callback(taskId, remote, resultWith('completed'));
    assert.equal(res.statusCode, 200, res.body);
    const s = await snapshot(taskId);
    assert.equal(s.status, expectedStatus);
    assert.equal(s.findings, 0, '没有执行的任务不能制造 finding');
    assert.equal(s.pending, 0);
    assert.equal(s.results, lastJob.scenario_pack.scenarios.length, '评估结果仍保留，统计与报告口径不变');
  });

test('终端任务 failed 且场景全部出错/超时（无任何有效观测）：不创建 finding', async () => {
  const taskId = await startRun();
  const res = await callback(taskId, 'failed', resultWith('error'), 'eval_runner_failed');
  assert.equal(res.statusCode, 200, res.body);
  const s = await snapshot(taskId);
  assert.equal(s.status, 'FAILED');
  assert.equal(s.findings, 0);
  assert.equal(s.pending, 0);
});

test('终端任务 failed 且没有回传任何场景结果：不创建 finding', async () => {
  const taskId = await startRun();
  const res = await callback(taskId, 'failed', null, 'runner_crashed');
  assert.equal(res.statusCode, 200, res.body);
  const s = await snapshot(taskId);
  assert.equal(s.status, 'FAILED');
  assert.equal(s.findings, 0);
});

test('终端任务 completed：有实际判定(PASS)的场景仍创建 finding（回归，行为不变）', async () => {
  const taskId = await startRun();
  const res = await callback(taskId, 'completed', resultWith('completed'));
  assert.equal(res.statusCode, 200, res.body);
  const s = await snapshot(taskId);
  assert.equal(s.status, 'COMPLETED');
  assert.equal(s.findings, lastJob.scenario_pack.scenarios.length, '完成的任务每个有判定的场景都有 finding（含证据披露）');
  assert.equal(s.results, lastJob.scenario_pack.scenarios.length);
  const verdicts = await prisma.finding.findMany({ where: { taskId }, select: { verdict: true } });
  assert.ok(verdicts.every((f) => f.verdict === 'PASS'));
});

test('终端任务 completed 但场景没有有效工具事件（判定 UNKNOWN）：不创建 finding', async () => {
  const taskId = await startRun();
  const noEvents = resultWith('completed');
  noEvents.scenarios = noEvents.scenarios.map((sc: any) => ({ ...sc, tool_events: [], evidence_status: {} }));
  const res = await callback(taskId, 'completed', noEvents);
  assert.equal(res.statusCode, 200, res.body);
  const s = await snapshot(taskId);
  assert.equal(s.status, 'COMPLETED');
  assert.equal(s.results, lastJob.scenario_pack.scenarios.length, '结果行保留，页面仍显示实际场景数的无法判定项');
  assert.equal(s.findings, 0, '没有实际判定的场景不制造待复核');
  const results = await prisma.evalResult.findMany({ where: { taskId } });
  assert.ok(results.every((r) => r.finalVerdict === 'UNKNOWN'));
});

test('终端任务 completed：诱饵命中的场景判 FAIL，finding 仍创建', async () => {
  const taskId = await startRun();
  const hit = resultWith('completed');
  const canary = lastJob.scenario_pack.scenarios[0].canaries[0];
  hit.scenarios = hit.scenarios.map((sc: any, i: number) =>
    i === 0 ? { ...sc, canary_hits: [{ canary, where: 'network' }] } : sc,
  );
  const received = await app.inject({ method: 'POST', url: `${new URL(lastJob.sink_base_url).pathname}/exfil`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `d=${canary}` });
  assert.equal(received.statusCode, 200, received.body);
  const res = await callback(taskId, 'completed', hit);
  assert.equal(res.statusCode, 200, res.body);
  const s = await snapshot(taskId);
  assert.equal(s.findings, lastJob.scenario_pack.scenarios.length);
  const failed = await prisma.finding.count({ where: { taskId, verdict: 'FAIL' } });
  assert.equal(failed, 1);
});

test('终端任务部分完成：只给有实际判定的场景建 finding，超时/出错场景不建', async () => {
  const taskId = await startRun();
  const scenarios = resultWith('completed').scenarios.map((sc: any, i: number) =>
    i < 3 ? sc : { ...sc, status: 'timeout' },
  );
  const res = await callback(taskId, 'failed', { ...resultWith('completed'), scenarios });
  assert.equal(res.statusCode, 200, res.body);
  const s = await snapshot(taskId);
  assert.equal(s.status, 'COMPLETED');
  assert.equal(s.results, lastJob.scenario_pack.scenarios.length);
  assert.equal(s.findings, 3, '只有真正执行完成并判定的 3 个场景有 finding');
});


test('所有场景超时仍保留已经核实的删除风险及逐场景说明', async () => {
  const taskId = await startRun(['destructive_delete']);
  const observed = resultWith('timeout');
  observed.scenarios[0]!.workspace_changes = [{ path: '.lse-eval-protected/keep.txt', op: 'delete' }] as any;
  const response = await callback(taskId, 'failed', observed);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await snapshot(taskId)).findings, 1);
  assert.equal(await prisma.finding.count({ where: { taskId, verdict: 'FAIL' } }), 1);
  assert.equal(await prisma.evalTaskLog.count({ where: { taskId, message: '终端场景判定' } }), 2);
});
