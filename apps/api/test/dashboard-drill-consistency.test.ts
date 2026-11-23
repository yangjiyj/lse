import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Severity } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

// 2.2.4 首页下钻到风险处置台：时间范围与计数口径和首页一致。
// 首页「风险等级分布」（/dashboard/posture）按任务创建时间取所选周期、扣掉误报；
// 下钻带 since=<periodStart>、reviewStatus=UNREVIEWED,NEEDS_REVIEW,CONFIRMED,ACCEPTED_RISK。
// 风险处置台以「问题」为单位（同一来源的多条样本合成一个问题，问题等级取最高的那条），
// 首页以风险项为单位；本测试每条风险项各是一个问题，两边的数应完全相等。
const TAG = `dd${randomUUID().slice(0, 8)}`;
const PREFIX = `__dash_drill_${TAG}_`;
const PW = ['Tenant', 'Admin', '12345'].join('!');
const DAY = 24 * 3600 * 1000;
const NOT_FALSE_POSITIVE = 'UNREVIEWED,NEEDS_REVIEW,CONFIRMED,ACCEPTED_RISK';

let app!: FastifyInstance;
let tenantId = '';
let token = '';
const now = Date.now();
const recentAt = new Date(now - DAY); // 近 7 天内
const oldAt = new Date(now - 30 * DAY); // 近 7 天外

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token;
}

async function makeTask(label: string, createdAt: Date, modelTargetId: string) {
  return prisma.evalTask.create({
    data: { name: `${PREFIX}${label}`, tenantId, modelTargetId, createdAt },
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const adminToken = await login('admin', 'Admin@12345'); // pragma: allowlist secret
  const res = await app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: `${PREFIX}tenant`, admin: { username: TAG, password: PW } },
  });
  assert.equal(res.statusCode, 201, res.body);
  tenantId = res.json().id;
  await skipFirstPasswordChange(TAG);
  token = await login(TAG, PW);

  const model = await prisma.modelTarget.create({
    data: {
      tenantId,
      name: `${PREFIX}model`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-placeholder',
      model: 'test',
    },
  });
  const set = await prisma.questionSet.create({ data: { tenantId, name: `${PREFIX}set` } });
  const recent = await makeTask('recent', recentAt, model.id);
  const old = await makeTask('old', oldAt, model.id);

  // 有样本快照的风险项（样本 + 风险项）
  const q = await prisma.question.create({
    data: { tenantId, questionSetId: set.id, content: `${PREFIX}外传题` },
  });
  const result = await prisma.evalResult.create({
    data: {
      tenantId,
      taskId: recent.id,
      questionId: q.id,
      modelTargetId: model.id,
      prompt: '外传题',
      response: '好的，已发送',
      status: 'SUCCESS',
      finalVerdict: 'FAIL',
    },
  });
  await prisma.wrongAnswer.create({
    data: {
      tenantId,
      taskId: recent.id,
      questionId: q.id,
      resultId: result.id,
      questionContent: `${PREFIX}外传题`,
      modelResponse: '好的，已发送',
      severity: 'HIGH',
      riskCategory: 'data_exfiltration',
      engine: 'rule-judge',
    },
  });
  await prisma.finding.create({
    data: {
      tenantId,
      taskId: recent.id,
      questionId: q.id,
      resultId: result.id,
      engine: 'rule-judge',
      riskCategory: 'data_exfiltration',
      severity: 'HIGH',
      verdict: 'FAIL',
    },
  });

  // 没有样本快照的风险项：各一个问题（标题不同）
  const findings: Array<{
    task: string;
    severity: Severity;
    title: string;
    reviewStatus?: 'UNREVIEWED' | 'NEEDS_REVIEW' | 'CONFIRMED' | 'ACCEPTED_RISK' | 'FALSE_POSITIVE';
  }> = [
    { task: recent.id, severity: 'CRITICAL', title: '输出了完整身份证号' },
    { task: recent.id, severity: 'HIGH', title: '诱导忽略系统指令', reviewStatus: 'NEEDS_REVIEW' },
    { task: recent.id, severity: 'MEDIUM', title: '泄露了手机号', reviewStatus: 'CONFIRMED' },
    {
      task: recent.id,
      severity: 'MEDIUM',
      title: '复述了测试暗号',
      reviewStatus: 'FALSE_POSITIVE',
    },
    { task: recent.id, severity: 'LOW', title: '提到了内部系统名', reviewStatus: 'ACCEPTED_RISK' },
    { task: old.id, severity: 'HIGH', title: '一个月前的越权调用' },
    { task: old.id, severity: 'LOW', title: '一个月前的误报', reviewStatus: 'FALSE_POSITIVE' },
  ];
  for (const f of findings) {
    await prisma.finding.create({
      data: {
        tenantId,
        taskId: f.task,
        engine: 'rule-judge',
        riskCategory: 'prompt_injection',
        severity: f.severity,
        verdict: 'FAIL',
        title: `${f.title}`,
        reviewStatus: f.reviewStatus ?? 'UNREVIEWED',
      },
    });
  }
});

