// 列表导出共用工具：行数上限、CSV 拼装。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPORT_ROW_LIMIT,
  assertExportSize,
  buildCsv,
  exportTime,
  neutralizeFormula,
  restoreFormula,
} from '../src/lib/tabular-export.js';
import { AppError } from '../src/lib/errors.js';

test('单次导出最多 50000 行，超出返回 400 并提示缩小范围', () => {
  assert.equal(EXPORT_ROW_LIMIT, 50_000);
  assert.doesNotThrow(() => assertExportSize(50_000));
  assert.throws(
    () => assertExportSize(50_001),
    (err: unknown) =>
      err instanceof AppError && err.statusCode === 400 && /请缩小范围/.test(err.message),
  );
});

test('CSV 带 UTF-8 BOM，转义逗号、引号和换行，水印在首行', () => {
  const buf = buildCsv(
    ['列一', '列二'],
    [
      ['a,b', 'say "hi"\n'],
      [null, 3],
    ],
    {
      text: '平台 admin 2026-11-17 10:00:00',
      platformTitle: '平台',
      downloader: 'admin',
      downloadedAt: '2026-11-17 10:00:00',
    },
  );
  assert.equal(buf.subarray(0, 3).toString('hex'), 'efbbbf');
  assert.equal(
    buf.subarray(3).toString('utf8'),
    '# 水印：平台 admin 2026-11-17 10:00:00\r\n列一,列二\r\n"a,b","say ""hi""\n"\r\n,3\r\n',
  );
});

test('超限提示可以换成具体的缩小办法', () => {
  assert.throws(
    () => assertExportSize(50_001, '请先按分类筛选'),
    (err: unknown) =>
      err instanceof AppError && err.message === '导出超过 50000 行，请先按分类筛选',
  );
});

test('CSV 防公式注入：= + - @ 制表符 回车开头的文本加单引号，数字不处理', () => {
  const buf = buildCsv(
    ['值'],
    [['=1+1'], ['+x'], ['-y'], ['@z'], ['\tt'], ['\rr'], [-5], [3.5], ['正常'], ["'已有引号"]],
  );
  assert.deepEqual(buf.subarray(3).toString('utf8').split('\r\n'), [
    '值',
    "'=1+1",
    "'+x",
    "'-y",
    "'@z",
    "'\tt",
    '"\'\rr"',
    '-5',
    '3.5',
    '正常',
    "'已有引号",
    '',
  ]);
});

test('公式前缀可以还原：只去掉紧跟触发字符的单引号', () => {
  for (const v of ['=1+1', '+x', '-y', '@z', '\tt', '\rr']) {
    assert.equal(restoreFormula(neutralizeFormula(v)), v);
  }
  assert.equal(restoreFormula("'普通"), "'普通");
  assert.equal(restoreFormula("'"), "'");
  assert.equal(neutralizeFormula('普通'), '普通');
});

test('导出时间写北京时间', () => {
  assert.equal(exportTime(new Date('2026-11-17T16:30:05Z')), '2026-11-18 00:30:05');
  assert.equal(exportTime(null), '');
});
