import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PFX = 'GENSEC_';
const AUDITOR_USERNAME = 'generator_security_auditor';
const AUDITOR_PASSWORD = ['Generator', 'Audit', '12345'].join('!');
const ADMIN_PASSWORD = ['Admin', '@', '12345'].join('');

let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';
let auditorToken = '';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function cleanup(): Promise<void> {
  await prisma.question.deleteMany({ where: { questionSet: { name: { startsWith: PFX } } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: AUDITOR_USERNAME } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();

  const auditorRole = await prisma.role.findUniqueOrThrow({ where: { name: 'auditor' } });
  const passwordHash = await argon2.hash(AUDITOR_PASSWORD, { type: argon2.argon2id });
  await prisma.user.create({
    data: {
      username: AUDITOR_USERNAME,
      passwordHash,
      displayName: '生成器安全测试审计员',
      isActive: true,
      roles: { create: { roleId: auditorRole.id } },
    },
  });

  const adminLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: ADMIN_PASSWORD },
  });
  assert.equal(adminLogin.statusCode, 200, adminLogin.body);
  adminToken = adminLogin.json().token;

  const auditorLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: AUDITOR_USERNAME, password: AUDITOR_PASSWORD },
  });
  assert.equal(auditorLogin.statusCode, 200, auditorLogin.body);
  auditorToken = auditorLogin.json().token;
});

after(async () => {
  await cleanup();
  await app.close();
});

test('auditor 无 generator:run 权限时 generate 返回 403 且不落库', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/generator/generate',
    headers: auth(auditorToken),
    payload: { name: `${PFX}forbidden`, types: ['GENERAL'], language: 'zh', count: 1 },
  });

  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().error.code, 'FORBIDDEN');
  assert.equal(await prisma.questionSet.count({ where: { name: { startsWith: PFX } } }), 0);
});

test('count 超过单次生成上限时返回 400 且不落库', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/generator/generate',
    headers: auth(adminToken),
    payload: { name: `${PFX}too-many`, types: ['GENERAL'], language: 'zh', count: 2001 },
  });

  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  assert.equal(await prisma.questionSet.count({ where: { name: { startsWith: PFX } } }), 0);
});

test('注入式题集名称只作为数据保存，question_sets 表仍可查询', async () => {
  const injectedName = `${PFX}'; DROP TABLE question_sets; --`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/generator/generate',
    headers: auth(adminToken),
    payload: {
      name: injectedName,
      description: '<script>alert(1)</script>',
      types: ['GENERAL'],
      language: 'zh',
      count: 3,
      seed: 'security-injection-name',
    },
  });

  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.ok(body.questionSetId);

  const set = await prisma.questionSet.findUnique({
    where: { id: body.questionSetId },
    include: { _count: { select: { questions: true } } },
  });
  assert.equal(set?.name, injectedName);
  assert.equal(set?._count.questions, body.produced);
  assert.ok((await prisma.questionSet.count()) > 0, 'question_sets table should remain queryable');
});
