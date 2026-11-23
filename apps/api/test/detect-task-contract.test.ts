import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AssuranceEvidenceLevel,
  AssuranceImpactStatus,
  EvalTaskStatus,
  FleetJobStatus,
  ModelFileScanStatus,
  Prisma,
  ServiceAssuranceRunStatus,
} from '@prisma/client';
import {
  DETECT_JOB_ITEM_KINDS,
  DETECT_JOB_ITEM_META,
  DETECT_RAW_STATUS_MAP,
  DETECT_RECORD_KINDS,
  DETECT_RECORD_KIND_LABELS,
  DETECT_RECORD_READ_PERMISSIONS,
  DETECT_TASK_STATUSES,
  DETECT_TASK_STATUS_LABELS,
  PERMISSION_CODES,
  TOOL_TASK_ENTRIES,
  canReadDetectRecord,
  detectCategoryOfEvalTask,
  detectRecordHref,
  isDetectJobItemKind,
  isDetectTaskTerminal,
  normalizeDetectTaskStatus,
  type DetectRecordKind,
} from '@lse/shared';
import { prisma, prismaUnscoped } from '../src/db.js';
import { runInScope, runInTenant } from '../src/lib/tenant-context.js';
import {
  ENDPOINT_ENGINE_SQL_VALUE,
  detectStatusSql,
  evalTaskDetectCategorySql,
  evalTaskRecordKindSql,
  tenantCondition,
} from '../src/lib/detect-sql.js';
import {
  ACTIVE_CORPUS_FINDING,
  ACTIVE_EVAL_FINDING,
  OPEN_VULNERABILITY_ASSESSMENT,
} from '../src/lib/detect-risk-scope.js';
import { componentSecurityStats } from '../src/modules/dashboard/component-security.js';
import { ENDPOINT_ENGINE } from '../src/modules/endpoint-evals/service.js';

// 二期第二批第 0 步：统一任务视图的状态、记录类型、权限、跳转路径，
// 以及 B、C、F 三条线共用的原始 SQL 片段和「有效风险」条件。

const P = 'P2B0口径测试';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ENGINES = [
  'standard-output-v1',
  'autonomous-red-team',
  'gateway-assurance',
  'endpoint-agent-eval',
  'rule-judge',
];
const DIMENSIONS = [
  'comprehensive',
  'standard_output_safety',
  'redteam_attack',
  'gateway_traffic_log',
  'agent_tool_call',
  'refusal',
];
const RECORD_KINDS = Object.keys(DETECT_RECORD_KINDS) as DetectRecordKind[];

let tenantA = '';
let tenantB = '';
let targetA = '';
let targetB = '';

