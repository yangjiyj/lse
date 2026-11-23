import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { requestLoginAddresses } from '../src/modules/system-settings/access-address.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let authorization: string;
let saved: Awaited<ReturnType<typeof prisma.systemSetting.findUnique>>;
before(async () => {
  saved = await prisma.systemSetting.findUnique({ where: { key: 'access' } });
  await prisma.systemSetting.deleteMany({ where: { key: 'access' } });
  app = await buildApp();
  // light-my-request 会自动补 localhost；在测试钩子中模拟真正缺失的 Host。
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-page-test-no-host'] === '1') delete request.headers.host;
  });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' } });
  assert.equal(login.statusCode, 200);
  authorization = `Bearer ${login.json().token}`;
});
after(async () => {
  await prisma.systemSetting.deleteMany({ where: { key: 'access' } });
  if (saved) await prisma.systemSetting.create({ data: saved as any });
  await app.close();
  await prisma.$disconnect();
});
const get = (headers: Record<string, string>) => app.inject({
  method: 'GET', url: '/api/system-settings', headers: {
    authorization, ...headers, ...(headers.host === '' ? { 'x-page-test-no-host': '1' } : {}),
  },
});
test('Host、反代 Host 与 Origin 推导默认入口，不写入配置', async () => {
  for (const headers of [{ host: 'eval.example.test:8090' },
    { host: 'internal.test', 'x-forwarded-host': 'eval.example.test' }]) {
    const res = await get(headers);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().access.encryptedLoginUrl, 'https://eval.example.test:10443/login');
    assert.equal(res.json().access.compatibleLoginUrl, 'http://eval.example.test:8090/login');
  }
  assert.equal(requestLoginAddresses({ origin: 'https://eval.example.test' }).encryptedLoginUrl,
    'https://eval.example.test:10443/login');
  assert.equal(await prisma.systemSetting.count({ where: { key: 'access' } }), 0);
});
test('没有 Host/Origin 时为未配置', async () => {
  assert.deepEqual(requestLoginAddresses({}), { encryptedLoginUrl: '', compatibleLoginUrl: '' });
  const res = await get({ host: '' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().access.encryptedLoginUrl, '');
});
test('拒绝恶意 Host 与反代头，不能降级使用其它头', async () => {
  for (const host of ['evil.test/path', 'user@evil.test', 'evil.test,good.test',
    '<script>.test', 'evil.test\\bad', 'evil.test%0d%0a', 'evil.test:99999']) {
    const res = await get({ host: 'safe.test', 'x-forwarded-host': host });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().access.encryptedLoginUrl, '', host);
    assert.equal(requestLoginAddresses({ host }).encryptedLoginUrl, '', host);
  }
});
test('已有自定义值不覆盖；旧模板值不再展示', async () => {
  await prisma.systemSetting.create({ data: { key: 'access', value: {
    encryptedLoginUrl: 'https://custom.example.test/login',
    compatibleLoginUrl: 'https://custom.example.test/legacy',
  } } });
  const res = await get({ host: 'different.test' });
  assert.equal(res.json().access.encryptedLoginUrl, 'https://custom.example.test/login');
  assert.equal(res.json().access.compatibleLoginUrl, 'https://custom.example.test/legacy');
  await prisma.systemSetting.update({ where: { key: 'access' }, data: { value: {
    encryptedLoginUrl: 'https://<部署主机>:10443/login',
    compatibleLoginUrl: 'http://<部署主机>:8090/login',
  } } });
  assert.equal((await get({ host: '' })).json().access.encryptedLoginUrl, '');
});
