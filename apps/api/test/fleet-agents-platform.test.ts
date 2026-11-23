import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { AgentShieldClient } from '../src/modules/endpoint-evals/agentshield-client.js';

/**
 * 智能体安全平台是「每个智能体一条登记」：同一台机器会有多条登记。
 * 资产台账要按机器合并，而不是把同一台机器列成好几台终端。
 */
let app: FastifyInstance;
let adminJwt = '';
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

type Registration = {
  endpoint_id: string; hostname: string; os: string; machine_id?: string;
  owner_display?: string | null; department?: string | null; last_seen_at: string | null;
  eval_runner_version?: string | null;
  agents: Array<{ product: string; version: string | null; headless_capable?: boolean }>;
};
type Row = { endpointId: string; endpointName: string; agentKey: string; version: string | null; groupKey: string; source: string;
  status: string; reason: string | null; evalRunnerVersion?: string | null };
type Group = { key: string; endpointId: string; source: string; name: string; online: boolean | null };

/** 现网形态：同一台机器 5 条登记，endpoint_id 各不相同，hostname、os、使用人相同。 */
function machine(host: string, id = randomBytes(3).toString('hex')): Registration[] {
  const base = { hostname: host, os: 'linux', owner_display: 'yj', department: null, eval_runner_version: null };
  return [
    { ...base, endpoint_id: `${id}-aiprobe`, last_seen_at: minutesAgo(3), agents: [
      { product: 'claude-code', version: '2.1.318' }, { product: 'codex', version: '0.169.0' },
      { product: 'opencode', version: 'version_unknown' }] },
    { ...base, endpoint_id: `${id}-claude-code`, last_seen_at: minutesAgo(1), agents: [{ product: 'claude-code', version: '' }] },
    { ...base, endpoint_id: `${id}-codex`, last_seen_at: null, agents: [{ product: 'codex', version: '' }] },
    { ...base, endpoint_id: `${id}-gemini`, last_seen_at: null, agents: [{ product: 'gemini', version: '' }] },
    { ...base, endpoint_id: `${id}-opencode`, last_seen_at: minutesAgo(1), agents: [{ product: 'opencode', version: '' }] },
  ];
}

async function listWith(remote: Registration[], query: string) {
  const oldBase = process.env.LSE_AGENTSHIELD_BASE_URL;
  const oldSecret = process.env.LSE_ENDPOINT_EVAL_HMAC_SECRET;
  const oldEndpoints = AgentShieldClient.prototype.endpoints;
  try {
    process.env.LSE_AGENTSHIELD_BASE_URL = 'https://connector.example';
    process.env.LSE_ENDPOINT_EVAL_HMAC_SECRET = 'test-secret';
    AgentShieldClient.prototype.endpoints = async () => remote as never;
    const response = await app.inject({ url: `/api/fleet/agents?${query}`, headers: bearer(adminJwt) });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { items: Row[]; groups?: Group[]; total: number };
  } finally {
    AgentShieldClient.prototype.endpoints = oldEndpoints;
    if (oldBase === undefined) delete process.env.LSE_AGENTSHIELD_BASE_URL; else process.env.LSE_AGENTSHIELD_BASE_URL = oldBase;
    if (oldSecret === undefined) delete process.env.LSE_ENDPOINT_EVAL_HMAC_SECRET; else process.env.LSE_ENDPOINT_EVAL_HMAC_SECRET = oldSecret;
  }
}