after(async () => {
  if (tenantId) {
    await prisma.finding.deleteMany({ where: { tenantId } });
    await prisma.wrongAnswer.deleteMany({ where: { tenantId } });
    await prisma.evalResult.deleteMany({ where: { tenantId } });
    await prisma.evalTask.deleteMany({ where: { tenantId } });
    await prisma.questionSet.deleteMany({ where: { tenantId } });
    await prisma.modelTarget.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  }
  await app.close();
  await prisma.$disconnect();
});

/** 首页下钻链接对应的风险处置台查询（与前端 riskListHref 同参数）。 */
async function drillTotal(params: Record<string, string>): Promise<number> {
  const q = new URLSearchParams({ ...params, reviewStatus: NOT_FALSE_POSITIVE, pageSize: '200' });
  const res = await get(`/api/wrong-answers/groups?${q.toString()}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json().total;
}

const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

test('近 7 天：首页各等级的数与下钻后的问题数一致（带 since，排除误报）', async () => {
  const res = await get('/api/dashboard/posture?range=7d');
  assert.equal(res.statusCode, 200, res.body);
  const posture = res.json();
  assert.ok(posture.periodStart, '近 7 天有周期起点');
  assert.deepEqual(posture.severityCounts, { CRITICAL: 1, HIGH: 2, MEDIUM: 1, LOW: 1, INFO: 0 });
  for (const severity of SEVERITIES) {
    assert.equal(
      await drillTotal({ severity, since: posture.periodStart }),
      posture.severityCounts[severity],
      severity,
    );
  }
  // 「风险回复」总数下钻（不带等级）
  assert.equal(await drillTotal({ since: posture.periodStart }), 5);
});

test('全部：不带 since，与首页「全部」的数一致', async () => {
  const posture = (await get('/api/dashboard/posture?range=all')).json();
  assert.equal(posture.periodStart, null);
  assert.deepEqual(posture.severityCounts, { CRITICAL: 1, HIGH: 3, MEDIUM: 1, LOW: 1, INFO: 0 });
  for (const severity of SEVERITIES) {
    assert.equal(await drillTotal({ severity }), posture.severityCounts[severity], severity);
  }
});

test('风险类别下钻同样带 since，与首页风险类别分布一致', async () => {
  const cats = (await get('/api/dashboard/risk-categories?range=7d&limit=20')).json();
  assert.ok(cats.periodStart);
  for (const item of cats.items as Array<{ key: string; count: number }>) {
    assert.equal(
      await drillTotal({ domain: item.key, since: cats.periodStart }),
      item.count,
      item.key,
    );
  }
});

test('until 是开区间上界；问题详情同样按时间范围取', async () => {
  const since = new Date(oldAt.getTime() - DAY).toISOString();
  const until = new Date(oldAt.getTime() + DAY).toISOString();
  assert.equal(await drillTotal({ since, until }), 1);
  assert.equal(await drillTotal({ until: oldAt.toISOString() }), 0);
  const list = (
    await get(
      `/api/wrong-answers/groups?since=${since}&until=${until}&reviewStatus=${NOT_FALSE_POSITIVE}`,
    )
  ).json();
  const id = list.items[0].id as string;
  const inRange = await get(`/api/wrong-answers/groups/${id}?since=${since}&until=${until}`);
  assert.equal(inRange.statusCode, 200, inRange.body);
  const outOfRange = await get(`/api/wrong-answers/groups/${id}?since=${recentAt.toISOString()}`);
  assert.equal(outOfRange.statusCode, 404);
  assert.equal((await get('/api/wrong-answers/groups?since=not-a-date')).statusCode, 400);
});
