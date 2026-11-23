import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { buildReadinessRow } from '../src/modules/dashboard/readiness.js';

const PREFIX = '__dashboard_overview_';

let app!: FastifyInstance;
let token = '';
let highTaskId = '';
let lowTaskId = '';

function auth(): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

async function seedTask(
  suffix: string,
  targetId: string,
  opts: {
    dimensions: string[];
    engines: string[];
    severities: Array<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'>;
  },
) {
  const task = await prisma.evalTask.create({
    data: {
      name: `${PREFIX}${suffix}`,
      status: 'COMPLETED',
      engines: opts.engines,
      dimensions: opts.dimensions,
      totalQuestions: 10,
      processedQuestions: 10,
      passedCount: 10 - opts.severities.length,
      failedCount: opts.severities.length,
      progress: 1,
      startedAt: new Date(),
      finishedAt: new Date(),
      modelTargetId: targetId,
    },
  });
  for (const severity of opts.severities) {
    await prisma.finding.create({
      data: {
        taskId: task.id,
        engine: 'rule-judge',
        riskCategory: 'test',
        severity,
        verdict: 'FAIL',
      },
    });
  }
  return task.id;
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;

  const target = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}target`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-dummy',
      model: 'fake-model',
      lastTestStatus: 'SUCCESS',
    },
  });
  highTaskId = await seedTask('redteam', target.id, {
    dimensions: ['redteam_attack'],
    engines: ['rule-judge'],
    severities: Array.from({ length: 40 }, () => 'CRITICAL' as const).concat([
      'HIGH',
      'MEDIUM',
      'LOW',
      'INFO',
    ]),
  });
  lowTaskId = await seedTask('content', target.id, {
    dimensions: ['compliance'],
    engines: ['rule-judge'],
    severities: ['MEDIUM'],
  });
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('未登录访问 overview 返回 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/dashboard/overview' });
  assert.equal(res.statusCode, 401);
});

test('overview 返回统计、分类、高中低风险分布、TOP5 与就绪表', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/dashboard/overview?period=all',
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.period, 'all');
  assert.ok(body.counts.taskTotal >= 2);
  assert.ok(body.counts.modelTargetCount >= 1);
  assert.equal(typeof body.counts.ownQuestionSetCount, 'number');

  const redteam = body.categories.find((c: { category: string }) => c.category === 'redteam');
  assert.equal(redteam.label, '多轮对抗演练');
  assert.ok(redteam.count >= 1);

  // CRITICAL/HIGH→高，MEDIUM→中，LOW/INFO→低
  assert.ok(body.riskDistribution.HIGH >= 41);
  assert.ok(body.riskDistribution.MEDIUM >= 2);
  assert.ok(body.riskDistribution.LOW >= 2);

  const top = body.topHighRiskTasks[0];
  assert.equal(top.id, highTaskId, '高风险发现最多的任务排第一');
  assert.equal(top.highRiskCount, 41);
  assert.equal(top.mediumRiskCount, 1);
  assert.equal(top.lowRiskCount, 2);
  // TOP5 的评估得分与任务详情综合评估得分同一口径
  const weighted = await app.inject({
    method: 'GET',
    url: `/api/evaluation-config/tasks/${top.id}/score`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(weighted.statusCode, 200, weighted.body);
  assert.equal(top.evalScore, weighted.json().score);
  assert.ok(body.topHighRiskTasks.length <= 5);
  assert.ok(!body.topHighRiskTasks.some((t: { id: string }) => t.id === lowTaskId));

  const row = body.readiness.find((r: { taskId: string }) => r.taskId === highTaskId);
  assert.ok(row, '最近任务出现在流程就绪表');
  assert.equal(row.modelName, `${PREFIX}target`);
  assert.equal(row.startStatus, '已启动');
  assert.deepEqual(
    row.stages.map((s: { label: string }) => s.label),
    ['模型接入', '样本库', '启动', '运行', '复核', '报告'],
  );
  assert.equal(row.stages[4].detail, '待复核 44 项');

  const recent = body.recentTasks.find((t: { id: string }) => t.id === lowTaskId);
  assert.equal(recent.categoryLabel, '内容安全评估');
  assert.ok(Array.isArray(body.taskStatus));
  assert.equal(body.taskTrend.length, 14);
});

test('period=7d 只统计近 7 天任务', async () => {
  await prisma.evalTask.update({
    where: { id: lowTaskId },
    data: { createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
  });
  const all = (
    await app.inject({ method: 'GET', url: '/api/dashboard/overview?period=all', headers: auth() })
  ).json();
  const week = (
    await app.inject({ method: 'GET', url: '/api/dashboard/overview?period=7d', headers: auth() })
  ).json();
  assert.equal(all.counts.periodTaskCount - week.counts.periodTaskCount >= 1, true);
});

test('就绪表：复核全部完成且未出报告时提示可生成报告', () => {
  const row = buildReadinessRow({
    id: 't',
    name: 'n',
    status: 'COMPLETED',
    startedAt: new Date(),
    totalQuestions: 5,
    questionSetCount: 1,
    reportCount: 0,
    findingCount: 3,
    pendingReviewCount: 0,
    modelTargetId: 'mt',
    modelTarget: { name: 'm', isActive: true, lastTestStatus: null },
  });
  assert.equal(row.stages[0].detail, '未做连通测试');
  assert.equal(row.stages[4].detail, '复核完成');
  assert.equal(row.stages[5].detail, '可生成报告');
});
