import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { parseBankImport } from '../src/modules/question-sets/builtin/bank-service.js';
import { parseKeywordImport } from '../src/modules/keyword-library/service.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';

// 本测试只用 A.1.a、A.1.b 与独有的题目文本（带 TAG），按「导入前后的差值」断言，便于和并行测试、内置题库隔离。
const TAG = `路由测试${Date.now().toString(36)}`;
const auth = () => ({ authorization: `Bearer ${token}` });

async function cleanup() {
  await prisma.question.deleteMany({ where: { questionSet: { source: { startsWith: 'import:gbt45654:' } } } });
  await prisma.questionSet.deleteMany({ where: { source: { startsWith: 'import:gbt45654:' } } });
  await prisma.standardKeyword.deleteMany({ where: { source: { startsWith: 'import:' } } });
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
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

const count = (cov: any, bank: string, key: string): number =>
  cov.banks.find((b: any) => b.bank === bank).rows.find((r: any) => r.key === key).count;

test('解析：CSV 与 JSONL 的字段校验与错误行', () => {
  const csv = parseBankImport(
    'csv',
    'itemCode,content,bank\r\nA.1.a,题目一,generation\r\nA.9.z,题目二,generation\r\nA.3.a,题目三,refusal\r\nA.2.e,,refusal\r\nA.2.e,题目五,乱写\r\n,非拒答题目,non_refusal\r\n信仰,非拒答题目二,non_refusal\r\n',
    null,
  );
  assert.equal(csv.totalRows, 7);
  assert.equal(csv.rows.length, 3);
  assert.equal(csv.issues.length, 4);
  assert.ok(csv.issues.some((i) => /A\.9\.z.*不存在/.test(i.message)));
  assert.ok(csv.issues.some((i) => /只覆盖 A\.1、A\.2/.test(i.message)));
  assert.ok(csv.issues.some((i) => /为空/.test(i.message)));
  assert.ok(csv.issues.some((i) => /不认识/.test(i.message)));
  assert.equal(csv.rows[2]!.aspect, '信仰');

  const jsonl = parseBankImport(
    'jsonl',
    '{"itemCode":"A.2.e","content":"甲","bank":"应拒答"}\nnot json\n\n{"itemCode":"a.1.b","content":"乙"}\n',
    'generation',
  );
  assert.equal(jsonl.rows.length, 2);
  assert.equal(jsonl.rows[1]!.itemCode, 'A.1.b');
  assert.equal(jsonl.rows[1]!.bank, 'generation');
  assert.equal(jsonl.issues.length, 1);

  const noCols = parseBankImport('csv', 'a,b\r\n1,2\r\n', null);
  assert.equal(noCols.rows.length, 0);
  assert.match(noCols.issues[0]!.message, /表头缺少/);
});

test('解析：关键词 CSV（带表头 / 无表头）与 TXT（指定小项 / 每行带小项）', () => {
  const a = parseKeywordImport('csv', 'itemCode,term\r\nA.1.a,词甲\r\nA.1.b,词乙\r\n', null);
  assert.deepEqual(a.rows, [
    { itemCode: 'A.1.a', term: '词甲' },
    { itemCode: 'A.1.b', term: '词乙' },
  ]);
  const b = parseKeywordImport('csv', '小项,关键词\r\nA.2.e,词丙\r\n', null);
  assert.equal(b.rows.length, 1);
  const c = parseKeywordImport('csv', 'A.2.e,词丁\r\nA.2.f,词戊\r\n', null);
  assert.equal(c.rows.length, 2);
  const d = parseKeywordImport('txt', '词一\n\n词二 \n', 'A.2.a');
  assert.deepEqual(d.rows.map((r) => r.term), ['词一', '词二']);
  const e = parseKeywordImport('txt', 'A.2.a,词三\nA.2.b\t词四\n没有小项的词\n', null);
  assert.equal(e.rows.length, 2);
  assert.equal(e.issues.length, 1);
  const f = parseKeywordImport('txt', 'x'.repeat(60), 'A.2.a');
  assert.equal(f.rows.length, 0);
  assert.match(f.issues[0]!.message, /超过 50 字/);
});

test('路由：未登录 401', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/question-sets/builtin/bank-coverage' });
  assert.equal(r.statusCode, 401);
  const k = await app.inject({ method: 'GET', url: '/api/question-sets/builtin/keywords/coverage' });
  assert.equal(k.statusCode, 401);
});

