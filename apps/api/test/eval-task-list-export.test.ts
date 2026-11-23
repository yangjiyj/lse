// 2.5.4 跨任务导出：GET /api/eval-tasks/export?format=csv|json，筛选与任务列表相同。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import {
  adminToken,
  bearer,
  cleanupFixtures,
  csvRows,
  limitedUserToken,
  tenantAdmin,
} from './helpers/w4-fixtures.js';

const P = 'w4taskexp_';
const HEADER = [
  '任务名',
  '租户',
  '评估对象',
  '状态',
  '创建人',
  '创建时间',
  '完成时间',
  '题数',
  '高风险数',
  '中风险数',
  '低风险数',
];
let app!: FastifyInstance;
let admin = '';
let platformName = '';
let targetA = '';
let tenant = { tenantId: '', token: '' };

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: P } } });
  await cleanupFixtures(P);
}

async function createTarget(name: string, tenantId?: string): Promise<string> {
  const t = await prisma.modelTarget.create({
    data: {
      ...(tenantId ? { tenantId } : {}),
      name,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-dummy',
      model: 'fake-model',
    },
  });
  return t.id;
}

const exportUrl = (query: string) => `/api/eval-tasks/export?${query}`;

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  admin = await adminToken(app);
  platformName = (await prisma.tenant.findUniqueOrThrow({ where: { id: PLATFORM_TENANT_ID } }))
    .name;
  const adminUser = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });

  targetA = await createTarget(`${P}对象甲`);
  const targetB = await createTarget(`${P}对象乙`);
  const done = await prisma.evalTask.create({
    data: {
      name: `${P}已完成任务`,
      status: 'COMPLETED',
      engines: [],
      dimensions: [],
      totalQuestions: 10,
      modelTargetId: targetA,
      createdById: adminUser.id,
      createdAt: new Date('2026-11-01T02:00:00Z'),
      finishedAt: new Date('2026-11-01T03:30:00Z'),
    },
  });
  await prisma.finding.createMany({
    data: (['CRITICAL', 'HIGH', 'MEDIUM'] as const).map((severity) => ({
      tenantId: PLATFORM_TENANT_ID,
      taskId: done.id,
      engine: 'rule-judge',
      riskCategory: 'test',
      verdict: 'FAIL' as const,
      severity,
    })),
  });
  await prisma.evalTask.create({
    data: {
      name: `${P}排队任务`,
      engines: [],
      dimensions: [],
      totalQuestions: 5,
      modelTargetId: targetB,
    },
  });

  tenant = await tenantAdmin(app, admin, `${P}t_`);
  const tenantTarget = await createTarget(`${P}租户对象`, tenant.tenantId);
  await prisma.evalTask.create({
    data: {
      tenantId: tenant.tenantId,
      name: `${P}租户任务`,
      engines: [],
      dimensions: [],
      totalQuestions: 3,
      modelTargetId: tenantTarget,
    },
  });
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('CSV 导出：带 BOM、作为附件，每行是任务名、租户、评估对象、状态、创建人、时间、题数和按等级的风险数', async () => {
  const res = await app.inject({
    method: 'GET',
    url: exportUrl(`format=csv&keyword=${P}`),
    headers: bearer(admin),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['content-type']), /^text\/csv/);
  assert.match(String(res.headers['content-disposition']), /^attachment;/);
  assert.equal(res.rawPayload.subarray(0, 3).toString('hex'), 'efbbbf');
  const rows = csvRows(res.body);
  assert.deepEqual(rows[0], HEADER);
  assert.equal(rows.length, 3, '默认视角只导出本租户的任务');
  const done = rows.find((r) => r[0] === `${P}已完成任务`);
  assert.deepEqual(done, [
    `${P}已完成任务`,
    platformName,
    `${P}对象甲`,
    '已完成',
    '超级管理员',
    '2026-11-01 10:00:00',
    '2026-11-01 11:30:00',
    '10',
    '2',
    '1',
    '0',
  ]);
  const queued = rows.find((r) => r[0] === `${P}排队任务`);
  assert.equal(queued?.[3], '排队中');
  assert.equal(queued?.[6], '');
});

