import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { parseStoredSecurity } from '../src/lib/security-policy.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';

// 2.1.1 自助注册：开关、字段校验、待审核登录提示、同 IP 限流、审计。
const PREFIX = 'w1reg_';
const TENANT_CODE = 'w1reg-tenant';
const PASSWORD = 'Register@123'; // pragma: allowlist secret

let app!: FastifyInstance;
let adminToken = '';
let savedSecurity: unknown = undefined;
let seq = 0;

/** 每个用例用不同的来源 IP，互不占用限流额度。 */
function freshIp(): string {
  return `10.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(1, 250)}`;
}

function nextUsername(): string {
  seq += 1;
  return `${PREFIX}${Date.now().toString(36)}${seq}`;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    username: nextUsername(),
    displayName: '张三',
    phone: '13800138000',
    organization: '测试单位',
    password: PASSWORD,
    ...overrides,
  };
}

function register(body: Record<string, unknown>, ip = freshIp()) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/register',
    remoteAddress: ip,
    payload: body,
  });
}

async function patchSecurity(security: Record<string, unknown>) {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { security },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res;
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const row = await prisma.systemSetting.findUnique({ where: { key: 'security' } });
  savedSecurity = row?.value;
  await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  await prismaUnscoped.tenant.deleteMany({ where: { code: TENANT_CODE } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  assert.equal(login.statusCode, 200, login.body);
  adminToken = login.json().token;
});

after(async () => {
  if (savedSecurity === undefined) {
    await prisma.systemSetting.deleteMany({ where: { key: 'security' } });
  } else {
    await prisma.systemSetting.update({
      where: { key: 'security' },
      data: { value: savedSecurity as object },
    });
  }
  await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  await prismaUnscoped.tenant.deleteMany({ where: { code: TENANT_CODE } });
  await app.close();
  await prisma.$disconnect();
});

test('注册开关默认关闭，注册归属租户默认不配置', () => {
  const policy = parseStoredSecurity({});
  assert.equal(policy.registrationEnabled, false);
  assert.equal(policy.registrationTenantId, null);
});

test('开关关闭时注册返回 403 REGISTRATION_DISABLED，免登录统计接口返回 registrationEnabled=false', async () => {
  await patchSecurity({ registrationEnabled: false, registrationTenantId: null });
  const body = validBody();
  const res = await register(body);
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().error.code, 'REGISTRATION_DISABLED');
  assert.equal(await prisma.user.count({ where: { username: body.username } }), 0);

  const stats = await app.inject({
    method: 'GET',
    url: '/api/public/login-stats',
    remoteAddress: freshIp(),
  });
  assert.equal(stats.statusCode, 200, stats.body);
  assert.equal(stats.json().registrationEnabled, false);
});

test('开关打开后注册成功：待审核、未启用、无角色，默认归平台租户，写审计', async () => {
  await patchSecurity({ registrationEnabled: true, registrationTenantId: null });
  const stats = await app.inject({
    method: 'GET',
    url: '/api/public/login-stats',
    remoteAddress: freshIp(),
  });
  assert.equal(stats.json().registrationEnabled, true);

  const startedAt = new Date(Date.now() - 1000);
  const body = validBody();
  const res = await register(body);
  assert.equal(res.statusCode, 201, res.body);
  const user = await prismaUnscoped.user.findUnique({
    where: { username: body.username },
    include: { roles: true },
  });
  assert.ok(user);
  assert.equal(user.isActive, false);
  assert.equal(user.registrationStatus, 'PENDING');
  assert.equal(user.roles.length, 0);
  assert.equal(user.tenantId, PLATFORM_TENANT_ID);
  assert.equal(user.displayName, '张三');
  assert.equal(user.phone, '13800138000');
  assert.equal(user.organization, '测试单位');
  assert.notEqual(user.passwordHash, PASSWORD);

  const audit = await prismaUnscoped.auditLog.findFirst({
    where: { action: 'auth.register', targetId: user.id, createdAt: { gte: startedAt } },
  });
  assert.ok(audit, '注册写审计 auth.register');
});

test('配置了 registrationTenantId 时注册用户归到该租户', async () => {
  const tenant = await prismaUnscoped.tenant.create({
    data: { name: '注册归属测试租户', code: TENANT_CODE },
  });
  await patchSecurity({ registrationEnabled: true, registrationTenantId: tenant.id });
  const body = validBody();
  const res = await register(body);
  assert.equal(res.statusCode, 201, res.body);
  const user = await prismaUnscoped.user.findUnique({ where: { username: body.username } });
  assert.equal(user?.tenantId, tenant.id);
  await prismaUnscoped.user.deleteMany({ where: { tenantId: tenant.id } });
  await patchSecurity({ registrationTenantId: null });
  await prismaUnscoped.tenant.delete({ where: { id: tenant.id } });
});

