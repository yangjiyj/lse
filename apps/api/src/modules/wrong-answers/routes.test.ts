import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../db.js';

let app: FastifyInstance;
let token = '';
let taskId = '';
let modelId = '';
let setId = '';

before(async () => {
  app = await buildApp();
  await app.ready();
  token = (await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' } })).json().token; // pragma: allowlist secret
  const model = await prisma.modelTarget.create({ data: { name: '车道D归并回归模型', provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-placeholder', model: 'test' } });
  modelId = model.id;
  const set = await prisma.questionSet.create({ data: { name: '车道D归并回归题集', type: 'GENERAL' } });
  setId = set.id;
  const task = await prisma.evalTask.create({ data: { name: '车道D归并回归任务', modelTargetId: modelId } });
  taskId = task.id;
  for (let i = 0; i < 2; i++) {
    const q = await prisma.question.create({ data: { questionSetId: setId, content: '脱敏测试题',
      metadata: { sourceQuestionId: '车道D原题' } } });
    const result = await prisma.evalResult.create({ data: { taskId, questionId: q.id, modelTargetId: modelId,
      prompt: '脱敏题', response: '我不能执行 LSE-CANARY-TEST', status: 'SUCCESS', finalVerdict: 'FAIL' } });
    await prisma.wrongAnswer.create({ data: { taskId, questionId: q.id, resultId: result.id,
      questionContent: '脱敏题'.repeat(300), modelResponse: result.response, severity: i ? 'CRITICAL' : 'HIGH',
      riskCategory: 'data_exfiltration', reason: '未观察到工具执行轨迹' } });
    await prisma.finding.create({ data: { taskId, questionId: q.id, resultId: result.id,
      engine: 'rule-judge', riskCategory: 'data_exfiltration', verdict: 'FAIL' } });
  }
});
after(async () => {
  if (taskId) {
    await prisma.finding.deleteMany({ where: { taskId } });
    await prisma.wrongAnswer.deleteMany({ where: { taskId } });
    await prisma.evalResult.deleteMany({ where: { taskId } });
    await prisma.evalTask.delete({ where: { id: taskId } });
  }
  if (setId) {
    await prisma.question.deleteMany({ where: { questionSetId: setId } });
    await prisma.questionSet.delete({ where: { id: setId } });
  }
  if (modelId) await prisma.modelTarget.delete({ where: { id: modelId } });
  if (app) await app.close();
  await prisma.$disconnect();
});
function get(path: string) {
  return app.inject({ method: 'GET', url: `/api/wrong-answers${path}`, headers: { authorization: `Bearer ${token}` } });
}
test('归并路由保留原列表且返回分页、最高等级、误报数', async () => {
  const res = await get(`/groups?taskId=${taskId}`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().total, 1);
  assert.equal(res.json().items[0].sampleCount, 2);
  assert.equal(res.json().items[0].severity, 'CRITICAL');
  assert.equal(res.json().items[0].suspectedFalsePositive, 2);
  assert.equal((await get(`?taskId=${taskId}`)).json().total, 2);
});
test('详情按组分页成员，完整操作引用不受分页影响', async () => {
  const id = (await get(`/groups?taskId=${taskId}`)).json().items[0].id;
  const res = await get(`/groups/${id}?taskId=${taskId}&pageSize=1&page=2`);
  assert.equal(res.statusCode, 200, res.body);
  const detail = res.json();
  assert.equal(detail.members.items.length, 1);
  assert.equal(detail.members.total, 2);
  assert.equal(detail.representative.questionContent.length, 600);
  assert.equal(detail.findingRefs.length, 2);
  assert.equal(detail.retestPlan.length, 0);
});
test('不存在问题返回404，未登录不能读取，非法页码返回400', async () => {
  assert.equal((await get('/groups/不存在')).statusCode, 404);
  assert.equal((await get('/groups?page=0')).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/wrong-answers/groups' })).statusCode, 401);
});
test('终端无样本快照的历史重复 finding 仍能归并并复核', async () => {
  const ids: string[] = [];
  try {
    for (let i = 0; i < 3; i++) ids.push((await prisma.finding.create({ data: { taskId,
      engine: 'endpoint-posture', riskCategory: 'permissions', title: '危险操作免确认',
      verdict: 'FAIL', severity: 'HIGH' } })).id);
    const res = await get(`/groups?taskId=${taskId}`);
    const g = res.json().items.find((g: { title: string }) => g.title === '危险操作免确认');
    assert.equal(g.sampleCount, 3);
    const detail = (await get(`/groups/${g.id}?taskId=${taskId}`)).json();
    assert.equal(detail.findingRefs.length, 3);
    assert.equal(detail.retestPlan.length, 0);
    await prisma.finding.updateMany({ where: { id: { in: ids } }, data: { reviewStatus: 'FALSE_POSITIVE' } });
    const closed = (await get(`/groups?taskId=${taskId}&status=已关闭`)).json();
    assert.equal(closed.total, 1);
  } finally { await prisma.finding.deleteMany({ where: { id: { in: ids } } }); }
});

test('发现深链不混入同结果其他类别，重复关联状态保守汇总', async () => {
  const answer = await prisma.wrongAnswer.findFirstOrThrow({ where: { taskId } });
  const findings = await prisma.finding.findMany({ where: { taskId, resultId: answer.resultId } });
  const original = findings[0]!;
  const other = await prisma.finding.create({ data: { taskId, resultId: answer.resultId,
    engine: 'rule-judge', riskCategory: 'privacy_leakage', title: '隐私风险', verdict: 'FAIL' } });
  const duplicate = await prisma.finding.create({ data: { taskId, resultId: answer.resultId,
    engine: 'rule-judge', riskCategory: 'data_exfiltration', reviewStatus: 'UNREVIEWED', verdict: 'FAIL' } });
  try {
    await prisma.finding.update({ where: { id: original.id }, data: { reviewStatus: 'FALSE_POSITIVE' } });
    const scoped = (await get(`/groups?taskId=${taskId}&findingIds=${other.id}`)).json();
    assert.equal(scoped.items[0].sampleCount, 1);
    assert.equal(scoped.total, 1);
    const groups = (await get(`/groups?taskId=${taskId}`)).json();
    const group = groups.items.find((g: { sampleCount: number }) => g.sampleCount === 2);
    const detail = (await get(`/groups/${group.id}?taskId=${taskId}`)).json();
    assert.equal(detail.status, '待确认');
    assert.equal(detail.findingRefs.length, 3);
  } finally {
    await prisma.finding.deleteMany({ where: { id: { in: [other.id, duplicate.id] } } });
    await prisma.finding.update({ where: { id: original.id }, data: { reviewStatus: 'UNREVIEWED' } });
  }
});
