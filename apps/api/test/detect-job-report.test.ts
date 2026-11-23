import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { strFromU8, unzipSync } from 'fflate';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import { buildCombinedPdfDoc, buildCombinedView } from '../src/modules/reports/combined-render.js';
import { parseCombinedSnapshot } from '../src/modules/reports/combined.js';
import { closeBrowser } from '../src/modules/reports/html/chromium.js';
import {
  adminToken,
  bearer,
  builtinRoleUserToken,
  cleanupFixtures,
} from './helpers/w4-fixtures.js';

// B-8 从组合任务生成综合检测报告（2.4.7）：评估类子任务走组合报告的取数，其他检测项（模型文件、语料、
// 资产测绘）出小结；风险数与首页四类风险同口径（误报、判为误报的命中不计）。

const P = 'p2bbjobrpt_';

let app!: FastifyInstance;
let admin = '';
let auditor = '';
let jobId = '';
let runningJobId = '';
const names = { scan: '', corpus: '', discovery: '' };
let taskId = '';

async function cleanup(): Promise<void> {
  const jobs = await prismaUnscoped.detectJob.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  await prismaUnscoped.report.deleteMany({ where: { title: { startsWith: P } } });
  await prismaUnscoped.detectJob.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } });
  await prismaUnscoped.evalTask.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.modelFileScan.deleteMany({
    where: { path: { startsWith: `/models/${P}` } },
  });
  await prismaUnscoped.corpusScan.deleteMany({ where: { fileName: { startsWith: P } } });
  await prismaUnscoped.assetDiscoveryRun.deleteMany({ where: { createdByName: P } });
  await prismaUnscoped.modelTarget.deleteMany({ where: { name: { startsWith: P } } });
  await cleanupFixtures(P);
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  admin = await adminToken(app);
  auditor = await builtinRoleUserToken(app, P, 'auditor');
  const target = await prisma.modelTarget.create({
    data: {
      name: `${P}对象`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-dummy',
      model: 'm',
    },
  });
  const task = await prisma.evalTask.create({
    data: {
      name: `${P}内容评估`,
      status: 'COMPLETED',
      totalQuestions: 10,
      processedQuestions: 10,
      passedCount: 8,
      failedCount: 2,
      progress: 1,
      modelTargetId: target.id,
      startedAt: new Date('2026-11-20T02:00:00Z'),
      finishedAt: new Date('2026-11-20T03:00:00Z'),
    },
  });
  taskId = task.id;
  await prisma.finding.createMany({
    data: [
      ['HIGH', 'jailbreak'],
      ['MEDIUM', 'privacy'],
    ].map(([severity, category]) => ({
      tenantId: PLATFORM_TENANT_ID,
      taskId: task.id,
      engine: 'rule-judge',
      riskCategory: category!,
      verdict: 'FAIL' as const,
      severity: severity as 'HIGH' | 'MEDIUM',
      title: `[rule-judge] ${category}`,
    })),
  });

  names.scan = `/models/${P}qwen`;
  const scan = await prisma.modelFileScan.create({
    data: {
      source: 'DIRECTORY',
      path: names.scan,
      status: 'COMPLETED',
      fileCount: 5,
      skippedCount: 1,
      finishedAt: new Date(),
    },
  });
  await prisma.modelFileFinding.createMany({
    data: [
      ['CRITICAL', 'UNREVIEWED'],
      ['HIGH', 'CONFIRMED'],
      ['HIGH', 'FALSE_POSITIVE'],
    ].map(([severity, reviewStatus], i) => ({
      scanId: scan.id,
      filePath: `${names.scan}/f${i}.pkl`,
      format: 'pickle',
      evidence: '危险调用',
      severity: severity as 'CRITICAL' | 'HIGH',
      ruleId: `rule-${i}`,
      title: `${P}模型文件问题${i}`,
      reviewStatus: reviewStatus as 'UNREVIEWED' | 'CONFIRMED' | 'FALSE_POSITIVE',
    })),
  });

  names.corpus = `${P}语料.jsonl`;
  const corpus = await prisma.corpusScan.create({
    data: {
      fileName: names.corpus,
      storageKey: randomUUID(),
      bytes: 100n,
      sha256: 'x',
      status: 'COMPLETED',
      totalRecords: 50,
      invalidRecords: 2,
      finishedAt: new Date(),
    },
  });
  await prisma.corpusFinding.createMany({
    data: [
      ['violation', 'HIGH', null],
      ['sensitive', 'MEDIUM', 'CONFIRMED'],
      ['sensitive', 'MEDIUM', null],
      ['custom', 'LOW', 'DISMISSED'],
    ].map(([category, severity, judgeVerdict], i) => ({
      scanId: corpus.id,
      recordIndex: i,
      line: i + 1,
      fieldPath: 'output',
      category: category!,
      subtype: `${category}-x`,
      subtypeLabel: `${category}子类`,
      matchText: '命中',
      severity: severity!,
      judgeVerdict,
    })),
  });

  const discovery = await prisma.assetDiscoveryRun.create({
    data: {
      targets: ['10.9.0.1'],
      ports: [11434],
      hostCount: 1,
      portCount: 1,
      status: 'FAILED',
      error: '探测失败',
      createdByName: P,
    },
  });
  names.discovery = '10.9.0.1';

  const items = [
    { kind: 'eval_task', recordKind: 'eval_task', recordId: task.id },
    { kind: 'model_file_scan', recordKind: 'model_file_scan', recordId: scan.id },
    { kind: 'corpus_scan', recordKind: 'corpus_scan', recordId: corpus.id },
    { kind: 'asset_discovery', recordKind: 'asset_discovery', recordId: discovery.id },
  ];
  const job = await prisma.detectJob.create({
    data: {
      name: `${P}季度检测`,
      status: 'FAILED',
      startedAt: new Date('2026-11-20T01:00:00Z'),
      finishedAt: new Date('2026-11-20T04:00:00Z'),
      items: {
        create: items.map((it, position) => ({
          position,
          kind: it.kind,
          title: `${P}${it.kind}`,
          params: {},
          status: it.kind === 'asset_discovery' ? 'FAILED' : 'COMPLETED',
          recordKind: it.recordKind,
          recordId: it.recordId,
        })),
      },
    },
  });
  jobId = job.id;
  runningJobId = (
    await prisma.detectJob.create({
      data: {
        name: `${P}还在跑`,
        status: 'RUNNING',
        items: {
          create: [
            {
              position: 0,
              kind: 'eval_task',
              title: 'x',
              params: {},
              status: 'COMPLETED',
              recordKind: 'eval_task',
              recordId: task.id,
            },
          ],
        },
      },
    })
  ).id;
});

