import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { AgentShieldClient } from '../src/modules/endpoint-evals/agentshield-client.js';
import { resetEndpointStateCache } from '../src/modules/model-targets/endpoint-state.js';

/**
 * 终端类评估对象绑定的终端在来源那边已经不存在时，评估对象列表要能看出来（endpointState）。
 * 现网形态：平台来源 accessConfig = {product, endpointId, endpointLabel, agentshieldBaseUrl}，provider='agentshield'；
 * 自管来源 accessConfig = {source, endpointId(publicId), endpointLabel, fleetEndpointId}，provider='jiandun-fleet'。
 */
const PREFIX = '__ep_state_';
const BASE = 'https://connector.example';
const PASSWORD = ['Ep', 'State', '123'].join('!');
let app: FastifyInstance;
let adminJwt = '';
let auditorJwt = '';
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function cleanup() {
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.fleetEndpoint.deleteMany({ where: { hostname: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' } }); // pragma: allowlist secret
  assert.equal(login.statusCode, 200, login.body);
  adminJwt = login.json().token;
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'auditor' } });
  const auditor = await prisma.user.create({ data: { username: `${PREFIX}auditor`, displayName: 'auditor', isActive: true,
    passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }), roles: { create: { roleId: role.id } } } });
  const auditorLogin = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { username: auditor.username, password: PASSWORD } });
  assert.equal(auditorLogin.statusCode, 200, auditorLogin.body);
  auditorJwt = auditorLogin.json().token;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

const platformTarget = (name: string, endpointId: string, agentshieldBaseUrl = BASE, product = 'claude-code') => prisma.modelTarget.create({ data: {
  name: `${PREFIX}${name}`, provider: 'agentshield', targetType: 'ENDPOINT_AGENT', baseUrl: agentshieldBaseUrl, apiKey: '',
  model: product, accessConfig: { product, endpointId, endpointLabel: 'pskc', agentshieldBaseUrl } } });

async function fleetEndpoint(name: string, data: { status?: 'ACTIVE' | 'REVOKED'; removedAt?: Date } = {}) {
  return prisma.fleetEndpoint.create({ data: {
    publicId: `ep_${randomBytes(10).toString('hex')}`, installationId: randomUUID(), machineId: `m-${name}`,
    hostname: `${PREFIX}${name}`, os: 'linux', capabilities: [],
    tokenHash: createHash('sha256').update(randomBytes(16)).digest('hex'), lastSeenAt: new Date(),
    status: data.status ?? 'ACTIVE', ...(data.status === 'REVOKED' ? { revokedAt: new Date() } : {}),
    ...(data.removedAt ? { removedAt: data.removedAt } : {}) } });
}
const fleetTarget = (name: string, endpoint: { id: string; publicId: string }) => prisma.modelTarget.create({ data: {
  name: `${PREFIX}${name}`, provider: 'jiandun-fleet', targetType: 'ENDPOINT_AGENT', baseUrl: `fleet://${endpoint.publicId}`,
  apiKey: '', model: 'endpoint-agent',
  accessConfig: { source: 'jiandun-fleet', fleetEndpointId: endpoint.id, endpointId: endpoint.publicId, endpointLabel: name } } });

type Item = { id: string; name: string; endpointState?: string };
/**
 * 在给定的连接器行为下取评估对象列表；返回列表、清单接口被调用的次数、逐个确认（posture）问过的登记。
 * exists：平台对某个登记是否还在的回答；不给时任何确认调用都算测试失败。
 */
