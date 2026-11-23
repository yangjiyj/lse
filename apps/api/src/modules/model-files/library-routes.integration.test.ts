import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../app.js';
import { prisma } from '../../db.js';
import { runModelFileScan, uploadPathFor } from './executor.js';
import { sweepStaleUploads } from './routes.js';
import { UPLOAD_DIR } from './service.js';

const PREFIX = `模型文件库集成测试-${randomUUID()}`;
const SAMPLE = Buffer.from('800263636f6c6c656374696f6e730a4f726465726564446963740a29522e', 'hex');
let app: Awaited<ReturnType<typeof buildApp>>;
let ownerId = '';
let roleId = '';
let managerRoleId = '';
let base = '';
let ownerToken = '';
let otherToken = '';
let adminToken = '';
let managerToken = '';
let unprivilegedToken = '';
const userIds: string[] = [];
const uploadIds: string[] = [];
const scanIds: string[] = [];
const auth = (token = ownerToken) => ({ authorization: `Bearer ${token}` });

async function createUser(
  suffix: string,
  options: { privileged?: boolean; builtin?: boolean; manager?: boolean } = {},
) {
  const user = await prisma.user.create({
    data: {
      username: `${PREFIX}-${suffix}`,
      displayName: `${PREFIX}-${suffix}`,
      passwordHash: '仅用于集成测试，不可用于登录',
      isBuiltin: options.builtin ?? false,
      ...(options.privileged
        ? { roles: { create: { roleId: options.manager ? managerRoleId : roleId } } }
        : {}),
    },
  });
  userIds.push(user.id);
  return { id: user.id, token: app.jwt.sign({ sub: user.id, username: user.username }) };
}

async function start(fileName = `${PREFIX}.pkl`, totalBytes = SAMPLE.length) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/model-files/library/uploads',
    headers: auth(),
    payload: { fileName, totalBytes },
  });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json<{ uploadId: string; chunkSize: number }>();
  assert.ok(result.chunkSize > 0 && result.chunkSize <= 64 * 1024 * 1024);
  uploadIds.push(result.uploadId);
  return result.uploadId;
}

async function chunk(id: string, offset: number, bytes: Buffer, token = ownerToken) {
  return app.inject({
    method: 'PUT',
    url: `/api/model-files/library/uploads/${id}/chunk?offset=${offset}`,
    headers: { ...auth(token), 'content-type': 'application/octet-stream' },
    payload: bytes,
  });
}

async function ready(fileName?: string) {
  const id = await start(fileName);
  const sent = await chunk(id, 0, SAMPLE);
  assert.equal(sent.statusCode, 200, sent.body);
  const response = await app.inject({
    method: 'POST',
    url: `/api/model-files/library/uploads/${id}/complete`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200, response.body);
  return id;
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const permission = await prisma.permission.findUniqueOrThrow({ where: { code: 'engine:scan' } });
  roleId = (
    await prisma.role.create({
      data: { name: PREFIX, permissions: { create: { permissionId: permission.id } } },
    })
  ).id;
  const management = await prisma.permission.findUniqueOrThrow({
    where: { code: 'platform_setting:update' },
  });
  managerRoleId = (
    await prisma.role.create({
      data: {
        name: `${PREFIX}-文件库管理`,
        permissions: { create: [{ permissionId: permission.id }, { permissionId: management.id }] },
      },
    })
  ).id;
  const owner = await createUser('上传人', { privileged: true });
  ownerId = owner.id;
  ownerToken = owner.token;
  otherToken = (await createUser('其他扫描用户', { privileged: true })).token;
  adminToken = (await createUser('管理员', { privileged: true, builtin: true })).token;
  managerToken = (await createUser('有文件库管理权限', { privileged: true, manager: true })).token;
  unprivilegedToken = (await createUser('无扫描权限')).token;
  base = await mkdtemp(join(tmpdir(), 'lse-model-library-test-'));
});

