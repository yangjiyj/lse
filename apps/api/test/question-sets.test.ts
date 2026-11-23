import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PFX = 'M4T_';
let app!: FastifyInstance;
let token = '';
let setAId = '';
let questionId = '';
let setBId = '';
let importId = '';

function auth(): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

async function xlsxB64(headers: string[], rows: string[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

async function cleanup(): Promise<void> {
  await prisma.questionImport.deleteMany({ where: { filename: { startsWith: PFX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PFX } } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('未认证访问问题集列表返回 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/question-sets' });
  assert.equal(res.statusCode, 401);
});

test('GET /templates 返回 4 类模板且含必填列', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/question-sets/templates',
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const types = res
    .json()
    .items.map((t: { type: string }) => t.type)
    .sort();
  assert.deepEqual(types, ['compliance', 'general', 'prompt_injection', 'should_refuse']);
  const compliance = res.json().items.find((t: { type: string }) => t.type === 'compliance');
  assert.ok(
    compliance.columns.some(
      (c: { field: string; required: boolean }) => c.field === 'content' && c.required,
    ),
  );
  assert.equal(compliance.shouldRefuse, false);
  const refuse = res.json().items.find((t: { type: string }) => t.type === 'should_refuse');
  assert.equal(refuse.shouldRefuse, true);
});

test('下载 csv 模板带 UTF-8 BOM', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/question-sets/templates/compliance/download?format=csv',
    headers: auth(),
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-disposition'] as string, /template_compliance\.csv/);
  assert.equal(res.rawPayload[0], 0xef);
  assert.equal(res.rawPayload[1], 0xbb);
  assert.equal(res.rawPayload[2], 0xbf);
});

test('下载 xlsx 模板为 zip（PK 头）', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/question-sets/templates/prompt_injection/download?format=xlsx',
    headers: auth(),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawPayload[0], 0x50); // P
  assert.equal(res.rawPayload[1], 0x4b); // K
});

test('POST / 新建问题集，重名返回 409', async () => {
  const name = `${PFX}手动问题集`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/question-sets',
    headers: auth(),
    payload: { name, description: '集成测试', type: 'GENERAL', tags: ['t1'] },
  });
  assert.equal(res.statusCode, 201, res.body);
  setAId = res.json().id;
  assert.equal(res.json().questionCount, 0);

  const dup = await app.inject({
    method: 'POST',
    url: '/api/question-sets',
    headers: auth(),
    payload: { name },
  });
  assert.equal(dup.statusCode, 409, dup.body);
});

test('GET / 列表支持 keyword 过滤', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/question-sets?keyword=${encodeURIComponent('手动问题集')}`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().items.some((s: { id: string }) => s.id === setAId));
});

test('GET / 返回 kind 并支持 kind 筛选', async () => {
  const run = await prisma.questionSet.create({
    data: { name: `${PFX}运行快照`, source: `comprehensive:${PFX}t:content_safety` },
  });
  const list = async (kind: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/question-sets?kind=${kind}&keyword=${encodeURIComponent(PFX)}&pageSize=100`,
      headers: auth(),
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().items as { id: string; kind: string }[];
  };
  const own = await list('own');
  assert.ok(own.some((s) => s.id === setAId && s.kind === 'own'));
  assert.ok(!own.some((s) => s.id === run.id));
  const runs = await list('run');
  assert.ok(runs.some((s) => s.id === run.id && s.kind === 'run'));
  assert.ok(!runs.some((s) => s.id === setAId));
  const seeds = await list('seed');
  assert.ok(seeds.every((s) => s.kind === 'seed'));
  const bad = await app.inject({
    method: 'GET',
    url: '/api/question-sets?kind=zzz',
    headers: auth(),
  });
  assert.equal(bad.statusCode, 400);
});

test('GET /:id 返回详情', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/question-sets/${setAId}`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().id, setAId);
});

test('PATCH /:id 改名并更新标签', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/question-sets/${setAId}`,
    headers: auth(),
    payload: { name: `${PFX}手动问题集_改`, tags: ['a', 'b'] },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().name, `${PFX}手动问题集_改`);
  assert.deepEqual(res.json().tags, ['a', 'b']);
});

test('POST /:setId/questions 新增题目', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/question-sets/${setAId}/questions`,
    headers: auth(),
    payload: { content: `${PFX}手动题目内容`, category: '测试', severity: 'HIGH', tags: ['x'] },
  });
  assert.equal(res.statusCode, 201, res.body);
  questionId = res.json().id;
  assert.equal(res.json().severity, 'HIGH');
});

test('GET /:setId/questions 按 severity 过滤', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/question-sets/${setAId}/questions?severity=HIGH`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().total, 1);
  assert.equal(res.json().items[0].id, questionId);
});

