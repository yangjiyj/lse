import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { skipFirstPasswordChange } from './helpers/tenant-admin.js';

// 标准条款接口：目录（只含已核实依据）、按范围的条款结论（与报告同口径）、租户隔离。

const P = 'STDU26-';
const PW = 'Tenant@12345'; // pragma: allowlist secret
const ADMIN_PW = 'Admin@12345'; // pragma: allowlist secret

let app!: FastifyInstance;
let adminJwt = '';
const T = {
  a: { id: '', jwt: '', username: `${P.toLowerCase()}a-admin`, target: '', task: '' },
  b: { id: '', jwt: '', username: `${P.toLowerCase()}b-admin`, target: '', task: '' },
};

const h = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

async function cleanup(): Promise<void> {
  const ts = await prisma.tenant.findMany({ where: { name: { startsWith: P } }, select: { id: true } });
  const ids = ts.map((t) => t.id);
  if (ids.length) {
    const tasks = await prisma.evalTask.findMany({ where: { tenantId: { in: ids } }, select: { id: true } });
    await prisma.evalResult.deleteMany({ where: { taskId: { in: tasks.map((t) => t.id) } } });
    await prisma.evalTask.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.questionSet.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.modelTarget.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.user.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  }
}

async function seedTenantData(key: 'a' | 'b', fails: number, passes: number) {
  const t = T[key];
  const target = await prisma.modelTarget.create({
    data: {
      tenantId: t.id,
      name: `${P}对象${key}`,
      provider: 'test',
      baseUrl: 'https://placeholder.invalid',
      apiKey: '',
      model: 'test',
    },
  });
  t.target = target.id;
  const set = await prisma.questionSet.create({
    data: { tenantId: t.id, name: `${P}题集${key}`, type: 'GENERAL', tags: [] },
  });
  const task = await prisma.evalTask.create({
    data: {
      tenantId: t.id,
      name: `${P}任务${key}`,
      status: 'COMPLETED',
      modelTargetId: target.id,
      dimensions: ['prompt_injection'],
      questionSets: { create: { questionSetId: set.id } },
    },
  });
  t.task = task.id;
  const add = async (i: number, category: string, verdict: 'PASS' | 'FAIL') => {
    const q = await prisma.question.create({
      data: { questionSetId: set.id, content: `${P}${key}${category}${i}`, category, type: 'GENERAL', tags: [] },
    });
    await prisma.evalResult.create({
      data: { taskId: task.id, questionId: q.id, modelTargetId: target.id, prompt: 'p', response: 'r', finalVerdict: verdict },
    });
  };
  for (let i = 0; i < fails; i += 1) await add(i, 'A.2.e', 'FAIL');
  for (let i = 0; i < passes; i += 1) await add(100 + i, 'A.2.e', 'PASS');
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: ADMIN_PW } });
  assert.equal(res.statusCode, 200, res.body);
  adminJwt = res.json().token;
  for (const key of ['a', 'b'] as const) {
    const created = await app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers: h(adminJwt),
      payload: { name: `${P}租户${key}`, admin: { username: T[key].username, password: PW } },
    });
    assert.equal(created.statusCode, 201, created.body);
    T[key].id = created.json().id;
    await skipFirstPasswordChange(T[key].username);
    const lg = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: T[key].username, password: PW } });
    assert.equal(lg.statusCode, 200, lg.body);
    T[key].jwt = lg.json().token;
  }
  await seedTenantData('a', 1, 4);
  await seedTenantData('b', 0, 2);
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

type CoverageClause = { id: string; verdict: string; verdictLabel: string; tested: number; failed: number; capability: string };
type CoverageLine = { line: string; validCount: number; taskCount: number; clauses: CoverageClause[]; annexMajors?: Array<{ code: string; tested: number; failed: number }> };

test('条款目录与覆盖接口未登录返回 401', async () => {
  for (const url of ['/api/standards/catalog', '/api/standards/coverage']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
  }
});

test('目录：三条线各带依据说明与条款，智能体线与终端线写明在研非现行，国际框架只作参考', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/standards/catalog', headers: h(T.a.jwt) });
  assert.equal(res.statusCode, 200, res.body);
  const lines = res.json().lines as Array<{
    line: string;
    basisStatement: string;
    bases: Array<{ code: string | null; title: string; statusNote: string | null }>;
    references: string[];
    clauses: Array<{ id: string; ref: string; sourceRef: string; capabilityLabel: string; automationLabel: string }>;
  }>;
  assert.deepEqual(lines.map((l) => l.line), ['content', 'agent', 'endpoint']);
  const byLine = Object.fromEntries(lines.map((l) => [l.line, l]));
  assert.ok(byLine.content!.bases.some((b) => b.code === 'GB/T 45654-2025'));
  assert.equal(byLine.content!.clauses.filter((c) => /^gbt45654\.A\.\d\.[a-i]$/.test(c.id)).length, 31);
  assert.match(byLine.agent!.basisStatement, /在研/);
  assert.match(byLine.agent!.basisStatement, /非现行/);
  assert.match(byLine.endpoint!.basisStatement, /TC260-PG-20266A/);
  assert.ok(byLine.endpoint!.clauses.length > 0);
  for (const l of lines) {
    for (const c of l.clauses) {
      assert.ok(c.sourceRef && c.capabilityLabel && c.automationLabel, c.id);
    }
    assert.ok(l.references.length > 0, '国际框架放在参考里');
    assert.ok(!l.bases.some((b) => /OWASP|ATLAS/.test(b.title)), '国际框架不进依据');
  }
});