async function listWith(connector: (() => Promise<unknown>) | null, keyword: string, jwt = adminJwt,
  exists: (endpointId: string) => Promise<boolean> = async (id) => { throw new Error(`unexpected confirm ${id}`); },
  /** keepCache：不清进程内缓存（默认每次调用前清掉，用例之间互不影响）；base：部署的连接器地址；param：列表请求带的开关参数。 */
  opts: { keepCache?: boolean; base?: string; param?: string } = {}) {
  if (!opts.keepCache) resetEndpointStateCache();
  const oldBase = process.env.LSE_AGENTSHIELD_BASE_URL;
  const oldSecret = process.env.LSE_ENDPOINT_EVAL_HMAC_SECRET;
  const oldEndpoints = AgentShieldClient.prototype.endpoints;
  const oldExists = AgentShieldClient.prototype.endpointExists;
  let calls = 0;
  const confirmed: string[] = [];
  try {
    if (connector) {
      process.env.LSE_AGENTSHIELD_BASE_URL = opts.base ?? BASE;
      process.env.LSE_ENDPOINT_EVAL_HMAC_SECRET = 'test-secret';
    } else delete process.env.LSE_AGENTSHIELD_BASE_URL;
    AgentShieldClient.prototype.endpoints = (async () => { calls += 1; return connector ? connector() : []; }) as never;
    AgentShieldClient.prototype.endpointExists = async (id: string) => { confirmed.push(id); return exists(id); };
    const response = await app.inject({ url: `/api/model-targets?pageSize=100&keyword=${encodeURIComponent(PREFIX + keyword)}${opts.param ?? '&withEndpointState=1'}`, headers: bearer(jwt) });
    assert.equal(response.statusCode, 200, response.body);
    const items = response.json().items as Item[];
    return { calls, confirmed, state: (name: string) => items.find((item) => item.name === `${PREFIX}${name}`)?.endpointState, items };
  } finally {
    AgentShieldClient.prototype.endpoints = oldEndpoints;
    AgentShieldClient.prototype.endpointExists = oldExists;
    if (oldBase === undefined) delete process.env.LSE_AGENTSHIELD_BASE_URL; else process.env.LSE_AGENTSHIELD_BASE_URL = oldBase;
    if (oldSecret === undefined) delete process.env.LSE_ENDPOINT_EVAL_HMAC_SECRET; else process.env.LSE_ENDPOINT_EVAL_HMAC_SECRET = oldSecret;
  }
}
const registration = (endpoint_id: string) => ({ endpoint_id, hostname: 'pskc', os: 'linux', owner_display: null, department: null,
  last_seen_at: null, eval_runner_version: null, agents: [] });

test('自管来源：终端不存在、已吊销或已删除即 gone，正常的为 active', async () => {
  const active = await fleetEndpoint('fleet-active');
  const revoked = await fleetEndpoint('fleet-revoked', { status: 'REVOKED' });
  const removed = await fleetEndpoint('fleet-removed', { status: 'REVOKED', removedAt: new Date() });
  await fleetTarget('fleet-active', active);
  await fleetTarget('fleet-revoked', revoked);
  await fleetTarget('fleet-removed', removed);
  await fleetTarget('fleet-missing', { id: randomUUID(), publicId: `ep_${randomBytes(10).toString('hex')}` });
  const { state, calls } = await listWith(async () => [], 'fleet-');
  assert.equal(state('fleet-active'), 'active');
  assert.equal(state('fleet-revoked'), 'gone');
  assert.equal(state('fleet-removed'), 'gone');
  assert.equal(state('fleet-missing'), 'gone');
  assert.equal(calls, 0, '页面里没有平台来源的对象时不调连接器');
});

test('平台来源：清单里没有、平台也确认登记不存在才是 gone；清单只调一次，清单里有的不再逐个确认', async () => {
  await platformTarget('plat-alive', 'reg-alive');
  await platformTarget('plat-gone-1', 'reg-revoked-1');
  await platformTarget('plat-gone-2', 'reg-revoked-2');
  const { state, calls, confirmed } = await listWith(async () => [registration('reg-alive'), registration('reg-other')], 'plat-',
    adminJwt, async () => false);
  assert.equal(state('plat-alive'), 'active');
  assert.equal(state('plat-gone-1'), 'gone');
  assert.equal(state('plat-gone-2'), 'gone');
  assert.equal(calls, 1);
  assert.deepEqual([...confirmed].sort(), ['reg-revoked-1', 'reg-revoked-2']);
});

