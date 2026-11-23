import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DETECT_CATEGORIES, ROLE_DEFS, TENANT_ADMIN_ROLE } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { runInScope, runInTenant } from '../src/lib/tenant-context.js';
import { periodStart } from '../src/modules/dashboard/routes.js';
import { RiskCounter, detectRiskStats } from '../src/modules/detect-risks/stats.js';
import {
  RISK_FIXTURE_EXPECTED,
  cleanupDetectRiskTenants,
  createRiskTenant,
  riskUserToken,
  seedDetectRiskFixture,
} from './helpers/detect-risk-fixtures.js';

// F-2 首页四类风险（2.2.2）：GET /api/dashboard/detect-risks。

const P = 'F线首页四类风险';
const U = '__p2bf_dash_';

let app: Awaited<ReturnType<typeof buildApp>>;
let tenantA = '';
const tokens = { tenantAdmin: '', auditor: '', none: '', platform: '' };
const tenantAdminPerms = new Set(ROLE_DEFS.find((r) => r.name === TENANT_ADMIN_ROLE)!.permissions);

type Stats = {
  period: string;
  periodStart: string | null;
  categories: Array<{
    category: string;
    label: string;
    total: number;
    high: number;
    sources: Array<{ source: string; label: string; count: { total: number } | null }>;
  }>;
  truncatedCorpusScans: number;
  discoveryRunsTruncated: boolean;
};

async function cleanup(): Promise<void> {
  const tenants = await prismaUnscoped.tenant.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  await cleanupDetectRiskTenants(tenants.map((t) => t.id));
  await prismaUnscoped.user.deleteMany({ where: { username: { startsWith: U } } });
  await prismaUnscoped.role.deleteMany({ where: { name: { startsWith: U } } });
}

async function get(token: string, query = '', headers: Record<string, string> = {}) {
  return app.inject({
    url: `/api/dashboard/detect-risks${query}`,
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
}

const source = (stats: Stats, key: string) =>
  stats.categories.flatMap((c) => c.sources).find((s) => s.source === key)!;

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  tenantA = await createRiskTenant(`${P}A`);
  await seedDetectRiskFixture(tenantA, 'F2甲');
  await seedDetectRiskFixture(await createRiskTenant(`${P}B`), 'F2乙');
  await prismaUnscoped.role.create({ data: { name: `${U}none` } });
  tokens.tenantAdmin = await riskUserToken(app, tenantA, `${U}tadmin`, TENANT_ADMIN_ROLE);
  tokens.auditor = await riskUserToken(app, tenantA, `${U}auditor`, 'auditor');
  tokens.none = await riskUserToken(app, tenantA, `${U}none`, `${U}none`);
  const admin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: ['Admin', '@', '12345'].join('') },
  });
  assert.equal(admin.statusCode, 200, admin.body);
  tokens.platform = admin.json().token;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('period=7d：窗口起点为 periodStart(7d)，四类按固定顺序，数与 detectRiskStats 一致', async () => {
  const t0 = new Date();
  const res = await get(tokens.tenantAdmin, '?period=7d');
  const t1 = new Date();
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as Stats;
  assert.equal(body.period, '7d');
  const start = Date.parse(body.periodStart!);
  assert.ok(start >= periodStart('7d', t0)!.getTime() && start <= periodStart('7d', t1)!.getTime());
  assert.deepEqual(
    body.categories.map((c) => c.category),
    [...DETECT_CATEGORIES],
  );
  const direct = await runInTenant(tenantA, async () =>
    detectRiskStats(
      (code) => tenantAdminPerms.has(code),
      new RiskCounter({ since: new Date(body.periodStart!), until: null }),
    ),
  );
  assert.deepEqual(body.categories, JSON.parse(JSON.stringify(direct.categories)));
  assert.equal(body.truncatedCorpusScans, direct.truncatedCorpusScans);
  assert.equal(body.discoveryRunsTruncated, false);
  // 另一个租户的同样数据不计入
  for (const [key, n] of Object.entries(RISK_FIXTURE_EXPECTED)) {
    assert.equal(source(body, key).count?.total, n, key);
  }
});

test('缺省为本月，起点与首页其他卡片同一个 periodStart；全部不设起点', async () => {
  const month = await get(tokens.tenantAdmin);
  assert.equal(month.statusCode, 200, month.body);
  assert.equal(month.json().period, 'month');
  assert.equal(month.json().periodStart, periodStart('month', new Date())!.toISOString());
  const all = await get(tokens.tenantAdmin, '?period=all');
  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.json().periodStart, null);
  assert.equal(source(all.json(), 'eval_app').count?.total, RISK_FIXTURE_EXPECTED.eval_app);
  const bad = await get(tokens.tenantAdmin, '?period=year');
  assert.equal(bad.statusCode, 400);
});

test('权限：没有任何来源权限 403，未登录 401；没权限的来源为 null', async () => {
  assert.equal((await get(tokens.none)).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/dashboard/detect-risks' })).statusCode, 401);
  const res = await get(tokens.auditor, '?period=all');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as Stats;
  assert.equal(
    source(body, 'model_file').count,
    null,
    'auditor 没有 engine:scan、remediation:read',
  );
  assert.equal(body.categories.find((c) => c.category === 'model')!.total, 0);
  assert.equal(source(body, 'corpus').count?.total, RISK_FIXTURE_EXPECTED.corpus);
});

test('全部租户视角与首页其他卡片一样汇总所有租户', async () => {
  const res = await get(tokens.platform, '?period=all', { 'x-lse-tenant': 'all' });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as Stats;
  const direct = await runInScope({ tenantId: null, sharedWrite: false, allTenants: true }, () =>
    detectRiskStats(() => true, new RiskCounter({ since: null, until: null })),
  );
  assert.deepEqual(body.categories, JSON.parse(JSON.stringify(direct.categories)));
  assert.ok(source(body, 'eval_content').count!.total >= 2 * RISK_FIXTURE_EXPECTED.eval_content);
});