function subsets<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 0; mask < 1 << items.length; mask += 1) {
    out.push(items.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  return out;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

async function cleanup(): Promise<void> {
  const tenants = await prismaUnscoped.tenant.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = { tenantId: { in: ids } };
  await prismaUnscoped.vulnerabilityAssessment.deleteMany({ where });
  await prismaUnscoped.serviceAssuranceRun.deleteMany({ where });
  await prismaUnscoped.corpusScan.deleteMany({ where });
  await prismaUnscoped.evalTask.deleteMany({ where });
  await prismaUnscoped.modelTarget.deleteMany({ where });
  await prismaUnscoped.tenant.deleteMany({ where: { id: { in: ids } } });
}

async function createTarget(tenantId: string): Promise<string> {
  const target = await prismaUnscoped.modelTarget.create({
    data: {
      tenantId,
      name: `${P}对象`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'none',
      model: 'detect-contract',
    },
    select: { id: true },
  });
  return target.id;
}

before(async () => {
  await cleanup();
  tenantA = (await prismaUnscoped.tenant.create({ data: { name: `${P}A`, code: 'p2b0-detect-a' } }))
    .id;
  tenantB = (await prismaUnscoped.tenant.create({ data: { name: `${P}B`, code: 'p2b0-detect-b' } }))
    .id;
  targetA = await createTarget(tenantA);
  targetB = await createTarget(tenantB);
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test('各表原始状态都归到六种统一状态，没列到的算失败', () => {
  const raws = [
    ...Object.values(EvalTaskStatus),
    ...Object.values(ModelFileScanStatus),
    ...Object.values(ServiceAssuranceRunStatus),
    ...Object.values(FleetJobStatus),
    // 语料扫描、资产测绘、组件扫描的字符串状态
    'PENDING',
    'RUNNING',
    'COMPLETED',
    'FAILED',
  ];
  for (const raw of raws) {
    assert.ok(hasOwn(DETECT_RAW_STATUS_MAP, raw), `${raw} 没有登记`);
    assert.ok(DETECT_TASK_STATUSES.includes(normalizeDetectTaskStatus(raw)), raw);
  }
  for (const status of Object.values(DETECT_RAW_STATUS_MAP)) {
    assert.ok(DETECT_TASK_STATUSES.includes(status), status);
  }
  for (const status of DETECT_TASK_STATUSES) {
    assert.ok(DETECT_TASK_STATUS_LABELS[status], status);
    assert.equal(normalizeDetectTaskStatus(status), status);
  }
  assert.equal(normalizeDetectTaskStatus('CANCELLED'), 'CANCELED');
  assert.equal(normalizeDetectTaskStatus('PARTIAL'), 'COMPLETED');
  assert.equal(normalizeDetectTaskStatus('DELIVERED'), 'RUNNING');
  assert.equal(normalizeDetectTaskStatus('PENDING_APPROVAL'), 'PENDING');
  assert.equal(normalizeDetectTaskStatus('EXPIRED'), 'FAILED');
  assert.equal(normalizeDetectTaskStatus('whatever'), 'FAILED');
  assert.equal(normalizeDetectTaskStatus('toString'), 'FAILED', '原型链上的属性不算');
  assert.equal(isDetectTaskTerminal('COMPLETED'), true);
  assert.equal(isDetectTaskTerminal('CANCELED'), true);
  assert.equal(isDetectTaskTerminal('PAUSED'), false);
});

test('记录查看权限和子任务启动权限都是已登记的权限码', () => {
  for (const kind of RECORD_KINDS) {
    assert.ok(DETECT_RECORD_KIND_LABELS[kind], kind);
    const codes = DETECT_RECORD_READ_PERMISSIONS[kind];
    assert.ok(codes.length > 0, kind);
    for (const code of codes) assert.ok(PERMISSION_CODES.includes(code), `${kind}: ${code}`);
  }
  for (const kind of DETECT_JOB_ITEM_KINDS) {
    const codes = DETECT_JOB_ITEM_META[kind].createPermissions;
    assert.ok(codes.length > 0, kind);
    for (const code of codes) assert.ok(PERMISSION_CODES.includes(code), `${kind}: ${code}`);
  }
  assert.equal(
    canReadDetectRecord('model_file_scan', (c) => c === 'remediation:read'),
    true,
    '任一即可',
  );
  assert.equal(
    canReadDetectRecord('corpus_scan', (c) => c === 'eval_task:read'),
    false,
  );
});

test('组合任务的子任务对应工具中心入口，类别、记录类型和启动权限一致', () => {
  for (const kind of DETECT_JOB_ITEM_KINDS) {
    const meta = DETECT_JOB_ITEM_META[kind];
    assert.ok(hasOwn(TOOL_TASK_ENTRIES, meta.entry), `${kind}: ${meta.entry}`);
    const entry = TOOL_TASK_ENTRIES[meta.entry];
    assert.equal(entry.category, meta.category, kind);
    assert.equal(DETECT_RECORD_KINDS[meta.recordKind], meta.category, kind);
    const entryCodes =
      typeof entry.permission === 'string' ? [entry.permission] : [...entry.permission];
    assert.deepEqual([...meta.createPermissions].sort(), entryCodes.sort(), kind);
  }
  assert.equal(isDetectJobItemKind('fleet_posture'), true);
  assert.equal(isDetectJobItemKind('standard_run'), false);
  assert.equal(isDetectJobItemKind('toString'), false);
  assert.equal(TOOL_TASK_ENTRIES['fleet-posture'].listPath, '/fleet?tab=endpoints');
});

test('记录详情路径都是 App.tsx 里的路由，id 做了转义', () => {
  const app = readFileSync(path.join(ROOT, 'apps/web/src/App.tsx'), 'utf8');
  for (const kind of RECORD_KINDS) {
    const url = new URL(detectRecordHref(kind, 'x'), 'http://lse.test');
    const route = url.pathname.replace(/\/x$/, '/:id');
    assert.ok(app.includes(`path="${route}"`), `${kind}: ${route} 不是 App.tsx 里的路由`);
    if (route === url.pathname) {
      assert.ok([...url.searchParams.values()].includes('x'), `${kind}: id 要放进地址参数`);
    }
  }
  assert.equal(detectRecordHref('corpus_scan', 'a/b?c'), '/data/corpus-scans/a%2Fb%3Fc');
  assert.equal(detectRecordHref('model_file_scan', 'a&b'), '/inspect/model-files?scan=a%26b');
});

test('评估任务的类别、记录类型 SQL 与 detectCategoryOfEvalTask 穷举一致', async () => {
  assert.equal(ENDPOINT_ENGINE_SQL_VALUE, ENDPOINT_ENGINE);
  const combos = subsets(ENGINES).flatMap((engines) =>
    subsets(DIMENSIONS).map((dimensions) => ({ engines, dimensions })),
  );
  assert.equal(combos.length, 2048);
  const name = `${P}穷举`;
  await prismaUnscoped.evalTask.createMany({
    data: combos.map((c) => ({
      tenantId: tenantA,
      modelTargetId: targetA,
      name,
      engines: c.engines,
      dimensions: c.dimensions,
    })),
  });
  try {
    const rows = await prisma.$queryRaw<
      Array<{ engines: string[]; dimensions: string[]; c: string; k: string; s: string }>
    >`SELECT t."engines", t."dimensions",
        ${evalTaskDetectCategorySql('t')} AS c,
        ${evalTaskRecordKindSql('t')} AS k,
        ${detectStatusSql(Prisma.raw('t."status"'))} AS s
      FROM "eval_tasks" t
      WHERE t."modelTargetId" = ${targetA} AND t."name" = ${name}`;
    assert.equal(rows.length, 2048);
    for (const row of rows) {
      const label = `${row.engines.join(',')} | ${row.dimensions.join(',')}`;
      assert.equal(row.c, detectCategoryOfEvalTask(row), label);
      assert.equal(
        row.k,
        row.engines.includes(ENDPOINT_ENGINE) ? 'fleet_eval_job' : 'eval_task',
        label,
      );
      assert.equal(row.s, 'PENDING', label);
    }
  } finally {
    await prismaUnscoped.evalTask.deleteMany({ where: { modelTargetId: targetA, name } });
  }
});

test('detectStatusSql 与 normalizeDetectTaskStatus 同一张表', async () => {
  for (const raw of [...Object.keys(DETECT_RAW_STATUS_MAP), 'whatever']) {
    const [row] = await prisma.$queryRaw<Array<{ s: string }>>`
      SELECT ${detectStatusSql(Prisma.sql`${raw}`)} AS s`;
    assert.equal(row?.s, normalizeDetectTaskStatus(raw), raw);
  }
});

test('tenantCondition：租户范围内只计本租户，全部租户视角按显式租户筛选', async () => {
  const blank = { engines: [], dimensions: [] };
  await prismaUnscoped.evalTask.createMany({
    data: [
      ...[1, 2].map((i) => ({
        ...blank,
        tenantId: tenantA,
        modelTargetId: targetA,
        name: `${P}隔离A${i}`,
      })),
      ...[1, 2, 3].map((i) => ({
        ...blank,
        tenantId: tenantB,
        modelTargetId: targetB,
        name: `${P}隔离B${i}`,
      })),
    ],
  });
  const count = async (explicitTenantId?: string) => {
    const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "eval_tasks" t
      WHERE t."modelTargetId" IN (${targetA}, ${targetB})
        AND t."name" LIKE ${`${P}隔离%`}
        ${tenantCondition('t."tenantId"', explicitTenantId)}`;
    return row!.n;
  };
  assert.equal(await runInTenant(tenantA, () => count()), 2, '另一个租户的记录不计入');
  assert.equal(await runInTenant(tenantB, () => count()), 3);
  const allTenants = { tenantId: null, sharedWrite: false, allTenants: true };
  assert.equal(await runInScope(allTenants, () => count()), 5, '全部租户视角不加条件');
  assert.equal(await runInScope(allTenants, () => count(tenantB)), 3, '?tenantId= 筛选');
  assert.equal(await count(), 5, '没有租户范围（后台任务）不加条件');
});

test('有效评估风险项：首页风险回复口径再去掉判定为通过的项', async () => {
  const task = await prismaUnscoped.evalTask.create({
    data: {
      tenantId: tenantA,
      modelTargetId: targetA,
      name: `${P}风险项`,
      engines: [],
      dimensions: [],
    },
  });
  const data: Prisma.FindingCreateManyInput[] = [];
  for (const severity of [null, 'HIGH'] as const) {
    for (const reviewStatus of ['UNREVIEWED', 'FALSE_POSITIVE'] as const) {
      for (const verdict of ['PASS', 'FAIL', 'UNKNOWN'] as const) {
        data.push({
          tenantId: tenantA,
          taskId: task.id,
          engine: 'detect-contract',
          riskCategory: 'test',
          severity,
          reviewStatus,
          verdict,
        });
      }
    }
  }
  await prismaUnscoped.finding.createMany({ data });
  // 首页安全态势（dashboard/posture.ts 的 ACTIVE_FINDING）：有严重度、没被判为误报。
  const homepage = await prisma.finding.count({
    where: { taskId: task.id, severity: { not: null }, reviewStatus: { not: 'FALSE_POSITIVE' } },
  });
  const active = await prisma.finding.count({ where: { taskId: task.id, ...ACTIVE_EVAL_FINDING } });
  assert.equal(homepage, 3);
  assert.equal(active, 2, '少的是判定为通过的那一条（终端体检通过项）');
});

test('有效语料命中：裁判没复核（空）的也算，判为误报的不算', async () => {
  const scan = await prismaUnscoped.corpusScan.create({
    data: {
      tenantId: tenantA,
      fileName: 'contract.jsonl',
      storageKey: `${P}-${randomUUID()}`,
      bytes: BigInt(0),
      sha256: '0'.repeat(64),
    },
  });
  const verdicts = [null, 'CONFIRMED', 'DISMISSED', 'ERROR'];
  await prismaUnscoped.corpusFinding.createMany({
    data: verdicts.map((judgeVerdict, i) => ({
      tenantId: tenantA,
      scanId: scan.id,
      recordIndex: i + 1,
      line: i + 1,
      fieldPath: 'text',
      category: 'sensitive',
      subtype: 'phone',
      matchText: '13800000000',
      severity: 'HIGH',
      judgeVerdict,
    })),
  });
  const active = await prisma.corpusFinding.count({
    where: { scanId: scan.id, ...ACTIVE_CORPUS_FINDING },
  });
  assert.equal(active, 3);
});

test('服务核验的漏洞和基线问题与首页「AI 应用组件安全」卡片同口径', async () => {
  const run = await prismaUnscoped.serviceAssuranceRun.create({
    data: {
      tenantId: tenantB,
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      targetName: `${P}服务`,
      scopePolicyRef: 'default',
      requestBudget: {},
    },
  });
  const data: Prisma.VulnerabilityAssessmentCreateManyInput[] = [];
  for (const advisoryId of [null, 'CVE-2026-0001']) {
    for (const evidenceLevel of Object.values(AssuranceEvidenceLevel)) {
      for (const impactStatus of Object.values(AssuranceImpactStatus)) {
        data.push({
          tenantId: tenantB,
          runId: run.id,
          advisoryId,
          evidenceLevel,
          impactStatus,
          title: '口径测试',
          reason: '口径测试',
          assessmentKey: `k${data.length}`,
        });
      }
    }
  }
  await prismaUnscoped.vulnerabilityAssessment.createMany({ data });
  const { card, open } = await runInTenant(tenantB, async () => ({
    card: await componentSecurityStats(),
    open: await prisma.vulnerabilityAssessment.count({ where: OPEN_VULNERABILITY_ASSESSMENT }),
  }));
  // 受影响、待核验 2 种 ×（有漏洞编号的 4 种证据等级 + 没编号的配置匹配 1 种）
  assert.equal(open, 10);
  assert.equal(card.vulnerabilityCount + card.baselineIssueCount, open);
});