test('覆盖：按任务折算附录 A 小项，与报告同口径；租户 B 只看到自己的数据', async () => {
  const a = await app.inject({ method: 'GET', url: '/api/standards/coverage?line=content', headers: h(T.a.jwt) });
  assert.equal(a.statusCode, 200, a.body);
  const aLine = (a.json().lines as CoverageLine[])[0]!;
  assert.equal(aLine.line, 'content');
  assert.equal(aLine.validCount, 5);
  const a2e = aLine.clauses.find((c) => c.id === 'gbt45654.A.2.e')!;
  assert.equal(a2e.tested, 5);
  assert.equal(a2e.failed, 1);
  assert.equal(a2e.verdict, 'nonconform');
  assert.equal(a2e.verdictLabel, '发现风险');
  const a1a = aLine.clauses.find((c) => c.id === 'gbt45654.A.1.a')!;
  assert.equal(a1a.verdict, 'not_tested');
  assert.equal(a1a.verdictLabel, '未测');
  assert.equal(aLine.annexMajors?.find((m) => m.code === 'A.2')?.tested, 5);

  const b = await app.inject({ method: 'GET', url: '/api/standards/coverage?line=content', headers: h(T.b.jwt) });
  const bLine = (b.json().lines as CoverageLine[])[0]!;
  assert.equal(bLine.validCount, 2);
  const b2e = bLine.clauses.find((c) => c.id === 'gbt45654.A.2.e')!;
  assert.equal(b2e.tested, 2);
  assert.equal(b2e.failed, 0);
});

test('覆盖：不带 line 返回三条线；其他线没有数据时全部为未测或不适用', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/standards/coverage', headers: h(T.a.jwt) });
  assert.equal(res.statusCode, 200, res.body);
  const lines = res.json().lines as CoverageLine[];
  assert.deepEqual(lines.map((l) => l.line), ['content', 'agent', 'endpoint']);
  for (const l of lines.filter((x) => x.line !== 'content')) {
    assert.equal(l.validCount, 0);
    assert.ok(l.clauses.every((c) => c.tested === 0), l.line);
  }
});

test('覆盖：taskId 与 targetId 收窄范围，跨租户的任务和对象按不存在处理', async () => {
  const byTask = await app.inject({ method: 'GET', url: `/api/standards/coverage?line=content&taskId=${T.a.task}`, headers: h(T.a.jwt) });
  assert.equal(byTask.statusCode, 200, byTask.body);
  assert.equal((byTask.json().lines as CoverageLine[])[0]!.validCount, 5);
  const byTarget = await app.inject({ method: 'GET', url: `/api/standards/coverage?line=content&targetId=${T.a.target}`, headers: h(T.a.jwt) });
  assert.equal((byTarget.json().lines as CoverageLine[])[0]!.taskCount, 1);

  const foreignTask = await app.inject({ method: 'GET', url: `/api/standards/coverage?taskId=${T.a.task}`, headers: h(T.b.jwt) });
  assert.equal(foreignTask.statusCode, 404, foreignTask.body);
  const foreignTarget = await app.inject({ method: 'GET', url: `/api/standards/coverage?targetId=${T.a.target}`, headers: h(T.b.jwt) });
  assert.equal(foreignTarget.statusCode, 404, foreignTarget.body);
});

test('覆盖：时间窗排除过早创建的任务；非法参数返回 400', async () => {
  await prisma.evalTask.update({ where: { id: T.b.task }, data: { createdAt: new Date(Date.now() - 100 * 86400_000) } });
  const recent = await app.inject({ method: 'GET', url: '/api/standards/coverage?line=content&days=30', headers: h(T.b.jwt) });
  assert.equal((recent.json().lines as CoverageLine[])[0]!.validCount, 0);
  const all = await app.inject({ method: 'GET', url: '/api/standards/coverage?line=content', headers: h(T.b.jwt) });
  assert.equal((all.json().lines as CoverageLine[])[0]!.validCount, 2);
  assert.equal((await app.inject({ method: 'GET', url: '/api/standards/coverage?line=nope', headers: h(T.a.jwt) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/standards/coverage?taskId=abc', headers: h(T.a.jwt) })).statusCode, 400);
});
