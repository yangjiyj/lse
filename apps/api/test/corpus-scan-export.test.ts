import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { runCorpusScan } from '../src/modules/corpus-scans/executor.js';
import { LEGACY_DOWNLOAD_ACTIONS } from '../src/modules/audit-logs/routes.js';

// 语料扫描结果导出（CSV、JSON）和打码副本下载。

const P = '__p2g_export_';
const PASSWORD = ['Corpus', 'Export', '12345'].join('@');
const ID = '110101199003071233';

let app: Awaited<ReturnType<typeof buildApp>>;
let storageDir = '';
let adminToken = '';
let auditorToken = '';
let operatorToken = '';
let scanId = '';
let ruleSetId = '';
const SOURCE = [
  JSON.stringify({ instruction: '登记', input: '', output: `身份证 ${ID}` }),
  JSON.stringify({
    instruction: '公式',
    input: '',
    output: '=HYPERLINK("http://x") 电话 13800138000',
  }),
  JSON.stringify({ instruction: '普通', input: '', output: '没有敏感信息' }),
].join('\n');

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function cleanup(): Promise<void> {
  await prismaUnscoped.corpusScan.deleteMany({ where: { fileName: { startsWith: P } } });
  await prismaUnscoped.corpusRuleSet.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.auditLog.deleteMany({ where: { action: { startsWith: 'corpus_' } } });
  await prismaUnscoped.user.deleteMany({ where: { username: { startsWith: P } } });
}

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

