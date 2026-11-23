import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { AppError } from '../src/lib/errors.js';
import { enforcePublicRateLimit, resetPublicRedis } from '../src/lib/public-rate-limit.js';

// 公开接口的限流：通用的 enforcePublicRateLimit、Redis 用单独连接，断开时不挂住请求。
const PREFIX = 'w1prl_';

let app!: FastifyInstance;
let adminToken = '';
let savedSecurity: unknown = undefined;

function freshIp(): string {
  return `10.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(1, 250)}`;
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const row = await prisma.systemSetting.findUnique({ where: { key: 'security' } });
  savedSecurity = row?.value;
  await prismaUnscoped.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  assert.equal(login.statusCode, 200, login.body);
  adminToken = login.json().token;
});

after(async () => {
  await resetPublicRedis();
  if (savedSecurity === undefined) {
    await prisma.systemSetting.deleteMany({ where: { key: 'security' } });
  } else {
    await prisma.systemSetting.update({
      where: { key: 'security' },
      data: { value: savedSecurity as object },
    });
  }
  await prismaUnscoped.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

test('enforcePublicRateLimit 可按接口指定每分钟次数，超出抛 429', async () => {
  const ip = freshIp();
  await enforcePublicRateLimit('unit-test', ip, { perMinute: 2 });
  await enforcePublicRateLimit('unit-test', ip, { perMinute: 2 });
  await assert.rejects(
    enforcePublicRateLimit('unit-test', ip, { perMinute: 2 }),
    (err: unknown) => err instanceof AppError && err.statusCode === 429,
  );
  // 不同接口名、不同 IP 各算各的
  await enforcePublicRateLimit('unit-test-2', ip, { perMinute: 2 });
  await enforcePublicRateLimit('unit-test', freshIp(), { perMinute: 2 });
});

test('Redis 连不上时三个公开接口都在 2 秒内返回：注册 503，访问计数与登录页统计照常', async () => {
  const patch = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { security: { registrationEnabled: true } },
  });
  assert.equal(patch.statusCode, 200, patch.body);

  // 指向一个关着的端口。
  await resetPublicRedis('redis://127.0.0.1:1/0');
  try {
    const timed = async (fn: () => ReturnType<FastifyInstance['inject']>) => {
      const started = Date.now();
      const res = await fn();
      return { res, ms: Date.now() - started };
    };

    const reg = await timed(() =>
      app.inject({
        method: 'POST',
        url: '/api/auth/register',
        remoteAddress: freshIp(),
        payload: {
          username: `${PREFIX}${Date.now().toString(36)}`,
          displayName: '张三',
          phone: '13800138000',
          organization: '测试单位',
          password: 'Register@123', // pragma: allowlist secret
        },
      }),
    );
    assert.equal(reg.res.statusCode, 503, reg.res.body);
    assert.equal(reg.res.json().error.code, 'REGISTRATION_UNAVAILABLE');
    assert.match(reg.res.json().error.message, /注册暂不可用/);
    assert.ok(reg.ms < 2000, `注册用时 ${reg.ms}ms`);
    assert.equal(
      await prismaUnscoped.user.count({ where: { username: { startsWith: PREFIX } } }),
      0,
      '额度记不上时不创建用户',
    );

    const visit = await timed(() =>
      app.inject({ method: 'POST', url: '/api/public/visits', remoteAddress: freshIp() }),
    );
    assert.equal(visit.res.statusCode, 204, visit.res.body);
    assert.ok(visit.ms < 2000, `访问计数用时 ${visit.ms}ms`);

    const stats = await timed(() =>
      app.inject({ method: 'GET', url: '/api/public/login-stats', remoteAddress: freshIp() }),
    );
    assert.equal(stats.res.statusCode, 200, stats.res.body);
    assert.equal(stats.res.json().registrationEnabled, true);
    assert.ok(stats.ms < 2000, `登录页统计用时 ${stats.ms}ms`);
  } finally {
    await resetPublicRedis();
  }

  // 恢复后照常限流与计数。
  const ip = freshIp();
  await enforcePublicRateLimit('after-reset', ip, { perMinute: 1 });
  await assert.rejects(enforcePublicRateLimit('after-reset', ip, { perMinute: 1 }));
});
