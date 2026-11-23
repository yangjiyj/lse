import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DETECT_CATEGORIES, ROLE_DEFS, TENANT_ADMIN_ROLE } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { runInTenant } from '../src/lib/tenant-context.js';
import { RISK_SOURCES_BY_CATEGORY } from '../src/modules/detect-risks/sources.js';
import {
  RISK_SEVERITY_KEYS,
  RiskCounter,
  countRiskSource,
  detectRiskStats,
} from '../src/modules/detect-risks/stats.js';
import {
  RISK_FIXTURE_EXPECTED,
  RISK_FIXTURE_SERVICE,
  RISK_FIXTURE_UNREGISTERED_MODEL,
  cleanupDetectRiskTenants,
  createRiskTenant,
  riskUserToken,
  seedDetectRiskFixture,
  type DetectRiskFixture,
} from './helpers/detect-risk-fixtures.js';

// F-3 检测结果四视角接口（2.5.3）：GET /api/detect-results。

const P = 'F线检测结果视角';
const U = '__p2bf_results_';
const ALL = { since: null, until: null };
const tenantAdminPerms = new Set(ROLE_DEFS.find((r) => r.name === TENANT_ADMIN_ROLE)!.permissions);

let app: Awaited<ReturnType<typeof buildApp>>;
let a!: DetectRiskFixture;
let b!: DetectRiskFixture;
const tokens = { tenantAdmin: '', auditor: '', platform: '' };

interface Row {
  source: string;
  id: string;
  tenantId: string | null;
  title: string;
  severity: string;
  subject: string | null;
  recordKind: string;
  recordId: string;
  recordName: string | null;
  href: string;
  createdAt: string;
}
interface Body {
  category: string;
  source: string;
  sources: Array<{ source: string; label: string; total: number }>;
  items: Row[];
  total: number;
  page: number;
  pageSize: number;
}

async function cleanup(): Promise<void> {
  const tenants = await prismaUnscoped.tenant.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  await cleanupDetectRiskTenants(tenants.map((t) => t.id));
  await prismaUnscoped.user.deleteMany({ where: { username: { startsWith: U } } });
}