test('平台来源：登记还在、只是暂时没有可测智能体（清单不列它）时不是 gone', async () => {
  // 平台清单接口会丢掉没有可测智能体的登记；这种登记逐个确认时平台回答还在。
  await platformTarget('idle-still-there', 'reg-idle');
  await platformTarget('idle-revoked', 'reg-idle-revoked');
  const { state } = await listWith(async () => [registration('reg-other')], 'idle-', adminJwt, async (id) => id === 'reg-idle');
  assert.equal(state('idle-still-there'), 'active');
  assert.equal(state('idle-revoked'), 'gone');
});

test('平台来源：逐个确认失败时为 unknown；产品不是平台认识的也无法确认', async () => {
  await platformTarget('confirm-fail', 'reg-confirm-fail');
  await platformTarget('confirm-badproduct', 'reg-bad-product', BASE, 'gemini');
  const { state, confirmed } = await listWith(async () => [], 'confirm-', adminJwt, async () => { throw new Error('posture down'); });
  assert.equal(state('confirm-fail'), 'unknown');
  assert.equal(state('confirm-badproduct'), 'unknown');
  assert.deepEqual(confirmed, ['reg-confirm-fail']);
});

test('平台来源：一次请求最多逐个确认 5 个登记，其余为 unknown；同一登记的多个对象只确认一次', async () => {
  for (let i = 1; i <= 7; i += 1) await platformTarget(`cap-${i}`, `reg-cap-${i}`);
  await platformTarget('cap-1-codex', 'reg-cap-1', BASE, 'codex');
  const { state, confirmed } = await listWith(async () => [], 'cap-', adminJwt, async () => false);
  assert.equal(confirmed.length, 5);
  assert.equal(new Set(confirmed).size, 5);
  const states = [1, 2, 3, 4, 5, 6, 7].map((i) => state(`cap-${i}`));
  assert.equal(states.filter((value) => value === 'gone').length, 5);
  assert.equal(states.filter((value) => value === 'unknown').length, 2);
  assert.equal(state('cap-1-codex'), state('cap-1'), '同一登记的对象状态一致');
  // 已有缓存结果的登记不占下一次请求的确认名额：再请求一次，剩下的 2 个也确认完。
  const next = await listWith(async () => [], 'cap-', adminJwt, async () => false, { keepCache: true });
  assert.equal(next.confirmed.length, 2);
  assert.ok(next.confirmed.every((id) => !confirmed.includes(id)));
  assert.ok([1, 2, 3, 4, 5, 6, 7].every((i) => next.state(`cap-${i}`) === 'gone'));
});

test('只有请求明确带 withEndpointState 时才计算终端状态；其他调用方不带该字段、也不调连接器', async () => {
  const endpoint = await fleetEndpoint('optin-fleet');
  await fleetTarget('optin-fleet', endpoint);
  await platformTarget('optin-plat', 'reg-optin');
  for (const param of ['', '&withEndpointState=0', '&withEndpointState=false']) {
    const plain = await listWith(async () => [registration('reg-optin')], 'optin-', adminJwt, undefined, { param });
    assert.equal(plain.items.length, 2);
    assert.ok(plain.items.every((item) => !('endpointState' in item)), param);
    assert.equal(plain.calls, 0, param);
  }
  const asked = await listWith(async () => [registration('reg-optin')], 'optin-', adminJwt, undefined, { param: '&withEndpointState=true' });
  assert.equal(asked.state('optin-fleet'), 'active');
  assert.equal(asked.state('optin-plat'), 'active');
  assert.equal(asked.calls, 1);
});

test('连接器清单和逐个确认的结果在进程内缓存 60 秒：期间不再调连接器，过期后重新调', async (t) => {
  await platformTarget('cache-alive', 'reg-cache-alive');
  await platformTarget('cache-gone', 'reg-cache-gone');
  const connector = async () => [registration('reg-cache-alive')];
  const first = await listWith(connector, 'cache-', adminJwt, async () => false);
  assert.equal(first.calls, 1);
  assert.deepEqual(first.confirmed, ['reg-cache-gone']);
  const second = await listWith(connector, 'cache-', adminJwt, undefined, { keepCache: true });
  assert.equal(second.calls, 0);
  assert.deepEqual(second.confirmed, []);
  assert.equal(second.state('cache-alive'), 'active');
  assert.equal(second.state('cache-gone'), 'gone');
  // 61 秒后缓存过期。
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.after(() => mock.timers.reset());
  mock.timers.tick(61_000);
  const third = await listWith(connector, 'cache-', adminJwt, async () => false, { keepCache: true });
  assert.equal(third.calls, 1);
  assert.deepEqual(third.confirmed, ['reg-cache-gone']);
});

