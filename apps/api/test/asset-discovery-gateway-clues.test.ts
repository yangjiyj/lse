import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { collectGatewayClues } from '../src/modules/asset-discovery/gateway-clues.js';

const PREFIX = '__asset_clue_';
const env = {
  GATEWAY_CONTROL_PLANE_ALLOWLIST: 'http://gw.test:8080',
  NEWAPI_EVAL_INTEGRATION_TOKEN: 'test-token-not-real',
  NEWAPI_TENANT_ID: 'tenant-a',
} as NodeJS.ProcessEnv;
let savedGateway: unknown = null;
const seenUrls: string[] = [];

function event(id: string, model: string, provider: string, createdAt: string) {
  return {
    id,
    request_id: `req-${id}`,
    created_at: createdAt,
    target: { provider_id: provider, model_id: '', model, endpoint_type: 'chat_completions' },
    evidence: { security_event_count: 0 },
    policy_hits: [],
  };
}

const okFetch = async (input: string | URL) => {
  seenUrls.push(String(input));
  return new Response(
    JSON.stringify({
      data: [
        event('1', 'shadow-upstream', 'p1', '2026-09-28T01:00:00Z'),
        event('2', 'shadow-upstream', 'p1', '2026-09-28T03:00:00Z'),
        event('3', `${PREFIX}known`, 'p2', '2026-09-28T02:00:00Z'),
        event('4', '', 'p3', '2026-09-28T02:00:00Z'),
      ],
      has_more: false,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

before(async () => {
  savedGateway =
    (await prisma.systemSetting.findUnique({ where: { key: 'gateway' } }))?.value ?? null;
  await prisma.systemSetting.upsert({
    where: { key: 'gateway' },
    create: {
      key: 'gateway',
      value: { gatewayBaseUrl: 'http://gw.test:8080', gatewayLinkageEnabled: true },
    },
    update: { value: { gatewayBaseUrl: 'http://gw.test:8080', gatewayLinkageEnabled: true } },
  });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}t`,
      provider: 'openai-compatible',
      baseUrl: 'http://x.test/v1',
      apiKey: 'k',
      model: `${PREFIX}known`,
    },
  });
});

after(async () => {
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.systemSetting.deleteMany({ where: { key: 'gateway' } });
  if (savedGateway)
    await prisma.systemSetting.create({ data: { key: 'gateway', value: savedGateway as object } });
});

test('聚合审计事件中的上游模型并与已登记对象比对', async () => {
  const r = await collectGatewayClues({
    env,
    fetchFn: okFetch,
    now: () => new Date('2026-09-29T00:00:00Z'),
  });
  assert.equal(r.status, 'OK');
  if (r.status !== 'OK') return;
  assert.equal(r.eventCount, 4);
  assert.equal(r.clues.length, 2);
  const [shadow, known] = r.clues;
  assert.equal(shadow!.model, 'shadow-upstream');
  assert.equal(shadow!.eventCount, 2);
  assert.equal(shadow!.lastSeenAt, '2026-09-28T03:00:00Z');
  assert.equal(shadow!.registered, false);
  assert.equal(known!.registered, true);
  assert.ok(seenUrls[0]!.startsWith('http://gw.test:8080/admin/v1/eval-integration/audit-events'));
});

test('网关不可达时返回受限状态，不抛错', async () => {
  const r = await collectGatewayClues({
    env,
    fetchFn: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  assert.equal(r.status, 'UNREACHABLE');
  assert.deepEqual(r.clues, []);
});

test('未配置令牌或未启用联动视为未接入', async () => {
  const noToken = await collectGatewayClues({
    env: { ...env, NEWAPI_EVAL_INTEGRATION_TOKEN: '' },
    fetchFn: okFetch,
  });
  assert.equal(noToken.status, 'NOT_CONNECTED');
  await prisma.systemSetting.update({
    where: { key: 'gateway' },
    data: { value: { gatewayBaseUrl: 'http://gw.test:8080', gatewayLinkageEnabled: false } },
  });
  const disabled = await collectGatewayClues({ env, fetchFn: okFetch });
  assert.equal(disabled.status, 'NOT_CONNECTED');
  assert.equal(disabled.message.startsWith('网关未接入，无法获取审计线索'), true);
});

test('网关地址不在部署授权列表内视为未接入（不放宽校验）', async () => {
  await prisma.systemSetting.update({
    where: { key: 'gateway' },
    data: { value: { gatewayBaseUrl: 'http://evil.test:8080', gatewayLinkageEnabled: true } },
  });
  const r = await collectGatewayClues({ env, fetchFn: okFetch });
  assert.equal(r.status, 'NOT_CONNECTED');
});
