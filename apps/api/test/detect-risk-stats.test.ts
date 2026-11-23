import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSION_CODES } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { runInScope, runInTenant } from '../src/lib/tenant-context.js';
import { buildPosture } from '../src/modules/dashboard/posture.js';
import { componentSecurityStats } from '../src/modules/dashboard/component-security.js';
import {
  RISK_SOURCES,
  RISK_SOURCES_BY_CATEGORY,
  RISK_SOURCE_PERMISSIONS,
  type RiskSourceKey,
} from '../src/modules/detect-risks/sources.js';
import {
  MAX_DISCOVERY_RUNS,
  RiskCounter,
  countRiskSource,
  detectRiskStats,
  unregisteredServices,
  type RiskWindow,
} from '../src/modules/detect-risks/stats.js';
import { listRiskResults } from '../src/modules/detect-risks/results.js';
import {
  RISK_FIXTURE_EXPECTED,
  RISK_FIXTURE_SERVICE,
  cleanupDetectRiskTenants,
  seedDetectRiskFixture,
  type DetectRiskFixture,
} from './helpers/detect-risk-fixtures.js';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';

// F-1 四类风险口径（2.2.2、2.5.3）：各来源计数、与现有页面一致、时间窗口、范围、权限、租户。

const P = 'F线风险口径统计';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ADMIN = '__p2bf_stats_admin';
const PASSWORD = ['Risk', 'Stats', '12345'].join('@');
const ALL: RiskWindow = { since: null, until: null };
const SOURCES = Object.keys(RISK_SOURCES) as RiskSourceKey[];
const allowAll = (code: string) => PERMISSION_CODES.includes(code);

let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
let a!: DetectRiskFixture;
let b!: DetectRiskFixture;

async function cleanup(): Promise<void> {
  const tenants = await prismaUnscoped.tenant.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  await cleanupDetectRiskTenants(tenants.map((t) => t.id));
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const admin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: ['Admin', '@', '12345'].join('') },
  });
  assert.equal(admin.statusCode, 200, admin.body);
  const created = await app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: { authorization: `Bearer ${admin.json().token}` },
    payload: { name: `${P}A`, admin: { username: ADMIN, password: PASSWORD } },
  });
  assert.equal(created.statusCode, 201, created.body);
  await skipFirstPasswordChange(ADMIN);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: ADMIN, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
  a = await seedDetectRiskFixture(created.json().id, 'F1甲');
  const tenantB = await prismaUnscoped.tenant.create({
    data: { name: `${P}B`, code: `p2bf-stats-b-${Date.now()}` },
  });
  b = await seedDetectRiskFixture(tenantB.id, 'F1乙');
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

// Prisma 查询是惰性的，到 await 时才读租户上下文：回调里必须 await，不能直接返回查询。
const inA = <T>(fn: () => Promise<T>) => runInTenant(a.tenantId, async () => await fn());

test('来源定义：每个来源属于一个类别，类别下的来源列表与定义一致', () => {
  for (const source of SOURCES) {
    const def = RISK_SOURCES[source];
    assert.ok(def.label, source);
    assert.ok(RISK_SOURCES_BY_CATEGORY[def.category].includes(source), source);
    for (const code of def.permissions) assert.ok(PERMISSION_CODES.includes(code), code);
  }
  assert.deepEqual(RISK_SOURCES_BY_CATEGORY.model, ['model_file']);
  assert.deepEqual(RISK_SOURCES_BY_CATEGORY.data, ['corpus']);
  assert.deepEqual(RISK_SOURCES_BY_CATEGORY.content, ['eval_content']);
  assert.deepEqual(RISK_SOURCES_BY_CATEGORY.app_env, [
    'eval_app',
    'service_assurance',
    'ai_component',
    'asset_discovery',
  ]);
});

test('各来源计数：扣掉误报、通过项、裁判判为误报的命中、已不受影响的研判，测绘跨次去重', async () => {
  for (const source of SOURCES) {
    const count = await inA(() => countRiskSource(source, ALL));
    assert.equal(count.total, RISK_FIXTURE_EXPECTED[source], source);
    const sum = Object.values(count.bySeverity).reduce((s, n) => s + n, 0);
    assert.equal(sum, count.total, `${source} 严重度合计`);
    assert.equal(count.high, count.bySeverity.CRITICAL + count.bySeverity.HIGH, source);
  }
  const content = await inA(() => countRiskSource('eval_content', ALL));
  assert.deepEqual(content.bySeverity, {
    CRITICAL: 1,
    HIGH: 0,
    MEDIUM: 1,
    LOW: 0,
    INFO: 0,
    UNRATED: 0,
  });
  const service = await inA(() => countRiskSource('service_assurance', ALL));
  assert.equal(service.bySeverity.UNRATED, 1, '研判没有严重度的记为未定级');
  const discovery = await inA(() => countRiskSource('asset_discovery', ALL));
  assert.equal(discovery.bySeverity.HIGH, 1, '未登记 AI 服务记为高危');
});

