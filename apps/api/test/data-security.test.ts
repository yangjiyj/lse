import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { applyHtmlWatermark, resolveDownloadWatermark } from '../src/lib/data-security.js';
import { parseTabular } from '../src/lib/question-import.js';
import { renderReportPdf } from '../src/modules/reports/pdf.js';

// 第 16 条数据安全：默认开启、查看明文权限与审计、下载水印与下载日志、操作日志按“下载”筛选。
let app!: FastifyInstance;
let adminToken = '';
let plainToken = '';
let saved: unknown = undefined;
const USERNAME = 'ds_plain_user';
const PASSWORD = 'Plain@12345'; // pragma: allowlist secret
const started = new Date();

async function login(username: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

before(async () => {
  app = await buildApp();
  await app.ready();
  saved = (await prisma.systemSetting.findUnique({ where: { key: 'data_security' } }))?.value;
  await prisma.systemSetting.deleteMany({ where: { key: 'data_security' } });
  await prisma.user.deleteMany({ where: { username: USERNAME } });
  await prisma.user.create({
    data: {
      username: USERNAME,
      passwordHash: await hashPassword(PASSWORD),
      displayName: '无权限用户',
      isActive: true,
    },
  });
  // 与迁移 20260928100001 一致：内置管理员拥有「查看敏感信息明文」（其他测试可能按旧角色定义重建过权限）
  const perm = await prisma.permission.upsert({
    where: { code: 'sensitive_data:view_plain' },
    create: { code: 'sensitive_data:view_plain', name: '查看敏感信息明文', group: '数据安全' },
    update: {},
  });
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'admin' } });
  await prisma.rolePermission.upsert({
    where: { roleId_permissionId: { roleId: adminRole.id, permissionId: perm.id } },
    create: { roleId: adminRole.id, permissionId: perm.id },
    update: {},
  });
  adminToken = (await login('admin', 'Admin@12345')).json().token; // pragma: allowlist secret
  plainToken = (await login(USERNAME, PASSWORD)).json().token;
});

after(async () => {
  if (saved === undefined)
    await prisma.systemSetting.deleteMany({ where: { key: 'data_security' } });
  else
    await prisma.systemSetting.upsert({
      where: { key: 'data_security' },
      update: { value: saved as object },
      create: { key: 'data_security', value: saved as object },
    });
  await prisma.user.deleteMany({ where: { username: USERNAME } });
  await app.close();
  await prisma.$disconnect();
});

test('数据安全开关默认开启，普通用户可读取但无查看明文权限', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/data-security',
    headers: auth(plainToken),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    maskSensitive: true,
    downloadWatermark: true,
    pageWatermark: true,
    canViewPlain: false,
  });
  const settings = await app.inject({
    method: 'GET',
    url: '/api/system-settings',
    headers: auth(adminToken),
  });
  assert.equal(settings.json().data_security.maskSensitive, true);
});

test('查看明文：无权限 403，管理员成功并写审计 sensitive_data.reveal', async () => {
  const payload = { kind: 'email', field: 'users.email', targetType: 'user', targetId: 'u-1' };
  const denied = await app.inject({
    method: 'POST',
    url: '/api/data-security/reveal',
    headers: auth(plainToken),
    payload,
  });
  assert.equal(denied.statusCode, 403);
  const ok = await app.inject({
    method: 'POST',
    url: '/api/data-security/reveal',
    headers: auth(adminToken),
    payload,
  });
  assert.equal(ok.statusCode, 200);
  const log = await prisma.auditLog.findFirst({
    where: { action: 'sensitive_data.reveal', targetId: 'u-1', createdAt: { gte: started } },
  });
  assert.ok(log);
  const bad = await app.inject({
    method: 'POST',
    url: '/api/data-security/reveal',
    headers: auth(adminToken),
    payload: { kind: 'password', field: 'x' },
  });
  assert.equal(bad.statusCode, 400);
});