test('registrationTenantId 指向不存在的租户时保存失败', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { security: { registrationTenantId: '11111111-1111-4111-8111-111111111111' } },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('字段校验：姓名、手机号、单位、用户名、密码策略', async () => {
  await patchSecurity({ registrationEnabled: true, registrationTenantId: null });
  const cases: Array<[string, Record<string, unknown>]> = [
    ['姓名为空', { displayName: '' }],
    ['姓名超过 32 字', { displayName: '张'.repeat(33) }],
    ['手机号位数不对', { phone: '1380013800' }],
    ['手机号不以 1 开头', { phone: '23800138000' }],
    ['手机号带字母', { phone: '1380013800a' }],
    ['单位为空', { organization: '' }],
    ['单位超过 64 字', { organization: '单'.repeat(65) }],
    ['用户名过短', { username: 'ab' }],
    ['用户名含非法字符', { username: `${PREFIX}张三` }],
    ['密码不满足策略', { password: 'short' }], // pragma: allowlist secret
  ];
  for (const [name, overrides] of cases) {
    const res = await register(validBody(overrides));
    assert.equal(res.statusCode, 400, `${name}: ${res.body}`);
  }
  const ok = await register(
    validBody({ displayName: '张'.repeat(32), organization: '单'.repeat(64) }),
  );
  assert.equal(ok.statusCode, 201, ok.body);
});

test('密码按安全策略校验，返回策略提示', async () => {
  await patchSecurity({ registrationEnabled: true, passwordRequireSpecial: true });
  const res = await register(validBody({ password: 'Register1234' })); // pragma: allowlist secret
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'PASSWORD_POLICY');
  await patchSecurity({ passwordRequireSpecial: false });
});

test('用户名重复返回 409', async () => {
  await patchSecurity({ registrationEnabled: true });
  const body = validBody();
  assert.equal((await register(body)).statusCode, 201);
  const dup = await register({ ...body, phone: '13900139000' });
  assert.equal(dup.statusCode, 409, dup.body);
  const admin = await register(validBody({ username: 'admin' }));
  assert.equal(admin.statusCode, 409, admin.body);
});

test('待审核账号：密码正确提示「账号待审核」，密码错误仍提示用户名或密码错误', async () => {
  await patchSecurity({ registrationEnabled: true });
  const body = validBody();
  assert.equal((await register(body)).statusCode, 201);

  const ok = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: body.username, password: PASSWORD },
  });
  assert.equal(ok.statusCode, 401, ok.body);
  assert.equal(ok.json().error.code, 'ACCOUNT_PENDING');
  assert.match(ok.json().error.message, /账号待审核/);

  const wrong = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: body.username, password: 'Wrong@12345' }, // pragma: allowlist secret
  });
  assert.equal(wrong.statusCode, 401, wrong.body);
  assert.equal(wrong.json().error.code, 'INVALID_CREDENTIALS');
});

test('待审核账号也计失败次数：连错到阈值被锁，锁定期间密码正确也不提示待审核', async () => {
  await patchSecurity({ registrationEnabled: true, maxFailedLoginAttempts: 3, lockoutMinutes: 15 });
  try {
    const body = validBody();
    assert.equal((await register(body)).statusCode, 201);
    const attempt = (password: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: body.username, password },
      });
    for (let i = 1; i < 3; i += 1) {
      const res = await attempt('Wrong@12345'); // pragma: allowlist secret
      assert.equal(res.statusCode, 401, `第 ${i} 次: ${res.body}`);
      assert.equal(res.json().error.code, 'INVALID_CREDENTIALS');
    }
    const third = await attempt('Wrong@12345'); // pragma: allowlist secret
    assert.equal(third.statusCode, 403, third.body);
    assert.equal(third.json().error.code, 'ACCOUNT_LOCKED');
    const row = await prismaUnscoped.user.findUniqueOrThrow({ where: { username: body.username } });
    assert.ok(row.lockedUntil && row.lockedUntil.getTime() > Date.now(), '待审核账号被锁定');

    const locked = await attempt(PASSWORD);
    assert.equal(locked.statusCode, 403, locked.body);
    assert.equal(locked.json().error.code, 'ACCOUNT_LOCKED');
  } finally {
    await patchSecurity({ maxFailedLoginAttempts: 5 });
  }
});

test('被拒绝的账号密码正确也只提示用户名或密码错误', async () => {
  await patchSecurity({ registrationEnabled: true });
  const body = validBody();
  assert.equal((await register(body)).statusCode, 201);
  await prismaUnscoped.user.update({
    where: { username: body.username },
    data: { registrationStatus: 'REJECTED' },
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: body.username, password: PASSWORD },
  });
  assert.equal(res.statusCode, 401, res.body);
  assert.equal(res.json().error.code, 'INVALID_CREDENTIALS');
});

