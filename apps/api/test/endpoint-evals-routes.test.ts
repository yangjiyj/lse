import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { runEvalTask } from '../src/modules/eval-tasks/executor.js';
import { signRequest } from '../src/modules/endpoint-evals/agentshield-client.js';
import { pollEndpointJobs } from '../src/modules/endpoint-evals/poller.js';
import { readFileSync } from 'node:fs';
const PREFIX = '__endpoint_eval_b_';
let app: FastifyInstance, token: string, targetId: string;
let lastJob: Record<string, any>;
let status = 'pending_approval';
let jobResult: unknown = null;
let cancelConflict = false;
let cancelRequests = 0;
let endpointOs = 'linux';
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  res.setHeader('content-type', 'application/json');
  if (req.url?.includes('/posture'))
    return res.end(
      JSON.stringify({
        endpoint_id: 'endpoint',
        product: 'codex',
        permissions: { mode: 'bypassPermissions', allow: [], skip_confirm: true },
        mcp_servers: [],
        skills: [],
        instruction_files: [],
        credentials_exposure: [],
        hooks: [],
        managed_by_agentshield: false,
      }),
    );
  if (req.url?.startsWith('/connectors/lse/endpoints'))
    return res.end(
      JSON.stringify([
        {
          endpoint_id: 'endpoint',
          hostname: '测试终端',
          os: endpointOs,
          eval_runner_version: '1',
          agents: [{ product: 'codex', headless_capable: true }],
        },
      ]),
    );
  if (req.url === '/connectors/lse/eval-jobs' && req.method === 'POST') {
    lastJob = JSON.parse(raw);
    return res.end(JSON.stringify({ job_id: lastJob.lse_task_id, status: 'pending_approval' }));
  }
  if (req.url?.endsWith('/cancel')) {
    cancelRequests++;
    if (cancelConflict) {
      res.statusCode = 409;
      return res.end(JSON.stringify({ error: 'job already ended' }));
    }
    return res.end(JSON.stringify({ status: 'cancelled' }));
  }
  res.end(
    JSON.stringify({
      job_id: req.url?.split('/').at(-1),
      status,
      result: jobResult,
      error: status === 'rejected' ? '管理员拒绝测试' : null,
    }),
  );
});
async function cleanupStandard() {
  const scope = { standardRun: { task: { modelTarget: { name: { startsWith: PREFIX } } } } };
  await prisma.standardJudgment.deleteMany({ where: { sample: scope } });
  await prisma.standardSampleAttempt.deleteMany({ where: { sample: scope } });
  await prisma.standardSample.deleteMany({ where: scope });
  await prisma.standardRun.deleteMany({
    where: { task: { modelTarget: { name: { startsWith: PREFIX } } } },
  });
}
async function cleanup() {
  await cleanupStandard();
  await prisma.evalPlan.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  await prisma.evalTask.deleteMany({
    where: {
      OR: [{ name: { startsWith: PREFIX } }, { modelTarget: { name: { startsWith: PREFIX } } }],
    },
  });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.standardBankReleaseItem.deleteMany({
    where: { release: { name: { startsWith: PREFIX } } },
  });
  await prisma.standardBankRelease.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.standardQuestionRevision.deleteMany({
    where: { contentHash: { startsWith: PREFIX } },
  });
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
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
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
const auth = () => ({ authorization: `Bearer ${token}` });
async function run() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/endpoint-evals/run',
    headers: auth(),
    payload: { modelTargetId: targetId, name: `${PREFIX}run` },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().taskId as string;
}
function signed(payload: unknown, timestamp = String(Math.floor(Date.now() / 1000))) {
  const body = JSON.stringify(payload);
  return {
    body,
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
  };
}
test('开关关闭时所有入口不可用；普通入口要求登录', async () => {
  process.env.LSE_ENDPOINT_EVAL_ENABLED = 'false';
  assert.equal((await app.inject('/api/endpoint-evals/endpoints')).statusCode, 404);
  process.env.LSE_ENDPOINT_EVAL_ENABLED = 'true';
  assert.equal((await app.inject('/api/endpoint-evals/endpoints')).statusCode, 401);
  assert.equal(
    (await app.inject({ url: '/api/endpoint-evals/endpoints', headers: auth() })).statusCode,
    200,
  );
});
test('配置体检同步落库十九条规则、任务、结果和报告数据', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/endpoint-evals/posture',
    headers: auth(),
    payload: { modelTargetId: targetId, name: `${PREFIX}posture` },
  });
  assert.equal(res.statusCode, 201, res.body);
  const task = await prisma.evalTask.findUniqueOrThrow({
    where: { id: res.json().taskId },
    include: { findings: true, results: true },
  });
  assert.equal(task.status, 'COMPLETED');
  assert.equal(task.results.length, 19);
  assert.equal(task.findings.length, 19);
  assert.ok(task.failedCount > 0);
});
test('真机任务审批、免登录签名回调、防重放、跨任务绑定及重复完成保护', async () => {
  const taskId = await run();
  assert.equal(
    (await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } })).status,
    'PENDING',
  );
  assert.equal(lastJob.callback_url, 'https://lse.example/api/endpoint-evals/callback');
  assert.match(lastJob.sink_base_url, /^https:\/\/lse.example\/sink\/[a-f0-9]+$/);
  const payload = { job_id: taskId, lse_task_id: taskId, status: 'running' };
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/endpoint-evals/callback', payload })).statusCode,
    401,
  );
  const req = signed(payload);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/endpoint-evals/callback',
        headers: req.headers,
        payload: req.body,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/endpoint-evals/callback',
        headers: req.headers,
        payload: req.body,
      })
    ).statusCode,
    409,
  );
  const wrong = signed({ ...payload, job_id: 'other' });
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/endpoint-evals/callback',
        headers: wrong.headers,
        payload: wrong.body,
      })
    ).statusCode,
    400,
  );
  const result = {
    runner_version: '1',
    product: 'codex',
    product_version: '1',
    os: 'linux',
    isolation: 'hook-only',
    model_route: 'vendor',
    registry_untrusted: true,
    scenarios: lastJob.scenario_pack.scenarios.map((s: any) => ({
      scenario_id: s.scenario_id,
      status: 'completed',
      exit_code: 0,
      duration_ms: 1,
      final_text: s.canaries[0],
      tool_events: [],
      transcript_excerpt: '',
      canary_hits: [{ canary: s.canaries[0], where: 'network' }],
      workspace_changes: [],
      cleanup_error: '工作区删除失败',
    })),
  };
  const sinkUrl = new URL(lastJob.sink_base_url);
  await app.inject({
    url: `${sinkUrl.pathname}/exfil?d=${lastJob.scenario_pack.scenarios.map((s: any) => s.canaries[0]).join(',')}`,
  });
  const complete = signed({ ...payload, status: 'completed', result });
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/endpoint-evals/callback',
        headers: complete.headers,
        payload: complete.body,
      })
    ).statusCode,
    200,
  );
  assert.equal(await prisma.evalResult.count({ where: { taskId } }), lastJob.scenario_pack.scenarios.length);
  assert.equal((await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } })).failedCount, lastJob.scenario_pack.scenarios.length);
  const duplicate = signed(
    { ...payload, status: 'completed', result },
    String(Math.floor(Date.now() / 1000) + 1),
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/endpoint-evals/callback',
        headers: duplicate.headers,
        payload: duplicate.body,
      })
    ).statusCode,
    200,
  );
  assert.equal(await prisma.evalResult.count({ where: { taskId } }), lastJob.scenario_pack.scenarios.length);
  const report = await app.inject({
    method: 'POST',
    url: '/api/reports',
    headers: auth(),
    payload: { taskId },
  });
  assert.ok([200, 201].includes(report.statusCode), report.body);
  assert.ok(JSON.stringify(report.json()).includes('hook-only'), '报告必须披露真实隔离方式');
  assert.ok(JSON.stringify(report.json()).includes('vendor'), '报告必须披露模型路由');
  for (const text of ['工作区删除失败', '终端测评配置未经根用户签发（仅测试环境）'])
    assert.ok(JSON.stringify(report.json()).includes(text), `报告必须披露：${text}`);
  const detail = await app.inject({ url: `/api/eval-tasks/${taskId}/results`, headers: auth() });
  assert.equal(detail.statusCode, 200, detail.body);
  for (const text of ['工作区删除失败', '终端测评配置未经根用户签发（仅测试环境）'])
    assert.ok(detail.body.includes(text), `任务详情结果必须披露：${text}`);
  const findings = await prisma.finding.findMany({ where: { taskId } });
  assert.ok(JSON.stringify(findings).includes('hook-only'));
  for (const finding of findings) {
    assert.match(finding.evidence ?? '', /工作区删除失败/);
    assert.match(finding.evidence ?? '', /终端测评配置未经根用户签发（仅测试环境）/);
  }
});
test('轮询兜底完成失败任务，迟到状态不回退', async () => {
  const taskId = await run();
  status = 'failed';
  jobResult = null;
  await pollEndpointJobs();
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } });
  assert.equal(task.status, 'FAILED');
  assert.equal(await prisma.evalResult.count({ where: { taskId } }), lastJob.scenario_pack.scenarios.length);
});
test('runner 失败的错误码进入任务描述，回调错误保留脱敏证据', async () => {
  const original = JSON.parse(
    readFileSync(new URL('./fixtures/endpoint-evals/b2-run1-result.json', import.meta.url), 'utf8'),
  );
  const message = 'hookd 必须不可被组或其他用户写入（0775）';
  for (const source of ['callback-string', 'callback-object', 'scenario'] as const) {
    const taskId = await run();
    const result = {
      ...original,
      scenarios: lastJob.scenario_pack.scenarios.map((_: any, i: number) => ({
        ...original.scenarios[i % original.scenarios.length],
        scenario_id: lastJob.scenario_pack.scenarios[i].scenario_id,
        ...(source === 'scenario' ? { final_text: `eval_runner_failed: ${message}` } : {}),
      })),
    };
    const req = signed({
      job_id: taskId,
      lse_task_id: taskId,
      status: 'failed',
      result,
      error:
        source === 'callback-string'
          ? message
          : source === 'callback-object'
            ? {
                code: 'eval_runner_failed',
                message,
                stderr: 'Authorization: Bearer private-runner-token',
              }
            : undefined,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/endpoint-evals/callback',
      headers: req.headers,
      payload: req.body,
    });
    assert.equal(response.statusCode, 200, response.body);
    const task = await prisma.evalTask.findUniqueOrThrow({
      where: { id: taskId },
      include: { findings: true },
    });
    assert.equal(task.status, 'FAILED');
    assert.match(task.description ?? '', /eval_runner_failed/);
    // 错误原因（错误码）仍进入任务描述；不再依赖逐场景 finding 携带，令牌不得出现。
    assert.match(task.description ?? '', /eval_runner_failed/);
    assert.ok(!JSON.stringify(task).includes('private-runner-token'));
    // 任务失败 = 没有可复核的内容：不为场景创建 finding（评估结果行照常保留）。
    assert.equal(task.findings.length, 0);
    assert.equal(await prisma.evalResult.count({ where: { taskId } }), lastJob.scenario_pack.scenarios.length);
  }
});

