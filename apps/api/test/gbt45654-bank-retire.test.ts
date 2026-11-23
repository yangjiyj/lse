import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../src/db.js';
import {
  buildAllBankSetSeeds,
  isRetiredQuestion,
  syncGbt45654Banks,
  type BankSetSeed,
} from '../src/modules/question-sets/builtin/gbt45654-bank.js';
import { computeBankCoverage } from '../src/modules/question-sets/builtin/bank-service.js';
import { loadBank } from '../src/modules/standard-evaluations/gbt45654/pipeline.js';
import { syncBuiltinKeywords } from '../src/modules/keyword-library/seed.js';

// 用独立的 source（builtin:gbt45654:zz-retire-test）演练「按版本对齐」，不动真实的三个题集，避免和并行测试互相影响。
const SOURCE = 'builtin:gbt45654:zz-retire-test';

async function cleanup() {
  await prisma.question.deleteMany({ where: { questionSet: { source: SOURCE } } });
  await prisma.questionSet.deleteMany({ where: { source: SOURCE } });
}
after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

function fakeSeed(version: string, keep: number[]): BankSetSeed {
  const base = buildAllBankSetSeeds().find((s) => s.bank === 'generation')!;
  const questions = keep.map((i) => {
    const q = base.questions[i]!;
    return {
      ...q,
      externalId: `${SOURCE}:${i}`,
      content: `${q.content}（版本演练${i}）`,
      metadata: { ...q.metadata, annexItem: 'A.4.g', clauseIds: ['gbt45654.A.4.g'] },
    };
  });
  return { ...base, source: SOURCE, metadata: { ...base.metadata, version }, questions };
}

test('isRetiredQuestion：只认 metadata.retired === true', () => {
  assert.equal(isRetiredQuestion({ retired: true }), true);
  assert.equal(isRetiredQuestion({ retired: false }), false);
  assert.equal(isRetiredQuestion({ retired: 'true' }), false);
  assert.equal(isRetiredQuestion(null), false);
  assert.equal(isRetiredQuestion([]), false);
});

test('按版本对齐：新版本没有的旧题标记下线、不物理删除，重新出现时恢复；覆盖统计排除下线题', async () => {
  await cleanup();
  const countA4g = async () =>
    (await computeBankCoverage(prisma)).find((b) => b.bank === 'generation')!.rows.find((r) => r.key === 'A.4.g')!.count;
  const base = await countA4g();

  const v1 = await syncGbt45654Banks(prisma, [fakeSeed('2026.11.1', [0, 1, 2, 3])]);
  assert.equal(v1[0]!.added, 4);
  assert.equal(v1[0]!.retired, 0);
  assert.equal(await countA4g(), base + 4);

  const v2 = await syncGbt45654Banks(prisma, [fakeSeed('2026.11.2', [0, 1])]);
  assert.equal(v2[0]!.added, 0);
  assert.equal(v2[0]!.retired, 2);
  const rows = await prisma.question.findMany({ where: { questionSet: { source: SOURCE } }, orderBy: { externalId: 'asc' } });
  assert.equal(rows.length, 4, '不物理删除');
  const retired = rows.filter((r) => isRetiredQuestion(r.metadata));
  assert.deepEqual(retired.map((r) => r.externalId), [`${SOURCE}:2`, `${SOURCE}:3`]);
  for (const r of retired) assert.equal((r.metadata as any).retiredInVersion, '2026.11.2');
  assert.equal(await countA4g(), base + 2, '下线题不计入覆盖');
  assert.equal(
    (await prisma.questionSet.findFirstOrThrow({ where: { source: SOURCE } })).metadata && ((await prisma.questionSet.findFirstOrThrow({ where: { source: SOURCE } })).metadata as any).version,
    '2026.11.2',
  );

  // 再跑一次：幂等
  const again = await syncGbt45654Banks(prisma, [fakeSeed('2026.11.2', [0, 1])]);
  assert.equal(again[0]!.retired, 0);
  assert.equal(again[0]!.restored, 0);

  // 重新出现：恢复上线
  const v3 = await syncGbt45654Banks(prisma, [fakeSeed('2026.11.3', [0, 1, 2])]);
  assert.equal(v3[0]!.restored, 1);
  assert.equal(v3[0]!.retired, 0); // 3 号仍不在，但已经标过下线，不重复计数
  const two = await prisma.question.findFirstOrThrow({ where: { externalId: `${SOURCE}:2` } });
  assert.equal(isRetiredQuestion(two.metadata), false);
  assert.equal((two.metadata as any).retiredInVersion, undefined);
  await cleanup();
});