test('筛选与任务列表相同：状态、评估对象', async () => {
  const byStatus = await app.inject({
    method: 'GET',
    url: exportUrl(`format=json&keyword=${P}&status=COMPLETED`),
    headers: bearer(admin),
  });
  assert.equal(byStatus.statusCode, 200, byStatus.body);
  assert.deepEqual(
    (byStatus.json() as Array<{ name: string }>).map((t) => t.name),
    [`${P}已完成任务`],
  );
  const byTarget = await app.inject({
    method: 'GET',
    url: exportUrl(`format=json&keyword=${P}&modelTargetId=${targetA}`),
    headers: bearer(admin),
  });
  assert.deepEqual(
    (byTarget.json() as Array<{ name: string }>).map((t) => t.name),
    [`${P}已完成任务`],
  );
});

test('JSON 导出字段完整，并记审计 eval_task.list_export', async () => {
  const res = await app.inject({
    method: 'GET',
    url: exportUrl(`format=json&keyword=${P}&status=COMPLETED`),
    headers: bearer(admin),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['content-type']), /^application\/json/);
  assert.match(String(res.headers['content-disposition']), /^attachment;/);
  const [item] = res.json() as Array<Record<string, unknown>>;
  assert.deepEqual(item, {
    id: item!.id,
    name: `${P}已完成任务`,
    tenantId: PLATFORM_TENANT_ID,
    tenantName: platformName,
    modelTargetName: `${P}对象甲`,
    status: 'COMPLETED',
    createdBy: '超级管理员',
    createdAt: '2026-11-01T02:00:00.000Z',
    finishedAt: '2026-11-01T03:30:00.000Z',
    totalQuestions: 10,
    riskLevels: { HIGH: 2, MEDIUM: 1, LOW: 0 },
  });
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'eval_task.list_export' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(audit, '应写审计 eval_task.list_export');
  const detail = audit!.detail as Record<string, unknown>;
  assert.equal(detail.format, 'json');
  assert.equal(detail.count, 1);
  assert.equal((detail.filters as Record<string, unknown>).status, 'COMPLETED');
});

test('平台管理员在「全部租户」视角下导出所有租户的任务，也可按租户筛选', async () => {
  const all = await app.inject({
    method: 'GET',
    url: exportUrl(`format=csv&keyword=${P}`),
    headers: bearer(admin, 'all'),
  });
  assert.equal(all.statusCode, 200, all.body);
  const rows = csvRows(all.body).slice(1);
  assert.equal(rows.length, 3);
  const tenantRow = rows.find((r) => r[0] === `${P}租户任务`);
  assert.equal(tenantRow?.[1], `${P}t_tenant`);

  const one = await app.inject({
    method: 'GET',
    url: exportUrl(`format=json&keyword=${P}&tenantId=${tenant.tenantId}`),
    headers: bearer(admin, 'all'),
  });
  assert.deepEqual(
    (one.json() as Array<{ name: string }>).map((t) => t.name),
    [`${P}租户任务`],
  );
});

test('租户管理员只导出本租户的任务', async () => {
  const res = await app.inject({
    method: 'GET',
    url: exportUrl(`format=json&keyword=${P}`),
    headers: bearer(tenant.token),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    (res.json() as Array<{ name: string }>).map((t) => t.name),
    [`${P}租户任务`],
  );
});

test('跨任务导出审计记 IP 和 UA，操作日志按「下载」能查到', async () => {
  const res = await app.inject({
    method: 'GET',
    url: exportUrl(`format=csv&keyword=${P}`),
    headers: { ...bearer(admin), 'user-agent': 'w4-list-export-agent' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const list = await app.inject({
    method: 'GET',
    url: '/api/audit-logs?category=download&action=eval_task.list_export&pageSize=20',
    headers: bearer(admin),
  });
  assert.equal(list.statusCode, 200, list.body);
  const item = (list.json().items as Array<{ ip: string | null; userAgent: string | null }>).find(
    (i) => i.userAgent === 'w4-list-export-agent',
  );
  assert.ok(item, '按「下载」筛选应能查到 eval_task.list_export');
  assert.ok(item!.ip);
});

test('format 只接受 csv 和 json', async () => {
  const res = await app.inject({
    method: 'GET',
    url: exportUrl('format=xlsx'),
    headers: bearer(admin),
  });
  assert.equal(res.statusCode, 400, res.body);
  const issues = res.json().error.issues as Array<{ path: string[] }>;
  assert.deepEqual(
    issues.map((i) => i.path.join('.')),
    ['format'],
  );
});

test('没有查看任务权限返回 403', async () => {
  const token = await limitedUserToken(app, `${P}noread_`, ['report:read']);
  const res = await app.inject({
    method: 'GET',
    url: exportUrl('format=csv'),
    headers: bearer(token),
  });
  assert.equal(res.statusCode, 403, res.body);
});