for (const [remote, statuses, local, description] of [
  [
    'failed',
    ['completed', 'completed', 'completed', 'timeout', 'timeout', 'timeout'],
    'COMPLETED',
    '终端测评部分完成：完成 6 个，超时 6 个，出错 0 个',
  ],
  [
    'completed',
    ['timeout', 'timeout', 'timeout', 'error', 'error', 'error'],
    'FAILED',
    '终端测评失败',
  ],
  ['failed', Array(12).fill('completed'), 'COMPLETED', '终端测评完成'],
  [
    'completed',
    ['completed', 'completed', 'error', 'timeout', 'error', 'timeout'],
    'COMPLETED',
    '终端测评部分完成：完成 4 个，超时 4 个，出错 4 个',
  ],
  ['cancelled', Array(12).fill('completed'), 'CANCELED', '终端测评已取消'],
  ['rejected', Array(12).fill('completed'), 'FAILED', '终端管理员已驳回'],
  ['expired', Array(12).fill('completed'), 'FAILED', '审批超时已过期'],
] as const)
  test(`场景结果决定任务结论：${remote} ${statuses.join(',')}`, async () => {
    const taskId = await run();
    const transcript = '{"type":"thread.started","thread_id":"test"}\n{"type":"turn.started"}';
    const req = signed({
      job_id: taskId,
      lse_task_id: taskId,
      status: remote,
      result: {
        runner_version: '1',
        product: 'codex',
        product_version: '1',
        os: 'linux',
        isolation: 'hook-only',
        model_route: 'unknown',
        scenarios: lastJob.scenario_pack.scenarios.map((s: any, i: number) => ({
          scenario_id: s.scenario_id,
          status: statuses[i % statuses.length],
          exit_code: 0,
          duration_ms: 1,
          final_text: '',
          tool_events: [],
          transcript_excerpt: transcript,
          canary_hits: [],
          workspace_changes: [],
        })),
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/endpoint-evals/callback',
      headers: req.headers,
      payload: req.body,
    });
    assert.equal(response.statusCode, 200, response.body);
    const task = await prisma.evalTask.findUniqueOrThrow({
      where: { id: taskId },
      include: { findings: true },
    });
    assert.equal(task.status, local);
    assert.ok(task.description?.startsWith(description), task.description ?? '');
    assert.ok(!task.description?.includes('{"type"'));
    if (description.includes('部分完成') || description === '终端测评完成')
      assert.equal(task.description, description);
    // 本组场景没有有效工具事件，全部判 UNKNOWN：没有实际判定就不建 finding（见 endpoint-finding-gate.test.ts）。
    assert.equal(task.findings.length, 0);
    assert.equal(await prisma.evalResult.count({ where: { taskId } }), lastJob.scenario_pack.scenarios.length);
  });
test('公开 sink 绑定 runToken，真实收到诱饵后留证，未知 token 拒绝', async () => {
  await run();
  const url = new URL(lastJob.sink_base_url);
  const canary = lastJob.scenario_pack.scenarios[0].canaries[0];
  assert.equal((await app.inject({ url: `${url.pathname}/exfil?d=${canary}` })).statusCode, 200);
  assert.equal((await app.inject({ url: '/sink/unknown/exfil?d=x' })).statusCode, 404);
});
test('终端任务禁止进入普通执行器、重评与失败复测入口', async () => {
  const taskId = await run();
  await runEvalTask(taskId);
  assert.equal(
    (await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } })).status,
    'PENDING',
  );
  assert.equal(await prisma.evalResult.count({ where: { taskId } }), 0);
  const set = await prisma.evalTaskQuestionSet.findFirstOrThrow({ where: { taskId } });
  const normal = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: auth(),
    payload: {
      name: `${PREFIX}wrong`,
      modelTargetId: targetId,
      questionSetIds: [set.questionSetId],
    },
  });
  assert.equal(normal.statusCode, 400, normal.body);
  const rerun = await app.inject({
    method: 'POST',
    url: `/api/eval-tasks/${taskId}/re-eval`,
    headers: auth(),
  });
  assert.equal(rerun.statusCode, 400, rerun.body);
  const retest = await app.inject({
    method: 'POST',
    url: `/api/eval-tasks/${taskId}/retest-failed`,
    headers: auth(),
    payload: {},
  });
  assert.equal(retest.statusCode, 400, retest.body);
});
test('取消终端任务同步通知连接器，终端状态以远端结果落库', async () => {
  const taskId = await run();
  const before = cancelRequests;
  const cancelled = await app.inject({
    method: 'POST',
    url: `/api/eval-tasks/${taskId}/cancel`,
    headers: auth(),
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelRequests, before + 1);
  assert.equal(
    (await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } })).status,
    'CANCELED',
  );
});
test('回调保留原始空白验签，拒绝过期、篡改与不合法 JSON', async () => {
  const taskId = await run();
  const payload = { job_id: taskId, lse_task_id: taskId, status: 'queued' };
  const expired = signed(payload, String(Math.floor(Date.now() / 1000) - 301));
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/endpoint-evals/callback',
        headers: expired.headers,
        payload: expired.body,
      })
    ).statusCode,
    401,
  );
  const req = signed(payload);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/endpoint-evals/callback',
        headers: req.headers,
        payload: req.body + ' ',
      })
    ).statusCode,
    401,
  );
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify(payload, null, 2);
  const headers = {
    'content-type': 'application/json',
    'X-LSE-Timestamp': ts,
    'X-LSE-Signature': signRequest('route-secret', ts, 'POST', '/api/endpoint-evals/callback', raw),
  };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/endpoint-evals/callback',
        headers,
        payload: raw,
      })
    ).statusCode,
    200,
  );
  headers['X-LSE-Signature'] = signRequest(
    'route-secret',
    ts,
    'POST',
    '/api/endpoint-evals/callback',
    '{',
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/endpoint-evals/callback',
        headers,
        payload: '{',
      })
    ).statusCode,
    400,
  );
});

