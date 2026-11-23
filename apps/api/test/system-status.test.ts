import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { EventEmitter } from 'node:events';
import * as collectModule from '../src/modules/system-status/collect.js';
import { collectSystemStatus } from '../src/modules/system-status/collect.js';

// 2.9.9 平台运行状态：只有平台管理员能看；不断言具体数值，只断言字段齐全、取值范围合理。

const P = 'w2sysstatus-';
const PW = ['System', 'Status', '@', '2026'].join(''); // pragma: allowlist secret

let app!: FastifyInstance;
let adminJwt = '';
const jwts: Record<string, string> = {};

const h = (jwt: string, tenant?: string) => ({
  authorization: `Bearer ${jwt}`,
  ...(tenant ? { 'x-lse-tenant': tenant } : {}),
});

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token;
}

async function cleanup(): Promise<void> {
  await prisma.user.deleteMany({ where: { username: { startsWith: P } } });
  await prisma.tenant.deleteMany({ where: { name: { startsWith: P } } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const tenant = await prisma.tenant.create({ data: { name: `${P}租户`, code: `${P}t` } });
  const users: Array<[string, string, string | undefined]> = [
    ['auditor', 'auditor', undefined],
    ['operator', 'operator', undefined],
    ['tadmin', 'tenant_admin', tenant.id],
  ];
  for (const [key, roleName, tenantId] of users) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    await prisma.user.create({
      data: {
        username: `${P}${key}`,
        displayName: key,
        passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
        ...(tenantId ? { tenantId } : {}),
        roles: { create: { roleId: role.id } },
      },
    });
    jwts[key] = await login(`${P}${key}`, PW);
  }
  adminJwt = await login('admin', ['Admin', '@', '12345'].join(''));
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('未登录返回 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/system/status' });
  assert.equal(res.statusCode, 401);
});

test('审计员、操作员、租户管理员都返回 403', async () => {
  for (const key of ['auditor', 'operator', 'tadmin']) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/status',
      headers: h(jwts[key]!),
    });
    assert.equal(res.statusCode, 403, `${key} ${res.body}`);
  }
});

test('平台管理员拿到 CPU、内存、磁盘、运行时长和依赖状态', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/system/status', headers: h(adminJwt) });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();

  assert.ok(Number.isInteger(body.cpu.cores) && body.cpu.cores >= 1);
  assert.equal(typeof body.cpu.load1, 'number');
  assert.equal(typeof body.cpu.load5, 'number');
  assert.equal(typeof body.cpu.usagePercent, 'number');
  assert.ok(
    body.cpu.usagePercent >= 0 && body.cpu.usagePercent <= 100,
    String(body.cpu.usagePercent),
  );

  assert.ok(body.memory.total > 0);
  assert.ok(body.memory.used >= 0 && body.memory.used <= body.memory.total);

  assert.ok(Array.isArray(body.disks) && body.disks.length >= 1);
  for (const disk of body.disks) {
    assert.equal(typeof disk.mount, 'string');
    assert.ok(disk.total > 0);
    assert.ok(disk.used >= 0 && disk.used <= disk.total);
  }
  assert.ok(body.disks.some((d: { mount: string }) => d.mount === '/'));

  assert.equal(typeof body.uptimeSeconds, 'number');
  assert.ok(body.uptimeSeconds >= 0);
  assert.ok(!Number.isNaN(Date.parse(body.checkedAt)));

  assert.deepEqual(body.dependencies, { database: 'ok', redis: 'ok' });
});

test('平台管理员在全部租户视角下也能看', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/system/status',
    headers: h(adminJwt, 'all'),
  });
  assert.equal(res.statusCode, 200, res.body);
});

test('依赖不可用或超时时记为 error，不拖垮接口', async () => {
  const status = await collectSystemStatus({
    sampleMs: 10,
    timeoutMs: 50,
    checkDatabase: async () => {
      throw new Error('down');
    },
    checkRedis: () => new Promise(() => undefined),
  });
  assert.deepEqual(status.dependencies, { database: 'error', redis: 'error' });
  assert.ok(status.cpu.usagePercent >= 0 && status.cpu.usagePercent <= 100);
});

