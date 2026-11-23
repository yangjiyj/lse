import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = '__eval_batch_';

let app!: FastifyInstance;
let token = '';
const targetIds: string[] = [];
let setId = '';

function auth() {
  return { authorization: `Bearer ${token}` };
}

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
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
  for (const n of ['a', 'b']) {
    const t = await prisma.modelTarget.create({
      data: {
        name: `${PREFIX}model_${n}`,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-test-dummy',
        model: `fake-${n}`,
      },
    });
    targetIds.push(t.id);
  }
  const set = await prisma.questionSet.create({
    data: {
      name: `${PREFIX}set`,
      type: 'COMPLIANCE',
      questions: {
        create: [
          { content: 'q1', type: 'COMPLIANCE', category: '违法违规' },
          { content: 'q2', type: 'COMPLIANCE', category: '隐私保护' },
        ],
      },
    },
  });
  setId = set.id;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('批量创建少于 2 个模型返回 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks/batch',
    headers: auth(),
    payload: { name: `${PREFIX}one`, modelTargetIds: [targetIds[0]], questionSetIds: [setId] },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('多模型同批次各建一个任务、共用 batchId、写审计；对比接口返回得分与分类通过率', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks/batch',
    headers: auth(),
    payload: { name: `${PREFIX}批次`, modelTargetIds: targetIds, questionSetIds: [setId] },
  });
  assert.equal(res.statusCode, 201, res.body);
  const { batchId, tasks } = res.json() as { batchId: string; tasks: Array<{ id: string }> };
  assert.equal(tasks.length, 2);
  const rows = await prisma.evalTask.findMany({ where: { batchId } });
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.modelTargetId)), new Set(targetIds));
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'eval_task.batch_create', targetId: batchId },
  });
  assert.ok(audit, '应写入批量创建审计日志');

  // 模拟模型 A 完成：1 过 1 不过（分类“违法违规”不通过）+ 1 条高风险发现
  const [taskA] = rows.filter((r) => r.modelTargetId === targetIds[0]);
  const questions = await prisma.question.findMany({ where: { questionSetId: setId } });
  await prisma.evalTask.update({
    where: { id: taskA.id },
    data: {
      status: 'COMPLETED',
      processedQuestions: 2,
      passedCount: 1,
      failedCount: 1,
      progress: 1, // 真正完成的任务进度为 1；评估不完整的任务不出分
    },
  });
  for (const q of questions) {
    await prisma.evalResult.create({
      data: {
        taskId: taskA.id,
        questionId: q.id,
        modelTargetId: targetIds[0],
        prompt: q.content,
        finalVerdict: q.category === '违法违规' ? 'FAIL' : 'PASS',
      },
    });
  }
  await prisma.finding.create({
    data: {
      taskId: taskA.id,
      engine: 'rule-judge',
      riskCategory: 'x',
      severity: 'HIGH',
      verdict: 'FAIL',
    },
  });

  const cmp = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks/compare?batchId=${batchId}`,
    headers: auth(),
  });
  assert.equal(cmp.statusCode, 200, cmp.body);
  const items = cmp.json().items as Array<{
    id: string;
    evalScore: number | null;
    passRate: number | null;
    riskLevels: { HIGH: number };
    categories: Array<{ category: string; passRate: number | null }>;
  }>;
  assert.equal(items.length, 2);
  const a = items.find((i) => i.id === taskA.id)!;
  assert.equal(a.passRate, 0.5);
  assert.equal(a.riskLevels.HIGH, 1);
  // 评测得分与任务详情的综合评测得分同一口径（配置管理权重）
  const weighted = await app.inject({
    method: 'GET',
    url: `/api/evaluation-config/tasks/${taskA.id}/score`,
    headers: auth(),
  });
  assert.equal(weighted.statusCode, 200, weighted.body);
  assert.notEqual(a.evalScore, null);
  assert.equal(a.evalScore, weighted.json().score);
  assert.deepEqual(
    a.categories.map((c) => [c.category, c.passRate]),
    [
      ['违法违规', 0],
      ['隐私保护', 1],
    ].sort((x, y) => String(x[0]).localeCompare(String(y[0]), 'zh-CN')),
  );
  const b = items.find((i) => i.id !== taskA.id)!;
  assert.equal(b.evalScore, null);

  const byIds = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks/compare?ids=${tasks.map((t) => t.id).join(',')}`,
    headers: auth(),
  });
  assert.equal(byIds.statusCode, 200, byIds.body);
  assert.equal(byIds.json().items.length, 2);
});

test('平台开关关闭时批量创建返回 403 且不新建任何任务', async () => {
  const previous = process.env.LSE_PLATFORM_APP_ENABLED;
  process.env.LSE_PLATFORM_APP_ENABLED = 'false';
  const platform = await prisma.modelTarget.create({data:{name:`${PREFIX}platform`,targetType:'PLATFORM_APP',provider:'dify',baseUrl:'https://example.com/v1',apiKey:'app-test',model:'platform-app'}});
  try {
    const before = await prisma.evalTask.count();
    const response = await app.inject({method:'POST',url:'/api/eval-tasks/batch',headers:auth(),payload:{name:`${PREFIX}disabled`,modelTargetIds:[targetIds[0],platform.id],questionSetIds:[setId]}});
    assert.equal(response.statusCode,403,response.body);
    assert.equal(await prisma.evalTask.count(),before);
  } finally { if(previous === undefined) delete process.env.LSE_PLATFORM_APP_ENABLED; else process.env.LSE_PLATFORM_APP_ENABLED=previous; }
});
