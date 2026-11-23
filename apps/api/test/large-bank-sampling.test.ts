import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { builtinSetSource } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { syncBuiltinDatasetSets } from '../src/modules/question-sets/builtin/dataset.js';
import { loadTaskQuestions } from '../src/modules/eval-tasks/sampling.js';

// 大规模内置题库（约 10 万题）：抽样评测与按小类复制的端到端校验。
const PFX = '__lbs_';
let app!: FastifyInstance;
let token = '';
let setId = '';
let modelTargetId = '';
const auth = () => ({ authorization: `Bearer ${token}` });

async function cleanup() {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PFX } } });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  const [r] = await syncBuiltinDatasetSets(prisma);
  setId = r!.setId;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' }, // pragma: allowlist secret
  });
  token = login.json().token;
  const m = await app.inject({
    method: 'POST',
    url: '/api/model-targets',
    headers: auth(),
    payload: {
      name: `${PFX}模型`,
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'dummy-secret-lbs-1234567890', // pragma: allowlist secret
      model: 'fake',
    },
  });
  assert.equal(m.statusCode, 201, m.body);
  modelTargetId = m.json().id;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('内置数据集题库：重复同步幂等，题量不低于 99000', async () => {
  const [r] = await syncBuiltinDatasetSets(prisma);
  assert.equal(r!.created, false);
  assert.equal(r!.added, 0);
  const set = await prisma.questionSet.findFirstOrThrow({
    where: { source: builtinSetSource('safety') },
  });
  assert.equal(set.isBuiltin, true);
  const n = await prisma.question.count({ where: { questionSetId: set.id } });
  assert.ok(n >= 99000, `仅 ${n} 题`);
});

test('抽样评测任务：totalQuestions=抽样数，种子落库，取题覆盖 13 个小类且可复现', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: auth(),
    payload: {
      name: `${PFX}抽样任务`,
      modelTargetId,
      questionSetIds: [setId],
      sampleSize: 200,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const b = res.json();
  assert.equal(b.totalQuestions, 200);
  assert.equal(b.sampleSize, 200);
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: b.id } });
  assert.ok(task.sampleSeed);
  const qs = await loadTaskQuestions(prisma, [setId], task.sampleSize, task.sampleSeed);
  assert.equal(qs.length, 200);
  assert.equal(new Set(qs.map((q) => q.category)).size, 13);
  const again = await loadTaskQuestions(prisma, [setId], task.sampleSize, task.sampleSeed);
  assert.deepEqual(
    again.map((q) => q.id),
    qs.map((q) => q.id),
  );
});

test('抽样题数越界 → 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/eval-tasks',
    headers: auth(),
    payload: {
      name: `${PFX}越界`,
      modelTargetId,
      questionSetIds: [setId],
      sampleSize: 20001,
    },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('按小类复制大题库：只复制所选小类，题数与库内一致', async () => {
  const cats = ['SAFETY.role_play', 'SAFETY.prompt_leaking'];
  const expected = await prisma.question.count({
    where: { questionSetId: setId, category: { in: cats } },
  });
  const res = await app.inject({
    method: 'POST',
    url: `/api/question-sets/${setId}/copy`,
    headers: auth(),
    payload: { name: `${PFX}角色扮演与提示泄露`, categories: cats },
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().id;
  assert.equal(res.json().questionCount, expected);
  const n = await prisma.question.count({ where: { questionSetId: id } });
  assert.equal(n, expected);
  const other = await prisma.question.count({
    where: { questionSetId: id, category: { notIn: cats } },
  });
  assert.equal(other, 0);
  const sample = await prisma.question.findFirstOrThrow({ where: { questionSetId: id } });
  assert.ok(!sample.tags.includes('内置'));
});
