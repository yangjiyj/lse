// 2.4.6 / 1.3.7 任务日志导出：GET /api/eval-tasks/:id/logs/export?format=csv|json
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { LOG_EXPORT_BATCH, forEachLogBatch } from '../src/modules/eval-tasks/log-export.js';
import {
  adminToken,
  bearer,
  cleanupFixtures,
  csvRows,
  limitedUserToken,
  tenantAdmin,
} from './helpers/w4-fixtures.js';

const P = 'w4logexp_';
let app!: FastifyInstance;
let admin = '';
let taskId = '';

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: P } } });
  await cleanupFixtures(P);
}

const exportUrl = (id: string, format: string) =>
  `/api/eval-tasks/${id}/logs/export?format=${format}`;

/** 操作日志按「下载」分类筛选，找这次导出的审计（带 IP 和 UA）。 */
async function findDownloadAudit(action: string, userAgent: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/audit-logs?category=download&action=${action}&pageSize=20`,
    headers: bearer(admin),
  });
  assert.equal(res.statusCode, 200, res.body);
  return (
    res.json().items as Array<{ action: string; ip: string | null; userAgent: string | null }>
  ).find((i) => i.userAgent === userAgent);
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  admin = await adminToken(app);
  const target = await prisma.modelTarget.create({
    data: {
      name: `${P}target`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-dummy',
      model: 'fake-model',
    },
  });
  const task = await prisma.evalTask.create({
    data: { name: `${P}task`, engines: [], dimensions: [], modelTargetId: target.id },
  });
  taskId = task.id;
  const base = Date.now() - 3_600_000;
  // 超过日志接口单页上限（500），确认导出的是全部日志。
  await prisma.evalTaskLog.createMany({
    data: Array.from({ length: 600 }, (_, i) => ({
      taskId,
      level: i === 1 ? 'error' : 'info',
      message: i === 0 ? '含逗号, 和"引号"的日志' : `第 ${i} 条`,
      context: i === 0 ? { step: 1 } : undefined,
      createdAt: new Date(base + i * 1000),
    })),
  });
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('CSV 导出全部日志：带 BOM、作为附件、按时间正序', async () => {
  const res = await app.inject({
    method: 'GET',
    url: exportUrl(taskId, 'csv'),
    headers: bearer(admin),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['content-type']), /^text\/csv/);
  assert.match(String(res.headers['content-disposition']), /^attachment;/);
  assert.equal(res.rawPayload.subarray(0, 3).toString('hex'), 'efbbbf');
  const rows = csvRows(res.body);
  assert.deepEqual(rows[0], ['时间', '级别', '内容', '上下文']);
  assert.equal(rows.length, 601);
  assert.equal(rows[1]![2], '含逗号, 和"引号"的日志');
  assert.equal(rows[1]![3], '{"step":1}');
  assert.equal(rows[2]![1], '错误');
  assert.equal(rows[1]![1], '信息');
  assert.equal(rows[600]![2], '第 599 条');
});

test('JSON 导出全部日志，并记审计 eval_task.log_export', async () => {
  const res = await app.inject({
    method: 'GET',
    url: exportUrl(taskId, 'json'),
    headers: bearer(admin),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['content-type']), /^application\/json/);
  assert.match(String(res.headers['content-disposition']), /^attachment;/);
  const items = JSON.parse(res.body) as Array<Record<string, unknown>>;
  assert.equal(items.length, 600);
  assert.deepEqual(Object.keys(items[0]!).sort(), ['context', 'createdAt', 'level', 'message']);
  assert.deepEqual(items[0]!.context, { step: 1 });
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'eval_task.log_export', targetId: taskId },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(audit, '应写审计 eval_task.log_export');
  assert.equal((audit!.detail as Record<string, unknown>).count, 600);
});

test('按每批 2000 行分批读库，跨批次不丢不重（同一时刻的日志按 ID 接续）', async () => {
  const task = await prisma.evalTask.create({
    data: {
      name: `${P}分批`,
      engines: [],
      dimensions: [],
      modelTargetId: (await prisma.evalTask.findUniqueOrThrow({ where: { id: taskId } }))
        .modelTargetId,
    },
  });
  const at = new Date(Date.now() - 7_200_000);
  // 4500 条：前 2500 条同一时刻，批次边界落在同一时刻的日志中间。
  await prisma.evalTaskLog.createMany({
    data: Array.from({ length: 4500 }, (_, i) => ({
      taskId: task.id,
      message: `分批 ${String(i).padStart(4, '0')}`,
      context: { i },
      createdAt: i < 2500 ? at : new Date(at.getTime() + i),
    })),
  });
  {
    for (const format of ['csv', 'json'] as const) {
      const res = await app.inject({
        method: 'GET',
        url: exportUrl(task.id, format),
        headers: bearer(admin),
      });
      assert.equal(res.statusCode, 200, res.body);
      const messages =
        format === 'csv'
          ? csvRows(res.body)
              .slice(1)
              .map((r) => r[2])
          : (JSON.parse(res.body) as Array<{ message: string }>).map((l) => l.message);
      assert.equal(messages.length, 4500);
      assert.equal(new Set(messages).size, 4500);
      assert.deepEqual(
        messages.slice(2500),
        Array.from({ length: 2000 }, (_, i) => `分批 ${2500 + i}`),
      );
    }
  }
});

test('分批读：每批 2000 行，按 (时间, ID) 游标接续，处理完一批再读下一批', async () => {
  assert.equal(LOG_EXPORT_BATCH, 2000);
  const at = new Date('2026-11-01T00:00:00Z');
  const rows = Array.from({ length: 4500 }, (_, i) => ({
    id: `id-${String(i).padStart(5, '0')}`,
    createdAt: at,
    level: 'info',
    message: `m${i}`,
    context: null,
  }));
  const calls: Array<{ take: number; skip?: number; cursor?: { id: string } }> = [];
  const fakeDb = {
    evalTaskLog: {
      findMany: async (args: { take: number; skip?: number; cursor?: { id: string } }) => {
        calls.push(args);
        const start = args.cursor
          ? rows.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0)
          : 0;
        return rows.slice(start, start + args.take);
      },
    },
  };
  const batches: number[] = [];
  const seen: string[] = [];
  const total = await forEachLogBatch(fakeDb as never, 'task-1', (batch) => {
    batches.push(batch.length);
    seen.push(...batch.map((r) => r.id));
  });
  assert.equal(total, 4500);
  assert.deepEqual(batches, [2000, 2000, 500]);
  assert.deepEqual(
    calls.map((c) => c.take),
    [2000, 2000, 2000],
  );
  assert.deepEqual(calls[1]!.cursor, { id: 'id-01999' });
  assert.deepEqual(
    seen,
    rows.map((r) => r.id),
  );
});

test('日志导出审计记 IP 和 UA，操作日志按「下载」能查到', async () => {
  const res = await app.inject({
    method: 'GET',
    url: exportUrl(taskId, 'csv'),
    headers: { ...bearer(admin), 'user-agent': 'w4-log-export-agent' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const item = await findDownloadAudit('eval_task.log_export', 'w4-log-export-agent');
  assert.ok(item, '按「下载」筛选应能查到 eval_task.log_export');
  assert.ok(item!.ip);
});

test('format 只接受 csv 和 json', async () => {
  const res = await app.inject({
    method: 'GET',
    url: exportUrl(taskId, 'xml'),
    headers: bearer(admin),
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('没有「查看任务日志」权限返回 403', async () => {
  const token = await limitedUserToken(app, `${P}reader_`, ['eval_task:read']);
  const res = await app.inject({
    method: 'GET',
    url: exportUrl(taskId, 'csv'),
    headers: bearer(token),
  });
  assert.equal(res.statusCode, 403, res.body);
});

test('其他租户的任务返回 404', async () => {
  const other = await tenantAdmin(app, admin, `${P}t_`);
  const res = await app.inject({
    method: 'GET',
    url: exportUrl(taskId, 'csv'),
    headers: bearer(other.token),
  });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().error.message, '评估任务不存在');
});

test('超过 50000 行返回 400，提示缩小范围', async () => {
  const start = Date.now();
  await prisma.evalTaskLog.createMany({
    data: Array.from({ length: 50_000 - 600 + 1 }, (_, i) => ({
      taskId,
      message: `批量 ${i}`,
      createdAt: new Date(start + i),
    })),
  });
  const res = await app.inject({
    method: 'GET',
    url: exportUrl(taskId, 'csv'),
    headers: bearer(admin),
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error.message, /请缩小范围/);
});
