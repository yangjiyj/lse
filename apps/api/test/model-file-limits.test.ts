import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { planFiles } from '../src/modules/model-files/filesystem.js';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  LIMIT_BOUNDS,
  SETTING_KEY,
  loadConfig,
} from '../src/modules/model-files/service.js';
import { GiB, TiB, formatBytes } from '../src/modules/model-files/units.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
const auth = () => ({ authorization: `Bearer ${token}` });

const clearSetting = () => prisma.systemSetting.deleteMany({ where: { key: SETTING_KEY } });
const putRaw = (value: Record<string, unknown>) =>
  prisma.systemSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: value as never },
    update: { value: value as never },
  });
const shards = (n: number, size: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `shard-${i}`, size }));

before(async () => {
  app = await buildApp();
  await app.ready();
  await clearSetting();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
});

after(async () => {
  await clearSetting();
  await app.close();
});

test('字节数展示为 KiB/MiB/GiB/TiB，去掉多余的小数', () => {
  assert.equal(formatBytes(4), '4 B');
  assert.equal(formatBytes(512 * 1024 * 1024), '512 MiB');
  assert.equal(formatBytes(1.5 * GiB), '1.5 GiB');
  assert.equal(formatBytes(1 * TiB), '1 TiB');
  assert.equal(formatBytes(16 * TiB), '16 TiB');
});

test('默认值与取值范围：总量默认 1 TiB、最大 16 TiB，文件数默认 10000', () => {
  assert.equal(DEFAULT_CONFIG.totalMaxBytes, 1 * TiB);
  assert.equal(DEFAULT_CONFIG.maxFiles, 10_000);
  assert.equal(LIMIT_BOUNDS.totalMaxBytes.max, 16 * TiB);
  assert.equal(LIMIT_BOUNDS.maxFiles.max, 100_000);
});

test('总量口径：几百 GB 的大模型目录一次扫完，不再被旧的 20 GiB 默认值截断', () => {
  const plan = planFiles(shards(5, 100 * GiB), DEFAULT_CONFIG);
  assert.equal(plan.chosen.length, 5);
  assert.equal(plan.planned, 500 * GiB);
  assert.equal(plan.truncatedReason, null);
});

test('总量口径：超过上限时只取前面的文件，提示用 TiB/GiB 表述而不是字节数', () => {
  const plan = planFiles(shards(12, 100 * GiB), DEFAULT_CONFIG);
  assert.equal(plan.chosen.length, 10);
  assert.equal(plan.planned, 1000 * GiB);
  assert.match(plan.truncatedReason ?? '', /总量上限 1 TiB/);
  assert.doesNotMatch(plan.truncatedReason ?? '', /字节/);
});

test('文件数口径：达到文件数上限时停止并标注数量', () => {
  const plan = planFiles(shards(30, 1024), { totalMaxBytes: 1 * TiB, maxFiles: 25 });
  assert.equal(plan.chosen.length, 25);
  assert.match(plan.truncatedReason ?? '', /数量超过上限 25/);
});

test('旧配置兼容：只有旧字段 maxBytes 的记录仍按总量读取', async () => {
  await putRaw({ roots: ['/models/a'], maxBytes: 5 * GiB });
  const cfg = await loadConfig();
  assert.deepEqual(cfg.roots, ['/models/a']);
  assert.equal(cfg.totalMaxBytes, 5 * GiB);
  assert.equal(cfg.maxFiles, DEFAULT_CONFIG.maxFiles);
  assert.equal(cfg.pickleMaxBytes, DEFAULT_CONFIG.pickleMaxBytes);
});

test('旧配置兼容：旧界面保存时写入的旧默认值（20 GiB / 2000 个）升级为新默认值', async () => {
  await putRaw({
    roots: [],
    pickleMaxBytes: 512 * 1024 * 1024,
    totalMaxBytes: 20 * GiB,
    maxFiles: 2000,
  });
  const cfg = await loadConfig();
  assert.equal(cfg.totalMaxBytes, 1 * TiB);
  assert.equal(cfg.maxFiles, 10_000);
});

test('旧配置兼容：管理员自己改过的旧值原样保留', async () => {
  await putRaw({
    roots: [],
    totalMaxBytes: 50 * GiB,
    maxFiles: 500,
    pickleMaxBytes: 64 * 1024 * 1024,
  });
  const cfg = await loadConfig();
  assert.equal(cfg.totalMaxBytes, 50 * GiB);
  assert.equal(cfg.maxFiles, 500);
  assert.equal(cfg.pickleMaxBytes, 64 * 1024 * 1024);
});

test('旧配置兼容：新版本保存的值原样保留，包括刻意设成的 20 GiB', async () => {
  await putRaw({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    roots: [],
    pickleMaxBytes: 512 * 1024 * 1024,
    totalMaxBytes: 20 * GiB,
    maxFiles: 2000,
  });
  const cfg = await loadConfig();
  assert.equal(cfg.totalMaxBytes, 20 * GiB);
  assert.equal(cfg.maxFiles, 2000);
});

test('旧配置兼容：库里超出新范围的脏值被收敛到范围内，不会读取失败', async () => {
  await putRaw({ roots: [], totalMaxBytes: 100 * TiB, maxFiles: 10_000_000, pickleMaxBytes: 1 });
  const cfg = await loadConfig();
  assert.equal(cfg.totalMaxBytes, 16 * TiB);
  assert.equal(cfg.maxFiles, 100_000);
  assert.equal(cfg.pickleMaxBytes, LIMIT_BOUNDS.pickleMaxBytes.min);
});

test('保存配置：总量上限最大可设 16 TiB，超出被拒；库里记录存储格式版本', async () => {
  const body = { roots: [], pickleMaxBytes: 512 * 1024 * 1024, maxFiles: 10_000 };
  const ok = await app.inject({
    method: 'PUT',
    url: '/api/model-files/config',
    headers: auth(),
    payload: { ...body, totalMaxBytes: 16 * TiB },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().totalMaxBytes, 16 * TiB);
  const stored = await prisma.systemSetting.findUniqueOrThrow({ where: { key: SETTING_KEY } });
  assert.equal((stored.value as { schemaVersion?: number }).schemaVersion, CONFIG_SCHEMA_VERSION);
  const get = await app.inject({ method: 'GET', url: '/api/model-files/config', headers: auth() });
  assert.equal(get.json().totalMaxBytes, 16 * TiB);

  const tooBig = await app.inject({
    method: 'PUT',
    url: '/api/model-files/config',
    headers: auth(),
    payload: { ...body, totalMaxBytes: 16 * TiB + 1 },
  });
  assert.equal(tooBig.statusCode, 400);
  const tooMany = await app.inject({
    method: 'PUT',
    url: '/api/model-files/config',
    headers: auth(),
    payload: { ...body, totalMaxBytes: 1 * TiB, maxFiles: 100_001 },
  });
  assert.equal(tooMany.statusCode, 400);
});