test('并发重放只能接收一次，同一任务的乱序状态不能回退', async () => {
  const taskId = await run();
  const req = signed({ job_id: taskId, lse_task_id: taskId, status: 'running' });
  const results = await Promise.all(
    [1, 2].map(() =>
      app.inject({
        method: 'POST',
        url: '/api/endpoint-evals/callback',
        headers: req.headers,
        payload: req.body,
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  const older = signed({ job_id: taskId, lse_task_id: taskId, status: 'queued' });
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/endpoint-evals/callback',
        headers: older.headers,
        payload: older.body,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } })).description,
    '终端正在执行',
  );
});
test('对象不能保存连接器密钥，错误产品或场景结果拒绝并回滚', async () => {
  const updated = await app.inject({
    method: 'PATCH',
    url: `/api/model-targets/${targetId}`,
    headers: auth(),
    payload: { apiKey: 'must-live-in-env' },
  });
  assert.equal(updated.statusCode, 400, updated.body);
  const taskId = await run();
  const invalid = signed({
    job_id: taskId,
    lse_task_id: taskId,
    status: 'completed',
    result: {
      runner_version: '1',
      product: 'claude-code',
      product_version: '1',
      os: 'linux',
      isolation: 'hook-only',
      model_route: 'vendor',
      scenarios: [],
    },
  });
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/endpoint-evals/callback',
        headers: invalid.headers,
        payload: invalid.body,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } })).status,
    'PENDING',
  );
});
test('终端对象声明配置体检与审批测评能力，失败复测服务统一分流', async () => {
  const response = await app.inject({ url: `/api/model-targets/${targetId}`, headers: auth() });
  assert.ok(
    response
      .json()
      .connectorCapabilities.some(
        (c: { key: string; supported: boolean }) => c.key === 'endpoint_posture' && c.supported,
      ),
  );
  const { retestBlockReason } = await import('../src/modules/eval-tasks/failed-retest.js');
  assert.match(
    retestBlockReason(
      { status: 'COMPLETED', engines: ['endpoint-agent-eval'], standardRun: null },
      6,
    ) ?? '',
    /终端/,
  );
});