before(async () => {
  process.env.FLEET_AGENT_ENABLED = 'true';
  app = await buildApp();
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' } }); // pragma: allowlist secret
  assert.equal(login.statusCode, 200, login.body);
  adminJwt = login.json().token;
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test('平台来源：同一台机器的多条登记合并成一台终端，行保留各自的 endpointId', async () => {
  const host = `pskc-${randomBytes(3).toString('hex')}`;
  const body = await listWith(machine(host, 'm1'), `groupBy=endpoint&q=${host}`);
  assert.equal(body.total, 1, '分页单位是机器');
  assert.equal(body.groups?.length, 1);
  const group = body.groups![0]!;
  assert.equal(group.source, 'agentshield');
  assert.equal(group.name, host);
  assert.deepEqual(body.items.map((row) => row.agentKey).sort(), ['claude-code', 'codex', 'gemini', 'opencode']);
  assert.ok(body.items.every((row) => row.groupKey === group.key), '每一行都指向同一个分组');
  assert.equal(body.items.find((row) => row.agentKey === 'gemini')?.endpointId, 'm1-gemini');
});

test('平台来源：同一产品去重时优先有版本号的登记，其次心跳更新的登记', async () => {
  const host = `pskc-${randomBytes(3).toString('hex')}`;
  const body = await listWith(machine(host, 'm2'), `groupBy=endpoint&q=${host}`);
  const by = (key: string) => body.items.find((row) => row.agentKey === key)!;
  // claude-code：aiprobe 有版本号，单独那条心跳更新但没有版本号 → 取有版本号的。
  assert.equal(by('claude-code').endpointId, 'm2-aiprobe');
  assert.equal(by('claude-code').version, '2.1.318');
  // codex：有版本号的那条胜出，没心跳的那条不会盖掉它。
  assert.equal(by('codex').endpointId, 'm2-aiprobe');
  // opencode：两条都没有可用的版本号（version_unknown 不算）→ 取心跳更新的。
  assert.equal(by('opencode').endpointId, 'm2-opencode');
});

test('平台来源：带 machine_id 时按它分组；没有时按主机名和操作系统（不分大小写）', async () => {
  const tag = randomBytes(3).toString('hex');
  const reg = (endpoint_id: string, hostname: string, os: string, product: string, machine_id?: string): Registration => ({
    endpoint_id, hostname, os, ...(machine_id ? { machine_id } : {}), last_seen_at: minutesAgo(1),
    agents: [{ product, version: '1' }] });
  const body = await listWith([
    reg('a1', `Host-${tag}`, 'Linux', 'claude-code'),
    reg('a2', `host-${tag}`, 'linux', 'codex'),
    reg('b1', `host-${tag}`, 'windows', 'codex'),
    reg('c1', `renamed-${tag}`, 'linux', 'claude-code', `mid-${tag}`),
    reg('c2', `other-${tag}`, 'linux', 'codex', `mid-${tag}`),
    reg('d1', `other-${tag}`, 'linux', 'opencode', `mid2-${tag}`),
  ], `groupBy=endpoint&q=${tag}`);
  const groupOf = (endpointId: string) => body.items.find((row) => row.endpointId === endpointId)!.groupKey;
  assert.equal(body.total, 4);
  assert.equal(groupOf('a1'), groupOf('a2'), '主机名和系统相同（不分大小写）是同一台');
  assert.notEqual(groupOf('a1'), groupOf('b1'), '系统不同不是同一台');
  assert.equal(groupOf('c1'), groupOf('c2'), 'machine_id 相同是同一台，即使主机名不同');
  assert.notEqual(groupOf('c2'), groupOf('d1'), 'machine_id 不同不是同一台，即使主机名相同');
});

test('平台来源：按机器分页，一台机器的智能体不会被拆到两页', async () => {
  const tag = randomBytes(3).toString('hex');
  const remote = [...machine(`first-${tag}`, 'p1'), ...machine(`second-${tag}`, 'p2')];
  const page1 = await listWith(remote, `groupBy=endpoint&q=${tag}&page=1&pageSize=1`);
  const page2 = await listWith(remote, `groupBy=endpoint&q=${tag}&page=2&pageSize=1`);
  assert.equal(page1.total, 2);
  assert.equal(page1.items.length, 4);
  assert.ok(page1.items.every((row) => row.endpointName === `first-${tag}`));
  assert.equal(page2.items.length, 4);
  assert.ok(page2.items.every((row) => row.endpointName === `second-${tag}`));
});

test('平台来源：从没发过心跳或心跳超过在线窗口的登记判离线', async () => {
  const tag = randomBytes(3).toString('hex');
  const reg = (endpoint_id: string, last_seen_at: string | null): Registration => ({
    endpoint_id, hostname: `${endpoint_id}-${tag}`, os: 'linux', last_seen_at, agents: [{ product: 'codex', version: '1' }] });
  const body = await listWith([reg('never', null), reg('stale', minutesAgo(11)), reg('bad-time', 'not-a-date'), reg('fresh', minutesAgo(1))],
    `groupBy=endpoint&q=${tag}`);
  const row = (endpointId: string) => body.items.find((item) => item.endpointId === endpointId)!;
  const group = (endpointId: string) => body.groups!.find((item) => item.key === row(endpointId).groupKey)!;
  for (const id of ['never', 'stale', 'bad-time']) {
    assert.equal(row(id).status, 'offline', id);
    assert.equal(group(id).online, false, id);
  }
  assert.notEqual(row('fresh').status, 'offline');
  assert.equal(group('fresh').online, true);
});

test('平台来源：一台机器只要有一条登记在线就算在线，没心跳的那条登记自己仍是离线', async () => {
  const host = `pskc-${randomBytes(3).toString('hex')}`;
  const body = await listWith(machine(host, 'm3'), `groupBy=endpoint&q=${host}`);
  assert.equal(body.groups![0]!.online, true);
  assert.equal(body.items.find((row) => row.agentKey === 'gemini')?.status, 'offline', 'gemini 那条登记从没发过心跳');
  assert.notEqual(body.items.find((row) => row.agentKey === 'claude-code')?.status, 'offline');
  // 在线的登记即使一个智能体都没报（或它的行被去重掉了），机器也算在线。
  const tag = randomBytes(3).toString('hex');
  const mixed = await listWith([
    { endpoint_id: 'alive', hostname: `mixed-${tag}`, os: 'linux', last_seen_at: minutesAgo(1), agents: [] },
    { endpoint_id: 'silent', hostname: `mixed-${tag}`, os: 'linux', last_seen_at: null, agents: [{ product: 'codex', version: '' }] },
  ], `groupBy=endpoint&q=mixed-${tag}`);
  assert.equal(mixed.groups![0]!.online, true);
  assert.equal(mixed.items[0]!.status, 'offline');
});

test('平台来源：在线的行是「平台管理」而不是「需处理」，并带上该登记上报的测评执行器版本', async () => {
  const tag = randomBytes(3).toString('hex');
  const reg = (endpoint_id: string, last_seen_at: string | null, eval_runner_version: string | null): Registration => ({
    endpoint_id, hostname: `${endpoint_id}-${tag}`, os: 'linux', last_seen_at, eval_runner_version,
    agents: [{ product: 'claude-code', version: '2.1.318', headless_capable: true }] });
  const body = await listWith([reg('runner', minutesAgo(1), '1.4.0'), reg('plain', minutesAgo(1), null), reg('gone', null, '1.4.0')],
    `q=${tag}`);
  const row = (endpointId: string) => body.items.find((item) => item.endpointId === endpointId)!;
  assert.equal(row('runner').status, 'platform_managed');
  assert.equal(row('runner').reason, null);
  assert.equal(row('runner').evalRunnerVersion, '1.4.0');
  assert.equal(row('plain').status, 'platform_managed');
  assert.equal(row('plain').evalRunnerVersion, null);
  assert.equal(row('gone').status, 'offline');
  assert.ok(body.items.every((item) => item.status !== 'needs_attention'));
});

test('平台来源：没有 machine_id 时，主机名和系统相同但使用人不同的登记不并成一台', async () => {
  const tag = randomBytes(3).toString('hex');
  const reg = (endpoint_id: string, owner_display: string | null, product: string, machine_id?: string): Registration => ({
    endpoint_id, hostname: `dev-${tag}`, os: 'linux', owner_display, ...(machine_id ? { machine_id } : {}),
    last_seen_at: minutesAgo(1), agents: [{ product, version: '1' }] });
  const body = await listWith([
    reg('alice-1', 'alice', 'claude-code'), reg('alice-2', 'alice', 'codex'),
    reg('bob-1', 'bob', 'claude-code'),
    reg('nobody-1', null, 'claude-code'), reg('nobody-2', '', 'codex'),
    reg('same-1', 'carol', 'claude-code', `mid-${tag}`), reg('same-2', 'dave', 'codex', `mid-${tag}`),
  ], `groupBy=endpoint&q=dev-${tag}`);
  const groupOf = (endpointId: string) => body.items.find((row) => row.endpointId === endpointId)!.groupKey;
  assert.equal(body.total, 4);
  assert.equal(body.items.length, 7, '同名机器的同一产品不会因为误并而只剩一行');
  assert.equal(groupOf('alice-1'), groupOf('alice-2'), '使用人相同仍是同一台');
  assert.notEqual(groupOf('alice-1'), groupOf('bob-1'), '使用人不同不是同一台');
  assert.equal(groupOf('nobody-1'), groupOf('nobody-2'), '使用人为空按空串算，仍并在一起');
  assert.notEqual(groupOf('nobody-1'), groupOf('alice-1'));
  assert.equal(groupOf('same-1'), groupOf('same-2'), '有 machine_id 时只看 machine_id');
});