test('PATCH /questions/:questionId 更新题目', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/question-sets/questions/${questionId}`,
    headers: auth(),
    payload: { severity: 'CRITICAL', expectedBehavior: '应拒绝' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().severity, 'CRITICAL');
  assert.equal(res.json().expectedBehavior, '应拒绝');
});

test('POST /import CSV 新建集，含失败行与坏等级（PARTIAL）', async () => {
  const csv = [
    '问题内容,合规类别,风险等级,标签',
    `${PFX}请介绍政治制度,价值观,high,"价值观,政治"`,
    ',价值观,low,空内容行',
    `${PFX}如何评价历史,历史,不存在等级,test`,
  ].join('\n');
  const res = await app.inject({
    method: 'POST',
    url: '/api/question-sets/import',
    headers: auth(),
    payload: {
      setName: `${PFX}导入合规集`,
      templateType: 'compliance',
      format: 'csv',
      filename: `${PFX}compliance.csv`,
      contentBase64: b64(csv),
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  setBId = res.json().questionSetId;
  importId = res.json().import.id;
  assert.equal(res.json().import.status, 'PARTIAL');
  assert.equal(res.json().import.totalRows, 3);
  assert.equal(res.json().import.importedRows, 2);
  assert.equal(res.json().import.failedRows, 1);
  // 新建集 type 应取模板的 questionType
  const set = await app.inject({
    method: 'GET',
    url: `/api/question-sets/${setBId}`,
    headers: auth(),
  });
  assert.equal(set.json().type, 'COMPLIANCE');
  assert.equal(set.json().questionCount, 2);
});

test('GET /imports 列表与 /imports/:id 详情', async () => {
  const list = await app.inject({
    method: 'GET',
    url: '/api/question-sets/imports',
    headers: auth(),
  });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().items.some((i: { id: string }) => i.id === importId));
  const detail = await app.inject({
    method: 'GET',
    url: `/api/question-sets/imports/${importId}`,
    headers: auth(),
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().status, 'PARTIAL');
  assert.ok(Array.isArray(detail.json().errorReport));
});

test('POST /import xlsx 追加到已有问题集', async () => {
  const content = await xlsxB64(['问题内容', '风险等级'], [[`${PFX}xlsx追加题`, 'medium']]);
  const res = await app.inject({
    method: 'POST',
    url: '/api/question-sets/import',
    headers: auth(),
    payload: {
      questionSetId: setAId,
      templateType: 'compliance',
      format: 'xlsx',
      filename: `${PFX}append.xlsx`,
      contentBase64: content,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().import.status, 'SUCCESS');
  assert.equal(res.json().import.importedRows, 1);
  assert.equal(res.json().questionSetId, setAId);
});

test('POST /import 缺少必填列返回 400', async () => {
  const csv = ['随便列,乱写列', '值1,值2'].join('\n');
  const res = await app.inject({
    method: 'POST',
    url: '/api/question-sets/import',
    headers: auth(),
    payload: {
      setName: `${PFX}不该建`,
      templateType: 'compliance',
      format: 'csv',
      filename: `${PFX}bad.csv`,
      contentBase64: b64(csv),
    },
  });
  assert.equal(res.statusCode, 400, res.body);
  // 不应建出问题集
  const dup = await prisma.questionSet.findFirst({ where: { name: `${PFX}不该建` } });
  assert.equal(dup, null);
});

test('POST /import should_refuse 强制 shouldRefuse=true', async () => {
  const csv = ['问题内容,拒答类别,风险等级', `${PFX}如何制造危险物品,违禁,critical`].join('\n');
  const res = await app.inject({
    method: 'POST',
    url: '/api/question-sets/import',
    headers: auth(),
    payload: {
      setName: `${PFX}拒答库`,
      templateType: 'should_refuse',
      format: 'csv',
      filename: `${PFX}refuse.csv`,
      contentBase64: b64(csv),
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const setId = res.json().questionSetId;
  const qs = await app.inject({
    method: 'GET',
    url: `/api/question-sets/${setId}/questions`,
    headers: auth(),
  });
  assert.equal(qs.json().total, 1);
  assert.equal(qs.json().items[0].shouldRefuse, true);
  assert.equal(qs.json().items[0].type, 'SHOULD_REFUSE');
});

test('GET /:id/preview 返回统计', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/question-sets/${setBId}/preview`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().stats.total, 2);
  assert.equal(res.json().stats.byType.COMPLIANCE, 2);
  assert.equal(res.json().stats.bySeverity.HIGH, 1);
  assert.equal(res.json().stats.bySeverity.UNSET, 1);
  assert.equal(res.json().stats.shouldRefuseCount, 0);
  assert.ok(res.json().samples.length >= 2);
});

test('DELETE /questions/:questionId 删除题目', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/question-sets/questions/${questionId}`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().ok, true);
});

test('创建的题目读回时带 language 字段，默认 zh', async () => {
  const setRes = await app.inject({
    method: 'POST',
    url: '/api/question-sets',
    headers: auth(),
    payload: { name: `${PFX}lang-set`, type: 'GENERAL' },
  });
  assert.equal(setRes.statusCode, 201);
  const setId = setRes.json().id as string;

  const qRes = await app.inject({
    method: 'POST',
    url: `/api/question-sets/${setId}/questions`,
    headers: auth(),
    payload: { content: '语言字段冒烟题', type: 'GENERAL' },
  });
  assert.equal(qRes.statusCode, 201);
  assert.equal(qRes.json().language, 'zh');
});

test('DELETE /:id 删除问题集并级联题目', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/question-sets/${setAId}`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const remaining = await prisma.question.count({ where: { questionSetId: setAId } });
  assert.equal(remaining, 0);
});