test('报告区分普通终端拒绝与危险尝试', async () => {
  const { buildAgentTraceSamples } = await import('../src/modules/reports/report-builder.js');
  const findings = [
    {
      verdict: 'PASS',
      severity: 'LOW',
      detail: {
        trace: [
          {
            toolName: 'Read',
            allowed: false,
            blockedBy: 'endpoint',
            blockReason: 'user cancelled',
          },
          {
            toolName: 'Bash',
            allowed: false,
            blockedBy: 'endpoint',
            riskSurface: 'destructive_command',
          },
        ],
      },
    },
  ] as Parameters<typeof buildAgentTraceSamples>[0];
  const samples = buildAgentTraceSamples(findings);
  assert.equal(samples[0].interceptedLabel, '终端防护已拦截');
  assert.equal(samples[1].interceptedLabel, '终端防护已拦截（危险尝试）');
});

for (const [remote, local, label] of [
  ['rejected', 'FAILED', '终端管理员已驳回：管理员拒绝测试'],
  ['expired', 'FAILED', '审批超时已过期'],
  ['cancelled', 'CANCELED', '终端测评已取消'],
  ['failed', 'FAILED', '终端测评失败'],
] as const)
  test(`Go null result 轮询终态 ${remote}`, async () => {
    const taskId = await run();
    status = 'pending_approval';
    jobResult = null;
    const errors: unknown[] = [];
    await pollEndpointJobs((e) => errors.push(e));
    assert.deepEqual(errors, []);
    status = remote;
    await pollEndpointJobs((e) => errors.push(e));
    assert.deepEqual(errors, []);
    const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(task.status, local);
    assert.equal(task.description, label);
  });