before(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'p2g-export-'));
  process.env.CORPUS_STORAGE_DIR = storageDir;
  app = await buildApp();
  await app.ready();
  await cleanup();
  adminToken = await login('admin', ['Admin', '@', '12345'].join(''));
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'auditor' } });
  await prisma.user.create({
    data: {
      username: `${P}au`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: `${P}au`,
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  auditorToken = await login(`${P}au`, PASSWORD);
  const opRole = await prisma.role.findUniqueOrThrow({ where: { name: 'operator' } });
  await prisma.user.create({
    data: {
      username: `${P}op`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: `${P}op`,
      isActive: true,
      roles: { create: { roleId: opRole.id } },
    },
  });
  operatorToken = await login(`${P}op`, PASSWORD);

  const set = await app.inject({
    method: 'POST',
    url: '/api/corpus-rules/sets',
    headers: bearer(adminToken),
    payload: { name: `${P}公式` },
  });
  ruleSetId = set.json().id;
  await app.inject({
    method: 'POST',
    url: `/api/corpus-rules/sets/${ruleSetId}/rules`,
    headers: bearer(adminToken),
    payload: { kind: 'regex', pattern: '=HYPERLINK\\(', category: '公式注入' },
  });
  const res = await app.inject({
    method: 'POST',
    url: `/api/corpus-scans?fileName=${encodeURIComponent(`${P}导出.jsonl`)}&ruleSetId=${ruleSetId}`,
    headers: { ...bearer(adminToken), 'content-type': 'application/octet-stream' },
    payload: Buffer.from(SOURCE, 'utf8'),
  });
  assert.equal(res.statusCode, 201, res.body);
  scanId = res.json().id;
  await runCorpusScan(scanId);
  const row = await prisma.corpusScan.findUniqueOrThrow({ where: { id: scanId } });
  assert.equal(row.status, 'COMPLETED', row.error ?? '');
});

after(async () => {
  await cleanup();
  await app.close();
  await rm(storageDir, { recursive: true, force: true });
  delete process.env.CORPUS_STORAGE_DIR;
});

test('导出命中原文、下载打码副本要 corpus_scan:export：auditor 403', async () => {
  for (const url of [
    `/api/corpus-scans/${scanId}/export?format=csv`,
    `/api/corpus-scans/${scanId}/export?format=json`,
    `/api/corpus-scans/${scanId}/masked-copy`,
  ]) {
    const res = await app.inject({ url, headers: bearer(auditorToken) });
    assert.equal(res.statusCode, 403, url);
  }
  const detail = await app.inject({
    url: `/api/corpus-scans/${scanId}`,
    headers: bearer(auditorToken),
  });
  assert.equal(detail.statusCode, 200, '只读照常');
});

test('导出 CSV：UTF-8 带 BOM，命中原文不打码，公式开头的单元格防注入；写下载审计', async () => {
  const res = await app.inject({
    url: `/api/corpus-scans/${scanId}/export?format=csv`,
    headers: { ...bearer(operatorToken), 'user-agent': 'p2g-export-test' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['content-type']), /text\/csv/);
  assert.match(String(res.headers['content-disposition']), /attachment/);
  assert.deepEqual([...res.rawPayload.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = res.rawPayload.subarray(3).toString('utf8');
  assert.ok(text.includes(ID), '命中原文不打码');
  assert.ok(text.includes("'=HYPERLINK("), '公式开头要加单引号');
  assert.ok(!/(^|,)=HYPERLINK/m.test(text));
  const audit = await prismaUnscoped.auditLog.findFirst({
    where: { action: 'corpus_scan.export', targetId: scanId },
  });
  assert.ok(audit);
  assert.equal(audit!.userAgent, 'p2g-export-test');
  assert.ok(audit!.ip);
  assert.ok((LEGACY_DOWNLOAD_ACTIONS as readonly string[]).includes('corpus_scan.export'));
});

test('导出 JSON：统计和全部命中', async () => {
  const res = await app.inject({
    url: `/api/corpus-scans/${scanId}/export?format=json`,
    headers: bearer(adminToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['content-disposition']), /attachment/);
  const body = res.json();
  assert.equal(body.scan.id, scanId);
  assert.ok(body.scan.findingCount >= 3);
  assert.equal(body.findings.length, body.scan.findingCount);
  assert.deepEqual(body.scan.stats.byCategory.sensitive, 2);
  assert.ok(body.findings.some((f: { matchText: string }) => f.matchText === ID));
  assert.equal(
    (
      await app.inject({
        url: `/api/corpus-scans/${scanId}/export?format=xml`,
        headers: bearer(adminToken),
      })
    ).statusCode,
    400,
  );
});

test('打码副本：身份证、手机号被替换，行数和格式不变；写下载审计', async () => {
  const res = await app.inject({
    url: `/api/corpus-scans/${scanId}/masked-copy`,
    headers: { ...bearer(operatorToken), 'user-agent': 'p2g-masked-test' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['content-disposition']), /masked\.jsonl/);
  const text = res.rawPayload.toString('utf8');
  assert.equal(text.split('\n').length, SOURCE.split('\n').length);
  assert.ok(!text.includes(ID));
  assert.ok(!text.includes('13800138000'));
  const rows = text.split('\n').map((l) => JSON.parse(l));
  assert.equal(rows[0].output, '身份证 [身份证号]');
  assert.equal(rows[1].output, '=HYPERLINK("http://x") 电话 [手机号]');
  assert.deepEqual(rows[2], JSON.parse(SOURCE.split('\n')[2]!));
  const audit = await prismaUnscoped.auditLog.findFirst({
    where: { action: 'corpus_scan.masked_copy', targetId: scanId },
  });
  assert.ok(audit);
  assert.equal(audit!.userAgent, 'p2g-masked-test');
  assert.ok((LEGACY_DOWNLOAD_ACTIONS as readonly string[]).includes('corpus_scan.masked_copy'));
});

test('没扫完不能下载打码副本', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/corpus-scans?fileName=${encodeURIComponent(`${P}未完成.txt`)}`,
    headers: { ...bearer(adminToken), 'content-type': 'application/octet-stream' },
    payload: Buffer.from('电话 13800138000'),
  });
  const pending = await app.inject({
    url: `/api/corpus-scans/${res.json().id}/masked-copy`,
    headers: bearer(adminToken),
  });
  assert.equal(pending.statusCode, 409, pending.body);
});

test('导出按批读库逐批写出：超过一批的命中全部导出、顺序不乱', async () => {
  const lines = Array.from({ length: 2500 }, (_, i) => `第${i}行 电话 13800138000`).join('\n');
  const res = await app.inject({
    method: 'POST',
    url: `/api/corpus-scans?fileName=${encodeURIComponent(`${P}多批.txt`)}`,
    headers: { ...bearer(adminToken), 'content-type': 'application/octet-stream' },
    payload: Buffer.from(lines, 'utf8'),
  });
  const id = res.json().id as string;
  await runCorpusScan(id);
  const json = await app.inject({
    url: `/api/corpus-scans/${id}/export?format=json`,
    headers: bearer(adminToken),
  });
  assert.equal(json.statusCode, 200, json.body);
  const body = json.json();
  assert.equal(body.findings.length, 2500);
  assert.deepEqual(
    body.findings.map((f: { recordIndex: number }) => f.recordIndex),
    Array.from({ length: 2500 }, (_, i) => i + 1),
  );
  assert.equal(body.scan.id, id);
  const csv = await app.inject({
    url: `/api/corpus-scans/${id}/export?format=csv`,
    headers: bearer(adminToken),
  });
  const all = csv.rawPayload.subarray(3).toString('utf8').trimEnd().split('\r\n');
  const rows = all.slice(all.findIndex((r) => r.startsWith('记录序号,')) + 1);
  assert.equal(rows.length, 2500);
  assert.match(rows[2499]!, /^2500,2500,text,/);
});

test('打码副本的兜底文件名：扩展名不规范时用 .txt', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/corpus-scans?fileName=${encodeURIComponent(`${P}怪名.j"s\\n`)}`,
    headers: { ...bearer(adminToken), 'content-type': 'application/octet-stream' },
    payload: Buffer.from('电话 13800138000'),
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().id as string;
  await runCorpusScan(id);
  const masked = await app.inject({
    url: `/api/corpus-scans/${id}/masked-copy`,
    headers: bearer(adminToken),
  });
  assert.equal(masked.statusCode, 200, masked.body);
  assert.match(
    String(masked.headers['content-disposition']),
    new RegExp(`filename="corpus-masked-${id}\\.txt"`),
  );
  assert.equal(masked.rawPayload.toString('utf8'), '电话 [手机号]');
});