function get(query: string, token = tokens.tenantAdmin, headers: Record<string, string> = {}) {
  return app.inject({
    url: `/api/detect-results?${query}`,
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
}

async function body(query: string, token?: string, headers?: Record<string, string>) {
  const res = await get(query, token, headers);
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as Body;
}

const rank = (s: string) => RISK_SEVERITY_KEYS.indexOf(s as (typeof RISK_SEVERITY_KEYS)[number]);

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  a = await seedDetectRiskFixture(await createRiskTenant(`${P}A`), 'F3甲');
  b = await seedDetectRiskFixture(await createRiskTenant(`${P}B`), 'F3乙');
  tokens.tenantAdmin = await riskUserToken(app, a.tenantId, `${U}tadmin`, TENANT_ADMIN_ROLE);
  tokens.auditor = await riskUserToken(app, a.tenantId, `${U}auditor`, 'auditor');
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

test('下钻一致：每个来源列表的合计等于计数口径，sources 合计等于统计', async () => {
  const stats = await runInTenant(a.tenantId, async () =>
    detectRiskStats((code) => tenantAdminPerms.has(code), new RiskCounter(ALL)),
  );
  for (const category of DETECT_CATEGORIES) {
    const expected = stats.categories.find((c) => c.category === category)!;
    for (const source of RISK_SOURCES_BY_CATEGORY[category]) {
      const res = await body(`category=${category}&source=${source}&pageSize=100`);
      const count = await runInTenant(a.tenantId, async () => countRiskSource(source, ALL));
      assert.equal(res.total, count.total, source);
      assert.equal(res.total, RISK_FIXTURE_EXPECTED[source], source);
      assert.equal(res.items.length, res.total, source);
      assert.ok(res.items.every((r) => r.source === source));
      assert.deepEqual(
        res.sources,
        expected.sources.map((s) => ({ source: s.source, label: s.label, total: s.count!.total })),
        category,
      );
    }
  }
});

test('缺省来源取该类第一个有权限的来源；排序按严重度从高到低，再按时间倒序', async () => {
  const res = await body('category=app_env');
  assert.equal(res.category, 'app_env');
  assert.equal(res.source, 'eval_app');
  assert.deepEqual(
    res.items.map((r) => r.severity),
    ['HIGH', 'HIGH', 'MEDIUM', 'LOW'],
  );
  const service = await body('category=app_env&source=service_assurance');
  assert.deepEqual(
    service.items.map((r) => r.severity),
    ['HIGH', 'UNRATED'],
    '未定级排最后',
  );
  for (let i = 1; i < res.items.length; i += 1) {
    const prev = res.items[i - 1]!;
    const cur = res.items[i]!;
    assert.ok(rank(prev.severity) <= rank(cur.severity));
    if (prev.severity === cur.severity) assert.ok(prev.createdAt >= cur.createdAt);
  }
});

test('分页跨严重度时与整页顺序一致', async () => {
  const full = await body('category=app_env&source=eval_app&pageSize=100');
  const pages: Row[] = [];
  for (let page = 1; page <= 2; page += 1) {
    const res = await body(`category=app_env&source=eval_app&page=${page}&pageSize=3`);
    assert.equal(res.total, 4);
    pages.push(...res.items);
  }
  assert.deepEqual(
    pages.map((r) => r.id),
    full.items.map((r) => r.id),
  );
  const beyond = await body('category=app_env&source=eval_app&page=3&pageSize=3');
  assert.deepEqual(beyond.items, []);
});

test('严重度筛选：severity=HIGH,CRITICAL 只留高危以上，来源合计不变', async () => {
  const res = await body('category=app_env&source=eval_app&severity=HIGH,CRITICAL');
  assert.equal(res.total, 2);
  assert.deepEqual(
    res.items.map((r) => r.severity),
    ['HIGH', 'HIGH'],
  );
  assert.equal(res.sources.find((s) => s.source === 'eval_app')!.total, 4);
  const content = await body('category=content&severity=CRITICAL');
  assert.deepEqual(
    content.items.map((r) => r.severity),
    ['CRITICAL'],
  );
  assert.equal((await get('category=content&severity=URGENT')).statusCode, 400);
});

test('各来源的行：标题、对象、来源记录和跳转', async () => {
  const content = await body('category=content&pageSize=100');
  const jailbreak = content.items.find((r) => r.severity === 'CRITICAL')!;
  assert.equal(jailbreak.title, '越狱', '去掉 [引擎] 前缀');
  assert.equal(jailbreak.subject, 'F3甲内容对象');
  assert.equal(jailbreak.recordKind, 'eval_task');
  assert.equal(jailbreak.recordId, a.tasks.content);
  assert.equal(jailbreak.recordName, 'F3甲内容评估');
  assert.equal(jailbreak.href, `/eval-tasks/${a.tasks.content}`);
  assert.equal(jailbreak.tenantId, a.tenantId, '全部租户视角下点记录要先进入所属租户');

  const appEval = await body('category=app_env&source=eval_app&pageSize=100');
  const endpointRow = appEval.items.find((r) => r.recordId === a.tasks.endpoint)!;
  assert.equal(endpointRow.recordKind, 'fleet_eval_job');

  const model = await body('category=model&pageSize=100');
  assert.equal(model.items[0]!.title, 'Pickle 加载时可执行危险对象', '规则标题');
  assert.match(model.items[0]!.subject!, /pickle_dangerous_global\.pkl$/);
  assert.equal(model.items[0]!.href, `/inspect/model-files?scan=${a.modelFileScanId}`);

  const corpus = await body('category=data&pageSize=100');
  assert.ok(corpus.items.every((r) => r.href === `/data/corpus-scans/${a.corpusScanId}`));
  const first = corpus.items.find((r) => r.subject === '第 1 条 output')!;
  assert.equal(first.title, '手机号');
  assert.ok(
    corpus.items.some((r) => r.title === 'phone'),
    '没有中文名时用子类',
  );
  assert.equal(first.recordName, 'F3甲语料.jsonl');

  const service = await body('category=app_env&source=service_assurance');
  assert.equal(service.items[0]!.subject, 'vllm', '有组件时显示组件名');
  assert.equal(service.items[1]!.subject, 'F3甲核验目标', '没有组件时显示核验目标');
  assert.equal(service.items[0]!.href, `/service-assurance?run=${a.serviceRunId}`);

  const component = await body('category=app_env&source=ai_component');
  assert.equal(component.items[0]!.subject, 'F3甲 MCP 服务');
  assert.equal(component.items[0]!.href, `/ai-asset-scan?scan=${a.aiScanId}`);

  const discovery = await body('category=app_env&source=asset_discovery');
  assert.equal(discovery.items.length, 1, '两次命中同一个未登记模型只算一行');
  const row = discovery.items[0]!;
  assert.equal(row.title, `未登记 AI 服务：${RISK_FIXTURE_UNREGISTERED_MODEL}`);
  assert.equal(row.subject, RISK_FIXTURE_SERVICE);
  assert.equal(row.severity, 'HIGH');
  assert.equal(row.recordId, a.discoveryRunIds[1], '指向最近一次测绘');
  assert.equal(row.href, `/inspect/asset-discovery?run=${a.discoveryRunIds[1]}`);
  for (const r of [...model.items, ...corpus.items, ...service.items, ...component.items, row]) {
    assert.equal(r.tenantId, a.tenantId, r.source);
  }
});

test('时间窗口：since、until 按记录所属任务或扫描的创建时间', async () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const res = await body(`category=content&since=${encodeURIComponent(future)}`);
  assert.equal(res.total, 0);
  assert.equal(res.sources[0]!.total, 0);
  const past = new Date(Date.now() - 3600_000).toISOString();
  assert.equal((await body(`category=content&until=${encodeURIComponent(past)}`)).total, 0);
  assert.equal((await body(`category=content&since=${encodeURIComponent(past)}`)).total, 2);
  assert.equal((await get('category=content&since=not-a-date')).statusCode, 400);
});

test('参数与权限：来源不属于该类别 400，没权限 403', async () => {
  assert.equal((await get('category=data&source=model_file')).statusCode, 400);
  assert.equal((await get('category=secret')).statusCode, 400);
  assert.equal((await get('')).statusCode, 400, 'category 必填');
  assert.equal((await get('category=content&pageSize=101')).statusCode, 400);
  assert.equal((await get('category=model', tokens.auditor)).statusCode, 403);
  assert.equal((await get('category=model&source=model_file', tokens.auditor)).statusCode, 403);
  const auditorApp = await body('category=app_env', tokens.auditor);
  assert.deepEqual(
    auditorApp.sources.map((s) => s.source),
    ['eval_app', 'service_assurance', 'ai_component', 'asset_discovery'],
  );
  assert.equal((await app.inject({ url: '/api/detect-results?category=content' })).statusCode, 401);
});

test('租户：另一个租户的数据不出现；全部租户视角可按租户筛选', async () => {
  const mine = new Set([a.tasks.content, a.tasks.agent, a.tasks.endpoint]);
  for (const category of DETECT_CATEGORIES) {
    for (const source of RISK_SOURCES_BY_CATEGORY[category]) {
      const res = await body(`category=${category}&source=${source}&pageSize=100`);
      const ids = new Set(res.items.map((r) => r.recordId));
      for (const id of [
        b.tasks.content,
        b.tasks.agent,
        b.tasks.endpoint,
        b.modelFileScanId,
        b.corpusScanId,
        b.serviceRunId,
        b.aiScanId,
        ...b.discoveryRunIds,
      ]) {
        assert.ok(!ids.has(id), `${source} 出现了另一个租户的记录`);
      }
      if (source.startsWith('eval_')) assert.ok(res.items.every((r) => mine.has(r.recordId)));
    }
  }
  const all = { 'x-lse-tenant': 'all' };
  const filtered = await body(
    `category=app_env&source=eval_app&pageSize=100&tenantId=${b.tenantId}`,
    tokens.platform,
    all,
  );
  assert.equal(filtered.total, RISK_FIXTURE_EXPECTED.eval_app);
  assert.ok(
    filtered.items.every((r) => [b.tasks.agent, b.tasks.endpoint].includes(r.recordId)),
    '只有乙租户的',
  );
  assert.equal(filtered.sources[0]!.total, RISK_FIXTURE_EXPECTED.eval_app);
  const discovery = await body(
    `category=app_env&source=asset_discovery&tenantId=${b.tenantId}`,
    tokens.platform,
    all,
  );
  assert.deepEqual(
    discovery.items.map((r) => r.recordId),
    [b.discoveryRunIds[1]],
  );
  // 租户视角下 tenantId 参数不起作用
  const ignored = await body(`category=app_env&source=eval_app&tenantId=${b.tenantId}`);
  assert.ok(ignored.items.every((r) => mine.has(r.recordId)));
});

test('四类统计接口：页签上的数与 detectRiskStats 一致，按时间窗口和租户', async () => {
  const stats = (query: string, token = tokens.tenantAdmin, headers: Record<string, string> = {}) =>
    app.inject({
      url: `/api/detect-results/stats${query}`,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
  const res = await stats('');
  assert.equal(res.statusCode, 200, res.body);
  const direct = await runInTenant(a.tenantId, async () =>
    detectRiskStats((code) => tenantAdminPerms.has(code), new RiskCounter(ALL)),
  );
  assert.deepEqual(res.json().categories, JSON.parse(JSON.stringify(direct.categories)));
  assert.equal(res.json().truncatedCorpusScans, 0);
  const future = encodeURIComponent(new Date(Date.now() + 3600_000).toISOString());
  const later = await stats(`?since=${future}`);
  assert.ok(later.json().categories.every((c: { total: number }) => c.total === 0));
  const auditor = await stats('', tokens.auditor);
  assert.equal(auditor.statusCode, 200, auditor.body);
  assert.equal(auditor.json().categories[0].sources[0].count, null);
  const filtered = await stats(`?tenantId=${b.tenantId}`, tokens.platform, {
    'x-lse-tenant': 'all',
  });
  assert.equal(filtered.statusCode, 200, filtered.body);
  const content = filtered
    .json()
    .categories.find((c: { category: string }) => c.category === 'content');
  assert.equal(content.total, RISK_FIXTURE_EXPECTED.eval_content);
  assert.equal((await stats('?until=bad')).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/detect-results/stats' })).statusCode, 401);
});