test('与安全态势卡：内容 + 应用与环境（评估类）= 风险回复数减去终端体检通过项', async () => {
  const posture = await inA(() => buildPosture('all', new Date()));
  const pass = await inA(() =>
    prisma.finding.count({
      where: { severity: { not: null }, reviewStatus: { not: 'FALSE_POSITIVE' }, verdict: 'PASS' },
    }),
  );
  assert.equal(pass, 1);
  const content = await inA(() => countRiskSource('eval_content', ALL));
  const appEval = await inA(() => countRiskSource('eval_app', ALL));
  assert.equal(content.total + appEval.total, posture.facts.activeFindingTotal - pass);
});

test('与组件安全卡：服务核验 = 漏洞数 + 基线问题数', async () => {
  const card = await inA(() => componentSecurityStats());
  const service = await inA(() => countRiskSource('service_assurance', ALL));
  assert.equal(service.total, card.vulnerabilityCount + card.baselineIssueCount);
});

test('与模型文件扫描页：各扫描发现总数之和减去误报', async () => {
  const scans = await inA(() => prisma.modelFileScan.findMany({ select: { id: true } }));
  let pageTotal = 0;
  let falsePositive = 0;
  for (const scan of scans) {
    const res = await app.inject({
      url: `/api/model-files/scans/${scan.id}/findings`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    pageTotal += res.json().total as number;
    falsePositive += await prismaUnscoped.modelFileFinding.count({
      where: { scanId: scan.id, reviewStatus: 'FALSE_POSITIVE' },
    });
  }
  const count = await inA(() => countRiskSource('model_file', ALL));
  assert.equal(count.total, pageTotal - falsePositive);
});

test('时间窗口：内容任务的创建时间早于窗口后不再计入', async () => {
  const window: RiskWindow = { since: new Date(Date.now() - 3600_000), until: null };
  assert.equal((await inA(() => countRiskSource('eval_content', window))).total, 2);
  const original = await prismaUnscoped.evalTask.findUniqueOrThrow({
    where: { id: a.tasks.content },
    select: { createdAt: true },
  });
  await prismaUnscoped.evalTask.update({
    where: { id: a.tasks.content },
    data: { createdAt: new Date(Date.now() - 2 * 3600_000) },
  });
  try {
    assert.equal((await inA(() => countRiskSource('eval_content', window))).total, 0);
    assert.equal((await inA(() => countRiskSource('eval_content', ALL))).total, 2);
    const upper: RiskWindow = { since: null, until: new Date(Date.now() - 3600_000) };
    assert.equal((await inA(() => countRiskSource('eval_content', upper))).total, 2, '上界');
    assert.equal((await inA(() => countRiskSource('eval_app', upper))).total, 0);
  } finally {
    await prismaUnscoped.evalTask.update({
      where: { id: a.tasks.content },
      data: { createdAt: original.createdAt },
    });
  }
});

test('范围：只含智能体任务的评估对象时，内容为 0、应用与环境（评估类）只计智能体的', async () => {
  const scope = { modelTargetIds: [a.targets.agent] };
  assert.equal((await inA(() => countRiskSource('eval_app', ALL, scope))).total, 2);
  assert.equal((await inA(() => countRiskSource('eval_content', ALL, scope))).total, 0);
  // 范围里没有该来源能用的字段时一条不计
  assert.equal((await inA(() => countRiskSource('corpus', ALL, scope))).total, 0);
  assert.equal(
    (await inA(() => countRiskSource('eval_content', ALL, { evalTaskIds: [a.tasks.content] })))
      .total,
    2,
  );
  assert.equal(
    (await inA(() => countRiskSource('corpus', ALL, { corpusScanIds: [a.corpusScanId] }))).total,
    3,
  );
  assert.equal(
    (
      await inA(() =>
        countRiskSource('ai_component', ALL, { aiComponentAssetKeys: [a.aiAssetKey] }),
      )
    ).total,
    1,
  );
  assert.equal(
    (await inA(() => countRiskSource('asset_discovery', ALL, { hosts: ['10.98.7.6'] }))).total,
    1,
  );
  assert.equal(
    (await inA(() => countRiskSource('asset_discovery', ALL, { hosts: ['10.0.0.1'] }))).total,
    0,
  );
});

test('权限：看不到模型文件扫描时该来源为 null，模型安全合计为 0', async () => {
  const has = (code: string) => code !== 'engine:scan' && code !== 'remediation:read';
  const stats = await inA(() => detectRiskStats(has, new RiskCounter(ALL)));
  const model = stats.categories.find((c) => c.category === 'model')!;
  assert.equal(model.total, 0);
  assert.equal(model.high, 0);
  assert.deepEqual(
    model.sources.map((s) => [s.source, s.count]),
    [['model_file', null]],
  );
  // 组件扫描（engine:scan 或 eval_task:read）仍可见
  const appEnv = stats.categories.find((c) => c.category === 'app_env')!;
  assert.ok(appEnv.sources.find((s) => s.source === 'ai_component')!.count);
});

test('四类合计：顺序为模型、数据、内容、应用与环境，合计等于各可见来源之和', async () => {
  const stats = await inA(() => detectRiskStats(allowAll, new RiskCounter(ALL)));
  assert.deepEqual(
    stats.categories.map((c) => c.category),
    ['model', 'data', 'content', 'app_env'],
  );
  const byCategory = Object.fromEntries(stats.categories.map((c) => [c.category, c]));
  assert.equal(byCategory.model!.total, 2);
  assert.equal(byCategory.data!.total, 3);
  assert.equal(byCategory.content!.total, 2);
  assert.equal(byCategory.app_env!.total, 4 + 2 + 1 + 1);
  assert.equal(byCategory.content!.high, 1);
  assert.equal(byCategory.model!.label, '模型安全');
  assert.equal(byCategory.app_env!.sources[0]!.label, RISK_SOURCES.eval_app.label);
  assert.equal(stats.truncatedCorpusScans, 0);
});

test('租户：另一个租户的同样数据不计入，全部租户视角可按租户筛选', async () => {
  for (const source of SOURCES) {
    const count = await runInTenant(b.tenantId, () => countRiskSource(source, ALL));
    assert.equal(count.total, RISK_FIXTURE_EXPECTED[source], `乙租户 ${source}`);
  }
  const allTenants = { tenantId: null, sharedWrite: false, allTenants: true };
  for (const source of SOURCES) {
    const count = await runInScope(allTenants, () =>
      countRiskSource(source, ALL, undefined, b.tenantId),
    );
    assert.equal(count.total, RISK_FIXTURE_EXPECTED[source], `全部租户视角筛乙 ${source}`);
  }
  const whole = await runInScope(allTenants, () => countRiskSource('eval_content', ALL));
  assert.ok(whole.total >= 4, '全部租户视角不按租户过滤');
});

test('语料命中过多的扫描：truncatedCorpusScans 计数，没有语料权限时为 0', async () => {
  await prismaUnscoped.corpusScan.update({
    where: { id: a.corpusScanId },
    data: { truncated: true },
  });
  try {
    const stats = await inA(() => detectRiskStats(allowAll, new RiskCounter(ALL)));
    assert.equal(stats.truncatedCorpusScans, 1);
    const noCorpus = await inA(() =>
      detectRiskStats((code) => code !== 'corpus_scan:read', new RiskCounter(ALL)),
    );
    assert.equal(noCorpus.truncatedCorpusScans, 0);
  } finally {
    await prismaUnscoped.corpusScan.update({
      where: { id: a.corpusScanId },
      data: { truncated: false },
    });
  }
});

test('前端的风险来源权限清单与 RISK_SOURCE_PERMISSIONS 一致', () => {
  const text = readFileSync(path.join(ROOT, 'apps/web/src/lib/detect-risks.ts'), 'utf8');
  const block = /DETECT_RISK_PERMISSIONS = \[([^\]]*)\]/.exec(text)?.[1];
  assert.ok(block, 'apps/web/src/lib/detect-risks.ts 里要有 DETECT_RISK_PERMISSIONS');
  const codes = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  assert.deepEqual([...codes].sort(), [...RISK_SOURCE_PERMISSIONS].sort());
});

test('未登记 AI 服务一次请求只查一次，计数和取页共用这一次的结果', async () => {
  const counter = new RiskCounter(ALL);
  // 查询要在租户范围里发起：第一次调用放进 inA。
  const [first, second] = await inA(async () => [counter.unregistered(), counter.unregistered()]);
  assert.equal(first, second, '同一个查询');
  assert.equal((await inA(() => counter.count('asset_discovery'))).total, 1);
  const extra = await prismaUnscoped.assetDiscoveryRun.create({
    data: {
      tenantId: a.tenantId,
      status: 'COMPLETED',
      targets: ['10.98.7.9'],
      ports: [8000],
      hostCount: 1,
      portCount: 1,
      hits: {
        create: {
          host: '10.98.7.9',
          port: 8000,
          baseUrl: 'http://10.98.7.9:8000',
          serviceType: 'vllm',
          models: ['qwen3:32b'],
          evidence: '/v1/models',
        },
      },
    },
  });
  try {
    const page = await inA(() =>
      listRiskResults('asset_discovery', { page: 1, pageSize: 20 }, counter),
    );
    assert.equal(page.total, 1, '取页用的是计数那一次的结果');
    assert.equal(page.items.length, 1);
    assert.equal(
      (await inA(() => countRiskSource('asset_discovery', ALL))).total,
      2,
      '新请求才看到',
    );
  } finally {
    await prismaUnscoped.assetDiscoveryRun.delete({ where: { id: extra.id } });
  }
});

test('评估类取页复用已算好的分档计数，不再重算', async () => {
  const counter = new RiskCounter(ALL);
  assert.equal((await inA(() => counter.count('eval_content'))).total, 2);
  const added = await prismaUnscoped.finding.create({
    data: {
      tenantId: a.tenantId,
      taskId: a.tasks.content,
      engine: 'rule-judge',
      riskCategory: 'jailbreak',
      severity: 'LOW',
      verdict: 'FAIL',
      title: '后加的风险项',
    },
  });
  try {
    const page = await inA(() =>
      listRiskResults('eval_content', { page: 1, pageSize: 20 }, counter),
    );
    assert.equal(page.total, 2);
    assert.ok(page.items.every((r) => r.id !== added.id));
    assert.equal((await inA(() => countRiskSource('eval_content', ALL))).total, 3);
  } finally {
    await prismaUnscoped.finding.delete({ where: { id: added.id } });
  }
});

test(`资产测绘只看窗口内最近 ${MAX_DISCOVERY_RUNS} 次已完成的，超出时返回截断标记`, async () => {
  const old = new Date(Date.now() - 24 * 3600_000);
  await prismaUnscoped.assetDiscoveryRun.createMany({
    data: Array.from({ length: MAX_DISCOVERY_RUNS }, () => ({
      tenantId: a.tenantId,
      status: 'COMPLETED',
      targets: ['10.98.8.0/24'],
      ports: [11434],
      hostCount: 256,
      portCount: 1,
      createdAt: old,
    })),
  });
  try {
    const all = await inA(() => unregisteredServices(ALL));
    assert.equal(all.truncated, true);
    assert.equal(all.services.length, 1, '最近的两次测绘仍在范围内');
    const stats = await inA(() => detectRiskStats(allowAll, new RiskCounter(ALL)));
    assert.equal(stats.discoveryRunsTruncated, true);
    const noDiscovery = await inA(() =>
      detectRiskStats(
        (code) => code !== 'engine:scan' && code !== 'platform_setting:read',
        new RiskCounter(ALL),
      ),
    );
    assert.equal(noDiscovery.discoveryRunsTruncated, false, '看不到资产测绘时不提示');
    const recent = { since: new Date(Date.now() - 3600_000), until: null };
    assert.equal((await inA(() => unregisteredServices(recent))).truncated, false);
  } finally {
    await prismaUnscoped.assetDiscoveryRun.deleteMany({
      where: { tenantId: a.tenantId, createdAt: old },
    });
  }
  assert.equal(
    (await inA(() => detectRiskStats(allowAll, new RiskCounter(ALL)))).discoveryRunsTruncated,
    false,
  );
});

test('有范围时测绘在库里按范围预筛：范围外较新的测绘不挤掉范围内的命中，也不标截断', async () => {
  const marker = '10.98.9.0/24';
  await prismaUnscoped.assetDiscoveryRun.createMany({
    data: Array.from({ length: MAX_DISCOVERY_RUNS }, () => ({
      tenantId: a.tenantId,
      status: 'COMPLETED',
      targets: [marker],
      ports: [8000],
      hostCount: 1,
      portCount: 1,
      createdAt: new Date(Date.now() + 60_000),
    })),
  });
  try {
    const whole = await inA(() => unregisteredServices(ALL));
    assert.equal(whole.truncated, true);
    assert.equal(whole.services.length, 0, '不带范围时夹具的两次测绘被较新的 500 次挤掉');
    const scopes = [
      { hosts: ['10.98.7.6'] },
      { origins: [RISK_FIXTURE_SERVICE] },
      { assetDiscoveryRunIds: [a.discoveryRunIds[0]] },
    ];
    for (const scope of scopes) {
      const scoped = await inA(() => unregisteredServices(ALL, scope));
      assert.equal(scoped.truncated, false, JSON.stringify(scope));
      assert.equal(scoped.services.length, 1, JSON.stringify(scope));
    }
    const other = await inA(() => unregisteredServices(ALL, { hosts: ['10.0.0.1'] }));
    assert.deepEqual(other, { services: [], truncated: false });
    const noField = await inA(() =>
      unregisteredServices(ALL, { modelTargetIds: [a.targets.agent] }),
    );
    assert.deepEqual(noField, { services: [], truncated: false }, '范围里没有测绘能用的字段');
  } finally {
    await prismaUnscoped.assetDiscoveryRun.deleteMany({
      where: { tenantId: a.tenantId, targets: { has: marker } },
    });
  }
});
