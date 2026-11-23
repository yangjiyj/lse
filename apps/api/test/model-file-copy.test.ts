import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GiB } from '../src/modules/model-files/units.js';
import { rootsEmptyMessage, uploadTooLargeMessage } from '../src/modules/model-files/messages.js';

// config 在首次 import 时一次性解析环境变量：模拟“部署时没有配置任何目录、上传上限只有 1 KiB”。
process.env.MODEL_SCAN_ROOTS = '';
process.env.MODEL_SCAN_HOST_DIR = '/srv/lse-models';
process.env.MODEL_SCAN_UPLOAD_MAX_BYTES = '1024';
const { buildApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { SETTING_KEY } = await import('../src/modules/model-files/service.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = join(HERE, '..', 'src', 'modules', 'model-files');
/** 去掉注释后的源码：注释里允许写环境变量名（给开发者看），字符串里不允许（会显示给客户）。 */
const code = (file: string) =>
  readFileSync(join(MODULE_DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
const auth = () => ({ authorization: `Bearer ${token}` });
const BANNED = /MODEL_SCAN|环境变量|\.env|docker|compose|Redis|worker/i;

before(async () => {
  app = await buildApp();
  await app.ready();
  await prisma.systemSetting.deleteMany({ where: { key: SETTING_KEY } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
});

after(async () => {
  await prisma.systemSetting.deleteMany({ where: { key: SETTING_KEY } });
  await app.close();
});

test('没有可用目录的提示：写明服务器上的主机目录，不出现环境变量名', () => {
  const msg = rootsEmptyMessage('/srv/lse-models');
  assert.match(msg, /\/srv\/lse-models/);
  assert.match(msg, /管理目录/);
  assert.doesNotMatch(msg, BANNED);
  const unknown = rootsEmptyMessage(null);
  assert.doesNotMatch(unknown, BANNED);
  assert.match(unknown, /管理目录/);
});

test('上传过大的提示：给出上限和该去哪个服务器目录（规格示例原文）', () => {
  assert.equal(
    uploadTooLargeMessage(2 * GiB, '/opt/lse/models'),
    '上传上限 2 GiB，更大的模型请放到服务器目录 /opt/lse/models 后用目录扫描',
  );
  assert.equal(
    uploadTooLargeMessage(2 * GiB, null),
    '上传上限 2 GiB，更大的模型请放到服务器上的模型目录后用目录扫描',
  );
  assert.doesNotMatch(uploadTooLargeMessage(512 * 1024 * 1024, null), BANNED);
});

test('配置接口：没有部署级目录时返回空列表和主机目录', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/model-files/config', headers: auth() });
  assert.equal(r.statusCode, 200, r.body);
  const cfg = r.json();
  assert.deepEqual(cfg.envRoots, []);
  assert.deepEqual(cfg.rootDetails, []);
  assert.equal(cfg.hostDir, '/srv/lse-models');
  assert.equal(cfg.uploadMaxBytes, 1024);
});

test('目录浏览与目录扫描在没有任何目录时：说明怎么做，错误码不变', async () => {
  const expected = rootsEmptyMessage('/srv/lse-models');
  const browse = await app.inject({
    method: 'GET',
    url: `/api/model-files/browse?path=${encodeURIComponent('/anywhere')}`,
    headers: auth(),
  });
  assert.equal(browse.statusCode, 400, browse.body);
  assert.equal(browse.json().error.code, 'MODEL_FILE_ROOTS_EMPTY');
  assert.equal(browse.json().error.message, expected);
  const scan = await app.inject({
    method: 'POST',
    url: '/api/model-files/scan/directory',
    headers: auth(),
    payload: { path: '/anywhere' },
  });
  assert.equal(scan.statusCode, 400, scan.body);
  assert.equal(scan.json().error.code, 'MODEL_FILE_ROOTS_EMPTY');
  assert.equal(scan.json().error.message, expected);
});

test('上传超过上限：中文提示里带上限和服务器目录', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/model-files/uploads?fileName=big.pkl',
    headers: { ...auth(), 'content-type': 'application/octet-stream' },
    payload: Buffer.alloc(2048),
  });
  assert.ok([400, 413].includes(r.statusCode), r.body);
  const err = r.json().error ?? r.json();
  assert.match(String(err.message), /上传上限 1 KiB/);
  assert.match(String(err.message), /\/srv\/lse-models/);
  assert.doesNotMatch(r.body, BANNED);
});

test('源码守卫：给客户看的提示字符串里不写环境变量名和内部组件名', () => {
  for (const file of ['routes.ts', 'messages.ts', 'roots.ts', 'browse.ts']) {
    const src = code(file);
    assert.doesNotMatch(src, /MODEL_SCAN_/, `${file} 的非注释内容含环境变量名`);
    assert.doesNotMatch(src, /Redis|worker|环境变量/, `${file} 的非注释内容含内部名词`);
  }
});

test('报告与导出物：AIBOM 的工具名使用产品名常量，不写内部代号', () => {
  const src = code('aibom.ts');
  assert.doesNotMatch(src, /LSE 模型文件扫描/);
  assert.match(src, /PRODUCT_NAME/);
});
