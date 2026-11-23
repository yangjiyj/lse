import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PFX = 'GENT_';
const NO_LLM_USERNAME = 'generator_routes_no_llm';
const NO_LLM_ROLE = 'generator_routes_no_llm_role';
const NO_LLM_PASSWORD = ['Generator', 'Routes', '12345'].join('!');
let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
let noLlmToken = '';
function auth() {
  return { authorization: `Bearer ${token}` };
}
function authNoLlm() {
  return { authorization: `Bearer ${noLlmToken}` };
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await prisma.question.deleteMany({ where: { questionSet: { name: { startsWith: PFX } } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: NO_LLM_USERNAME } });
  await prisma.role.deleteMany({ where: { name: NO_LLM_ROLE } });

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  token = login.json().token;

  const permissions = await prisma.permission.findMany({
    where: { code: { in: ['generator:preview', 'generator:run'] } },
    select: { id: true },
  });
  assert.equal(permissions.length, 2);
  const role = await prisma.role.create({
    data: {
      name: NO_LLM_ROLE,
      description: '生成器路由测试：无 LLM 增强权限',
      permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
    },
  });
  const passwordHash = await argon2.hash(NO_LLM_PASSWORD, { type: argon2.argon2id });
  await prisma.user.create({
    data: {
      username: NO_LLM_USERNAME,
      passwordHash,
      displayName: '无增强权限生成器用户',
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  const noLlmLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: NO_LLM_USERNAME, password: NO_LLM_PASSWORD },
  });
  assert.equal(noLlmLogin.statusCode, 200, noLlmLogin.body);
  noLlmToken = noLlmLogin.json().token;
});

after(async () => {
  await prisma.question.deleteMany({ where: { questionSet: { name: { startsWith: PFX } } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: NO_LLM_USERNAME } });
  await prisma.role.deleteMany({ where: { name: NO_LLM_ROLE } });
  await app.close();
});

test('未认证 → 401', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/generator/preview', payload: {} });
  assert.equal(res.statusCode, 401);
});

test('preview 干跑返回 requested/produced/capacityCeiling/samples，不落库', async () => {
  const before = await prisma.questionSet.count({ where: { name: { startsWith: PFX } } });
  const res = await app.inject({
    method: 'POST',
    url: '/api/generator/preview',
    headers: auth(),
    payload: { types: ['GENERAL'], language: 'zh', count: 12, seed: 'p1' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.requested, 12);
  assert.ok(body.produced > 0 && body.produced <= 12);
  assert.ok(body.capacityCeiling >= body.produced);
  assert.ok(Array.isArray(body.samples) && body.samples.length <= 20);
  assert.equal(await prisma.questionSet.count({ where: { name: { startsWith: PFX } } }), before); // 未落库
});

test('preview 默认自动语言与变体并返回 diversity 分布', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/generator/preview',
    headers: auth(),
    payload: {
      types: ['PROMPT_INJECTION', 'SHOULD_REFUSE', 'COMPLIANCE'],
      count: 60,
      seed: 'auto-preview',
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(body.diversity.languages.length >= 8);
  assert.ok(body.diversity.variants.length >= 8);
  assert.ok(
    body.diversity.riskDomains.some((item: { key: string }) => item.key === 'prompt_injection'),
  );
  assert.ok(
    body.samples.some((q: { tags: string[] }) => q.tags.some((tag) => tag.startsWith('variant:'))),
  );
  assert.ok(
    body.samples.some((q: { tags: string[] }) => q.tags.some((tag) => tag.startsWith('risk:'))),
  );
});

test('generate 落库：建题集（source=generator:签名, language）+ createMany 题目', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/generator/generate',
    headers: auth(),
    payload: {
      name: `${PFX}set1`,
      types: ['GENERAL', 'SHOULD_REFUSE'],
      language: 'zh',
      count: 20,
      variantStrength: 1,
      seed: 'g1',
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.ok(body.questionSetId);
  assert.ok(body.produced > 0);
  const set = await prisma.questionSet.findUnique({
    where: { id: body.questionSetId },
    include: { _count: { select: { questions: true } } },
  });
  assert.equal(set?.language, 'zh');
  assert.match(set?.source ?? '', /^generator:gen/);
  assert.equal(set?._count.questions, body.produced);
});

test('generate 默认自动模式：题集 multi 元数据、题目风险标签与审计 diversity', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/generator/generate',
    headers: auth(),
    payload: {
      name: `${PFX}auto`,
      types: ['PROMPT_INJECTION', 'SHOULD_REFUSE', 'COMPLIANCE'],
      count: 80,
      seed: 'auto-route',
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.ok(body.diversity.languages.length >= 8);
  assert.ok(body.diversity.variants.length >= 8);
  const set = await prisma.questionSet.findUnique({
    where: { id: body.questionSetId },
    include: { questions: true },
  });
  assert.equal(set?.language, 'multi');
  assert.ok(set?.tags.includes('gen:auto-diverse'));
  assert.ok(set?.tags.includes('lang:multi'));
  assert.ok(set?.tags.includes('risk:prompt_injection'));
  assert.ok(set?.tags.includes('risk:harmful_capability'));
  const languages = new Set(set?.questions.map((q) => q.language));
  assert.ok(languages.size >= 8);
  assert.ok(set?.questions.some((q) => q.tags.some((tag) => tag.startsWith('variant:'))));
  assert.ok(set?.questions.some((q) => q.tags.some((tag) => tag.startsWith('risk:'))));
  const log = await prisma.auditLog.findFirst({
    where: { action: 'generator.generate', targetId: body.questionSetId },
  });
  const detail = log?.detail as {
    language?: string;
    variantStrength?: string;
    diversity?: { languages?: unknown[] };
  };
  assert.equal(detail.language, 'auto');
  assert.equal(detail.variantStrength, 'auto');
  assert.ok((detail.diversity?.languages?.length ?? 0) >= 8);
});

test('generate 空结果 → 400 GENERATE_EMPTY', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/generator/generate',
    headers: auth(),
    payload: {
      name: `${PFX}empty`,
      types: ['GENERAL'],
      language: 'zh',
      count: 5,
      categories: ['不存在的分类'],
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'GENERATE_EMPTY');
});

test('generate 写审计日志 generator.generate', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/generator/generate',
    headers: auth(),
    payload: { name: `${PFX}audit`, types: ['GENERAL'], language: 'zh', count: 6, seed: 'a1' },
  });
  assert.equal(res.statusCode, 201);
  const log = await prisma.auditLog.findFirst({
    where: { action: 'generator.generate', targetId: res.json().questionSetId },
  });
  assert.ok(log, '应写入 generator.generate 审计');
  assert.equal(log?.targetType, 'question_set');
});

