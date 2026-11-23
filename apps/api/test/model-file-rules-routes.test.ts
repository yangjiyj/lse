import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { runModelFileScan } from '../src/modules/model-files/executor.js';
import { MODEL_FILE_RULES } from '../src/modules/model-files/rules.js';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';

/** 规则清单接口与扫描结果的脚本风险分组接口。 */
const here = dirname(fileURLToPath(import.meta.url));
let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
let base = '';
let scanId = '';
const auth = () => ({ authorization: `Bearer ${token}` });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const USER_PREFIX = '__h_mfrules_';
const TENANT_NAME = 'H线模型文件规则测试租户';
const PASSWORD = ['Rules', 'Test', '12345'].join('@');

async function cleanup() {
  await prisma.modelFileScan.deleteMany({ where: { path: { contains: 'lse-mf-rules-' } } });
  await prisma.systemSetting.deleteMany({ where: { key: 'model_file_scan.config' } });
  const tenants = await prisma.tenant.findMany({
    where: { name: TENANT_NAME },
    select: { id: true },
  });
  const tenantIds = tenants.map((t) => t.id);
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.user.deleteMany({
    where: { OR: [{ username: { startsWith: USER_PREFIX } }, { tenantId: { in: tenantIds } }] },
  });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.rolePermission.deleteMany({
    where: { role: { name: { startsWith: USER_PREFIX } } },
  });
  await prisma.role.deleteMany({ where: { name: { startsWith: USER_PREFIX } } });
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
  base = await mkdtemp(join(tmpdir(), 'lse-mf-rules-'));
  execFileSync('python3', [join(here, 'fixtures/model-files/gen_scripts.py'), base], {
    cwd: join(here, 'fixtures/model-files'),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: 'pipe',
  });
  const put = await app.inject({
    method: 'PUT',
    url: '/api/model-files/config',
    headers: auth(),
    payload: {
      roots: [base],
      pickleMaxBytes: 1024 * 1024,
      totalMaxBytes: 64 * 1024 * 1024,
      maxFiles: 1000,
    },
  });
  assert.equal(put.statusCode, 200, put.body);
});

after(async () => {
  await cleanup();
  await rm(base, { recursive: true, force: true });
  await app.close();
});

test('规则清单：返回全部规则和规则数，含类别、严重度、说明；分检测和提示两类', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/model-files/rules', headers: auth() });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json() as {
    total: number;
    detectTotal: number;
    noteTotal: number;
    items: Array<{
      id: string;
      category: string;
      kind: 'detect' | 'note';
      severity: string;
      title: string;
      description: string;
    }>;
  };
  assert.equal(body.total, MODEL_FILE_RULES.length);
  assert.equal(body.items.length, body.total);
  assert.equal(body.detectTotal + body.noteTotal, body.total);
  assert.equal(body.detectTotal, body.items.filter((x) => x.kind === 'detect').length);
  const kindOf = (id: string) => body.items.find((x) => x.id === id)?.kind;
  for (const id of [
    'SAFETENSORS_VALIDATED',
    'PICKLE_PARSED',
    'SCRIPT_TRUNCATED',
    'MODEL_PARSE_ABORTED',
    'ARCHIVE_ENTRIES_SKIPPED',
  ])
    assert.equal(kindOf(id), 'note', id);
  for (const id of [
    'PICKLE_DANGEROUS_GLOBAL',
    'vba.auto_exec',
    'KNOWN_MODEL_HASH_MISMATCH',
    'code.command_execution',
  ])
    assert.equal(kindOf(id), 'detect', id);
  const vba = body.items.find((x) => x.id === 'vba.auto_exec')!;
  assert.equal(vba.category, 'VBA 宏');
  assert.ok(vba.description);
  assert.equal(
    body.items.find((x) => x.id === 'code.command_execution')?.category,
    '脚本（组件扫描规则）',
  );
});

