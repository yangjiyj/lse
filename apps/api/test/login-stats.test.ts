import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { shanghaiDay } from '../src/lib/platform-stats.js';

// 2.1.2 / 2.1.3 登录页访问量与下载量：免登录、按 IP 去重、限流、按北京时间切日。
const HISTORY_DAY = new Date('2000-01-01T00:00:00Z');

let app!: FastifyInstance;

function freshIp(): string {
  return `10.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(1, 250)}`;
}

function visit(ip: string) {
  return app.inject({ method: 'POST', url: '/api/public/visits', remoteAddress: ip });
}

function stats(ip = freshIp()) {
  return app.inject({ method: 'GET', url: '/api/public/login-stats', remoteAddress: ip });
}

async function todayRow() {
  return prismaUnscoped.platformDailyStat.findUnique({ where: { date: shanghaiDay() } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await prismaUnscoped.platformDailyStat.deleteMany({ where: { date: HISTORY_DAY } });
});

after(async () => {
  await prismaUnscoped.platformDailyStat.deleteMany({ where: { date: HISTORY_DAY } });
  await app.close();
  await prisma.$disconnect();
});

test('按北京时间切日', () => {
  assert.equal(
    shanghaiDay(new Date('2026-11-17T15:59:59Z')).toISOString(),
    '2026-11-17T00:00:00.000Z',
  );
  assert.equal(
    shanghaiDay(new Date('2026-11-17T16:00:00Z')).toISOString(),
    '2026-11-18T00:00:00.000Z',
  );
});

test('访问量：免登录，返回 204；同一 IP 30 分钟内只计 1 次，换 IP 再计', async () => {
  const before = (await todayRow())?.visits ?? 0;
  const ip = freshIp();
  const first = await visit(ip);
  assert.equal(first.statusCode, 204, first.body);
  assert.equal((await todayRow())?.visits, before + 1);

  assert.equal((await visit(ip)).statusCode, 204);
  assert.equal((await todayRow())?.visits, before + 1, '同一 IP 不重复计');

  assert.equal((await visit(freshIp())).statusCode, 204);
  assert.equal((await todayRow())?.visits, before + 2);
});

test('登录页统计：免登录，返回今日与累计的访问量、下载量和注册开关，不含其他数据', async () => {
  await prismaUnscoped.platformDailyStat.create({
    data: { date: HISTORY_DAY, visits: 7, downloads: 3 },
  });
  const today = await todayRow();
  const sum = await prismaUnscoped.platformDailyStat.aggregate({
    _sum: { visits: true, downloads: true },
  });
  const res = await stats();
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), [
    'downloads',
    'passwordPolicy',
    'registrationEnabled',
    'visits',
  ]);
  assert.deepEqual(body.visits, { today: today?.visits ?? 0, total: sum._sum.visits ?? 0 });
  assert.deepEqual(body.downloads, {
    today: today?.downloads ?? 0,
    total: sum._sum.downloads ?? 0,
  });
  assert.ok(body.visits.total >= 7);
  assert.ok(body.downloads.total >= 3);
  assert.equal(typeof body.registrationEnabled, 'boolean');
});

test('访问量接口同一 IP 每分钟最多 30 次', async () => {
  const ip = freshIp();
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await visit(ip)).statusCode, 204, `第 ${i + 1} 次`);
  }
  assert.equal((await visit(ip)).statusCode, 429);
});

test('统计接口同一 IP 每分钟最多 30 次', async () => {
  const ip = freshIp();
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await stats(ip)).statusCode, 200, `第 ${i + 1} 次`);
  }
  assert.equal((await stats(ip)).statusCode, 429);
});

test('限流按紧挨着的上一跳（反代）给的地址计，客户端自带 X-Forwarded-For 伪造多跳无效', async () => {
  const real = freshIp();
  const viaProxy = () =>
    app.inject({
      method: 'GET',
      url: '/api/public/login-stats',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': `${freshIp()}, ${real}` },
    });
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await viaProxy()).statusCode, 200, `第 ${i + 1} 次`);
  }
  assert.equal((await viaProxy()).statusCode, 429);
});
