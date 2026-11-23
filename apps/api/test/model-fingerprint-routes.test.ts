import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = '__fproutes_';
const AUDITOR_USERNAME = `${PREFIX}auditor`;
const AUDITOR_PASSWORD = ['Auditor', 'FP', '123'].join('@');
const ADMIN_PASSWORD = ['Admin', '@', '12345'].join('');
const SECRET = 'sk-fp-routes-secret-777'; // pragma: allowlist secret

let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';
let auditorToken = '';
let targetId = '';
let server: http.Server;
let failMode = false;
let variant = 'A';
const origAllow = process.env.LSE_TARGET_EGRESS_ALLOWLIST;
const origPriv = process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function cleanup(): Promise<void> {
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { username: AUDITOR_USERNAME } });
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (failMode) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: 'upstream down' } }));
        return;
      }
      const msgs = (JSON.parse(raw) as { messages: { content: string }[] }).messages;
      const content = `${variant} 的回答：${msgs[msgs.length - 1]!.content.slice(0, 10)}`;
      res.end(JSON.stringify({ model: 'mock', choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  process.env.LSE_TARGET_EGRESS_ALLOWLIST = new URL(baseUrl).origin;
  process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = 'true';

  app = await buildApp();
  await app.ready();
  await cleanup();
  const auditorRole = await prisma.role.findUniqueOrThrow({ where: { name: 'auditor' } });
  await prisma.user.create({
    data: {
      username: AUDITOR_USERNAME,
      passwordHash: await argon2.hash(AUDITOR_PASSWORD, { type: argon2.argon2id }),
      displayName: '指纹测试审计员',
      isActive: true,
      roles: { create: { roleId: auditorRole.id } },
    },
  });
  const t = await prisma.modelTarget.create({
    data: { name: `${PREFIX}model`, provider: 'openai-compatible', baseUrl, apiKey: SECRET, model: 'mock' },
  });
  targetId = t.id;
  const a = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: ADMIN_PASSWORD } });
  assert.equal(a.statusCode, 200, a.body);
  adminToken = a.json().token;
  const u = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: AUDITOR_USERNAME, password: AUDITOR_PASSWORD },
  });
  assert.equal(u.statusCode, 200, u.body);
  auditorToken = u.json().token;
});

after(async () => {
  await cleanup();
  await app.close();
  await new Promise<void>((r) => server.close(() => r()));
  if (origAllow === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOWLIST;
  else process.env.LSE_TARGET_EGRESS_ALLOWLIST = origAllow;
  if (origPriv === undefined) delete process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE;
  else process.env.LSE_TARGET_EGRESS_ALLOW_PRIVATE = origPriv;
  await prisma.$disconnect();
});

const url = (p = '') => `/api/model-targets/${targetId}/fingerprints${p}`;

test('未认证返回 401', async () => {
  assert.equal((await app.inject({ method: 'GET', url: url() })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: url() })).statusCode, 401);
});

test('审计员可读列表但采集/设基线返回 403', async () => {
  const list = await app.inject({ method: 'GET', url: url(), headers: auth(auditorToken) });
  assert.equal(list.statusCode, 200, list.body);
  const post = await app.inject({ method: 'POST', url: url(), headers: auth(auditorToken) });
  assert.equal(post.statusCode, 403);
  const base = await app.inject({
    method: 'POST',
    url: url('/00000000-0000-4000-8000-000000000000/baseline'),
    headers: auth(auditorToken),
  });
  assert.equal(base.statusCode, 403);
});

test('采集、设基线、比对全流程：写审计且不回显凭据', async () => {
  variant = 'A';
  const r1 = await app.inject({ method: 'POST', url: url(), headers: auth(adminToken) });
  assert.equal(r1.statusCode, 201, r1.body);
  assert.ok(!r1.body.includes(SECRET));
  const fp1 = r1.json();
  assert.equal(fp1.source, 'MANUAL');
  assert.equal(fp1.apiKey, undefined);
  const collectAudit = await prisma.auditLog.findFirst({
    where: { action: 'model_fingerprint.collect', targetId },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(collectAudit);
  assert.ok(!JSON.stringify(collectAudit).includes(SECRET));

  variant = 'B';
  const fp2 = (await app.inject({ method: 'POST', url: url(), headers: auth(adminToken) })).json();

  const b1 = await app.inject({ method: 'POST', url: url(`/${fp1.id}/baseline`), headers: auth(adminToken) });
  assert.equal(b1.statusCode, 200, b1.body);
  assert.equal(b1.json().isBaseline, true);
  const b2 = await app.inject({ method: 'POST', url: url(`/${fp2.id}/baseline`), headers: auth(adminToken) });
  assert.equal(b2.statusCode, 200);
  assert.equal(await prisma.modelFingerprint.count({ where: { modelTargetId: targetId, isBaseline: true } }), 1);
  const setAudit = await prisma.auditLog.findFirst({
    where: { action: 'model_fingerprint.set_baseline', targetId },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal((setAudit!.detail as { previousBaselineId: string }).previousBaselineId, fp1.id);

  const list = await app.inject({ method: 'GET', url: url(), headers: auth(auditorToken) });
  const lb = list.json();
  assert.equal(lb.items.length, 2);
  assert.equal(lb.baselineId, fp2.id);
  assert.equal(lb.probes.length, 10);
  assert.ok(!list.body.includes(SECRET));

  const cmp = await app.inject({ method: 'GET', url: url(`/compare?a=${fp1.id}&b=${fp2.id}`), headers: auth(auditorToken) });
  assert.equal(cmp.statusCode, 200, cmp.body);
  const c = cmp.json();
  assert.ok(c.similarity > 0 && c.similarity < 1);
  assert.equal(c.threshold, 0.6);
  assert.equal(c.a.id, fp1.id);
  const same = (await app.inject({ method: 'GET', url: url(`/compare?a=${fp1.id}&b=${fp1.id}&threshold=0.9`), headers: auth(adminToken) })).json();
  assert.equal(same.similarity, 1);
  assert.equal(same.threshold, 0.9);
});

test('采集失败返回 502 并写失败审计，不回显凭据', async () => {
  failMode = true;
  const r = await app.inject({ method: 'POST', url: url(), headers: auth(adminToken) });
  failMode = false;
  assert.equal(r.statusCode, 502, r.body);
  assert.ok(!r.body.includes(SECRET));
  const a = await prisma.auditLog.findFirst({
    where: { action: 'model_fingerprint.collect', targetId },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal((a!.detail as { status: string }).status, 'FAILED');
});

test('不存在的对象或指纹返回 404', async () => {
  const missing = '00000000-0000-4000-8000-000000000000';
  const r = await app.inject({ method: 'GET', url: `/api/model-targets/${missing}/fingerprints`, headers: auth(adminToken) });
  assert.equal(r.statusCode, 404);
  const b = await app.inject({ method: 'POST', url: url(`/${missing}/baseline`), headers: auth(adminToken) });
  assert.equal(b.statusCode, 404);
  const c = await app.inject({ method: 'GET', url: url(`/compare?a=${missing}&b=${missing}`), headers: auth(adminToken) });
  assert.equal(c.statusCode, 404);
});
