import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { authenticate } from '../src/plugins/auth.js';
import { hashPassword } from '../src/lib/password.js';
import { prisma } from '../src/db.js';

const PREFIX = '__framework_heatmap_';
const USERNAME = `${PREFIX}forbidden`;
const PASSWORD = `${PREFIX}password`;
const ADMIN_PASSWORD = ['Admin', '@', '12345'].join('');
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';
let forbiddenToken = '';
let taskId = '';
let targetId = '';
let findingId = '';

async function cleanup() {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.role.deleteMany({ where: { name: `${PREFIX}role` } });
  await prisma.user.deleteMany({ where: { username: USERNAME } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();

  const role = await prisma.role.create({ data: { name: `${PREFIX}role`, description: '无评测权限测试角色' } });
  await prisma.user.create({ data: {
    username: USERNAME,
    passwordHash: await hashPassword(PASSWORD),
    displayName: '框架权限测试用户',
    passwordChangedAt: new Date(),
    lastActiveAt: new Date(),
    roles: { create: { roleId: role.id } },
  } });
  const adminLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: ADMIN_PASSWORD } });
  assert.equal(adminLogin.statusCode, 200, adminLogin.body);
  adminToken = adminLogin.json().token;
  const adminMe = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(adminToken) });
  assert.equal(adminMe.statusCode, 200, adminMe.body);
  const forbiddenLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: USERNAME, password: PASSWORD } });
  assert.equal(forbiddenLogin.statusCode, 200, forbiddenLogin.body);
  forbiddenToken = forbiddenLogin.json().token;
  const forbiddenMe = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(forbiddenToken) });
  assert.equal(forbiddenMe.statusCode, 200, forbiddenMe.body);

  const target = await prisma.modelTarget.create({ data: {
    name: `${PREFIX}target`, provider: 'test', baseUrl: 'https://placeholder.invalid', apiKey: '', model: 'test',
  } });
  targetId = target.id;
  const questionSet = await prisma.questionSet.create({ data: { name: `${PREFIX}set`, type: 'GENERAL', tags: [] } });
  const questions = await Promise.all([
    ['pass', 'prompt_injection'], ['fail', 'prompt_injection'], ['unmapped', 'general_safety'],
    ['unknown', 'prompt_injection'], ['error', 'prompt_injection'], ['manual', 'prompt_injection'],
  ].map(([key, category]) => prisma.question.create({ data: {
    questionSetId: questionSet.id, content: `${PREFIX}${key}`, category, type: 'GENERAL', tags: [],
  } })));
  const task = await prisma.evalTask.create({ data: {
    name: `${PREFIX}task`, status: 'COMPLETED', modelTargetId: targetId,
    totalQuestions: questions.length, finishedAt: new Date(),
    questionSets: { create: { questionSetId: questionSet.id } },
  } });
  taskId = task.id;
  const verdicts = ['PASS', 'FAIL', 'PASS', 'UNKNOWN', 'ERROR', 'PASS'] as const;
  for (let i = 0; i < questions.length; i += 1) {
    const result = await prisma.evalResult.create({ data: {
      taskId, questionId: questions[i]!.id, modelTargetId: targetId,
      prompt: `${PREFIX}prompt`, response: 'response', finalVerdict: verdicts[i],
    } });
    const finding = await prisma.finding.create({ data: {
      taskId, resultId: result.id, questionId: questions[i]!.id,
      engine: 'test', riskCategory: questions[i]!.category!, verdict: verdicts[i] === 'FAIL' ? 'FAIL' : 'PASS',
    } });
    if (i === 5) findingId = finding.id;
  }
  await prisma.findingFrameworkMapping.createMany({ data: [
    { findingId, framework: 'OWASP_LLM', entryId: 'LLM01', entryName: '提示词注入', action: 'REMOVE', reason: 'heatmap test' },
    { findingId, framework: 'OWASP_LLM', entryId: 'LLM02', entryName: '敏感信息泄露', action: 'UPSERT', reason: 'heatmap test' },
  ] });
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('匿名用户无法读取热力图或修订人工映射', async () => {
  const get = await app.inject({ method: 'GET', url: '/api/frameworks/heatmap?dimension=task&framework=OWASP_LLM' });
  assert.equal(get.statusCode, 401);
  const post = await app.inject({ method: 'POST', url: `/api/frameworks/findings/${findingId}/mappings`, payload: {
    framework: 'OWASP_LLM', entryId: 'LLM03', entryName: '供应链', action: 'UPSERT', reason: 'unauthenticated',
  } });
  assert.equal(post.statusCode, 401);
});

