import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = 'MF-REMED-';
const OP_USER = 'mf-remed-operator';
const OP_PASS = 'Operator@12345';
let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';
let opToken = '';
let adminId = '';
const h = (t: string) => ({ authorization: `Bearer ${t}` });

async function cleanup() {
  await prisma.modelFileScan.deleteMany({ where: { path: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { username: OP_USER } });
}

/** 直接落一条已完成扫描；hit=true 时带一条 HIGH 发现。 */
async function scan(path: string, hit: boolean, createdById = adminId) {
  return prisma.modelFileScan.create({
    data: {
      source: 'DIRECTORY',
      path,
      status: 'COMPLETED',
      createdById,
      highCount: hit ? 1 : 0,
      findings: hit
        ? {
            create: {
              filePath: 'model.bin',
              format: 'pickle',
              severity: 'HIGH',
              ruleId: 'PICKLE_DANGEROUS_GLOBAL',
              title: 'pickle 引用危险可调用对象',
              evidence: 'os.system',
            },
          }
        : undefined,
    },
    include: { findings: true },
  });
}

async function login(username: string, password: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().token as string;
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'operator' } });
  await prisma.user.create({
    data: {
      username: OP_USER,
      passwordHash: await argon2.hash(OP_PASS, { type: argon2.argon2id }),
      displayName: '模型文件整改测试操作员',
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  adminToken = await login('admin', 'Admin@12345');
  opToken = await login(OP_USER, OP_PASS);
  adminId = (await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).id;
});

after(async () => {
  await cleanup();
  await app.close();
});

test('可见性统一：有模块读权限的非创建者也能看到列表、详情、发现与处置台来源', async () => {
  const s = await scan(`${PREFIX}vis`, true);
  const list = (await app.inject({ method: 'GET', url: '/api/model-files/scans?pageSize=100', headers: h(opToken) })).json();
  assert.ok(list.items.some((x: { id: string }) => x.id === s.id));
  const detail = await app.inject({ method: 'GET', url: `/api/model-files/scans/${s.id}`, headers: h(opToken) });
  assert.equal(detail.statusCode, 200);
  const f = await app.inject({ method: 'GET', url: `/api/model-files/scans/${s.id}/findings`, headers: h(opToken) });
  assert.equal(f.json().total, 1);
  const rem = (await app.inject({ method: 'GET', url: '/api/model-files/findings?pageSize=100', headers: h(opToken) })).json();
  assert.ok(rem.items.some((x: { scanId: string }) => x.scanId === s.id));
});

test('复核：非未复核结论必须填依据；非创建者不能改他人扫描的发现', async () => {
  const s = await scan(`${PREFIX}review`, true);
  const id = s.findings[0]!.id;
  const url = `/api/model-files/findings/${id}/review`;
  const noReason = await app.inject({ method: 'PATCH', url, headers: h(adminToken), payload: { status: 'CONFIRMED' } });
  assert.equal(noReason.statusCode, 409);
  const other = await app.inject({ method: 'PATCH', url, headers: h(opToken), payload: { status: 'CONFIRMED', reason: 'x' } });
  assert.equal(other.statusCode, 403);
  const ok = await app.inject({ method: 'PATCH', url, headers: h(adminToken), payload: { status: 'CONFIRMED', reason: '确认含 os.system' } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().finding.reviewStatus, 'CONFIRMED');
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'model_file_finding.review', targetId: id } }));
});

test('验证关闭：需确认+关闭证据+同路径已完成复扫；复扫仍命中则自动重开，干净复扫才关闭', async () => {
  const s = await scan(`${PREFIX}close`, true);
  const id = s.findings[0]!.id;
  const url = `/api/model-files/findings/${id}`;
  const unconfirmed = await app.inject({ method: 'PATCH', url, headers: h(adminToken), payload: { status: 'VERIFIED_CLOSED' } });
  assert.equal(unconfirmed.statusCode, 409);
  await prisma.modelFileFinding.update({ where: { id }, data: { reviewStatus: 'CONFIRMED', reviewReason: 'x' } });
  const noEvidence = await app.inject({ method: 'PATCH', url, headers: h(adminToken), payload: { status: 'VERIFIED_CLOSED' } });
  assert.equal(noEvidence.statusCode, 409);
  const otherPath = await scan(`${PREFIX}close-other`, false);
  const mismatch = await app.inject({
    method: 'PATCH', url, headers: h(adminToken),
    payload: { status: 'VERIFIED_CLOSED', closureEvidence: '已替换为 safetensors', retestScanId: otherPath.id },
  });
  assert.equal(mismatch.statusCode, 409);
  const dirty = await scan(`${PREFIX}close`, true);
  const reopened = await app.inject({
    method: 'PATCH', url, headers: h(adminToken),
    payload: { status: 'VERIFIED_CLOSED', closureEvidence: '已替换', retestScanId: dirty.id },
  });
  assert.equal(reopened.statusCode, 200, reopened.body);
  assert.equal(reopened.json().reopened, true);
  assert.equal(reopened.json().finding.remediationStatus, 'REOPENED');
  const clean = await scan(`${PREFIX}close`, false);
  const closed = await app.inject({
    method: 'PATCH', url, headers: h(adminToken),
    payload: { status: 'VERIFIED_CLOSED', closureEvidence: '已替换为 safetensors', retestScanId: clean.id },
  });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(closed.json().finding.remediationStatus, 'VERIFIED_CLOSED');
  assert.ok(closed.json().finding.remediationClosedAt);
});

test('风险接受不能验证关闭；不适用必须填处置记录', async () => {
  const s = await scan(`${PREFIX}accept`, true);
  const id = s.findings[0]!.id;
  await prisma.modelFileFinding.update({ where: { id }, data: { reviewStatus: 'ACCEPTED_RISK', reviewReason: 'x' } });
  const clean = await scan(`${PREFIX}accept`, false);
  const r = await app.inject({
    method: 'PATCH', url: `/api/model-files/findings/${id}`, headers: h(adminToken),
    payload: { status: 'VERIFIED_CLOSED', closureEvidence: 'x', retestScanId: clean.id },
  });
  assert.equal(r.statusCode, 409);
  const na = await app.inject({ method: 'PATCH', url: `/api/model-files/findings/${id}`, headers: h(adminToken), payload: { status: 'NOT_APPLICABLE' } });
  assert.equal(na.statusCode, 409);
});

test('看板待办包含模型文件发现的待复核与临期整改', async () => {
  const s = await scan(`${PREFIX}dash`, true);
  await prisma.modelFileFinding.update({
    where: { id: s.findings[0]!.id },
    data: { remediationDueAt: new Date(Date.now() + 24 * 3600 * 1000) },
  });
  const r = await app.inject({ method: 'GET', url: '/api/dashboard/todos', headers: h(adminToken) });
  assert.equal(r.statusCode, 200, r.body);
  const mf = r.json().modelFile;
  assert.ok(mf.reviewCount >= 1);
  assert.ok(mf.remediationCount >= 1);
  assert.ok(mf.items.some((x: { scanId: string }) => x.scanId === s.id));
});
