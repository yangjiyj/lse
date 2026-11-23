import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { PERMISSIONS } from '@lse/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

// RAG 页发起前需知道“评估模型是否已配置”：/status 只返回布尔与提示，只读用户可见，不暴露评估模型接入细节。
const PREFIX = `__rag_st_${randomUUID().slice(0, 6)}_`;
const PASSWORD = ['RagSt', 'Test9', '77'].join('@');
const JUDGE_URL = `https://${PREFIX.replace(/_/g, '')}.judge.invalid/v1`;
const JUDGE_KEY = `sk-${PREFIX}secret`;
const JUDGE_MODEL = `${PREFIX}model-x`;
let app!: FastifyInstance;
let readerToken = '';
let activeJudgeIds: string[] = [];
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function makeReader() {
  const codes = ['rag_eval:read'];
  const role = await prisma.role.create({ data: { name: `${PREFIX}reader` } });
  for (const def of PERMISSIONS.filter((p) => codes.includes(p.code))) {
    await prisma.permission.upsert({ where: { code: def.code }, create: { code: def.code, name: def.name, group: def.group }, update: {} });
  }
  const perms = await prisma.permission.findMany({ where: { code: { in: codes } } });
  await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
  await prisma.user.create({
    data: {
      username: `${PREFIX}reader`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: '只读',
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${PREFIX}reader`, password: PASSWORD } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

async function cleanup() {
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  readerToken = await makeReader();
  // 先停用已有评估模型，测试结束后恢复。
  activeJudgeIds = (await prisma.modelTarget.findMany({ where: { targetType: 'JUDGE', isActive: true }, select: { id: true } })).map((r) => r.id);
  await prisma.modelTarget.updateMany({ where: { id: { in: activeJudgeIds } }, data: { isActive: false } });
});

after(async () => {
  await cleanup();
  await prisma.modelTarget.updateMany({ where: { id: { in: activeJudgeIds } }, data: { isActive: true } });
  await app.close();
  await prisma.$disconnect();
});

const status = () => app.inject({ method: 'GET', url: '/api/rag-eval/status', headers: auth(readerToken) });

test('未配置评估模型：只读用户拿到 judgeConfigured=false 与配置入口', { skip: Boolean(process.env.LLM_JUDGE_BASE_URL) }, async () => {
  const res = await status();
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.judgeConfigured, false);
  assert.equal(typeof body.message, 'string');
  assert.equal(body.judgeSettingsPath, '/settings#independent-judge-model');
});

test('已配置评估模型：只读用户拿到 judgeConfigured=true，响应不含评估模型地址、密钥与模型标识', async () => {
  await prisma.modelTarget.create({
    data: { name: `${PREFIX}评估模型`, targetType: 'JUDGE', provider: 'openai-compatible', baseUrl: JUDGE_URL, apiKey: JUDGE_KEY, model: JUDGE_MODEL },
  });
  const res = await status();
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.judgeConfigured, true);
  assert.equal(typeof body.judgeConfigured, 'boolean');
  assert.equal(body.message, null);
  for (const secret of [JUDGE_URL, JUDGE_KEY, JUDGE_MODEL, 'judge.invalid']) {
    assert.ok(!res.body.includes(secret), `响应泄露了评估模型配置：${secret.slice(0, 12)}…`);
  }
  for (const key of ['baseUrl', 'apiKey', 'model', 'judgeBaseUrl', 'judgeModel']) {
    assert.equal(key in body, false, `响应不应含字段 ${key}`);
  }
});
