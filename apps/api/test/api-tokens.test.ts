import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { requireApiTokenOrUser } from '../src/plugins/api-token-auth.js';

const PREFIX = '__api_token_test_';
const OPERATOR_USERNAME = `${PREFIX}operator`;
const OPERATOR_PASSWORD = ['Operator', 'Tok', '123'].join('!');
const PROBE_URL = '/api/__test/api-token-probe';

let app: Awaited<ReturnType<typeof buildApp>>;
let adminJwt = '';
let operatorJwt = '';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function cleanup(): Promise<void> {
  const tokens = await prisma.apiToken.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = tokens.map((t) => t.id);
  if (ids.length > 0) await prisma.auditLog.deleteMany({ where: { targetId: { in: ids } } });
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { username: OPERATOR_USERNAME } });
}

async function createToken(
  payload: Record<string, unknown>,
): Promise<{ token: string; id: string; prefix: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/api-tokens',
    headers: bearer(adminJwt),
    payload,
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  return { token: body.token, id: body.item.id, prefix: body.item.prefix };
}

before(async () => {
  app = await buildApp();
  // 探针路由：只挂 requireApiTokenOrUser，验证 token/JWT 两条鉴权路径。
  app.get(
    PROBE_URL,
    { preHandler: [requireApiTokenOrUser('gates:read', 'eval_task:read')] },
    async (request) => ({
      via: request.apiToken ? 'token' : 'user',
      tokenId: request.apiToken?.id ?? null,
      userId: request.currentUser?.id ?? null,
    }),
  );
  await app.ready();
  await cleanup();

  const operatorRole = await prisma.role.findUniqueOrThrow({ where: { name: 'operator' } });
  await prisma.user.create({
    data: {
      username: OPERATOR_USERNAME,
      passwordHash: await argon2.hash(OPERATOR_PASSWORD, { type: argon2.argon2id }),
      displayName: OPERATOR_USERNAME,
      isActive: true,
      roles: { create: { roleId: operatorRole.id } },
    },
  });
  const adminLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  assert.equal(adminLogin.statusCode, 200, adminLogin.body);
  adminJwt = adminLogin.json().token;
  const operatorLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: OPERATOR_USERNAME, password: OPERATOR_PASSWORD },
  });
  assert.equal(operatorLogin.statusCode, 200, operatorLogin.body);
  operatorJwt = operatorLogin.json().token;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('管理接口：未登录 401，非管理员 403', async () => {
  const anon = await app.inject({ method: 'GET', url: '/api/api-tokens' });
  assert.equal(anon.statusCode, 401);
  const op = await app.inject({
    method: 'GET',
    url: '/api/api-tokens',
    headers: bearer(operatorJwt),
  });
  assert.equal(op.statusCode, 403);
  const opCreate = await app.inject({
    method: 'POST',
    url: '/api/api-tokens',
    headers: bearer(operatorJwt),
    payload: { name: `${PREFIX}op`, scopes: ['gates:read'], expiresInDays: 30 },
  });
  assert.equal(opCreate.statusCode, 403);
});

test('创建令牌：明文只返回一次，库里只存 sha256，列表不含明文/哈希，写审计', async () => {
  const { token, id, prefix } = await createToken({
    name: `${PREFIX}ci`,
    scopes: ['gates:read', 'eval-plans:trigger'],
    expiresInDays: 30,
  });
  assert.match(token, /^lse_[0-9a-f]{8}_[0-9a-f]{32}$/);
  assert.equal(token.split('_')[1], prefix);

  const row = await prisma.apiToken.findUniqueOrThrow({ where: { id } });
  assert.equal(row.tokenHash, sha256(token));
  assert.notEqual(row.tokenHash, token);
  assert.deepEqual(row.scopes.sort(), ['eval-plans:trigger', 'gates:read']);
  assert.ok(row.expiresAt && row.expiresAt.getTime() > Date.now() + 29 * 86400_000);

  const list = await app.inject({
    method: 'GET',
    url: '/api/api-tokens',
    headers: bearer(adminJwt),
  });
  assert.equal(list.statusCode, 200, list.body);
  assert.ok(!list.body.includes(token));
  assert.ok(!list.body.includes(row.tokenHash));
  const item = list.json().items.find((it: { id: string }) => it.id === id);
  assert.ok(item);
  assert.equal(item.status, 'ACTIVE');
  assert.equal('tokenHash' in item, false);

  const audit = await prisma.auditLog.findFirst({
    where: { action: 'api_token.create', targetId: id },
  });
  assert.ok(audit);
  assert.ok(!JSON.stringify(audit.detail).includes(token));
});