after(async () => {
  await prisma.modelFileScan.deleteMany({
    where: { OR: [{ id: { in: scanIds } }, { uploadId: { in: uploadIds } }] },
  });
  await prisma.modelFileUpload.deleteMany({ where: { id: { in: uploadIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.role.deleteMany({ where: { id: { in: [roleId, managerRoleId].filter(Boolean) } } });
  for (const id of uploadIds) {
    await rm(uploadPathFor(id), { force: true });
    await rm(join(UPLOAD_DIR, `${id}.part`), { force: true });
    await rm(join(UPLOAD_DIR, `${id}.json`), { force: true });
  }
  if (base) await rm(base, { recursive: true, force: true });
  await app.close();
});

test('顺序上传拒绝错误偏移，查询进度后从服务器偏移续传并生成文件指纹', async () => {
  const id = await start();
  const first = await chunk(id, 0, SAMPLE.subarray(0, 8));
  assert.equal(first.statusCode, 200, first.body);
  const wrong = await chunk(id, 0, SAMPLE.subarray(8));
  assert.equal(wrong.statusCode, 409, wrong.body);
  assert.equal(wrong.json().error.code, 'MODEL_FILE_UPLOAD_OFFSET');
  assert.equal(Number(wrong.json().error.details.bytes), 8);
  const progress = await app.inject({
    method: 'GET',
    url: `/api/model-files/library/uploads/${id}`,
    headers: auth(),
  });
  assert.equal(progress.statusCode, 200, progress.body);
  assert.equal(progress.json().status, 'UPLOADING');
  assert.equal(Number(progress.json().bytes), 8);
  assert.equal(Number(progress.json().expectedBytes), SAMPLE.length);
  assert.equal((await chunk(id, 8, SAMPLE.subarray(8))).statusCode, 200);
  const completed = await app.inject({
    method: 'POST',
    url: `/api/model-files/library/uploads/${id}/complete`,
    headers: auth(),
  });
  assert.equal(completed.statusCode, 200, completed.body);
  const row = await prisma.modelFileUpload.findUniqueOrThrow({ where: { id } });
  assert.equal(row.status, 'READY');
  assert.equal(row.storedPath, id);
  assert.equal(row.sha256, createHash('sha256').update(SAMPLE).digest('hex'));
  assert.deepEqual(await readFile(uploadPathFor(id)), SAMPLE);
});

test('完成时总大小不符拒绝，已上传部分仍保留以便续传', async () => {
  const id = await start();
  assert.equal((await chunk(id, 0, SAMPLE.subarray(0, 5))).statusCode, 200);
  const response = await app.inject({
    method: 'POST',
    url: `/api/model-files/library/uploads/${id}/complete`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, 'MODEL_FILE_UPLOAD_INCOMPLETE');
  assert.equal(Number(response.json().error.details.bytes), 5);
  assert.equal(Number(response.json().error.details.expectedBytes), SAMPLE.length);
  const row = await prisma.modelFileUpload.findUniqueOrThrow({ where: { id } });
  assert.equal(row.status, 'UPLOADING');
  assert.equal(row.bytes, 5n);
});

test('已知总大小超过可用磁盘时拒绝并说明剩余空间和所需空间', async () => {
  const disk = await statfs(UPLOAD_DIR);
  const totalBytes = disk.bavail * disk.bsize + 1;
  const response = await app.inject({
    method: 'POST',
    url: '/api/model-files/library/uploads',
    headers: auth(),
    payload: { fileName: `${PREFIX}-磁盘不足.pkl`, totalBytes },
  });
  assert.equal(response.statusCode, 413, response.body);
  assert.match(response.body, /服务器磁盘剩余/);
  assert.match(response.body, /需要/);
});

test('路径穿越和非 UUID 标识在续传、完成、删除、扫描时均被拒绝', async () => {
  for (const id of [
    encodeURIComponent('不是上传标识'),
    encodeURIComponent('../models/保护文件.pkl'),
  ]) {
    for (const operation of [
      { method: 'GET' as const, url: `/api/model-files/library/uploads/${id}` },
      { method: 'POST' as const, url: `/api/model-files/library/uploads/${id}/complete` },
      { method: 'DELETE' as const, url: `/api/model-files/library/${id}` },
      { method: 'POST' as const, url: `/api/model-files/library/${id}/scan` },
    ]) {
      const response = await app.inject({ ...operation, headers: auth() });
      assert.equal(response.statusCode, 400, response.body);
    }
    const response = await chunk(id, 0, SAMPLE);
    assert.equal(response.statusCode, 400, response.body);
  }
});

test('需要扫描权限，其他普通用户不能操作上传，内置管理员和配置管理员可以操作', async () => {
  const anonymous = await app.inject({ method: 'GET', url: '/api/model-files/library' });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  const denied = await app.inject({
    method: 'POST',
    url: '/api/model-files/library/uploads',
    headers: auth(unprivilegedToken),
    payload: { fileName: `${PREFIX}-无权限.pkl`, totalBytes: SAMPLE.length },
  });
  assert.equal(denied.statusCode, 403, denied.body);
  const id = await start();
  assert.equal((await chunk(id, 0, SAMPLE, otherToken)).statusCode, 403);
  for (const operation of [
    { method: 'GET' as const, url: `/api/model-files/library/uploads/${id}` },
    { method: 'POST' as const, url: `/api/model-files/library/uploads/${id}/complete` },
    { method: 'POST' as const, url: `/api/model-files/library/${id}/scan` },
    { method: 'DELETE' as const, url: `/api/model-files/library/${id}` },
  ]) {
    const response = await app.inject({ ...operation, headers: auth(otherToken) });
    assert.equal(response.statusCode, 403, response.body);
  }
  const admin = await app.inject({
    method: 'DELETE',
    url: `/api/model-files/library/${id}`,
    headers: auth(adminToken),
  });
  assert.equal(admin.statusCode, 200, admin.body);
  const managedId = await ready();
  const managed = await app.inject({
    method: 'DELETE',
    url: `/api/model-files/library/${managedId}`,
    headers: auth(managerToken),
  });
  assert.equal(managed.statusCode, 200, managed.body);
  assert.equal(
    (await prisma.modelFileUpload.findUniqueOrThrow({ where: { id: managedId } })).status,
    'DELETED',
  );
  await assert.rejects(stat(uploadPathFor(managedId)), { code: 'ENOENT' });
});

test('库文件扫描后保留，列表带最近扫描；删除仅删除上传文件并保留扫描和审计', async () => {
  const protectedPath = join(base, '服务器模型.pkl');
  await writeFile(protectedPath, SAMPLE);
  const id = await ready(protectedPath);
  const scan = await app.inject({
    method: 'POST',
    url: `/api/model-files/library/${id}/scan`,
    headers: auth(),
    payload: {},
  });
  assert.equal(scan.statusCode, 200, scan.body);
  const scanId = scan.json().id as string;
  scanIds.push(scanId);
  const blocked = await app.inject({
    method: 'DELETE',
    url: `/api/model-files/library/${id}`,
    headers: auth(),
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  await prisma.modelFileScan.update({ where: { id: scanId }, data: { status: 'RUNNING' } });
  const running = await app.inject({
    method: 'DELETE',
    url: `/api/model-files/library/${id}`,
    headers: auth(),
  });
  assert.equal(running.statusCode, 409, running.body);
  await prisma.modelFileScan.update({ where: { id: scanId }, data: { status: 'PENDING' } });
  await runModelFileScan(scanId);
  const row = await prisma.modelFileScan.findUniqueOrThrow({ where: { id: scanId } });
  assert.equal(row.status, 'COMPLETED', row.error ?? '扫描应当成功');
  assert.equal(row.uploadId, id);
  assert.deepEqual(await readFile(uploadPathFor(id)), SAMPLE);
  const list = await app.inject({
    method: 'GET',
    url: '/api/model-files/library?pageSize=100',
    headers: auth(),
  });
  assert.equal(list.statusCode, 200, list.body);
  const body = list.json();
  assert.ok(Number(body.diskFreeBytes) > 0);
  assert.ok(Number(body.libraryBytes) >= SAMPLE.length);
  const item = body.items.find((entry: { id: string }) => entry.id === id);
  assert.ok(item, '已完成文件应出现在文件库');
  assert.equal(item.fileName, '服务器模型.pkl');
  assert.equal(Number(item.bytes), SAMPLE.length);
  assert.equal(item.createdBy.id, ownerId);
  assert.equal(item.createdBy.displayName, `${PREFIX}-上传人`);
  assert.ok(Number.isFinite(Date.parse(item.createdAt)), '列表应包含上传时间');
  assert.equal(item.latestScan.id, scanId);
  assert.equal(item.latestScan.status, 'COMPLETED');
  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/model-files/library/${id}`,
    headers: auth(),
  });
  assert.equal(removed.statusCode, 200, removed.body);
  await assert.rejects(stat(uploadPathFor(id)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(protectedPath), SAMPLE);
  assert.equal(
    (await prisma.modelFileUpload.findUniqueOrThrow({ where: { id } })).status,
    'DELETED',
  );
  assert.ok(await prisma.modelFileScan.findUnique({ where: { id: scanId } }));
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'model_file_library.delete', targetId: id, actorId: ownerId },
  });
  assert.ok(audit, '删除应写入审计记录');
});

test('超过七天无进展的未完成文件会清理，已完成文件永久保留', async () => {
  const completedId = await ready();
  const pendingId = await start();
  assert.equal((await chunk(pendingId, 0, SAMPLE.subarray(0, 5))).statusCode, 200);
  await prisma.modelFileUpload.updateMany({
    where: { id: { in: [completedId, pendingId] } },
    data: { updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
  });
  await sweepStaleUploads();
  assert.equal(
    (await prisma.modelFileUpload.findUniqueOrThrow({ where: { id: completedId } })).status,
    'READY',
  );
  assert.deepEqual(await readFile(uploadPathFor(completedId)), SAMPLE);
  await assert.rejects(stat(join(UPLOAD_DIR, `${pendingId}.part`)), { code: 'ENOENT' });
  const pending = await prisma.modelFileUpload.findUnique({ where: { id: pendingId } });
  assert.ok(pending === null || pending.status === 'DELETED');
});

test('旧一次性上传仍可扫描并在完成后删除临时文件，默认配置不限制上传总大小', async () => {
  const config = await app.inject({
    method: 'GET',
    url: '/api/model-files/config',
    headers: auth(adminToken),
  });
  assert.equal(config.statusCode, 200, config.body);
  assert.equal(config.json().uploadMaxBytes, 0);
  const staged = await app.inject({
    method: 'POST',
    url: `/api/model-files/uploads?fileName=${encodeURIComponent(`${PREFIX}-旧上传.pkl`)}`,
    headers: { ...auth(), 'content-type': 'application/octet-stream' },
    payload: SAMPLE,
  });
  assert.equal(staged.statusCode, 200, staged.body);
  const uploadId = staged.json().uploadId as string;
  uploadIds.push(uploadId);
  const scan = await app.inject({
    method: 'POST',
    url: '/api/model-files/scan/upload',
    headers: auth(),
    payload: { uploadId },
  });
  assert.equal(scan.statusCode, 200, scan.body);
  const scanId = scan.json().id as string;
  scanIds.push(scanId);
  await runModelFileScan(scanId);
  assert.equal(
    (await prisma.modelFileScan.findUniqueOrThrow({ where: { id: scanId } })).status,
    'COMPLETED',
  );
  await assert.rejects(stat(uploadPathFor(uploadId)), { code: 'ENOENT' });
});
