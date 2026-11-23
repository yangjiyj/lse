import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { SETTING_KEY } from '../src/modules/model-files/service.js';
import { BROWSE_LIMITS, browseDirectory } from '../src/modules/model-files/browse.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
let base = '';
let root = '';
const auth = () => ({ authorization: `Bearer ${token}` });
const browse = (path: string, extra = '') =>
  app.inject({
    method: 'GET',
    url: `/api/model-files/browse?path=${encodeURIComponent(path)}${extra}`,
    headers: auth(),
  });

before(async () => {
  app = await buildApp();
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
  base = await mkdtemp(join(tmpdir(), 'lse-mf-browse-'));
  root = join(base, 'models');
  await mkdir(join(root, 'llama'), { recursive: true });
  await mkdir(join(root, 'qwen'), { recursive: true });
  await mkdir(join(root, 'empty'), { recursive: true });
  await writeFile(join(root, 'tiny.safetensors'), Buffer.alloc(2048));
  await writeFile(join(root, 'weights.bin'), Buffer.alloc(100));
  await writeFile(join(root, 'README.md'), 'doc');
  await writeFile(join(root, 'notes.txt'), 'doc');
  await utimes(
    join(root, 'tiny.safetensors'),
    new Date('2026-10-01T08:00:00Z'),
    new Date('2026-10-01T08:00:00Z'),
  );
  await prisma.systemSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: { schemaVersion: 2, roots: [root] } },
    update: { value: { schemaVersion: 2, roots: [root] } },
  });
});

after(async () => {
  await prisma.systemSetting.deleteMany({ where: { key: SETTING_KEY } });
  await chmod(join(root, 'locked'), 0o755).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
  await app.close();
});

test('浏览：先目录后模型文件，目录带名称，模型文件带大小和修改时间', async () => {
  const r = await browse(root);
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.path, root);
  assert.deepEqual(body.directories, ['empty', 'llama', 'qwen'], '兼容旧字段：目录名数组');
  assert.deepEqual(
    body.modelFiles.map((f: { name: string }) => f.name),
    ['tiny.safetensors', 'weights.bin'],
  );
  const tiny = body.modelFiles.find((f: { name: string }) => f.name === 'tiny.safetensors');
  assert.equal(tiny.bytes, 2048);
  assert.equal(new Date(tiny.modifiedAt).toISOString(), '2026-10-01T08:00:00.000Z');
  assert.equal(body.fileCount, 4, '本级文件总数（含非模型文件），保持原含义');
  assert.equal(body.otherFileCount, 2, '其中不是模型文件的数量');
});

test('浏览：空目录返回空列表而不是报错', async () => {
  const r = await browse(join(root, 'empty'));
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().directories, []);
  assert.deepEqual(r.json().modelFiles, []);
  assert.equal(r.json().fileCount, 0);
  assert.equal(r.json().truncated, false);
});

test('浏览：目录很多时只返回前 N 个并说明总数，不一次返回几万项', async () => {
  const wide = join(root, 'wide');
  await mkdir(wide);
  const total = BROWSE_LIMITS.maxEntries + 30;
  await Promise.all(
    Array.from({ length: total }, (_, i) => mkdir(join(wide, `d${String(i).padStart(5, '0')}`))),
  );
  const r = await browse(wide);
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.directories.length, BROWSE_LIMITS.maxEntries);
  assert.equal(body.directories[0], 'd00000', '按名称排序后截取前 N 个');
  assert.equal(body.directoryTotal, total);
  assert.equal(body.truncated, true);
  assert.equal(body.limit, BROWSE_LIMITS.maxEntries);
});

test('浏览：目录项超过读取上限时，标明只统计了前一部分（用小上限在单元层验证）', async () => {
  const huge = join(root, 'huge');
  await mkdir(huge);
  for (let i = 0; i < 25; i++) await writeFile(join(huge, `f${i}.txt`), '');
  const r = await browseDirectory(huge, { maxEntries: 5, maxScanned: 20 });
  assert.equal(r.scanLimited, true);
  assert.equal(r.truncated, true);
  assert.equal(r.fileCount, 20, '只统计读到的前 20 项');
  const small = await browseDirectory(huge, { maxEntries: 5, maxScanned: 100 });
  assert.equal(small.scanLimited, false);
  assert.equal(small.fileCount, 25);
});

test('浏览：模型文件超过显示上限时只给前 N 个并说明总数', async () => {
  const shardsDir = join(root, 'shards');
  await mkdir(shardsDir);
  for (let i = 0; i < 12; i++)
    await writeFile(
      join(shardsDir, `model-${String(i).padStart(5, '0')}.safetensors`),
      Buffer.alloc(8),
    );
  const r = await browseDirectory(shardsDir, { maxEntries: 10, maxScanned: 100 });
  assert.equal(r.modelFiles.length, 10);
  assert.equal(r.modelFiles[0]!.name, 'model-00000.safetensors');
  assert.equal(r.modelFileTotal, 12);
  assert.equal(r.truncated, true);
});

test('浏览：指向白名单内的符号链接目录不列出（保持原行为），指向文件的链接按文件统计', async () => {
  const dir = join(root, 'links');
  await mkdir(dir);
  await mkdir(join(dir, 'real'));
  await writeFile(join(dir, 'blob'), Buffer.alloc(64));
  await symlink(join(dir, 'real'), join(dir, 'dirlink'));
  await symlink(join(dir, 'blob'), join(dir, 'model.safetensors'));
  const r = (await browse(dir)).json();
  assert.deepEqual(r.directories, ['real']);
  assert.deepEqual(
    r.modelFiles.map((f: { name: string; bytes: number }) => [f.name, f.bytes]),
    [['model.safetensors', 64]],
  );
});

test('浏览：越界路径被拒绝并给出中文原因，不泄露环境变量名', async () => {
  const r = await browse(base);
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error.message, /不在/);
  assert.doesNotMatch(r.body, /MODEL_SCAN|环境变量/);
});

test(
  '浏览：目录没有读取权限时返回中文原因而不是 500（root 身份运行时跳过）',
  { skip: process.getuid?.() === 0 },
  async () => {
    const locked = join(root, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const r = await browse(locked);
      assert.equal(r.statusCode, 400, r.body);
      assert.equal(r.json().error.code, 'MODEL_FILE_BROWSE_FAILED');
      assert.match(r.json().error.message, /读取权限/);
    } finally {
      await chmod(locked, 0o755);
    }
  },
);

test('浏览：返回当前目录对应的服务器路径（部署时未配置主机目录则为空）', async () => {
  const r = (await browse(root)).json();
  assert.equal(r.hostPath, null, '测试目录不在 /models 下，推不出服务器路径');
});

test('browseDirectory：单元行为与接口一致', async () => {
  const r = await browseDirectory(join(root, 'qwen'));
  assert.deepEqual(r.directories, []);
  assert.deepEqual(r.modelFiles, []);
  assert.equal(r.truncated, false);
});