test('创建令牌：非法 scope / 缺少过期时间返回 400', async () => {
  const bad = await app.inject({
    method: 'POST',
    url: '/api/api-tokens',
    headers: bearer(adminJwt),
    payload: { name: `${PREFIX}bad`, scopes: ['admin:*'], expiresInDays: 30 },
  });
  assert.equal(bad.statusCode, 400);
  const noExpiry = await app.inject({
    method: 'POST',
    url: '/api/api-tokens',
    headers: bearer(adminJwt),
    payload: { name: `${PREFIX}bad2`, scopes: ['gates:read'], expiresInDays: 0 },
  });
  assert.equal(noExpiry.statusCode, 400);
});

test('令牌访问挂了 preHandler 的路由：成功更新 lastUsedAt 并写使用审计', async () => {
  const { token, id } = await createToken({
    name: `${PREFIX}use`,
    scopes: ['gates:read'],
    expiresInDays: 7,
  });
  const res = await app.inject({ method: 'GET', url: PROBE_URL, headers: bearer(token) });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { via: 'token', tokenId: id, userId: null });
  const row = await prisma.apiToken.findUniqueOrThrow({ where: { id } });
  assert.ok(row.lastUsedAt);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'api_token.use', targetId: id },
  });
  assert.ok(audit);
  assert.ok(!JSON.stringify(audit.detail).includes(token));
});

test('scope 不符返回 403 并写失败审计', async () => {
  const { token, id } = await createToken({
    name: `${PREFIX}scope`,
    scopes: ['eval-plans:trigger'],
    expiresInDays: 7,
  });
  const res = await app.inject({ method: 'GET', url: PROBE_URL, headers: bearer(token) });
  assert.equal(res.statusCode, 403, res.body);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'api_token.use_failed', targetId: id },
  });
  assert.ok(audit);
  assert.equal((audit.detail as { reason?: string }).reason, 'SCOPE_MISMATCH');
});

test('吊销、过期、伪造、篡改的令牌一律 401', async () => {
  const revoked = await createToken({
    name: `${PREFIX}revoked`,
    scopes: ['gates:read'],
    expiresInDays: 7,
  });
  const rv = await app.inject({
    method: 'POST',
    url: `/api/api-tokens/${revoked.id}/revoke`,
    headers: bearer(adminJwt),
  });
  assert.equal(rv.statusCode, 200, rv.body);
  assert.ok(
    await prisma.auditLog.findFirst({
      where: { action: 'api_token.revoke', targetId: revoked.id },
    }),
  );
  const r1 = await app.inject({ method: 'GET', url: PROBE_URL, headers: bearer(revoked.token) });
  assert.equal(r1.statusCode, 401);

  const expired = await createToken({
    name: `${PREFIX}expired`,
    scopes: ['gates:read'],
    expiresInDays: 7,
  });
  await prisma.apiToken.update({
    where: { id: expired.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const r2 = await app.inject({ method: 'GET', url: PROBE_URL, headers: bearer(expired.token) });
  assert.equal(r2.statusCode, 401);
  const expAudit = await prisma.auditLog.findFirst({
    where: { action: 'api_token.use_failed', targetId: expired.id },
  });
  assert.equal((expAudit?.detail as { reason?: string }).reason, 'EXPIRED');

  const good = await createToken({
    name: `${PREFIX}tamper`,
    scopes: ['gates:read'],
    expiresInDays: 7,
  });
  const tampered = good.token.slice(0, -1) + (good.token.endsWith('0') ? '1' : '0');
  const r3 = await app.inject({ method: 'GET', url: PROBE_URL, headers: bearer(tampered) });
  assert.equal(r3.statusCode, 401);
  const r4 = await app.inject({
    method: 'GET',
    url: PROBE_URL,
    headers: bearer('lse_deadbeef_00000000000000000000000000000000'),
  });
  assert.equal(r4.statusCode, 401);
  const r5 = await app.inject({ method: 'GET', url: PROBE_URL, headers: bearer('lse_garbage') });
  assert.equal(r5.statusCode, 401);
});

test('令牌不能当用户会话访问其他受保护接口（一律 401）', async () => {
  const { token } = await createToken({
    name: `${PREFIX}isolation`,
    scopes: ['gates:read', 'eval-plans:trigger'],
    expiresInDays: 7,
  });
  for (const url of [
    '/api/auth/me',
    '/api/audit-logs',
    '/api/api-tokens',
    '/api/eval-tasks',
    '/api/users',
  ]) {
    const res = await app.inject({ method: 'GET', url, headers: bearer(token) });
    assert.equal(res.statusCode, 401, `${url} → ${res.statusCode}`);
  }
});

test('无令牌时回退 JWT：有权限 200，无 Authorization 401', async () => {
  const ok = await app.inject({ method: 'GET', url: PROBE_URL, headers: bearer(adminJwt) });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().via, 'user');
  const anon = await app.inject({ method: 'GET', url: PROBE_URL });
  assert.equal(anon.statusCode, 401);
});
