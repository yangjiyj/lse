import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';

const prefix = `__remediation_${randomUUID()}_`;
let app!: FastifyInstance;
let token = '';
let targetId = '';
let findingId = '';
let originalTaskId = '';
let noisyRetestTaskId = '';
let cleanRetestTaskId = '';
let scopeMismatchTaskId = '';
let restrictedUserId = '';
let restrictedRoleId = '';
let restrictedToken = '';
let adminUserId = '';

const auth = () => ({ authorization: `Bearer ${token}` });

async function createTask(name: string, status: 'PENDING' | 'COMPLETED' = 'PENDING') {
  return prisma.evalTask.create({
    data: {
      name: `${prefix}${name}`,
      modelTargetId: targetId,
      engines: ['agent-tool-guard'],
      dimensions: ['prompt_injection'],
      status,
      createdById: adminUserId,
      finishedAt: status === 'COMPLETED' ? new Date('2026-09-06T10:00:00.000Z') : null,
    },
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
  adminUserId = (await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).id;

  const readPermission = await prisma.permission.findUniqueOrThrow({
    where: { code: 'remediation:read' },
  });
  const updatePermission = await prisma.permission.findUniqueOrThrow({
    where: { code: 'remediation:update' },
  });
  const restrictedRole = await prisma.role.create({
    data: { name: `${prefix}restricted`, description: 'test-only remediation access role' },
  });
  restrictedRoleId = restrictedRole.id;
  await prisma.rolePermission.createMany({
    data: [readPermission, updatePermission].map((permission) => ({
      roleId: restrictedRole.id,
      permissionId: permission.id,
    })),
  });
  const restrictedUser = await prisma.user.create({
    data: {
      username: `${prefix}user`.slice(0, 64),
      passwordHash: await hashPassword('Test-only-Password-123!'),
      displayName: '整改权限测试用户',
      roles: { create: { roleId: restrictedRole.id } },
    },
  });
  restrictedUserId = restrictedUser.id;
  const restrictedLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: restrictedUser.username, password: 'Test-only-Password-123!' },
  });
  assert.equal(restrictedLogin.statusCode, 200, restrictedLogin.body);
  restrictedToken = restrictedLogin.json().token;

  const target = await prisma.modelTarget.create({
    data: {
      name: `${prefix}对象`,
      provider: 'openai-compatible',
      targetType: 'MODEL',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-only',
      model: 'test-model',
    },
  });
  targetId = target.id;
  const original = await createTask('原始任务');
  originalTaskId = original.id;
  const noisy = await createTask('含重复风险复测', 'COMPLETED');
  noisyRetestTaskId = noisy.id;
  await prisma.evalTask.update({ where: { id: noisy.id }, data: { parentTaskId: original.id } });
  const clean = await createTask('无重复风险复测', 'COMPLETED');
  cleanRetestTaskId = clean.id;
  await prisma.evalTask.update({ where: { id: clean.id }, data: { parentTaskId: original.id } });
  const scopeMismatch = await prisma.evalTask.create({
    data: {
      name: `${prefix}范围不同复测`,
      modelTargetId: targetId,
      engines: ['agent-tool-guard'],
      dimensions: ['content_safety'],
      status: 'COMPLETED',
      finishedAt: new Date('2026-09-06T10:00:00.000Z'),
    },
  });
  scopeMismatchTaskId = scopeMismatch.id;

  const set = await prisma.questionSet.create({ data: { name: `${prefix}样本集` } });
  const question = await prisma.question.create({
    data: { questionSetId: set.id, content: `${prefix}样本`, severity: 'HIGH' },
  });
  const result = await prisma.evalResult.create({
    data: {
      taskId: original.id,
      questionId: question.id,
      modelTargetId: target.id,
      prompt: 'test prompt',
      response: 'test response',
      status: 'SUCCESS',
      finalVerdict: 'FAIL',
    },
  });
  const finding = await prisma.finding.create({
    data: {
      taskId: original.id,
      resultId: result.id,
      questionId: question.id,
      engine: 'test-engine',
      riskCategory: 'prompt_injection',
      severity: 'HIGH',
      verdict: 'FAIL',
      reviewStatus: 'CONFIRMED',
      evidence: 'controlled evidence',
    },
  });
  findingId = finding.id;
  await prisma.evalResult.create({ data: { taskId: clean.id, questionId: question.id, modelTargetId: target.id,
    prompt: 'test prompt', response: 'safe retest response', status: 'SUCCESS', finalVerdict: 'PASS' } });
  await prisma.finding.create({
    data: {
      taskId: noisy.id,
      engine: 'test-engine',
      riskCategory: 'prompt_injection',
      severity: 'HIGH',
      verdict: 'FAIL',
      reviewStatus: 'CONFIRMED',
      evidence: 'repeated evidence',
    },
  });
});

after(async () => {
  if (restrictedUserId) await prisma.user.delete({ where: { id: restrictedUserId } });
  if (restrictedRoleId)
    await prisma.rolePermission.deleteMany({ where: { roleId: restrictedRoleId } });
  if (restrictedRoleId) await prisma.role.delete({ where: { id: restrictedRoleId } });
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: prefix } } });
  await app.close();
});