after(async () => {
  await cleanup();
  await closeBrowser();
  await app.close();
});

function generate(id: string, payload: Record<string, unknown> = {}, token = admin) {
  return app.inject({
    method: 'POST',
    url: `/api/detect-jobs/${id}/report`,
    headers: bearer(token),
    payload,
  });
}

test('组合任务还在执行时不能生成：409 DETECT_JOB_REPORT_NOT_READY；审计员 403', async () => {
  const res = await generate(runningJobId);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error.code, 'DETECT_JOB_REPORT_NOT_READY');
  assert.equal((await generate(jobId, {}, auditor)).statusCode, 403);
});

test('生成综合检测报告：评估任务走组合报告，其他检测项按同口径计风险；三种格式都有「其他检测项」', async () => {
  const res = await generate(jobId);
  assert.equal(res.statusCode, 201, res.body);
  const reportId = res.json().id as string;
  const row = await prisma.report.findUniqueOrThrow({ where: { id: reportId } });
  assert.equal(row.title, `${P}季度检测 综合检测报告`);
  assert.equal(row.kind, 'combined');
  const snapshot = parseCombinedSnapshot(row.summary)!;
  assert.deepEqual(
    snapshot.tasks.map((t) => t.id),
    [taskId],
  );
  assert.equal(snapshot.job?.itemCount, 4);
  assert.equal(snapshot.job?.id, jobId);
  const records = snapshot.records ?? [];
  assert.equal(records.length, 3);
  const byKind = new Map(records.map((r) => [r.kind, r]));
  assert.equal(byKind.get('model_file_scan')?.riskCount, 2);
  assert.equal(byKind.get('model_file_scan')?.category, 'model');
  assert.equal(byKind.get('corpus_scan')?.riskCount, 3);
  assert.equal(byKind.get('corpus_scan')?.category, 'data');
  assert.equal(byKind.get('asset_discovery')?.status, 'FAILED');
  assert.equal(byKind.get('asset_discovery')?.riskCount, 0);
  assert.ok(byKind.get('asset_discovery')?.lines.some((l) => l.includes('未完成，未计入风险统计')));
  assert.ok(byKind.get('model_file_scan')!.topFindings.length <= 10);
  assert.equal(byKind.get('model_file_scan')!.topFindings[0]!.severity, 'CRITICAL');

  const html = await app.inject({
    url: `/api/reports/${reportId}/download?format=html`,
    headers: bearer(admin),
  });
  assert.equal(html.statusCode, 200, html.body);
  for (const text of ['其他检测项', names.scan, names.corpus, names.discovery]) {
    assert.ok(html.body.includes(text), `HTML 含「${text}」`);
  }
  assert.match(html.body, /内容 \d+ 项、模型 2 项、数据 3 项、应用与环境 0 项/);

  const docx = await app.inject({
    url: `/api/reports/${reportId}/download?format=docx`,
    headers: bearer(admin),
  });
  assert.equal(docx.statusCode, 200, docx.body);
  const files = unzipSync(new Uint8Array(docx.rawPayload));
  const body = strFromU8(files['word/document.xml']!);
  for (const text of ['其他检测项', names.scan, names.corpus, names.discovery]) {
    assert.ok(body.includes(text), `Word 含「${text}」`);
  }

  // PDF：chromium 版用同一份 HTML；pdfkit 兜底版也有这一章
  const pdf = await app.inject({
    url: `/api/reports/${reportId}/download?format=pdf`,
    headers: bearer(admin),
  });
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.equal(pdf.rawPayload.subarray(0, 4).toString('latin1'), '%PDF');
  const view = buildCombinedView({
    title: row.title,
    reportId,
    createdAt: row.createdAt,
    snapshot,
    tasks: snapshot.tasks.map((t) => ({ ...t, deleted: false, movedOut: false })),
  });
  const pdfText = JSON.stringify(buildCombinedPdfDoc(view).blocks);
  for (const text of ['其他检测项', names.scan, names.corpus, names.discovery]) {
    assert.ok(pdfText.includes(text), `PDF 含「${text}」`);
  }

  // 报告列表标签
  const list = await app.inject({
    url: '/api/reports?kind=combined&pageSize=200',
    headers: bearer(admin),
  });
  assert.equal(list.statusCode, 200, list.body);
  const item = list.json().items.find((r: { id: string }) => r.id === reportId);
  assert.equal(item.label, '综合检测 · 4 项');
  assert.equal(item.detectItemCount, 4);
});