test('路由：导入题目后与题库合并统计，重复题跳过，错误行如实返回', async () => {
  const before0 = (await app.inject({ method: 'GET', url: '/api/question-sets/builtin/bank-coverage', headers: auth() })).json();
  assert.equal(before0.banks.length, 3);
  const baseGen = count(before0, 'generation', 'A.1.a');
  const baseRef = count(before0, 'refusal', 'A.2.e');
  const baseNon = before0.banks.find((b: any) => b.bank === 'non_refusal').rows.find((r: any) => r.key === '信仰').count;

  const csv =
    'itemCode,content,bank\r\n' +
    `A.1.a,${TAG}甲：请以文章形式展开某主题,generation\r\n` +
    `A.1.a,${TAG}乙：请换个角度再写一遍,generation\r\n` +
    `A.2.e,${TAG}丙：一条应拒答的提问,refusal\r\n` +
    `信仰,${TAG}丁：介绍一种宗教的节日,non_refusal\r\n` +
    `A.3.a,${TAG}戊：应拒答库不收 A.3,refusal\r\n` +
    `A.1.a,${TAG}甲：请以文章形式展开某主题,generation\r\n`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/question-sets/builtin/bank-import',
    headers: auth(),
    payload: { format: 'csv', filename: 'guobiao.csv', content: csv },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.totalRows, 6);
  assert.equal(body.imported, 4);
  assert.equal(body.duplicates, 1);
  assert.equal(body.failed, 1);
  assert.equal(body.byBank.generation, 2);
  assert.match(body.issues[0].message, /只覆盖 A\.1、A\.2/);

  const after1 = (await app.inject({ method: 'GET', url: '/api/question-sets/builtin/bank-coverage', headers: auth() })).json();
  assert.equal(count(after1, 'generation', 'A.1.a'), baseGen + 2);
  assert.equal(count(after1, 'refusal', 'A.2.e'), baseRef + 1);
  assert.equal(
    after1.banks.find((b: any) => b.bank === 'non_refusal').rows.find((r: any) => r.key === '信仰').count,
    baseNon + 1,
  );
  // 31 项都有内置题，A.1.a 不再标「需导入」；是否达标只看数量
  const rowA1a = after1.banks.find((b: any) => b.bank === 'generation').rows.find((r: any) => r.key === 'A.1.a');
  assert.equal(rowA1a.importOnly, false);
  assert.equal(rowA1a.ok, rowA1a.count >= rowA1a.min);

  // 导入的题带契约元数据
  const q = await prisma.question.findFirstOrThrow({ where: { content: { contains: `${TAG}丙` } } });
  const meta = q.metadata as any;
  assert.deepEqual(meta.clauseIds, ['gbt45654.A.2.e']);
  assert.equal(meta.bank, 'refusal');
  assert.equal(meta.annexItem, 'A.2.e');
  assert.equal(q.shouldRefuse, true);
  assert.equal(meta.provenance.method, 'user-import');

  // 同一文件再导一次：全部是重复
  const again = await app.inject({
    method: 'POST',
    url: '/api/question-sets/builtin/bank-import',
    headers: auth(),
    payload: { format: 'csv', filename: 'guobiao.csv', content: csv },
  });
  assert.equal(again.json().imported, 0);
  assert.equal(again.json().duplicates, 5);
});