test('失败结果也缓存：平台不通时 60 秒内不再反复去等', async () => {
  await platformTarget('failcache-a', 'reg-failcache-a');
  const down = async () => { throw new Error('connector down'); };
  const first = await listWith(down, 'failcache-');
  assert.equal(first.calls, 1);
  assert.equal(first.state('failcache-a'), 'unknown');
  const second = await listWith(down, 'failcache-', adminJwt, undefined, { keepCache: true });
  assert.equal(second.calls, 0);
  assert.equal(second.state('failcache-a'), 'unknown');
  // 逐个确认失败同样缓存。
  const confirmDown = async () => { throw new Error('posture down'); };
  const third = await listWith(async () => [], 'failcache-', adminJwt, confirmDown);
  assert.deepEqual(third.confirmed, ['reg-failcache-a']);
  const fourth = await listWith(async () => [], 'failcache-', adminJwt, confirmDown, { keepCache: true });
  assert.deepEqual(fourth.confirmed, []);
  assert.equal(fourth.state('failcache-a'), 'unknown');
});

test('缓存按部署的连接器地址区分：换了地址不会用上旧地址的结果', async () => {
  const other = 'https://connector-b.example';
  await platformTarget('addrcache-a', 'reg-addrcache', BASE);
  await platformTarget('addrcache-b', 'reg-addrcache', other);
  const onA = await listWith(async () => [registration('reg-addrcache')], 'addrcache-');
  assert.equal(onA.state('addrcache-a'), 'active');
  assert.equal(onA.state('addrcache-b'), 'unknown');
  // 部署改指向另一个平台：那边没有这个登记。
  const onB = await listWith(async () => [], 'addrcache-', adminJwt, async () => false, { keepCache: true, base: other });
  assert.equal(onB.calls, 1, '新地址要重新读清单');
  assert.equal(onB.state('addrcache-b'), 'gone');
  assert.equal(onB.state('addrcache-a'), 'unknown');
});

test('平台来源：连接器未配置、调用失败、返回格式不对、无权限时为 unknown，列表照常返回', async () => {
  await platformTarget('unk-a', 'reg-a');
  assert.equal((await listWith(null, 'unk-')).state('unk-a'), 'unknown', '未配置');
  const failed = await listWith(async () => { throw new Error('connector down'); }, 'unk-');
  assert.equal(failed.state('unk-a'), 'unknown', '调用失败');
  assert.deepEqual(failed.confirmed, [], '清单都读不到时不再逐个确认');
  assert.equal((await listWith(async () => ({ error: 'x' }), 'unk-')).state('unk-a'), 'unknown', '返回格式不对');
  const denied = await listWith(async () => [], 'unk-', auditorJwt);
  assert.equal(denied.state('unk-a'), 'unknown', '只读账号无权读连接器清单');
  assert.equal(denied.calls, 0);
});

test('平台来源：对象保存的平台地址与当前部署不一致时无法判断，为 unknown', async () => {
  await platformTarget('addr-other', 'reg-x', 'https://another-connector.example');
  assert.equal((await listWith(async () => [], 'addr-')).state('addr-other'), 'unknown');
});

test('非终端类对象不带 endpointState', async () => {
  await prisma.modelTarget.create({ data: { name: `${PREFIX}model-plain`, provider: 'openai-compatible', targetType: 'MODEL',
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-key', model: 'm' } });
  const { items, calls } = await listWith(async () => [], 'model-');
  assert.equal(items.length, 1);
  assert.equal('endpointState' in items[0]!, false);
  assert.equal(calls, 0);
});