test('CPU 使用率在约 200 毫秒内采两次求差', async () => {
  const started = Date.now();
  await collectSystemStatus({
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 190 && elapsed < 2000, `耗时 ${elapsed}ms`);
});

const GB = 1024 ** 3;

type HostOverrides = Record<string, unknown>;

function collectWith(host: HostOverrides) {
  return collectSystemStatus({
    sampleMs: 5,
    diskPaths: [],
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
    host,
  } as Parameters<typeof collectSystemStatus>[0]);
}

const hostBase = {
  totalmem: () => 16 * GB,
  freemem: () => 10 * GB,
  constrainedMemory: () => 0,
  availableMemory: () => 10 * GB,
  cpuCount: () => 16,
  readCpuMax: async () => null,
  processUptime: () => 42.9,
};

test('容器有内存限制时总量按限制算，已用 = 总量 - 可用', async () => {
  const status = await collectWith({
    ...hostBase,
    constrainedMemory: () => 2 * GB,
    availableMemory: () => 0.5 * GB,
  });
  assert.deepEqual(status.memory, { total: 2 * GB, used: 1.5 * GB });
});

test('没有内存限制（0、取不到、大于物理内存）时退回 os.totalmem', async () => {
  for (const constrainedMemory of [() => 0, () => undefined, () => 2 ** 64]) {
    const status = await collectWith({
      ...hostBase,
      constrainedMemory,
      availableMemory: () => 6 * GB,
    });
    assert.deepEqual(status.memory, { total: 16 * GB, used: 10 * GB });
  }
});

test('已运行取平台进程的运行时长', async () => {
  const status = await collectWith({ ...hostBase, processUptime: () => 42.9 });
  assert.equal(status.uptimeSeconds, 42);
});

test('默认读取的是平台进程运行时长，不是宿主机开机时长', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/system/status', headers: h(adminJwt) });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(res.json().uptimeSeconds <= Math.ceil(process.uptime()) + 1, res.body);
});

test('CPU 核数按 cgroup 配额算，读不到或不限时退回 CPU 个数', async () => {
  const cases: Array<[string | null, number]> = [
    ['200000 100000', 2],
    ['150000 100000\n', 2],
    ['50000 100000', 1],
    ['max 100000', 16],
    ['6400000 100000', 16],
    ['garbage', 16],
    [null, 16],
  ];
  for (const [cpuMax, cores] of cases) {
    const status = await collectWith({ ...hostBase, readCpuMax: async () => cpuMax });
    assert.equal(status.cpu.cores, cores, String(cpuMax));
  }
});

type FakeRedis = EventEmitter & { status: string; ping: () => Promise<unknown>; pings: number };

function fakeRedis(status: string): FakeRedis {
  const redis = new EventEmitter() as FakeRedis;
  redis.status = status;
  redis.pings = 0;
  redis.ping = async () => {
    redis.pings += 1;
    return 'PONG';
  };
  return redis;
}

const pingWhenReady = () =>
  (collectModule as Record<string, unknown>).pingRedisWhenReady as
    | ((redis: FakeRedis, timeoutMs: number) => Promise<unknown>)
    | undefined;

test('Redis 连接不是 ready 时直接判异常，不往离线队列塞 ping', async () => {
  const ping = pingWhenReady();
  assert.equal(typeof ping, 'function', '缺少 pingRedisWhenReady');
  for (const status of ['reconnecting', 'close', 'end', 'wait']) {
    const redis = fakeRedis(status);
    await assert.rejects(ping!(redis, 50), status);
    assert.equal(redis.pings, 0, status);
  }
});

test('Redis 连接 ready 时才发 ping', async () => {
  const ping = pingWhenReady();
  assert.equal(typeof ping, 'function', '缺少 pingRedisWhenReady');
  const redis = fakeRedis('ready');
  assert.equal(await ping!(redis, 50), 'PONG');
  assert.equal(redis.pings, 1);
});

test('首次连接中等到 ready 再 ping，超时判异常且不留监听', async () => {
  const ping = pingWhenReady();
  assert.equal(typeof ping, 'function', '缺少 pingRedisWhenReady');
  const connecting = fakeRedis('connecting');
  const pending = ping!(connecting, 500);
  setTimeout(() => {
    connecting.status = 'ready';
    connecting.emit('ready');
  }, 10);
  assert.equal(await pending, 'PONG');
  assert.equal(connecting.listenerCount('ready'), 0);

  const stuck = fakeRedis('connecting');
  await assert.rejects(ping!(stuck, 30));
  assert.equal(stuck.pings, 0);
  assert.equal(stuck.listenerCount('ready'), 0);
});
