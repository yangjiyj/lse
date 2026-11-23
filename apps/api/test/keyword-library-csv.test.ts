// 关键词库 CSV 导出防公式注入，导出的文件原样导回关键词不变。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/db.js';
import { parseCsv } from '../src/lib/question-import.js';
import { exportKeywordsCsv, parseKeywordImport } from '../src/modules/keyword-library/service.js';

const MARK = `kwcsv${randomUUID().slice(0, 6)}`;
const ITEM = 'A.2.e';
const TERMS = [
  `=HYPERLINK("http://e.x","${MARK}")`,
  `+${MARK} 加号开头`,
  `-${MARK} 减号开头`,
  `@${MARK} 艾特开头`,
  `'${MARK} 单引号开头`,
  `${MARK},带逗号"引号"`,
];

before(async () => {
  await prisma.standardKeyword.deleteMany({ where: { term: { contains: 'kwcsv' } } });
  await prisma.standardKeyword.createMany({
    data: TERMS.map((term) => ({ tenantId: null, itemCode: ITEM, term, source: 'manual' })),
  });
});

after(async () => {
  await prisma.standardKeyword.deleteMany({ where: { term: { contains: MARK } } });
});

test('导出 CSV 时公式触发字符开头的关键词加单引号', async () => {
  const csv = await exportKeywordsCsv(prisma, ITEM);
  const ours = parseCsv(csv).filter((r) => r[1]?.includes(MARK));
  assert.equal(ours.length, TERMS.length, csv);
  assert.ok(
    ours.some((r) => r[1] === `'=HYPERLINK("http://e.x","${MARK}")`),
    csv,
  );
  for (const row of ours) {
    for (const cell of row) {
      assert.doesNotMatch(cell, /^[=+\-@\t\r]/, `单元格「${cell}」会被 Excel 当公式执行`);
    }
  }
});

test('导入 CSV 时去掉公式触发字符前的单引号，其余单引号保留', () => {
  const parsed = parseKeywordImport(
    'csv',
    "itemCode,term\r\nA.2.e,'=1+1\r\nA.2.e,'-减号\r\nA.2.e,'普通\r\n",
    null,
  );
  assert.deepEqual(
    parsed.rows.map((r) => r.term),
    ['=1+1', '-减号', "'普通"],
  );
});

test('导出的 CSV 原样导回，关键词与原词一致', async () => {
  const csv = await exportKeywordsCsv(prisma, ITEM);
  const parsed = parseKeywordImport('csv', csv, null);
  const ours = parsed.rows.filter((r) => r.term.includes(MARK));
  assert.deepEqual(
    ours.map((r) => r.itemCode),
    TERMS.map(() => ITEM),
  );
  assert.deepEqual(ours.map((r) => r.term).sort(), [...TERMS].sort());
});