test('整改记录可读写，并把复测再次命中保留为重开而非关闭', async () => {
  const list = await app.inject({
    method: 'GET',
    url: `/api/remediation?taskId=${originalTaskId}`,
    headers: auth(),
  });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().items[0].remediation.status, 'OPEN');

  const needsReview = await app.inject({
    method: 'PATCH',
    url: `/api/remediation/${findingId}/review`,
    headers: auth(),
    payload: { status: 'NEEDS_REVIEW', reason: '先核对原始回答与执行证据。' },
  });
  assert.equal(needsReview.statusCode, 200, needsReview.body);
  assert.equal(needsReview.json().finding.reviewStatus, 'NEEDS_REVIEW');

  const reviewed = await app.inject({
    method: 'PATCH',
    url: `/api/remediation/${findingId}/review`,
    headers: auth(),
    payload: { status: 'CONFIRMED', reason: '已核对回答文本与同题样本，确认属于本次评估风险。' },
  });
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.equal(reviewed.json().finding.reviewStatus, 'CONFIRMED');
  assert.equal(
    reviewed.json().finding.reviewReason,
    '已核对回答文本与同题样本，确认属于本次评估风险。',
  );

  const updated = await app.inject({
    method: 'PATCH',
    url: `/api/remediation/${findingId}`,
    headers: auth(),
    payload: {
      status: 'IN_PROGRESS',
      owner: '安全平台主管',
      team: '应用安全组',
      controlLocation: '应用网关输出策略',
      action: '补充输出阻断和工具授权校验',
      dueAt: '2026-09-30T23:59:59+08:00',
      record: '已创建整改工单并完成方案评审。',
      acceptanceCriteria: '同类变体不可再产生未授权输出。',
    },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().finding.remediation.owner, '安全平台主管');

  const reopened = await app.inject({
    method: 'PATCH',
    url: `/api/remediation/${findingId}`,
    headers: auth(),
    payload: {
      status: 'VERIFIED_CLOSED',
      retestTaskId: noisyRetestTaskId,
      acceptanceCriteria: '同类变体不可再产生未授权输出。',
      closureEvidence: '复测仍命中同类风险。',
    },
  });
  assert.equal(reopened.statusCode, 200, reopened.body);
  assert.equal(reopened.json().reopened, true);
  assert.equal(reopened.json().finding.remediation.status, 'REOPENED');

  const closed = await app.inject({
    method: 'PATCH',
    url: `/api/remediation/${findingId}`,
    headers: auth(),
    payload: {
      status: 'VERIFIED_CLOSED',
      retestTaskId: cleanRetestTaskId,
      acceptanceCriteria: '同类变体不可再产生未授权输出。',
      closureEvidence: '清洁复测已完成，保留复测任务证据。',
    },
  });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(closed.json().finding.remediation.status, 'VERIFIED_CLOSED');

  const reviewAudit = await prisma.auditLog.findFirst({
    where: { action: 'finding.review', targetId: findingId },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(reviewAudit);
});

test('关闭不能用异常/未完成复测或风险接受替代', async () => {
  const finding = await prisma.finding.findUniqueOrThrow({ where: { id: findingId } });
  await prisma.finding.update({
    where: { id: finding.id },
    data: { remediationStatus: 'REOPENED', reviewStatus: 'CONFIRMED' },
  });
  const scopeMismatch = await app.inject({
    method: 'PATCH',
    url: `/api/remediation/${findingId}`,
    headers: auth(),
    payload: {
      status: 'VERIFIED_CLOSED',
      retestTaskId: scopeMismatchTaskId,
      acceptanceCriteria: '条件',
      closureEvidence: '证据',
    },
  });
  assert.equal(scopeMismatch.statusCode, 409, scopeMismatch.body);
  assert.equal(scopeMismatch.json().error.code, 'REMEDIATION_RETEST_SCOPE_MISMATCH');
  await prisma.finding.update({
    where: { id: finding.id },
    data: { reviewStatus: 'ACCEPTED_RISK' },
  });
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/remediation/${findingId}`,
    headers: auth(),
    payload: {
      status: 'VERIFIED_CLOSED',
      retestTaskId: cleanRetestTaskId,
      acceptanceCriteria: '条件',
      closureEvidence: '证据',
    },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, 'REMEDIATION_REVIEW_REQUIRED');
});

test('整改权限仍受评估任务对象归属约束', async () => {
  const list = await app.inject({
    method: 'GET',
    url: `/api/remediation?taskId=${originalTaskId}`,
    headers: { authorization: `Bearer ${restrictedToken}` },
  });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().total, 0);

  const detail = await app.inject({
    method: 'GET',
    url: `/api/remediation/${findingId}`,
    headers: { authorization: `Bearer ${restrictedToken}` },
  });
  assert.equal(detail.statusCode, 404, detail.body);

  const update = await app.inject({
    method: 'PATCH',
    url: `/api/remediation/${findingId}`,
    headers: { authorization: `Bearer ${restrictedToken}` },
    payload: { owner: '越权写入' },
  });
  assert.equal(update.statusCode, 403, update.body);
  assert.equal(update.json().error.code, 'REMEDIATION_ACCESS_DENIED');

  const review = await app.inject({
    method: 'PATCH',
    url: `/api/remediation/${findingId}/review`,
    headers: { authorization: `Bearer ${restrictedToken}` },
    payload: { status: 'FALSE_POSITIVE', reason: '越权复核' },
  });
  assert.equal(review.statusCode, 403, review.body);
  assert.equal(review.json().error.code, 'REMEDIATION_ACCESS_DENIED');
});
