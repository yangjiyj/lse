import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { syncBuiltinComplianceSets } from '../src/modules/question-sets/builtin/seed.js';
import { buildComplianceSetSeeds } from '../src/modules/question-sets/builtin/build.js';

const PFX = 'BTQ_';
let app!: FastifyInstance;
let token = '';
let tc260Id = '';
const auth = () => ({ authorization: `Bearer ${token}` });

before(async () => {
  app = await buildApp();
  await app.ready();
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PFX } } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;
});

after(async () => {
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PFX } } });
  await app.close();
  await prisma.$disconnect();
});

test('幂等 seed：重复执行不重复插入', async () => {
  await syncBuiltinComplianceSets(prisma);
  const second = await syncBuiltinComplianceSets(prisma);
  assert.ok(second.every((r) => !r.created && r.added === 0));
  const expected = buildComplianceSetSeeds();
  for (const [i, r] of second.entries()) {
    const n = await prisma.question.count({ where: { questionSetId: r.setId } });
    assert.equal(n, expected[i]!.questions.length);
    const set = await prisma.questionSet.findUniqueOrThrow({ where: { id: r.setId } });
    assert.equal(set.isBuiltin, true);
  }
  tc260Id = second[0]!.setId;
});

test('GET /builtin/stats：未登录 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/question-sets/builtin/stats' });
  assert.equal(res.statusCode, 401);
});

test('GET /builtin/stats：契约结构', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/question-sets/builtin/stats',
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), [
    'builtinQuestionTotal',
    'builtinSetCount',
    'categories',
    'ownSetCount',
  ]);
  assert.ok(body.builtinSetCount >= 3);
  assert.equal(typeof body.ownSetCount, 'number');
  const cats = body.categories as {
    taxonomy: string;
    major: string;
    minor: string;
    count: number;
  }[];
  assert.deepEqual(Object.keys(cats[0]!).sort(), ['count', 'major', 'minor', 'taxonomy']);
  assert.equal(cats.filter((c) => c.taxonomy === 'tc260').length, 31);
  // 信通院、能源行业两套已下线，不再出现在统计里。
  assert.equal(cats.filter((c) => c.taxonomy === 'caict' || c.taxonomy === 'energy').length, 0);
  const sum = cats.reduce((a, c) => a + c.count, 0);
  assert.ok(sum <= body.builtinQuestionTotal);
});

test('内置题库不可删改：返回 403', async () => {
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/question-sets/${tc260Id}`,
    headers: auth(),
  });
  assert.equal(del.statusCode, 403, del.body);
  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/question-sets/${tc260Id}`,
    headers: auth(),
    payload: { name: `${PFX}改名` },
  });
  assert.equal(patch.statusCode, 403, patch.body);
  const q = await prisma.question.findFirstOrThrow({ where: { questionSetId: tc260Id } });
  const qp = await app.inject({
    method: 'PATCH',
    url: `/api/question-sets/questions/${q.id}`,
    headers: auth(),
    payload: { content: 'x' },
  });
  assert.equal(qp.statusCode, 403, qp.body);
  const qd = await app.inject({
    method: 'DELETE',
    url: `/api/question-sets/questions/${q.id}`,
    headers: auth(),
  });
  assert.equal(qd.statusCode, 403, qd.body);
});

test('复制为自有题库：可编辑、带元数据、记审计', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/question-sets/${tc260Id}/copy`,
    headers: auth(),
    payload: { name: `${PFX}副本` },
  });
  assert.equal(res.statusCode, 201, res.body);
  const copy = await prisma.questionSet.findUniqueOrThrow({
    where: { id: res.json().id },
    include: { questions: { take: 1 } },
  });
  assert.equal(copy.isBuiltin, false);
  assert.ok(!copy.tags.includes('内置'));
  assert.ok((copy.questions[0]!.metadata as { minor?: string }).minor);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'question_set.copy', targetId: copy.id },
  });
  assert.ok(audit);
  const dup = await app.inject({
    method: 'POST',
    url: `/api/question-sets/${tc260Id}/copy`,
    headers: auth(),
    payload: { name: `${PFX}副本` },
  });
  assert.equal(dup.statusCode, 409);
});

test('GET /builtin/browse：小类浏览与统计同口径——跨在用内置库列出，只列在用题，带所属题库', async () => {
  const gen = await prisma.questionSet.create({ data: { name: `${PFX}国标生成`, isBuiltin: true, source: 'btq:gen' } });
  const ref = await prisma.questionSet.create({ data: { name: `${PFX}国标应拒答`, isBuiltin: true, source: 'btq:refusal' } });
  const own = await prisma.questionSet.create({ data: { name: `${PFX}自有库`, isBuiltin: false, source: 'btq:own' } });
  await prisma.question.createMany({
    data: [
      { questionSetId: gen.id, content: `${PFX}在用一`, category: 'A.1.a' },
      { questionSetId: gen.id, content: `${PFX}已下线`, category: 'A.1.a', metadata: { retired: true } },
      { questionSetId: gen.id, content: `${PFX}待生效`, category: 'A.1.a', metadata: { pendingVersion: '2099.1.1' } },
      { questionSetId: ref.id, content: `${PFX}在用二`, category: 'A.1.a' },
      { questionSetId: ref.id, content: `${PFX}别的小类`, category: 'A.1.b' },
      { questionSetId: own.id, content: `${PFX}自有题`, category: 'A.1.a' },
    ],
  });
  const stats = (await app.inject({ method: 'GET', url: '/api/question-sets/builtin/stats', headers: auth() })).json();
  const expected = (stats.categories as { taxonomy: string; minor: string; count: number }[]).find(
    (c) => c.taxonomy === 'tc260' && c.minor === '煽动颠覆国家政权、推翻社会主义制度',
  )!.count;

  const unauth = await app.inject({ method: 'GET', url: '/api/question-sets/builtin/browse?minor=A.1.a' });
  assert.equal(unauth.statusCode, 401);
  const bad = await app.inject({ method: 'GET', url: '/api/question-sets/builtin/browse?minor=Z.9.z', headers: auth() });
  assert.equal(bad.statusCode, 409);

  const seen: { content: string; setName: string; setSource: string | null }[] = [];
  let total = -1;
  for (let page = 1; page <= 50; page += 1) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/question-sets/builtin/browse?minor=A.1.a&page=${page}&pageSize=100`,
      headers: auth(),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    total = body.total;
    seen.push(...body.items);
    if (seen.length >= total || body.items.length === 0) break;
  }
  assert.equal(total, expected, '浏览的总数和小类题数一致');
  assert.equal(seen.length, total);
  const mine = seen.filter((x) => x.content.startsWith(PFX));
  assert.deepEqual(
    mine.map((x) => [x.content, x.setName, x.setSource]).sort(),
    [
      [`${PFX}在用一`, `${PFX}国标生成`, 'btq:gen'],
      [`${PFX}在用二`, `${PFX}国标应拒答`, 'btq:refusal'],
    ].sort(),
  );
});