test('generate 参数非法 → 400 VALIDATION_ERROR', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/generator/generate',
    headers: auth(),
    payload: { name: `${PFX}bad`, types: [], language: 'zh', count: 5 },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_ERROR');
});

test('无 generator:llm 权限时带 enhance 生成返回 403', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/generator/generate',
    headers: authNoLlm(),
    payload: {
      name: `${PFX}no-llm`,
      types: ['GENERAL'],
      language: 'zh',
      count: 1,
      enhance: { mode: 'rewrite', intensity: 1, language: 'zh' },
    },
  });
  assert.equal(res.statusCode, 403, res.body);
});

test('有权限但未配置增强 LLM 时 generate 成功并标记 not_configured', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/generator/generate',
    headers: auth(),
    payload: {
      name: `${PFX}enhance-off`,
      types: ['GENERAL'],
      language: 'zh',
      count: 2,
      enhance: { mode: 'rewrite', intensity: 1, language: 'zh' },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().enhancement.configured, false);
  assert.equal(res.json().enhancement.skippedReason, 'not_configured');
});

test('preview 返回增强统计与增强对照字段', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/generator/preview',
    headers: auth(),
    payload: {
      types: ['GENERAL'],
      language: 'zh',
      count: 2,
      enhance: { mode: 'rewrite', intensity: 1, language: 'zh', sampleLimit: 2 },
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(typeof res.json().enhancement.configured, 'boolean');
  assert.ok(Array.isArray(res.json().enhancedSamples ?? []));
});

test('customer-data preview 用客户数据蓝图生成泄漏样本且不落库', async () => {
  const before = await prisma.questionSet.count({ where: { name: { startsWith: PFX } } });
  const res = await app.inject({
    method: 'POST',
    url: '/api/generator/customer-data/preview',
    headers: auth(),
    payload: {
      datasetName: '某零售客户订单库',
      count: 16,
      seed: 'customer-preview',
      fields: [
        { key: 'mobile', label: '会员手机号', kind: 'phone' },
        { key: 'card', label: '银行卡号', kind: 'bank_card' },
        { key: 'secret', label: '三方接口密钥', kind: 'api_key' },
      ],
    },
  });

  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.requested, 16);
  assert.equal(body.produced, 16);
  assert.ok(body.samples.length <= 20);
  assert.ok(body.samples.some((q: { content: string }) => q.content.includes('会员手机号')));
  assert.ok(body.diversity.scenarios.length >= 5);
  assert.equal(await prisma.questionSet.count({ where: { name: { startsWith: PFX } } }), before);
});

test('customer-data generate 创建客户数据泄漏样本库并写入审计', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/generator/customer-data/generate',
    headers: auth(),
    payload: {
      name: `${PFX}customer-data`,
      description: '客户数据泄漏专项样本',
      datasetName: '某医疗客户随访库',
      count: 18,
      seed: 'customer-generate',
      fields: [
        { key: 'patient', label: '患者姓名', kind: 'person_name' },
        { key: 'diagnosis', label: '诊断记录', kind: 'medical_record' },
        { key: 'phone', label: '联系电话', kind: 'phone' },
      ],
    },
  });

  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.equal(body.produced, 18);
  const set = await prisma.questionSet.findUnique({
    where: { id: body.questionSetId },
    include: { questions: true },
  });
  assert.equal(set?.type, 'COMPLIANCE');
  assert.equal(set?.source?.startsWith('customer-data-generator:'), true);
  assert.ok(set?.tags.includes('gen:customer-data'));
  assert.ok(set?.tags.includes('risk:data_leakage'));
  assert.equal(set?.questions.length, 18);
  assert.ok(set?.questions.every((q) => q.metadata && typeof q.metadata === 'object'));

  const log = await prisma.auditLog.findFirst({
    where: { action: 'generator.customer_data.generate', targetId: body.questionSetId },
  });
  assert.ok(log, '应写入 generator.customer_data.generate 审计');
});