test('规则清单与脚本风险接口要求登录', async () => {
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/model-files/rules' })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: `/api/model-files/scans/${randomUUID()}/script-risks`,
      })
    ).statusCode,
    401,
  );
});

test('脚本风险按语言分组：宏文档里的命中归到 VBA，提示级不列出', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/model-files/scan/directory',
    headers: auth(),
    payload: { path: base },
  });
  assert.equal(r.statusCode, 200, r.body);
  const id = r.json().id as string;
  await runModelFileScan(id);
  const res = await app.inject({
    method: 'GET',
    url: `/api/model-files/scans/${id}/script-risks`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const groups = res.json().groups as Array<{
    format: string;
    total: number;
    items: Array<{ format: string; severity: string; filePath: string; ruleId: string }>;
  }>;
  const formats = groups.map((g) => g.format);
  for (const f of [
    'python',
    'javascript',
    'typescript',
    'shell',
    'powershell',
    'batch',
    'vbscript',
    'vba',
    'config',
  ])
    assert.ok(formats.includes(f), `缺少分组 ${f}，实际 ${formats.join(',')}`);
  assert.equal(formats.indexOf('python'), 0, '按固定语言顺序排列');
  for (const g of groups) {
    assert.ok(
      g.items.every((x) => x.format === g.format && x.severity !== 'INFO'),
      g.format,
    );
    assert.equal(g.total, g.items.length);
  }
  const vba = groups.find((g) => g.format === 'vba')!;
  assert.ok(
    vba.items.some(
      (x) => x.filePath === 'office/evil.xlsm' && x.ruleId === 'vba.auto_exec_payload',
    ),
  );
  const python = groups.find((g) => g.format === 'python')!;
  assert.ok(
    python.items.some((x) => x.filePath === 'archive/model.pt'),
    '归档内的 Python 脚本归到 Python',
  );
  const missing = await app.inject({
    method: 'GET',
    url: `/api/model-files/scans/${randomUUID()}/script-risks`,
    headers: auth(),
  });
  assert.equal(missing.statusCode, 404);
  scanId = id;
});

test('脚本风险与规则清单：没有扫描权限 403；其他租户看不到本租户的扫描（404）', async () => {
  assert.ok(scanId, '依赖上一条测试建的扫描');
  const role = await prisma.role.create({
    data: { name: `${USER_PREFIX}reader`, description: '无扫描权限', isBuiltin: false },
  });
  const perm = await prisma.permission.findUniqueOrThrow({
    where: { code: 'system_setting:read' },
  });
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  await prisma.user.create({
    data: {
      username: `${USER_PREFIX}reader`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: '无扫描权限',
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  const reader = await login(`${USER_PREFIX}reader`, PASSWORD);
  for (const url of [`/api/model-files/scans/${scanId}/script-risks`, '/api/model-files/rules']) {
    const r = await app.inject({ method: 'GET', url, headers: bearer(reader) });
    assert.equal(r.statusCode, 403, `${url} ${r.body}`);
  }
  const tenant = await app.inject({
    method: 'POST',
    url: '/api/tenants',
    headers: auth(),
    payload: { name: TENANT_NAME, admin: { username: `${USER_PREFIX}tadmin`, password: PASSWORD } },
  });
  assert.equal(tenant.statusCode, 201, tenant.body);
  await skipFirstPasswordChange(`${USER_PREFIX}tadmin`);
  const other = await login(`${USER_PREFIX}tadmin`, PASSWORD);
  const cross = await app.inject({
    method: 'GET',
    url: `/api/model-files/scans/${scanId}/script-risks`,
    headers: bearer(other),
  });
  assert.equal(cross.statusCode, 404, cross.body);
  const own = await app.inject({
    method: 'GET',
    url: `/api/model-files/scans/${scanId}/script-risks`,
    headers: auth(),
  });
  assert.equal(own.statusCode, 200);
});