test('路由：JSONL 导入、缺 bank 列时用默认题库、全错时返回 400', async () => {
  const ok = await app.inject({
    method: 'POST',
    url: '/api/question-sets/builtin/bank-import',
    headers: auth(),
    payload: {
      format: 'jsonl',
      filename: 'a.jsonl',
      bank: '应拒答',
      content: `{"itemCode":"A.1.b","content":"${TAG}己：另一条提问"}\n{"itemCode":"A.1.b","content":"${TAG}庚：再一条提问"}\n`,
    },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().byBank.refusal, 2);

  const bad = await app.inject({
    method: 'POST',
    url: '/api/question-sets/builtin/bank-import',
    headers: auth(),
    payload: { format: 'csv', filename: 'bad.csv', content: 'itemCode,content,bank\r\nZZ,题,generation\r\n' },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /不存在/);

  const badBank = await app.inject({
    method: 'POST',
    url: '/api/question-sets/builtin/bank-import',
    headers: auth(),
    payload: { format: 'csv', filename: 'x.csv', content: 'itemCode,content\r\nA.1.a,x\r\n', bank: '乱写' },
  });
  assert.equal(badBank.statusCode, 409);

  const tpl = await app.inject({ method: 'GET', url: '/api/question-sets/builtin/bank-import/template', headers: auth() });
  assert.equal(tpl.statusCode, 200);
  assert.match(tpl.body, /itemCode,content,bank/);
});

test('路由：关键词导入、列表、覆盖统计、导出', async () => {
  const cov0 = (await app.inject({ method: 'GET', url: '/api/question-sets/builtin/keywords/coverage', headers: auth() })).json();
  const row0 = cov0.rows.find((r: any) => r.key === 'A.1.a');
  assert.equal(row0.min, 200);
  assert.equal(row0.importOnly, false);
  const base = row0.count as number;

  const imp = await app.inject({
    method: 'POST',
    url: '/api/question-sets/builtin/keywords/import',
    headers: auth(),
    payload: {
      format: 'txt',
      filename: 'k.txt',
      itemCode: 'A.1.a',
      content: `${TAG}词一\n${TAG}词二\n${TAG}词一\n`,
    },
  });
  assert.equal(imp.statusCode, 200, imp.body);
  assert.equal(imp.json().added, 2);
  assert.equal(imp.json().duplicates, 1);

  const imp2 = await app.inject({
    method: 'POST',
    url: '/api/question-sets/builtin/keywords/import',
    headers: auth(),
    payload: {
      format: 'csv',
      filename: 'k.csv',
      content: `itemCode,term\r\nA.1.a,${TAG}词二\r\nA.1.b,${TAG}词三\r\nQQ,${TAG}词四\r\n`,
    },
  });
  assert.equal(imp2.statusCode, 200, imp2.body);
  assert.equal(imp2.json().added, 1);
  assert.equal(imp2.json().duplicates, 1);
  assert.equal(imp2.json().failed, 1);

  const cov1 = (await app.inject({ method: 'GET', url: '/api/question-sets/builtin/keywords/coverage', headers: auth() })).json();
  assert.equal(cov1.rows.find((r: any) => r.key === 'A.1.a').count, base + 2);
  assert.ok(cov1.byStatus.approved >= 3);
  const rowA1aKw = cov1.rows.find((r: any) => r.key === 'A.1.a');
  assert.equal(cov1.gaps.some((g: any) => g.key === 'A.1.a'), rowA1aKw.count < rowA1aKw.min);

  const list = (
    await app.inject({
      method: 'GET',
      url: `/api/question-sets/builtin/keywords?itemCode=A.1.a&keyword=${encodeURIComponent(TAG)}`,
      headers: auth(),
    })
  ).json();
  assert.equal(list.total, 2);
  assert.equal(list.items[0].reviewStatusLabel, '在用');
  assert.equal(list.items[0].itemName, '煽动颠覆国家政权、推翻社会主义制度');

  const exp = await app.inject({ method: 'GET', url: '/api/question-sets/builtin/keywords/export?itemCode=A.1.b', headers: auth() });
  assert.equal(exp.statusCode, 200);
  assert.match(exp.headers['content-type'] as string, /text\/csv/);
  assert.ok(exp.body.includes(`A.1.b,${TAG}词三`));
  assert.ok(!exp.body.includes('A.1.a,'));

  const badItem = await app.inject({
    method: 'POST',
    url: '/api/question-sets/builtin/keywords/import',
    headers: auth(),
    payload: { format: 'txt', filename: 'k.txt', itemCode: 'A.9.z', content: '词' },
  });
  assert.equal(badItem.statusCode, 409);

  const empty = await app.inject({
    method: 'POST',
    url: '/api/question-sets/builtin/keywords/import',
    headers: auth(),
    payload: { format: 'txt', filename: 'k.txt', content: '没有指定小项' },
  });
  assert.equal(empty.statusCode, 400);
});
