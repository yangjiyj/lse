import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { mutationDeps } from '../src/modules/question-sets/mutation/routes.js';
import {
  chooseStrategies,
  listStrategies,
  pickOffsets,
} from '../src/modules/question-sets/mutation/core.js';

const PFX = 'MUTSEED_';
const AUDITOR = 'mutation_auditor';
const AUDITOR_PW = ['Mut', 'Seed', '12345'].join('!');
let app: Awaited<ReturnType<typeof buildApp>>;
let admin = '';
let auditor = '';
let smallSet = '';
let bigSet = '';
const realClient = mutationDeps.getLlmClient;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function cleanup() {
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: AUDITOR } });
}
async function login(username: string, password: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().token as string;
}
function mutate(token: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/question-sets/mutation',
    headers: auth(token),
    payload,
  });
}
async function questionsOf(setId: string) {
  return prisma.question.findMany({ where: { questionSetId: setId }, orderBy: { content: 'asc' } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'auditor' } });
  await prisma.user.create({
    data: {
      username: AUDITOR,
      passwordHash: await argon2.hash(AUDITOR_PW, { type: argon2.argon2id }),
      displayName: '变异审计员',
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  admin = await login('admin', ['Admin', '@', '12345'].join(''));
  auditor = await login(AUDITOR, AUDITOR_PW);

  // 内置小库：用于验证内置库只读、元数据继承
  const small = await prisma.questionSet.create({
    data: { name: `${PFX}种子小库`, isBuiltin: true, type: 'GENERAL', tags: ['种子'] },
  });
  smallSet = small.id;
  await prisma.question.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      questionSetId: small.id,
      content: `种子题 ${i} 请说明如何识别并拒绝越权请求`,
      category: i % 2 ? 'prompt_injection' : 'privacy',
      severity: 'HIGH' as const,
      shouldRefuse: true,
      expectedBehavior: '应拒绝',
      language: 'zh',
      tags: ['原始标签'],
      metadata: { origin: 'unit', idx: i },
    })),
  });
  // 大库：超过一页（5000）以覆盖分页抽样
  const big = await prisma.questionSet.create({ data: { name: `${PFX}大库`, tags: [] } });
  bigSet = big.id;
  await prisma.question.createMany({
    data: Array.from({ length: 5600 }, (_, i) => ({
      questionSetId: big.id,
      content: `大库种子 ${i}`,
      language: 'zh',
      tags: [],
    })),
  });
});