test('用户名重复检查不区分大小写', async () => {
  await patchSecurity({ registrationEnabled: true });
  const admin = await register(validBody({ username: 'Admin' }));
  assert.equal(admin.statusCode, 409, admin.body);
  assert.equal(admin.json().error.code, 'USERNAME_TAKEN');

  const body = validBody();
  assert.equal((await register(body)).statusCode, 201);
  const upper = await register(validBody({ username: body.username.toUpperCase() }));
  assert.equal(upper.statusCode, 409, upper.body);
  assert.equal(upper.json().error.code, 'USERNAME_TAKEN');
  assert.equal(
    await prismaUnscoped.user.count({
      where: { username: { equals: body.username, mode: 'insensitive' } },
    }),
    1,
  );
});

test('同一 IP 一小时内最多注册 5 次，第 6 次返回 429', async () => {
  await patchSecurity({ registrationEnabled: true });
  const ip = freshIp();
  for (let i = 0; i < 5; i += 1) {
    const res = await register(validBody(), ip);
    assert.equal(res.statusCode, 201, `第 ${i + 1} 次: ${res.body}`);
  }
  const sixth = await register(validBody(), ip);
  assert.equal(sixth.statusCode, 429, sixth.body);
  // 换个 IP 不受影响
  assert.equal((await register(validBody())).statusCode, 201);
});

test('每小时额度原子计数：同一 IP 并发 12 个注册，只有 5 个成功，其余 429', async () => {
  await patchSecurity({ registrationEnabled: true });
  const ip = freshIp();
  const results = await Promise.all(Array.from({ length: 12 }, () => register(validBody(), ip)));
  const codes = results.map((r) => r.statusCode);
  assert.equal(codes.filter((c) => c === 201).length, 5, codes.join(','));
  assert.equal(codes.filter((c) => c === 429).length, 7, codes.join(','));
});

test('每小时额度按尝试计：重名和参数错误也消耗额度', async () => {
  await patchSecurity({ registrationEnabled: true });
  const taken = validBody();
  assert.equal((await register(taken)).statusCode, 201);

  const ip = freshIp();
  for (let i = 0; i < 5; i += 1) {
    const res = await register({ ...taken, phone: '13900139000' }, ip);
    assert.equal(res.statusCode, 409, `第 ${i + 1} 次: ${res.body}`);
  }
  const sixth = await register({ ...taken, phone: '13900139000' }, ip);
  assert.equal(sixth.statusCode, 429, sixth.body);
  assert.equal((await register(validBody(), ip)).statusCode, 429, '合规的注册也被挡');

  const badIp = freshIp();
  for (let i = 0; i < 5; i += 1) {
    const res = await register(validBody({ phone: 'bad' }), badIp);
    assert.equal(res.statusCode, 400, `第 ${i + 1} 次: ${res.body}`);
  }
  assert.equal((await register(validBody(), badIp)).statusCode, 429);
});

test('注册接口同一 IP 每分钟最多 30 次请求', async () => {
  // 关着注册时不消耗每小时额度，只看每分钟的公开接口限流。
  await patchSecurity({ registrationEnabled: false });
  try {
    const ip = freshIp();
    for (let i = 0; i < 30; i += 1) {
      const res = await register(validBody(), ip);
      assert.equal(res.statusCode, 403, `第 ${i + 1} 次: ${res.body}`);
    }
    const over = await register(validBody(), ip);
    assert.equal(over.statusCode, 429, over.body);
  } finally {
    await patchSecurity({ registrationEnabled: true });
  }
});

test('登录页统计在开放注册时带上密码规则（只有规则字段），关闭时不带', async () => {
  await patchSecurity({
    registrationEnabled: true,
    passwordMinLength: 10,
    passwordRequireUppercase: false,
    passwordRequireLowercase: false,
    passwordRequireDigit: true,
    passwordRequireSpecial: false,
  });
  try {
    const open = await app.inject({
      method: 'GET',
      url: '/api/public/login-stats',
      remoteAddress: freshIp(),
    });
    assert.equal(open.statusCode, 200, open.body);
    assert.deepEqual(open.json().passwordPolicy, {
      passwordMinLength: 10,
      passwordRequireUppercase: false,
      passwordRequireLowercase: false,
      passwordRequireDigit: true,
      passwordRequireSpecial: false,
    });

    await patchSecurity({ registrationEnabled: false });
    const closed = await app.inject({
      method: 'GET',
      url: '/api/public/login-stats',
      remoteAddress: freshIp(),
    });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json().passwordPolicy, null);
  } finally {
    await patchSecurity({
      registrationEnabled: true,
      passwordMinLength: 8,
      passwordRequireDigit: false,
    });
  }
});