test('缺少评测权限的用户不能读取热力图或修订映射', async () => {
  const get = await app.inject({ method: 'GET', url: '/api/frameworks/heatmap?dimension=task&framework=OWASP_LLM', headers: auth(forbiddenToken) });
  assert.equal(get.statusCode, 403, get.body);
  const post = await app.inject({ method: 'POST', url: `/api/frameworks/findings/${findingId}/mappings`, headers: auth(forbiddenToken), payload: {
    framework: 'OWASP_LLM', entryId: 'LLM03', entryName: '供应链', action: 'UPSERT', reason: 'forbidden',
  } });
  assert.equal(post.statusCode, 403);
});

test('按已判定结果统计热力图并应用逐条人工映射', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/frameworks/heatmap?dimension=task&framework=OWASP_LLM', headers: auth(adminToken) });
  assert.equal(response.statusCode, 200, response.body);
  const heatmap = response.json();
  assert.equal(heatmap.unmappedCount, 1);
  const cell = (entryId: string) => heatmap.cells.find((item: { entryId: string; columnId: string }) => item.entryId === entryId && item.columnId === taskId);
  assert.deepEqual({ testCount: cell('LLM01').testCount, failCount: cell('LLM01').failCount, rate: cell('LLM01').rate }, { testCount: 2, failCount: 1, rate: 0.5 });
  assert.equal(cell('LLM02').testCount, 1, '人工 UPSERT 应把 Finding 加入 LLM02');
  assert.equal(cell('LLM03').tested, false);
  assert.equal(cell('LLM03').rate, null);
  assert.equal(cell('LLM01').testCount + cell('LLM02').testCount, 3, 'UNKNOWN/ERROR 不计入判定分母或任何格子');

  const revision = await app.inject({ method: 'POST', url: `/api/frameworks/findings/${findingId}/mappings`, headers: auth(adminToken), payload: {
    framework: 'OWASP_LLM', entryId: 'LLM02', entryName: '敏感信息泄露', action: 'UPSERT', reason: 'verify audit trail',
  } });
  assert.equal(revision.statusCode, 200, revision.body);
  const audit = await prisma.auditLog.findFirst({ where: {
    action: 'finding.framework_mapping.update', targetType: 'finding', targetId: findingId,
  }, orderBy: { createdAt: 'desc' } });
  assert.ok(audit, '人工映射修订应写入审计日志');
});

test("未映射结果按风险类别给出明细", async () => {
  const response = await app.inject({ method: "GET", url: "/api/frameworks/heatmap?dimension=task&framework=OWASP_LLM", headers: auth(adminToken) });
  const heatmap = response.json();
  const total = heatmap.unmapped.reduce((sum: number, item: { count: number }) => sum + item.count, 0);
  assert.equal(total, heatmap.unmappedCount);
  assert.ok(heatmap.unmapped.length > 0 && heatmap.unmapped.every((item: { label: string }) => item.label.length > 0));
});

test("ATLAS 条目带中文译名与战术中文名，且口径与覆盖矩阵一致", async () => {
  const response = await app.inject({ method: "GET", url: "/api/frameworks/heatmap?dimension=task&framework=ATLAS_MATRIX", headers: auth(adminToken) });
  const heatmap = response.json();
  const t51 = heatmap.items.find((item: { id: string }) => item.id === "AML.T0051");
  assert.equal(t51.nameEn, "LLM Prompt Injection");
  assert.equal(t51.nameZh, "大模型提示词注入");
  assert.ok(t51.groupZh.length > 0 && /[一-龥]/.test(t51.groupZh), "战术应为中文名");
  const tested = heatmap.cells.filter((cell: { tested: boolean }) => cell.tested).map((cell: { entryId: string }) => cell.entryId);
  assert.ok(tested.includes("AML.T0051"));
  const coverage = await app.inject({ method: "GET", url: `/api/frameworks/coverage?framework=ATLAS&taskId=${taskId}`, headers: auth(adminToken) });
  const covTested = coverage.json().rows.filter((row: { tested: number }) => row.tested > 0).map((row: { entryId: string }) => row.entryId).sort();
  assert.deepEqual([...new Set(tested)].sort(), covTested);
});

test("OWASP 智能体一侧与覆盖矩阵口径一致", async () => {
  const response = await app.inject({ method: "GET", url: "/api/frameworks/heatmap?dimension=task&framework=OWASP_AGENTIC", headers: auth(adminToken) });
  const coverage = await app.inject({ method: "GET", url: `/api/frameworks/coverage?framework=OWASP_AGENTIC&taskId=${taskId}`, headers: auth(adminToken) });
  const covTested = coverage.json().rows.filter((row: { tested: number }) => row.tested > 0).map((row: { entryId: string }) => row.entryId).sort();
  const heatTested = [...new Set(response.json().cells.filter((cell: { tested: boolean }) => cell.tested).map((cell: { entryId: string }) => cell.entryId))].sort();
  assert.deepEqual(heatTested, covTested);
});
