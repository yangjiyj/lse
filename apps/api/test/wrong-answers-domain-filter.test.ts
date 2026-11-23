import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

// 2.2.4 总览下钻：风险处置台按风险类别（与首页「风险类别分布」同一套风险域）筛选。
const PREFIX = `__wa_domain_${randomUUID().slice(0, 8)}_`;
let app!: FastifyInstance;
let token = '';
let taskId = '';
let taskB = '';
let modelId = '';
let setId = '';

function get(path: string) {
  return app.inject({
    method: 'GET',
    url: `/api/wrong-answers${path}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
  const model = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}model`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-placeholder',
      model: 'test',
    },
  });
  modelId = model.id;
  setId = (await prisma.questionSet.create({ data: { name: `${PREFIX}set`, type: 'GENERAL' } })).id;
  taskId = (
    await prisma.evalTask.create({ data: { name: `${PREFIX}task`, modelTargetId: modelId } })
  ).id;

  // 有样本快照的：数据外传
  const q = await prisma.question.create({ data: { questionSetId: setId, content: '外传测试题' } });
  const result = await prisma.evalResult.create({
    data: {
      taskId,
      questionId: q.id,
      modelTargetId: modelId,
      prompt: '外传测试题',
      response: '好的，已发送',
      status: 'SUCCESS',
      finalVerdict: 'FAIL',
    },
  });
  await prisma.wrongAnswer.create({
    data: {
      taskId,
      questionId: q.id,
      resultId: result.id,
      questionContent: '外传测试题',
      modelResponse: '好的，已发送',
      severity: 'HIGH',
      riskCategory: 'data_exfiltration',
    },
  });
  await prisma.finding.create({
    data: {
      taskId,
      questionId: q.id,
      resultId: result.id,
      engine: 'rule-judge',
      riskCategory: 'data_exfiltration',
      severity: 'HIGH',
      verdict: 'FAIL',
    },
  });
  // 没有样本快照的发现：提示词注入；以及原始类别不是风险域编码、要归到隐私泄露的
  await prisma.finding.create({
    data: {
      taskId,
      engine: 'rule-judge',
      riskCategory: 'prompt_injection',
      title: '诱导忽略系统指令',
      severity: 'MEDIUM',
      verdict: 'FAIL',
    },
  });
  await prisma.finding.create({
    data: {
      taskId,
      engine: 'rule-judge',
      riskCategory: 'sensitive_info_pii',
      title: '输出了身份证号',
      severity: 'LOW',
      verdict: 'FAIL',
    },
  });

  // 第二个任务：同一类别下不同等级、不同处置状态；以及样本快照没记引擎、风险项记了引擎的。
  taskB = (
    await prisma.evalTask.create({ data: { name: `${PREFIX}task-b`, modelTargetId: modelId } })
  ).id;
  for (const [title, severity, reviewStatus] of [
    ['泄露了手机号', 'HIGH', 'UNREVIEWED'],
    ['泄露了邮箱', 'HIGH', 'FALSE_POSITIVE'],
    ['泄露了住址', 'LOW', 'CONFIRMED'],
  ] as const) {
    await prisma.finding.create({
      data: {
        taskId: taskB,
        engine: 'rule-judge',
        riskCategory: 'sensitive_info_pii',
        title,
        severity,
        reviewStatus,
        verdict: 'FAIL',
      },
    });
  }
  const pq = await prisma.question.create({
    data: { questionSetId: setId, content: '组件版本题' },
  });
  const pr = await prisma.evalResult.create({
    data: {
      taskId: taskB,
      questionId: pq.id,
      modelTargetId: modelId,
      prompt: '组件版本题',
      response: '使用了过期组件',
      status: 'SUCCESS',
      finalVerdict: 'FAIL',
    },
  });
  await prisma.wrongAnswer.create({
    data: {
      taskId: taskB,
      questionId: pq.id,
      resultId: pr.id,
      questionContent: '组件版本题',
      modelResponse: '使用了过期组件',
      severity: 'MEDIUM',
      riskCategory: 'outdated_package',
    },
  });
  await prisma.finding.create({
    data: {
      taskId: taskB,
      questionId: pq.id,
      resultId: pr.id,
      engine: 'trivy',
      riskCategory: 'outdated_package',
      severity: 'MEDIUM',
      verdict: 'FAIL',
    },
  });
});

after(async () => {
  for (const id of [taskId, taskB].filter(Boolean)) {
    await prisma.finding.deleteMany({ where: { taskId: id } });
    await prisma.wrongAnswer.deleteMany({ where: { taskId: id } });
    await prisma.evalResult.deleteMany({ where: { taskId: id } });
    await prisma.evalTask.delete({ where: { id } });
  }
  if (setId) await prisma.questionSet.delete({ where: { id: setId } });
  if (modelId) await prisma.modelTarget.delete({ where: { id: modelId } });
  await app.close();
  await prisma.$disconnect();
});

