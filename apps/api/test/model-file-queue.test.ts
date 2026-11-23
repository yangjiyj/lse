import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { randomUUID } from 'node:crypto';
import {
  runModelFileScan,
  uploadMetaPathFor,
  uploadPathFor,
} from '../src/modules/model-files/executor.js';
import { maliciousPickle, safePickle } from './helpers/model-file-fixtures.js';

const PREFIX = 'MODEL-FILE-QUEUE-';
let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
let base = '';
const auth = () => ({ authorization: `Bearer ${token}` });

async function cleanup() {
  await prisma.modelFileScan.deleteMany({
    where: { OR: [{ path: { contains: 'lse-mf-queue-' } }, { path: { startsWith: PREFIX } }] },
  });
  await prisma.systemSetting.deleteMany({ where: { key: 'model_file_scan.config' } });
}

async function stage(name: string, bytes: Buffer) {
  const r = await app.inject({
    method: 'POST',
    url: `/api/model-files/uploads?fileName=${encodeURIComponent(name)}`,
    headers: { ...auth(), 'content-type': 'application/octet-stream' },
    payload: bytes,
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as { uploadId: string; bytes: number };
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
  token = login.json().token;
  base = await mkdtemp(join(tmpdir(), 'lse-mf-queue-'));
  await mkdir(join(base, 'models'), { recursive: true });
  await writeFile(join(base, 'models', 'evil.pkl'), maliciousPickle());
  await writeFile(join(base, 'models', 'ok.pkl'), safePickle());
  await app.inject({
    method: 'PUT',
    url: '/api/model-files/config',
    headers: auth(),
    payload: {
      roots: [join(base, 'models')],
      pickleMaxBytes: 1 << 20,
      totalMaxBytes: 1 << 24,
      maxFiles: 100,
    },
  });
});

after(async () => {
  await cleanup();
  await rm(base, { recursive: true, force: true });
  await app.close();
});

test('配置接口返回部署级白名单与上传上限（默认 0 表示不限制）', async () => {
  const cfg = (
    await app.inject({ method: 'GET', url: '/api/model-files/config', headers: auth() })
  ).json();
  assert.deepEqual(cfg.envRoots, ['/models']);
  assert.equal(cfg.uploadMaxBytes, 0);
});

test('原始字节上传：先暂存再建扫描，状态 PENDING，执行后 COMPLETED 且临时文件删除', async () => {
  const up = await stage(`${PREFIX}evil.pkl`, maliciousPickle());
  assert.equal(up.bytes, maliciousPickle().length);
  assert.ok(existsSync(uploadPathFor(up.uploadId)));
  const r = await app.inject({
    method: 'POST',
    url: '/api/model-files/scan/upload',
    headers: auth(),
    payload: { uploadId: up.uploadId, fileName: `${PREFIX}evil.pkl` },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, 'PENDING');
  await runModelFileScan(r.json().id);
  const row = await prisma.modelFileScan.findUniqueOrThrow({ where: { id: r.json().id } });
  assert.equal(row.status, 'COMPLETED');
  assert.ok(row.highCount >= 1);
  assert.ok(row.startedAt && row.finishedAt);
  assert.equal(existsSync(uploadPathFor(up.uploadId)), false);
  // 重复执行不会再次处理（幂等）
  const before = await prisma.modelFileFinding.count({ where: { scanId: row.id } });
  await runModelFileScan(row.id);
  assert.equal(await prisma.modelFileFinding.count({ where: { scanId: row.id } }), before);
});

test('暂存 ID 不能复用，也不能凭空伪造', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/model-files/scan/upload',
    headers: auth(),
    payload: { uploadId: '00000000-0000-4000-8000-000000000000', fileName: 'x.pkl' },
  });
  assert.equal(r.statusCode, 400);
});

test('目录扫描入队后执行，记录进度与计划量；安全文件无高危', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/model-files/scan/directory',
    headers: auth(),
    payload: { path: join(base, 'models') },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, 'PENDING');
  await runModelFileScan(r.json().id);
  const row = await prisma.modelFileScan.findUniqueOrThrow({ where: { id: r.json().id } });
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.fileCount, 2);
  assert.equal(row.plannedFiles, 2);
  assert.equal(row.progressFiles, 2);
  const high = await prisma.modelFileFinding.findMany({
    where: { scanId: row.id, severity: 'HIGH' },
  });
  assert.ok(high.length >= 1 && high.every((f) => f.filePath.endsWith('evil.pkl')));
});

test('取消：排队中的扫描可取消，执行器跳过；已完成的不可取消', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/model-files/scan/directory',
    headers: auth(),
    payload: { path: join(base, 'models') },
  });
  const id = r.json().id;
  const c = await app.inject({
    method: 'POST',
    url: `/api/model-files/scans/${id}/cancel`,
    headers: auth(),
  });
  assert.equal(c.statusCode, 200, c.body);
  await runModelFileScan(id);
  const row = await prisma.modelFileScan.findUniqueOrThrow({ where: { id } });
  assert.equal(row.status, 'CANCELLED');
  assert.equal(row.fileCount, 0);
  assert.ok(
    await prisma.auditLog.findFirst({ where: { action: 'model_file_scan.cancel', targetId: id } }),
  );
  const again = await app.inject({
    method: 'POST',
    url: `/api/model-files/scans/${id}/cancel`,
    headers: auth(),
  });
  assert.equal(again.statusCode, 409);
});

test('上传：非 octet-stream、空文件、他人的暂存 ID 都被拒绝', async () => {
  const json = await app.inject({
    method: 'POST',
    url: '/api/model-files/uploads?fileName=a.pkl',
    headers: auth(),
    payload: { contentBase64: 'AAAA' },
  });
  assert.equal(json.statusCode, 400);
  const empty = await app.inject({
    method: 'POST',
    url: '/api/model-files/uploads?fileName=a.pkl',
    headers: { ...auth(), 'content-type': 'application/octet-stream' },
    payload: Buffer.alloc(0),
  });
  assert.equal(empty.statusCode, 400);
  const up = await stage('other.pkl', safePickle());
  const meta = JSON.parse(await readFile(uploadMetaPathFor(up.uploadId), 'utf8'));
  await writeFile(
    uploadMetaPathFor(up.uploadId),
    JSON.stringify({ ...meta, userId: randomUUID() }),
  );
  const r = await app.inject({
    method: 'POST',
    url: '/api/model-files/scan/upload',
    headers: auth(),
    payload: { uploadId: up.uploadId },
  });
  assert.equal(r.statusCode, 400);
});

test('AIBOM：评估对象的模型标识不再误填为 version，而是写入 lse:modelId 属性', async () => {
  const { buildCycloneDxMlBom } = await import('../src/modules/model-files/aibom.js');
  const bom = buildCycloneDxMlBom(
    [
      {
        name: 'a.gguf',
        path: 'a.gguf',
        format: 'gguf',
        bytes: 1,
        sha256: 'a'.repeat(64),
        meta: {},
      },
    ],
    { target: { id: 't', name: '客服大模型', model: 'qwen2.5-7b-instruct' } },
  );
  const c = bom.metadata.component!;
  assert.equal('version' in c, false);
  assert.deepEqual(c.properties, [{ name: 'lse:modelId', value: 'qwen2.5-7b-instruct' }]);
  const none = buildCycloneDxMlBom([], { target: { id: 't', name: 'x', model: '' } });
  assert.equal(none.metadata.component!.properties, undefined);
});