test('自定义标题、生成时选报告模板', async () => {
  const tpl = await app.inject({
    method: 'POST',
    url: '/api/report-templates',
    headers: bearer(admin),
    payload: { name: `${P}综合模板`, headerText: '综合检测页眉' },
  });
  assert.equal(tpl.statusCode, 201, tpl.body);
  const res = await generate(jobId, { title: `${P}自定义标题`, templateId: tpl.json().id });
  assert.equal(res.statusCode, 201, res.body);
  const html = await app.inject({
    url: `/api/reports/${res.json().id}/download?format=html`,
    headers: bearer(admin),
  });
  assert.ok(html.body.includes('综合检测页眉'));
  assert.ok(html.body.includes(`${P}自定义标题`));
  await prismaUnscoped.reportTemplate.deleteMany({ where: { name: { startsWith: P } } });
});

// ---- 审查修复：子任务记录后来被删、被重评；生成人没有某类记录的读权限 ----

async function completedJob(name: string) {
  const target = await prisma.modelTarget.findFirstOrThrow({ where: { name: `${P}对象` } });
  const task = await prisma.evalTask.create({
    data: {
      name: `${P}${name}评估`,
      status: 'COMPLETED',
      totalQuestions: 2,
      processedQuestions: 2,
      passedCount: 2,
      progress: 1,
      modelTargetId: target.id,
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
  const scan = await prisma.modelFileScan.create({
    data: {
      source: 'DIRECTORY',
      path: `/models/${P}${name}`,
      status: 'COMPLETED',
      fileCount: 1,
      finishedAt: new Date(),
    },
  });
  const job = await prisma.detectJob.create({
    data: {
      name: `${P}${name}`,
      status: 'COMPLETED',
      startedAt: new Date(),
      finishedAt: new Date(),
      items: {
        create: [
          {
            position: 0,
            kind: 'eval_task',
            title: '内容评估',
            params: {},
            status: 'COMPLETED',
            recordKind: 'eval_task',
            recordId: task.id,
          },
          {
            position: 1,
            kind: 'model_file_scan',
            title: '模型文件',
            params: {},
            status: 'COMPLETED',
            recordKind: 'model_file_scan',
            recordId: scan.id,
          },
        ],
      },
    },
  });
  return { jobId: job.id, taskId: task.id };
}

async function generateFor(id: string, token = admin) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/detect-jobs/${id}/report`,
    headers: bearer(token),
    payload: { title: `${P}重筛报告` },
  });
  assert.equal(res.statusCode, 201, res.body);
  const row = await prismaUnscoped.report.findUniqueOrThrow({ where: { id: res.json().id } });
  const snap = row.summary as Record<string, any>;
  // 「共 N 项」与表格行数一致
  const rows = snap.tasks.length + snap.records.length;
  assert.match(snap.headline, new RegExp(`共 ${rows} 项检测`));
  assert.equal(snap.job.itemCount, rows);
  return snap;
}

test('已完成的评估子任务记录后来被删：照常生成，该项写「检测记录已被删除」，不计风险', async () => {
  const { jobId: id, taskId: removed } = await completedJob('删记录');
  await prisma.evalTask.delete({ where: { id: removed } });
  const snap = await generateFor(id);
  assert.equal(snap.tasks.length, 0);
  const row = snap.records.find((r: { id: string }) => r.id === removed);
  assert.ok(row, '被删的子任务占一行');
  assert.deepEqual(row.lines, ['检测记录已被删除，未计入风险统计']);
  assert.equal(row.riskCount, 0);
  assert.equal(snap.records.length, 2);
});

test('已完成的评估子任务后来被重评（回到排队中）：照常生成，该项按未完成出小结', async () => {
  const { jobId: id, taskId: reEval } = await completedJob('重评');
  await prisma.evalTask.update({ where: { id: reEval }, data: { status: 'PENDING' } });
  const snap = await generateFor(id);
  assert.equal(snap.tasks.length, 0);
  const row = snap.records.find((r: { id: string }) => r.id === reEval);
  assert.ok(row);
  assert.equal(row.status, 'PENDING');
  assert.equal(row.riskCount, 0);
});

test('生成人没有某类记录的读权限：该项只写类型和原因，不进摘要', async () => {
  const { jobId: id } = await completedJob('读权限');
  const perms = await prisma.permission.findMany({
    where: {
      code: { in: ['detect_task:read', 'report:generate', 'report:read', 'eval_task:read'] },
    },
  });
  const role = await prisma.role.create({
    data: {
      name: `${P}报告员`,
      permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
    },
  });
  const password = ['Report', 'Gen', '12345'].join('@');
  await prisma.user.create({
    data: {
      username: `${P}reporter`,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      displayName: 'reporter',
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: `${P}reporter`, password },
  });
  assert.equal(login.statusCode, 200, login.body);
  const snap = await generateFor(id, login.json().token);
  assert.equal(snap.tasks.length, 1, '有评估任务的读权限，照常进组合报告');
  const file = snap.records.find((r: { kind: string }) => r.kind === 'model_file_scan');
  assert.equal(file.name, '模型文件扫描');
  assert.deepEqual(file.lines, ['无权查看该类检测记录，未计入风险统计']);
  assert.deepEqual(file.topFindings, []);
});
