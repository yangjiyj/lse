// 种子库列表：国标三个题库除了表里的总题数 questionCount，还返回在用题数 activeQuestionCount
// （不含按版本下线的 retired 和自动更新尚未生效的 pendingVersion），种子库页按它和附录 B 的规模要求比较。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BANK_SOURCES } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { syncGbt45654Banks } from '../src/modules/question-sets/builtin/gbt45654-bank.js';

const TAG = `activecnt${Date.now().toString(36)}`;
let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';

before(async () => {
  app = await buildApp();
  await app.ready();
  await syncGbt45654Banks(prisma);
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: ['Admin', '@', '12345'].join('') },
  });
  assert.equal(r.statusCode, 200, r.body);
  token = r.json().token;
});

after(async () => {
  await prisma.question.deleteMany({ where: { externalId: { startsWith: TAG } } });
  await app.close();
  await prisma.$disconnect();
});

test('种子库列表：国标题库返回在用题数，不含已下线和尚未生效的题；其他题源在用题数等于总题数', async () => {
  const gen = await prisma.questionSet.findFirstOrThrow({
    where: { source: BANK_SOURCES.generation, tenantId: null },
  });
  const tpl = await prisma.question.findFirstOrThrow({ where: { questionSetId: gen.id } });
  const extra = (n: number, metadata: object) =>
    prisma.question.create({
      data: {
        questionSetId: gen.id,
        tenantId: null,
        externalId: `${TAG}-${n}`,
        content: `${TAG} 第 ${n} 题`,
        category: tpl.category,
        expectedBehavior: tpl.expectedBehavior,
        type: tpl.type,
        severity: tpl.severity,
        shouldRefuse: tpl.shouldRefuse,
        language: 'zh',
        tags: tpl.tags,
        metadata,
      },
    });
  const list = async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/question-sets?kind=seed&pageSize=100',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().items as Array<{
      source: string | null;
      questionCount: number;
      activeQuestionCount: number;
    }>;
  };
  const before = (await list()).find((s) => s.source === BANK_SOURCES.generation)!;
  assert.equal(typeof before.activeQuestionCount, 'number');

  await extra(1, {
    bank: 'generation',
    annexItem: 'A.1.a',
    retired: true,
    retiredInVersion: '2026.11.1',
  });
  await extra(2, { bank: 'generation', annexItem: 'A.1.a', pendingVersion: '2099.01.1' });
  await extra(3, { bank: 'generation', annexItem: 'A.1.a' });

  const items = await list();
  const after = items.find((s) => s.source === BANK_SOURCES.generation)!;
  assert.equal(after.questionCount, before.questionCount + 3, 'questionCount 是表里的总行数');
  assert.equal(
    after.activeQuestionCount,
    before.activeQuestionCount + 1,
    '在用题数只多了那道正常题',
  );
  assert.ok(after.activeQuestionCount < after.questionCount);
  const active = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "questions" q WHERE q."questionSetId" = ${gen.id}
      AND COALESCE(q."metadata"->>'retired', 'false') <> 'true' AND (q."metadata"->>'pendingVersion') IS NULL`;
  assert.equal(after.activeQuestionCount, active[0]!.n);

  const other = items.find((s) => s.source && !s.source.startsWith('builtin:gbt45654'));
  assert.ok(other, '至少有一个其他题源');
  assert.equal(other.activeQuestionCount, other.questionCount);
});
