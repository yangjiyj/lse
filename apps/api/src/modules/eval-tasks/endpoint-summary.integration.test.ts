import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { buildApp } from '../../app.js';
import { prisma } from '../../db.js';
import { ensureFleetTarget } from '../fleet-admin/service.js';
const prefix = `__jd24_c_${randomUUID()}_`;
let app: Awaited<ReturnType<typeof buildApp>>;
let token = '',
  targetId = '',
  endpointId = '',
  taskId = '';
before(async () => {
  process.env.FLEET_AGENT_ENABLED = 'true';
  app = await buildApp();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
  const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
  const endpoint = await prisma.fleetEndpoint.create({
    data: {
      publicId: `ep_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      installationId: randomUUID(),
      machineId: prefix,
      hostname: prefix + '电脑',
      os: 'linux',
      capabilities: [],
      tokenHash: '仅供隔离测试',
      lastHealth: {
        live_eval: {
          products: [
            { product: 'codex', liveEvalSupported: true, liveEvalRegistered: true, liveEvalRunnable: true },
          ],
        },
      },
    },
  });
  endpointId = endpoint.id;
  const target = await prisma.$transaction((tx) => ensureFleetTarget(tx, endpoint, admin.id));
  targetId = target.id;
  await prisma.fleetProbeReport.create({
    data: {
      endpointId,
      reportId: prefix + 'report',
      scannedAt: new Date(),
      status: 'complete',
      assetCount: 1,
      bodyHash: '隔离测试',
      body: {
        host: { users: [{ account_key: 'c'.repeat(64), username: 'tester', domain: 'WORKGROUP' }] },
        assets: [
          {
            kind: 'cli_agent',
            product: 'codex',
            name: 'Codex',
            version: '0.160.1',
            evidence: {
              install_path_label: '.codex',
              install_path_hash: `sha256:${'9'.repeat(64)}`,
              owner_account_key: 'c'.repeat(64),
              config: {
                permission_mode: 'ask-SECRETMARK',
                auto_approval: 'default:disabled',
                sandbox_mode: 'unknown',
              },
            },
          },
        ],
        collectors: [],
      },
    },
  });
});
after(async () => {
  if (targetId) {
    const links = await prisma.evalTaskQuestionSet.findMany({
      where: { task: { modelTargetId: targetId } },
      select: { questionSetId: true },
    });
    await prisma.evalTask.deleteMany({ where: { modelTargetId: targetId } });
    await prisma.questionSet.deleteMany({
      where: { id: { in: links.map((l) => l.questionSetId) } },
    });
    await prisma.modelTarget.delete({ where: { id: targetId } });
  }
  if (endpointId) await prisma.fleetEndpoint.delete({ where: { id: endpointId } });
  if (app) await app.close();
  await prisma.$disconnect();
});
const headers = () => ({ authorization: `Bearer ${token}` });
test('普通任务入口可直接创建终端配置检测，摘要保留未知项与真实智能体版本', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: headers(),
    payload: { modelTargetId: targetId, name: prefix + '配置检测', mode: 'posture' },
  });
  assert.equal(created.statusCode, 201, created.body);
  taskId = created.json().taskId;
  const response = await app.inject({
    url: `/api/eval-tasks/${taskId}/endpoint-summary`,
    headers: headers(),
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json();
  assert.equal(data.mode, 'posture');
  assert.equal(data.agents[0].displayName, 'Codex');
  assert.equal(data.agents[0].version, '0.160.1');
  // 终端心跳已登记 Codex：结果页不能再显示成未登记。
  assert.equal(data.agents[0].liveEvalRegistered, true);
  assert.equal(data.agents[0].liveEvalBlockedReason, undefined);
  assert.ok(
    data.groups
      .flatMap((g: { items: Array<{ state: string }> }) => g.items)
      .some((i: { state: string }) => i.state === 'not_checked'),
  );
});
test('终端摘要要求与任务详情相同的登录权限', async () => {
  const response = await app.inject({ url: `/api/eval-tasks/${taskId}/endpoint-summary` });
  assert.equal(response.statusCode, 401);
});
test('配置重评创建新记录并保留原结果', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/eval-tasks/${taskId}/re-eval`,
    headers: headers(),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.notEqual(response.json().id, taskId);
  assert.ok((await prisma.evalResult.count({ where: { taskId } })) > 0);
});
test('真机入口没有影响确认时不得创建执行任务', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: headers(),
    payload: { modelTargetId: targetId, mode: 'live', product: 'codex' },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(await prisma.fleetEvalJob.count({ where: { endpointId } }), 0);
});

test('新建配置体检任务把每个智能体的配置读取状态与安装位置存进快照，任务页读到真实状态', async () => {
  const log = await prisma.evalTaskLog.findFirstOrThrow({
    where: { taskId, message: '终端配置体检范围' },
  });
  const saved = (log.context as { agents?: Array<Record<string, unknown>> }).agents;
  assert.equal(saved?.length, 1);
  assert.equal(saved![0]!.configState, 'partial');
  assert.equal(saved![0]!.location, '~/.codex');
  assert.equal(saved![0]!.account, 'tester');
  assert.doesNotMatch(JSON.stringify(log.context), /SECRETMARK|sha256|WORKGROUP/);
  const response = await app.inject({
    url: `/api/eval-tasks/${taskId}/endpoint-summary`,
    headers: headers(),
  });
  assert.equal(response.statusCode, 200, response.body);
  const agent = response.json().agents[0];
  assert.equal(agent.config.state, 'partial');
  assert.deepEqual(
    agent.config.items.map((i: { item: string; state: string }) => [i.item, i.state]),
    [
      ['permission', 'explicit'],
      ['auto_approval', 'default'],
      ['sandbox', 'unknown'],
    ],
  );
  assert.equal(agent.location, '~/.codex');
  assert.equal(agent.account, 'tester');
  assert.doesNotMatch(response.body, /SECRETMARK|sha256:|snapshot/);
});
test('旧任务快照里没有配置读取状态时不编造：不返回配置状态，位置与账号仍取自当时的报告', async () => {
  const log = await prisma.evalTaskLog.findFirstOrThrow({
    where: { taskId, message: '终端配置体检范围' },
  });
  const { agents: _drop, ...legacy } = log.context as Record<string, unknown>;
  await prisma.evalTaskLog.update({ where: { id: log.id }, data: { context: legacy as object } });
  const response = await app.inject({
    url: `/api/eval-tasks/${taskId}/endpoint-summary`,
    headers: headers(),
  });
  assert.equal(response.statusCode, 200, response.body);
  const agent = response.json().agents[0];
  assert.equal('config' in agent, false);
  assert.equal(agent.location, '~/.codex');
  assert.equal(agent.account, 'tester');
});
