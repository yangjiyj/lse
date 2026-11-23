import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const prefix = '__platform_v2_keep_';
const KB = 'LSE-CANARY-KB-keep01';
const SYS = 'LSE-CANARY-SYS-keep01';
const BASE = 'http://127.0.0.1:9/v1';
let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
let targetId = '';
const prev = process.env.LSE_PLATFORM_APP_ENABLED;

async function cleanup() {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.questionSet.deleteMany({ where: { name: { contains: prefix } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: prefix } } });
}
before(async () => {
  process.env.LSE_PLATFORM_APP_ENABLED = 'true';
  await cleanup();
  targetId = (await prisma.modelTarget.create({ data: { name: `${prefix}靶应用`, targetType: 'PLATFORM_APP', provider: 'dify', baseUrl: BASE, apiKey: 'app-local-secret', model: 'platform-app',
    accessConfig: { platform: 'dify', baseUrl: BASE, appMode: 'agent-chat', knowledgeCanary: KB, systemCanary: SYS } } })).id;
  app = await buildApp();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'Admin@12345' } });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
});
after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
  if (prev === undefined) delete process.env.LSE_PLATFORM_APP_ENABLED; else process.env.LSE_PLATFORM_APP_ENABLED = prev;
});
const headers = () => ({ authorization: `Bearer ${token}` });
const stored = async () => (await prisma.modelTarget.findUniqueOrThrow({ where: { id: targetId } })).accessConfig as Record<string, unknown>;

test('表单保存时没带暗号字段：沿用库里的原值，不被清掉', async () => {
  const patch = await app.inject({ method: 'PATCH', url: `/api/model-targets/${targetId}`, headers: headers(),
    payload: { accessConfig: { platform: 'dify', baseUrl: BASE, appMode: 'agent-chat' } } });
  assert.equal(patch.statusCode, 200, patch.body);
  const after = await stored();
  assert.equal(after.knowledgeCanary, KB);
  assert.equal(after.systemCanary, SYS);
});

test('表单把读取到的脱敏值原样回传：还原成库里的原值，不报 400', async () => {
  const read = await app.inject({ method: 'GET', url: `/api/model-targets/${targetId}`, headers: headers() });
  assert.equal(read.statusCode, 200, read.body);
  const shown = read.json().accessConfig ?? read.json().target?.accessConfig;
  assert.match(String(shown.knowledgeCanary), /^hash:[0-9a-f]{12}$/, '读取接口应把暗号脱敏');
  const patch = await app.inject({ method: 'PATCH', url: `/api/model-targets/${targetId}`, headers: headers(),
    payload: { accessConfig: { ...shown } } });
  assert.equal(patch.statusCode, 200, patch.body);
  const after = await stored();
  assert.equal(after.knowledgeCanary, KB);
  assert.equal(after.systemCanary, SYS);
});

test('用户重新输入了新暗号：以新值为准；输入了格式错误的值：被拒绝', async () => {
  const ok = await app.inject({ method: 'PATCH', url: `/api/model-targets/${targetId}`, headers: headers(),
    payload: { accessConfig: { platform: 'dify', baseUrl: BASE, appMode: 'agent-chat', knowledgeCanary: 'LSE-CANARY-KB-new01' } } });
  assert.equal(ok.statusCode, 200, ok.body);
  const after = await stored();
  assert.equal(after.knowledgeCanary, 'LSE-CANARY-KB-new01');
  assert.equal(after.systemCanary, SYS, '没动的那个沿用原值');
  const bad = await app.inject({ method: 'PATCH', url: `/api/model-targets/${targetId}`, headers: headers(),
    payload: { accessConfig: { platform: 'dify', baseUrl: BASE, appMode: 'agent-chat', knowledgeCanary: '不是暗号格式' } } });
  assert.ok(bad.statusCode >= 400 && bad.statusCode < 500, bad.body);
});

test('非平台对象的 accessConfig 不受影响', async () => {
  const other = await prisma.modelTarget.create({ data: { name: `${prefix}普通`, targetType: 'MODEL', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-local-secret', model: 'm1',
    accessConfig: { headers: { 'x-trace': 'abc' }, note: 'keep' } as never } });
  const patch = await app.inject({ method: 'PATCH', url: `/api/model-targets/${other.id}`, headers: headers(), payload: { accessConfig: { headers: { 'x-trace': 'abc' }, note: 'keep' } } });
  assert.equal(patch.statusCode, 200, patch.body);
  const after = (await prisma.modelTarget.findUniqueOrThrow({ where: { id: other.id } })).accessConfig as Record<string, unknown>;
  assert.equal(after.note, 'keep');
  assert.equal((after.headers as Record<string, string>)['x-trace'], 'abc');
});