test('不带类别时列出全部', async () => {
  const res = await get(`/groups?taskId=${taskId}`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().total, 3);
});

test('按风险类别筛选，口径与首页风险类别分布一致', async () => {
  const exfil = await get(`/groups?taskId=${taskId}&domain=data_exfiltration`);
  assert.equal(exfil.statusCode, 200, exfil.body);
  assert.equal(exfil.json().total, 1);
  assert.equal(exfil.json().items[0].sampleCount, 1);

  const injection = (await get(`/groups?taskId=${taskId}&domain=prompt_injection`)).json();
  assert.deepEqual(
    injection.items.map((g: { title: string }) => g.title),
    ['诱导忽略系统指令'],
  );
  // sensitive_info_pii 按风险域归到隐私泄露
  const privacy = (await get(`/groups?taskId=${taskId}&domain=privacy_leakage`)).json();
  assert.deepEqual(
    privacy.items.map((g: { title: string }) => g.title),
    ['输出了身份证号'],
  );
  // 页签计数也只算该类别
  assert.equal(privacy.counts['待确认'], 1);

  // 首页风险类别分布里同样归到这三类
  const cats = await app.inject({
    method: 'GET',
    url: '/api/dashboard/risk-categories?range=all&limit=20',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(cats.statusCode, 200, cats.body);
  const keys = cats.json().items.map((c: { key: string }) => c.key);
  for (const key of ['data_exfiltration', 'prompt_injection', 'privacy_leakage']) {
    assert.ok(keys.includes(key), key);
  }
});

test('类别筛选同样作用于问题详情；不认识的类别返回 400', async () => {
  const group = (await get(`/groups?taskId=${taskId}&domain=prompt_injection`)).json().items[0];
  const detail = await get(`/groups/${group.id}?taskId=${taskId}&domain=prompt_injection`);
  assert.equal(detail.statusCode, 200, detail.body);
  const other = await get(`/groups/${group.id}?taskId=${taskId}&domain=privacy_leakage`);
  assert.equal(other.statusCode, 404);
  assert.equal((await get(`/groups?domain=not_a_domain`)).statusCode, 400);
});

test('类别与等级同时筛选时，页签计数也按等级算，与列表合计一致', async () => {
  const all = (await get(`/groups?taskId=${taskB}&domain=privacy_leakage&severity=HIGH`)).json();
  assert.deepEqual(all.items.map((g: { title: string }) => g.title).sort(), [
    '泄露了手机号',
    '泄露了邮箱',
  ]);
  assert.deepEqual(all.counts, { 待确认: 1, 整改中: 0, 已关闭: 1 });
  const sum = Object.values(all.counts as Record<string, number>).reduce((a, b) => a + b, 0);
  assert.equal(all.total, sum);
  const pending = (
    await get(`/groups?taskId=${taskB}&domain=privacy_leakage&severity=HIGH&status=待确认`)
  ).json();
  assert.equal(pending.total, pending.counts['待确认']);
  // 不带等级时整改中的低危也计入
  const noSeverity = (await get(`/groups?taskId=${taskB}&domain=privacy_leakage`)).json();
  assert.deepEqual(noSeverity.counts, { 待确认: 1, 整改中: 1, 已关闭: 1 });
});

test('样本快照没记引擎时按风险项的引擎归类，与首页一致', async () => {
  const res = (await get(`/groups?taskId=${taskB}&domain=component_vulnerability`)).json();
  assert.deepEqual(
    res.items.map((g: { sampleCount: number }) => g.sampleCount),
    [1],
  );
  const cats = await app.inject({
    method: 'GET',
    url: '/api/dashboard/risk-categories?range=all&limit=20',
    headers: { authorization: `Bearer ${token}` },
  });
  const keys = cats.json().items.map((c: { key: string }) => c.key);
  assert.ok(keys.includes('component_vulnerability'));
});

async function exportText(query: string): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/wrong-answers/export?${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
  const cells: string[] = [];
  wb.eachSheet((sheet) =>
    sheet.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.text)))),
  );
  return cells.join('\n');
}

test('导出按风险类别和日期过滤，与列表同口径；不认识的类别返回 400', async () => {
  assert.match(await exportText(`taskId=${taskId}`), /外传测试题/);
  assert.match(await exportText(`taskId=${taskId}&domain=data_exfiltration`), /外传测试题/);
  assert.doesNotMatch(await exportText(`taskId=${taskId}&domain=privacy_leakage`), /外传测试题/);
  const future = new Date(Date.now() + 86_400_000).toISOString();
  assert.doesNotMatch(
    await exportText(`taskId=${taskId}&since=${encodeURIComponent(future)}`),
    /外传测试题/,
  );
  const bad = await app.inject({
    method: 'GET',
    url: `/api/wrong-answers/export?taskId=${taskId}&domain=not_a_domain`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(bad.statusCode, 400);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'wrong_answer.export', targetId: taskId },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok((audit?.detail as { since?: string })?.since, '审计记下筛选条件');
});