test('抽样取题（loadBank）排除下线题', async () => {
  const mk = (id: string, retired: boolean) => ({
    id,
    externalId: id,
    content: id,
    expectedBehavior: null,
    metadata: { bank: 'generation', annexItem: 'A.2.a', clauseIds: ['gbt45654.A.2.a'], ...(retired ? { retired: true, retiredInVersion: '2026.11.2' } : {}) },
  });
  const stub = {
    questionSet: { findMany: async () => [{ id: 'set1', metadata: { version: '2026.11.2', sha256: 'x' } }] },
    question: { findMany: async () => [mk('q1', false), mk('q2', true), mk('q3', false)] },
  } as unknown as PrismaClient;
  const bank = await loadBank(stub, 'generation');
  assert.deepEqual(bank.questions.map((q) => q.id), ['q1', 'q3']);
  assert.equal(bank.summary.total, 2);
  assert.equal(bank.summary.perStratum['A.2.a'], 2);
});

test('关键词版本对齐：旧版本有、新版本没有的内置词（候选、生效）标为已剔除，停用的不碰', async () => {
  await syncBuiltinKeywords(prisma);
  const stale = await prisma.standardKeyword.createMany({
    data: [
      { tenantId: null, itemCode: 'A.2.a', term: '版本对齐演练-候选旧词', source: 'builtin:gbt45654', reviewStatus: 'pending' },
      { tenantId: null, itemCode: 'A.2.a', term: '版本对齐演练-生效旧词', source: 'builtin:gbt45654', reviewStatus: 'approved' },
      { tenantId: null, itemCode: 'A.2.a', term: '版本对齐演练-停用旧词', source: 'builtin:gbt45654', reviewStatus: 'disabled' },
    ],
  });
  assert.equal(stale.count, 3);
  try {
    const r = await syncBuiltinKeywords(prisma);
    assert.equal(r.rejected, 2);
    const st = async (term: string) =>
      (await prisma.standardKeyword.findFirstOrThrow({ where: { tenantId: null, term } })).reviewStatus;
    assert.equal(await st('版本对齐演练-候选旧词'), 'rejected');
    assert.equal(await st('版本对齐演练-生效旧词'), 'rejected');
    assert.equal(await st('版本对齐演练-停用旧词'), 'disabled');
    const again = await syncBuiltinKeywords(prisma);
    assert.equal(again.rejected, 0);
  } finally {
    await prisma.standardKeyword.deleteMany({ where: { term: { startsWith: '版本对齐演练-' } } });
  }
});

test('关键词版本对齐：新版本里重新出现、此前被标为已剔除的平台词恢复为生效；停用的词不恢复', async () => {
  await syncBuiltinKeywords(prisma);
  const [victim, off] = await prisma.standardKeyword.findMany({
    where: { tenantId: null, source: 'builtin:gbt45654', reviewStatus: { in: ['approved', 'pending'] } },
    take: 2,
    orderBy: { term: 'asc' },
  });
  await prisma.standardKeyword.update({ where: { id: victim!.id }, data: { reviewStatus: 'rejected' } });
  await prisma.standardKeyword.update({ where: { id: off!.id }, data: { reviewStatus: 'disabled' } });
  try {
    const r = await syncBuiltinKeywords(prisma);
    assert.equal(r.restored, 1);
    assert.equal((await prisma.standardKeyword.findUniqueOrThrow({ where: { id: victim!.id } })).reviewStatus, 'approved');
    assert.equal((await prisma.standardKeyword.findUniqueOrThrow({ where: { id: off!.id } })).reviewStatus, 'disabled');
    const again = await syncBuiltinKeywords(prisma);
    assert.equal(again.restored, 0);
  } finally {
    await prisma.standardKeyword.update({ where: { id: off!.id }, data: { reviewStatus: off!.reviewStatus } });
  }
});

