// RAG 测试集 CSV 导出防公式注入，导出的文件原样导回题目不变。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { parseCsv } from '../src/lib/question-import.js';

const PREFIX = `__rag_csvf_${randomUUID().slice(0, 6)}_`;
let app!: FastifyInstance;
let token = '';
let corpusId = '';
const auth = () => ({ authorization: `Bearer ${token}` });

const ITEMS = [
  { type: 'FACT', question: '=HYPERLINK("http://evil.example","点我")', referenceAnswer: '=1+1' },
  { type: 'FACT', question: "+cmd|' /C calc'!A0 远程命令示例", referenceAnswer: '-5 度' },
  { type: 'NO_ANSWER', question: '@SUM(1,2) 公司股票代码是什么', referenceAnswer: null },
  { type: 'FACT', question: '-2+3 等于几？', referenceAnswer: '@张三' },
  { type: 'FACT', question: "'普通单引号开头的问题", referenceAnswer: "'引号开头的答案" },
  {
    type: 'MULTI_HOP',
    question: '带逗号, 和 "引号" 的多跳问题',
    referenceAnswer: '第一行\n第二行',
  },
];

async function createSet(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/rag-eval/corpora/${corpusId}/test-sets`,
    headers: auth(),
    payload: { name: `${PREFIX}${name}`, includeSecurity: false },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

async function itemsOf(testSetId: string) {
  const rows = await prisma.ragTestItem.findMany({
    where: { testSetId },
    select: { type: true, question: true, referenceAnswer: true },
  });
  return rows.sort((a, b) => a.question.localeCompare(b.question));
}

before(async () => {
  app = await buildApp({
    ragEval: { dispatchRun: async () => undefined, cancelRun: async () => undefined },
  });
  await app.ready();
  await prisma.ragCorpus.deleteMany({ where: { name: { startsWith: '__rag_csvf_' } } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token as string;
  const corpus = await app.inject({
    method: 'POST',
    url: '/api/rag-eval/corpora',
    headers: auth(),
    payload: { name: `${PREFIX}库` },
  });
  assert.equal(corpus.statusCode, 201, corpus.body);
  corpusId = corpus.json().id as string;
});

after(async () => {
  await prisma.ragCorpus.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await app.close();
});

test('导出 CSV 时公式触发字符开头的单元格加单引号，导回后题目与原题一致', async () => {
  const from = await createSet('源');
  await prisma.ragTestItem.createMany({
    data: ITEMS.map((i) => ({ ...i, testSetId: from, sourceChunkIds: [], origin: 'MANUAL' })),
  });

  const exp = await app.inject({
    method: 'GET',
    url: `/api/rag-eval/test-sets/${from}/items/export?format=csv`,
    headers: auth(),
  });
  assert.equal(exp.statusCode, 200, exp.body);
  const table = parseCsv(exp.body);
  assert.deepEqual(table[0], ['type', 'question', 'reference_answer', 'source_chunk_ids']);
  const cells = table.slice(1).flat();
  assert.ok(cells.includes(`'=HYPERLINK("http://evil.example","点我")`), exp.body);
  for (const cell of cells) {
    assert.doesNotMatch(cell, /^[=+\-@\t\r]/, `单元格「${cell}」会被 Excel 当公式执行`);
  }

  const to = await createSet('导回');
  const imp = await app.inject({
    method: 'POST',
    url: `/api/rag-eval/test-sets/${to}/items/import`,
    headers: auth(),
    payload: { format: 'csv', content: exp.body },
  });
  assert.equal(imp.statusCode, 200, imp.body);
  assert.deepEqual(imp.json(), { imported: ITEMS.length, duplicates: 0 });
  assert.deepEqual(await itemsOf(to), await itemsOf(from));
});