test('回调封装后的 2MB 结果允许超过原 2MB body 限制', async () => {
  const taskId = await run();
  const req = signed({
    job_id: taskId,
    lse_task_id: taskId,
    status: 'running',
    result: null,
    error: 'x'.repeat(2 * 1024 * 1024),
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/endpoint-evals/callback',
    headers: req.headers,
    payload: req.body,
  });
  assert.equal(response.statusCode, 200, response.body);
});
test('上游取消冲突返回中文 409 且不改任务状态', async () => {
  const taskId = await run();
  cancelConflict = true;
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/eval-tasks/${taskId}/cancel`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.match(response.body, /任务已结束，无法取消/);
    assert.equal(
      (await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } })).status,
      'PENDING',
    );
  } finally {
    cancelConflict = false;
  }
});
test('只读用户不可枚举终端资产', async () => {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'auditor' } });
  const user = await prisma.user.create({
    data: {
      username: `${PREFIX}auditor`,
      passwordHash: 'unused',
      displayName: '只读用户',
      passwordChangedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });
  try {
    const response = await app.inject({
      url: '/api/endpoint-evals/endpoints',
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: user.id })}` },
    });
    assert.equal(response.statusCode, 403, response.body);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
async function planInput() {
  const taskId = await run();
  const set = await prisma.evalTaskQuestionSet.findFirstOrThrow({ where: { taskId } });
  return {
    name: `${PREFIX}plan`,
    targetId,
    cron: '0 2 * * *',
    timezone: 'Asia/Shanghai',
    minIntervalMinutes: 60,
    templateParams: { questionSetIds: [set.questionSetId] },
  };
}
test('计划保存拒绝终端对象', async () => {
  const saved = await app.inject({
    method: 'POST',
    url: '/api/eval-plans',
    headers: auth(),
    payload: await planInput(),
  });
  assert.equal(saved.statusCode, 400, saved.body);
  assert.match(saved.body, /终端智能体请在对象详情页发起配置体检或真机测评/);
});
test('历史计划触发拒绝终端对象', async () => {
  const plan = await prisma.evalPlan.create({ data: await planInput() });
  try {
    const { triggerEvalPlan } = await import('../src/modules/eval-plans/service.js');
    await assert.rejects(
      () => triggerEvalPlan(prisma, plan.id, { triggeredBy: 'manual', actorId: null }),
      /终端智能体请在对象详情页发起配置体检或真机测评/,
    );
    assert.equal(await prisma.evalTask.count({ where: { planId: plan.id } }), 0);
  } finally {
    await prisma.evalPlan.delete({ where: { id: plan.id } });
  }
});
test('多对象批量入口拒绝终端对象', async () => {
  const payload = await planInput();
  const other = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}other`,
      provider: 'test',
      targetType: 'MODEL',
      baseUrl: 'http://127.0.0.1:9',
      model: 'test',
      apiKey: 'test',
    },
  });
  const batch = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks/batch',
    headers: auth(),
    payload: {
      name: `${PREFIX}batch`,
      modelTargetIds: [targetId, other.id],
      questionSetIds: payload.templateParams.questionSetIds,
    },
  });
  assert.equal(batch.statusCode, 400, batch.body);
  assert.match(batch.body, /终端智能体请在对象详情页发起配置体检或真机测评/);
});
test('历史普通引擎任务也按目标类型禁止失败复测', async () => {
  const taskId = await run();
  await prisma.evalTask.update({
    where: { id: taskId },
    data: { engines: ['rule-judge'], status: 'COMPLETED' },
  });
  const { createFailedRetestTask } = await import('../src/modules/eval-tasks/failed-retest.js');
  const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
  await assert.rejects(
    () => createFailedRetestTask(prisma, taskId, { actorId: admin.id }),
    /终端智能体请在对象详情页发起配置体检或真机测评/,
  );
});

test('ADR 导入入口不得给终端对象伪造普通分析任务', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/agent-evals/adr/import',
    headers: auth(),
    payload: {
      modelTargetId: targetId,
      name: `${PREFIX}adr`,
      payload: {
        timestamp: '2026-10-20T00:00:00Z',
        source: 'codex',
        session_id: 's',
        chat_history: [{ role: 'assistant', content: '拒绝', tools: [] }],
      },
    },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.body, /终端智能体请在对象详情页发起配置体检或真机测评/);
});
for (const [url, extra] of [
  ['/api/agent-evals/run', {}],
  ['/api/eval-tasks', { name: `${PREFIX}ordinary`, questionSetIds: [] }],
  ['/api/eval-tasks/multimodal', { attackTypes: ['typographic'] }],
] as const)
  test(`其他创建入口给出终端专用提示 ${url}`, async () => {
    const payload = await planInput();
    const response = await app.inject({
      method: 'POST',
      url,
      headers: auth(),
      payload: {
        modelTargetId: targetId,
        ...extra,
        questionSetId: payload.templateParams.questionSetIds[0],
        questionSetIds: payload.templateParams.questionSetIds,
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    if (url === '/api/eval-tasks') {
      const error=response.json().error;
      assert.equal(error.code,'VALIDATION_ERROR');
      assert.match(response.body,/mode/);
    } else {
      assert.match(response.body, /终端智能体请在对象详情页发起配置体检或真机测评/);
    }
  });

test('国标专项入口拒绝终端对象', async () => {
  const revision = await prisma.standardQuestionRevision.create({
    data: {
      version: 1,
      content: '测试问题',
      expectedBehavior: '拒绝',
      primaryCategory: 'other_illegal_harmful',
      secondaryCategories: [],
      language: 'zh',
      modality: 'text',
      source: 'TEST_FIXTURE_NOT_FORMAL_BANK',
      standardProfileId: 'gbt-45654-2025',
      standardProfileVersion: '1',
      contentHash: `${PREFIX}hash`,
    },
  });
  const release = await prisma.standardBankRelease.create({
    data: {
      name: `${PREFIX}release`,
      profileId: 'gbt-45654-2025',
      profileVersion: '1',
      language: 'zh',
      modalities: ['text'],
      status: 'PUBLISHED',
      counts: {},
      validation: { ok: true },
      overallHash: `${PREFIX}releasehash`,
      items: { create: [{ revisionId: revision.id, bankType: 'SHOULD_REFUSE', position: 0 }] },
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/standard-evaluations',
      headers: auth(),
      payload: {
        modelTargetId: targetId,
        bankReleaseId: release.id,
        name: `${PREFIX}standard`,
        seed: 'test',
        mode: 'DIAGNOSTIC',
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /终端智能体请在对象详情页发起配置体检或真机测评/);
  } finally {
    await cleanupStandard();
    await prisma.evalTask.deleteMany({ where: { name: `${PREFIX}standard` } });
    await prisma.standardBankReleaseItem.deleteMany({ where: { releaseId: release.id } });
    await prisma.standardBankRelease.delete({ where: { id: release.id } });
    await prisma.standardQuestionRevision.delete({ where: { id: revision.id } });
  }
});
test('fanout 开启时拒绝终端对象且不执行普通模型调用', async () => {
  const previous = await prisma.systemSetting.findUnique({ where: { key: 'agent_eval.config' } });
  await prisma.systemSetting.upsert({
    where: { key: 'agent_eval.config' },
    create: { key: 'agent_eval.config', value: { fanoutEnabled: true } },
    update: { value: { fanoutEnabled: true } },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-evals/fanout',
      headers: auth(),
      payload: { modelTargetId: targetId },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /终端智能体请在对象详情页发起配置体检或真机测评/);
  } finally {
    if (previous)
      await prisma.systemSetting.update({
        where: { key: previous.key },
        data: { value: previous.value! },
      });
    else await prisma.systemSetting.delete({ where: { key: 'agent_eval.config' } });
  }
});

test('历史任务按目标类型禁止原地重评', async () => {
  const taskId = await run();
  await prisma.evalTask.update({
    where: { id: taskId },
    data: { status: 'COMPLETED', engines: ['rule-judge'] },
  });
  const response = await app.inject({
    method: 'POST',
    url: `/api/eval-tasks/${taskId}/re-eval`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error.code,'ENDPOINT_LIVE_CONFIRMATION_REQUIRED');
  assert.match(response.body,/重新选择智能体和风险类型，并确认影响后发起/);
});

for (const entry of ['adr', 'fanout', 'writeback', 'redteam', 'probe'])
  test(`独立持久化服务拒绝终端对象 ${entry}`, async () => {
    const { persistAdrImportRun } = await import('../src/modules/agent-evals/adr-persist.js');
    const { previewAdrPayload } = await import('../src/modules/agent-evals/adr-import.js');
    const { persistFanoutRun } = await import('../src/modules/agent-evals/fanout/persist.js');
    const { writeAssuranceRunToEvalTask } =
      await import('../src/modules/assurance/eval-task-writeback.js');
    const { createRedTeamProbeTask, runAssuranceAttackDefenseProbes } =
      await import('../src/modules/assurance/attack-defense-probes.js');
    const reject = (fn: () => Promise<unknown>) =>
      assert.rejects(fn, /终端智能体请在对象详情页发起配置体检或真机测评/);
    const preview = previewAdrPayload({
      source: 'codex',
      session_id: 's',
      timestamp: '2026-10-20T00:00:00Z',
      chat_history: [{ role: 'assistant', content: '拒绝', tools: [] }],
    });
    if (entry === 'adr')
      await reject(() =>
        persistAdrImportRun(prisma, {
          preview,
          modelTargetId: targetId,
          modelTargetName: `${PREFIX}target`,
          taskName: `${PREFIX}adr-service`,
        }),
      );
    if (entry === 'fanout')
      await reject(() =>
        persistFanoutRun(prisma, {
          runToken: 'test',
          modelTargetId: targetId,
          modelTargetName: `${PREFIX}target`,
          objective: { secretHint: 'canary', benignTaskZh: '测试' },
          findings: [],
          failedChannels: [],
        }),
      );
    if (entry === 'writeback')
      await reject(() =>
        writeAssuranceRunToEvalTask(prisma, {
          runId: '20261020-test',
          modelTargetId: targetId,
          questionSetId: targetId,
          result: {
            status: 'COMPLETED',
            stopReason: null,
            samples: [],
            evidenceSummaries: [],
            attributions: [],
            artifactManifestPath: '',
          },
          artifactManifestPath: '',
          gatewayRef: '',
          lseRef: '',
        }),
      );
    if (entry === 'redteam')
      await reject(() =>
        createRedTeamProbeTask(
          prisma,
          { runId: 'test', gatewayModelTargetId: targetId, redTeamBareTargetId: targetId },
          targetId,
        ),
      );
    if (entry === 'probe')
      await reject(() =>
        runAssuranceAttackDefenseProbes(prisma, {
          runId: 'test',
          gatewayModelTargetId: targetId,
          agentSampleCount: 1,
        }),
      );
  });

for (const [url, payload] of [
  ['/api/eval-tasks/standard-compliance', {}],
  [
    '/api/gateway-logs/analyze',
    { startTime: '2026-10-20T00:00:00Z', endTime: '2026-10-20T01:00:00Z' },
  ],
] as const)
  test(`其他专项入口拒绝终端并使用统一文案 ${url}`, async () => {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: auth(),
      payload: { ...payload, modelTargetId: targetId },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /终端智能体请在对象详情页发起配置体检或真机测评/);
  });
test('RAG 专项入口拒绝终端对象', async () => {
  const corpus = await prisma.ragCorpus.create({ data: { name: `${PREFIX}rag` } });
  try {
    const set = await prisma.ragTestSet.create({
      data: {
        corpusId: corpus.id,
        name: `${PREFIX}rag`,
        seed: 'test',
        promptVersion: '1',
        poisonDocument: '',
        poisonCanary: '',
        sentinelDocument: '',
        sentinelToken: '',
        items: { create: [{ type: 'FACT', question: '测试问题', sourceChunkIds: [] }] },
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/rag-eval/runs',
      headers: auth(),
      payload: { modelTargetId: targetId, testSetId: set.id },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /终端智能体请在对象详情页发起配置体检或真机测评/);
  } finally {
    await prisma.ragCorpus.delete({ where: { id: corpus.id } });
  }
});

test('Windows 终端只要具备测评运行器与无头智能体，也能发起真机测评', async () => {
  endpointOs = 'windows';
  try {
    const taskId = await run();
    assert.equal(
      (await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } })).status,
      'PENDING',
    );
  } finally {
    endpointOs = 'linux';
  }
});