test('关键词同步：数据集里有、仍是候选的内置词改为生效；停用的不碰；幂等', async () => {
  await syncBuiltinKeywords(prisma);
  const [p, off] = await prisma.standardKeyword.findMany({
    where: { tenantId: null, source: 'builtin:gbt45654', reviewStatus: 'approved' },
    take: 2,
    orderBy: { term: 'asc' },
    skip: 10,
  });
  await prisma.standardKeyword.update({ where: { id: p!.id }, data: { reviewStatus: 'pending' } });
  await prisma.standardKeyword.update({ where: { id: off!.id }, data: { reviewStatus: 'disabled' } });
  try {
    const r = await syncBuiltinKeywords(prisma);
    assert.equal(r.promoted, 1);
    assert.equal((await prisma.standardKeyword.findUniqueOrThrow({ where: { id: p!.id } })).reviewStatus, 'approved');
    assert.equal((await prisma.standardKeyword.findUniqueOrThrow({ where: { id: off!.id } })).reviewStatus, 'disabled');
    assert.equal((await syncBuiltinKeywords(prisma)).promoted, 0);
  } finally {
    await prisma.standardKeyword.update({ where: { id: off!.id }, data: { reviewStatus: 'approved' } });
  }
});

test('关键词同步：数据集里的词已有同名的每周更新词（候选）时，把那一行改成内置来源并生效；停用的不碰', async () => {
  await syncBuiltinKeywords(prisma);
  const [w, d] = await prisma.standardKeyword.findMany({
    where: { tenantId: null, source: 'builtin:gbt45654', reviewStatus: 'approved' },
    take: 2,
    orderBy: { term: 'desc' },
    skip: 10,
  });
  await prisma.standardKeyword.deleteMany({ where: { id: { in: [w!.id, d!.id] } } });
  const auto = await prisma.standardKeyword.create({
    data: { tenantId: null, itemCode: w!.itemCode, term: w!.term, source: 'auto:weekly', reviewStatus: 'pending' },
  });
  const autoOff = await prisma.standardKeyword.create({
    data: { tenantId: null, itemCode: d!.itemCode, term: d!.term, source: 'auto:weekly', reviewStatus: 'disabled' },
  });
  try {
    const r = await syncBuiltinKeywords(prisma);
    assert.equal(r.added, 0, '不再补一条同名内置词');
    assert.equal(r.adopted, 1);
    const row = await prisma.standardKeyword.findUniqueOrThrow({ where: { id: auto.id } });
    assert.equal(row.source, 'builtin:gbt45654');
    assert.equal(row.reviewStatus, 'approved');
    const off = await prisma.standardKeyword.findUniqueOrThrow({ where: { id: autoOff.id } });
    assert.deepEqual({ source: off.source, reviewStatus: off.reviewStatus }, { source: 'auto:weekly', reviewStatus: 'disabled' });
    assert.equal((await syncBuiltinKeywords(prisma)).adopted, 0);
  } finally {
    await prisma.standardKeyword.update({ where: { id: autoOff.id }, data: { source: 'builtin:gbt45654', reviewStatus: 'approved' } });
  }
});

test('关键词同步：新写入的内置词就是生效；已有的停用词不被改回', async () => {
  await syncBuiltinKeywords(prisma);
  const [gone, off] = await prisma.standardKeyword.findMany({
    where: { tenantId: null, source: 'builtin:gbt45654', reviewStatus: { in: ['approved', 'pending'] } },
    take: 2,
    orderBy: { term: 'desc' },
  });
  await prisma.standardKeyword.delete({ where: { id: gone!.id } });
  await prisma.standardKeyword.update({ where: { id: off!.id }, data: { reviewStatus: 'disabled' } });
  try {
    const r = await syncBuiltinKeywords(prisma);
    assert.equal(r.added, 1);
    const back = await prisma.standardKeyword.findFirstOrThrow({
      where: { tenantId: null, itemCode: gone!.itemCode, term: gone!.term },
    });
    assert.equal(back.reviewStatus, 'approved');
    assert.equal(back.source, 'builtin:gbt45654');
    assert.equal((await prisma.standardKeyword.findUniqueOrThrow({ where: { id: off!.id } })).reviewStatus, 'disabled');
  } finally {
    await prisma.standardKeyword.update({ where: { id: off!.id }, data: { reviewStatus: off!.reviewStatus } });
  }
});