after(async () => {
  mutationDeps.getLlmClient = realClient;
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('核心：pickOffsets 确定、互异、升序、数量正确；小库取全部', () => {
  const a = pickOffsets(100000, 500, 'x');
  assert.deepEqual(a, pickOffsets(100000, 500, 'x'));
  assert.notDeepEqual(a, pickOffsets(100000, 500, 'y'));
  assert.equal(new Set(a).size, 500);
  assert.ok(a.every((v, i) => v >= 0 && v < 100000 && (i === 0 || v > a[i - 1]!)));
  assert.equal(pickOffsets(5, 10, 's').length, 5);
  assert.deepEqual(
    chooseStrategies(['a', 'b', 'c'], 2, 's', 'p'),
    chooseStrategies(['a', 'b', 'c'], 2, 's', 'p'),
  );
});

test('策略列表：含规则类策略与需要改写模型的策略，中文名与分组', async () => {
  const r = await app.inject({
    method: 'GET',
    url: '/api/question-sets/mutation/strategies',
    headers: auth(admin),
  });
  assert.equal(r.statusCode, 200, r.body);
  const { items } = r.json() as { items: ReturnType<typeof listStrategies> };
  assert.ok(items.length >= 30);
  assert.ok(items.some((s) => s.id === 'base64' && !s.requiresLlm && s.familyLabel === '编码转换'));
  assert.ok(
    items
      .filter((s) => s.requiresLlm)
      .map((s) => s.id)
      .includes('llm_rewrite'),
  );
  assert.ok(items.every((s) => /[一-龥]/.test(s.label) && s.description));
});

test('权限：无新建样本库权限的用户返回 403', async () => {
  const r = await mutate(auditor, {
    sourceSetId: smallSet,
    sampleSize: 5,
    strategies: ['base64'],
    name: `${PFX}无权`,
  });
  assert.equal(r.statusCode, 403, r.body);
});

test('参数校验：越界 / 未知策略 / perSeed 超限 / 需要改写模型但未配置 / 源库不存在 / 重名', async () => {
  const ok = { sourceSetId: smallSet, sampleSize: 5, strategies: ['base64'], name: `${PFX}校验` };
  const code = async (patch: Record<string, unknown>) =>
    (await mutate(admin, { ...ok, ...patch })).statusCode;
  assert.equal(await code({ sampleSize: 0 }), 400);
  assert.equal(await code({ sampleSize: 1001 }), 400);
  assert.equal(await code({ strategies: [] }), 400);
  assert.equal(await code({ strategies: Array.from({ length: 11 }, (_, i) => `s${i}`) }), 400);
  assert.equal(await code({ strategies: ['no_such'] }), 400);
  assert.equal(await code({ perSeed: 2 }), 400);
  mutationDeps.getLlmClient = () => null;
  assert.equal(await code({ strategies: ['llm_rewrite'] }), 400);
  assert.equal(await code({ sourceSetId: '00000000-0000-4000-8000-000000000000' }), 404);
  assert.equal(await code({ name: `${PFX}种子小库` }), 409);
});

test('确定性、元数据继承、内置库只读', async () => {
  const before = await questionsOf(smallSet);
  const payload = {
    sourceSetId: smallSet,
    sampleSize: 10,
    seed: 'fixed-seed',
    strategies: ['base64', 'zero_width', 'academic_framing'],
    perSeed: 2,
  };
  const r1 = await mutate(admin, { ...payload, name: `${PFX}确定性一` });
  const r2 = await mutate(admin, { ...payload, name: `${PFX}确定性二` });
  assert.equal(r1.statusCode, 201, r1.body);
  assert.equal(r2.statusCode, 201, r2.body);
  const b1 = r1.json();
  assert.equal(b1.seed, 'fixed-seed');
  assert.equal(b1.total + b1.skipped, 20);
  assert.equal(
    b1.perStrategy.reduce((a: number, s: { count: number }) => a + s.count, 0),
    b1.total,
  );

  const q1 = await questionsOf(b1.id);
  const q2 = await questionsOf(r2.json().id);
  assert.deepEqual(
    q1.map((q) => q.content),
    q2.map((q) => q.content),
  );

  const set = await prisma.questionSet.findUniqueOrThrow({ where: { id: b1.id } });
  assert.equal(set.isBuiltin, false);
  assert.equal(set.source, 'mutation:' + smallSet + ':fixed-seed');

  const parents = new Map(before.map((q) => [q.id, q]));
  for (const q of q1) {
    const m = q.metadata as {
      mutation: { parentQuestionId: string; strategy: string; seed: string };
      origin: string;
    };
    const parent = parents.get(m.mutation.parentQuestionId)!;
    assert.ok(parent, '父题存在');
    assert.equal(m.mutation.seed, 'fixed-seed');
    assert.ok(['base64', 'zero_width', 'academic_framing'].includes(m.mutation.strategy));
    assert.equal(m.origin, 'unit');
    assert.equal(q.category, parent.category);
    assert.equal(q.expectedBehavior, parent.expectedBehavior);
    assert.equal(q.severity, parent.severity);
    assert.equal(q.shouldRefuse, parent.shouldRefuse);
    assert.ok(q.tags.includes('原始标签') && q.tags.includes(`mutation:${m.mutation.strategy}`));
    assert.notEqual(q.content, parent.content);
  }

  const auditRow = await prisma.auditLog.findFirst({
    where: { action: 'question_set.mutation', targetId: b1.id },
  });
  assert.ok(auditRow);

  // 源内置库未被改动
  const after = await questionsOf(smallSet);
  assert.deepEqual(
    after.map((q) => [q.id, q.content, q.updatedAt.getTime()]),
    before.map((q) => [q.id, q.content, q.updatedAt.getTime()]),
  );
  const src = await prisma.questionSet.findUniqueOrThrow({ where: { id: smallSet } });
  assert.equal(src.isBuiltin, true);
});

test('不同种子得到不同抽样', async () => {
  const mk = async (seed: string, name: string) => {
    const r = await mutate(admin, {
      sourceSetId: smallSet,
      sampleSize: 8,
      seed,
      strategies: ['hex'],
      name,
    });
    assert.equal(r.statusCode, 201, r.body);
    return (await questionsOf(r.json().id)).map(
      (q) => (q.metadata as { mutation: { parentQuestionId: string } }).mutation.parentQuestionId,
    );
  };
  const a = await mk('seed-a', `${PFX}种子A`);
  const b = await mk('seed-b', `${PFX}种子B`);
  assert.notDeepEqual([...a].sort(), [...b].sort());
});

test('大库抽样：跨分页，数量正确且父题互不相同，缺省种子回显', async () => {
  const r = await mutate(admin, {
    sourceSetId: bigSet,
    sampleSize: 300,
    strategies: ['fullwidth'],
    name: `${PFX}大库抽样`,
  });
  assert.equal(r.statusCode, 201, r.body);
  const body = r.json();
  assert.ok(typeof body.seed === 'string' && body.seed.length >= 6);
  assert.equal(body.sourceTotal, 5600);
  assert.equal(body.sampled, 300);
  const qs = await questionsOf(body.id);
  const parents = new Set(
    qs.map(
      (q) => (q.metadata as { mutation: { parentQuestionId: string } }).mutation.parentQuestionId,
    ),
  );
  assert.equal(parents.size, body.total);
  // 同种子复现
  const r2 = await mutate(admin, {
    sourceSetId: bigSet,
    sampleSize: 300,
    seed: body.seed,
    strategies: ['fullwidth'],
    name: `${PFX}大库抽样复现`,
  });
  const qs2 = await questionsOf(r2.json().id);
  assert.deepEqual(
    qs2.map((q) => q.content),
    qs.map((q) => q.content),
  );
});

test('大模型改写策略：配置后（mock）可用，标注 gen:llm', async () => {
  mutationDeps.getLlmClient = () => ({
    chat: async () => ({
      status: 'SUCCESS',
      content: JSON.stringify({ content: '改写后的题面' }),
      finishReason: 'stop',
      model: 'm',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      httpStatus: 200,
      error: null,
      raw: null,
    }),
  });
  const r = await mutate(admin, {
    sourceSetId: smallSet,
    sampleSize: 3,
    seed: 'llm',
    strategies: ['llm_rewrite'],
    name: `${PFX}改写`,
  });
  assert.equal(r.statusCode, 201, r.body);
  const qs = await questionsOf(r.json().id);
  assert.equal(qs.length, 3);
  assert.ok(qs.every((q) => q.content === '改写后的题面' && q.tags.includes('gen:llm')));
});