test('模板下载：xlsx 页眉水印、csv 首行水印（导入时忽略），并写下载日志', async () => {
  const xlsx = await app.inject({
    method: 'GET',
    url: '/api/question-sets/templates/compliance/download?format=xlsx',
    headers: auth(adminToken),
  });
  assert.equal(xlsx.statusCode, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
  const header = wb.worksheets[0]!.headerFooter.oddHeader ?? '';
  assert.match(header, /鉴盾 · 大模型安全评估平台|admin/);
  assert.match(header, /admin/);
  assert.match(header, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);

  const csv = await app.inject({
    method: 'GET',
    url: '/api/question-sets/templates/compliance/download?format=csv',
    headers: auth(adminToken),
  });
  const text = csv.rawPayload.toString('utf8');
  assert.match(text.replace(/^\uFEFF/, '').split('\r\n')[0]!, /^# 水印：.*admin/);
  const rows = await parseTabular(csv.rawPayload, 'csv');
  assert.ok(!rows[0]![0]!.startsWith('# 水印'));

  const logs = await prisma.auditLog.findMany({
    where: { action: 'download.question_template', createdAt: { gte: started } },
  });
  assert.equal(logs.length, 2);
});

test('操作日志 category=download 只返回下载类日志', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/audit-logs?category=download&pageSize=100&start=${encodeURIComponent(started.toISOString())}`,
    headers: auth(adminToken),
  });
  assert.equal(res.statusCode, 200);
  const actions: string[] = res.json().items.map((i: { action: string }) => i.action);
  assert.ok(actions.length >= 2);
  assert.ok(
    actions.every(
      (a) => a.startsWith('download.') || ['report.download', 'wrong_answer.export'].includes(a),
    ),
  );
  assert.ok(!actions.includes('sensitive_data.reveal'));
});

test('PDF(pdfkit) 每页含水印文本；HTML 报告注入水印样式', async () => {
  const wm = await resolveDownloadWatermark({ username: 'admin', displayName: '管理员' });
  assert.ok(wm);
  assert.match(wm.text, /^鉴盾 · 大模型安全评估平台 管理员\(admin\) \d{4}-/);
  const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
  const buf = await renderReportPdf(
    { title: 'T', blocks: [{ type: 'paragraph', text: 'body' }] } as never,
    { cjkFontPath: fs.existsSync(font) ? font : undefined, watermark: wm.text },
  );
  const tmp = path.join(os.tmpdir(), `ds-wm-${process.pid}.pdf`);
  fs.writeFileSync(tmp, buf);
  try {
    const out = execFileSync('pdftotext', [tmp, '-'], { encoding: 'utf8' });
    assert.match(out, /admin/);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const html = applyHtmlWatermark(
    '<html><head></head><body>@bottom-center{ width:70mm; text-align:center; content:"鉴盾 · 大模型安全评估平台"; }</body></html>',
    { ...wm, text: 'x"</style><script>' },
  );
  assert.ok(!html.includes('</style><script>'));
  assert.match(html, /pagedjs_page::after/);
  // 斜向水印伸出页面会让 Chrome 打印时整页缩小、PDF 右侧和底部留白：页面内必须裁掉
  assert.ok(html.includes('.pagedjs_page{position:relative;overflow:hidden;}'));
});

test('关闭下载水印后不再加水印，但下载日志照常记录', async () => {
  const patch = await app.inject({
    method: 'PATCH',
    url: '/api/system-settings',
    headers: auth(adminToken),
    payload: { data_security: { downloadWatermark: false } },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().data_security.downloadWatermark, false);
  assert.equal(patch.json().data_security.maskSensitive, true);
  assert.equal(await resolveDownloadWatermark({ username: 'admin' }), null);
  const csv = await app.inject({
    method: 'GET',
    url: '/api/question-sets/templates/compliance/download?format=csv',
    headers: auth(adminToken),
  });
  assert.ok(!csv.rawPayload.toString('utf8').includes('水印'));
  const logs = await prisma.auditLog.count({
    where: { action: 'download.question_template', createdAt: { gte: started } },
  });
  assert.equal(logs, 3);
});
