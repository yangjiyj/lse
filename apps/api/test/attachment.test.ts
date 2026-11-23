// 附件下载响应头：报告下载与列表导出共用一个实现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentDisposition } from '../src/lib/attachment.js';

test('中文文件名：ASCII 兜底名 + UTF-8 原名，路径和保留字符换成空格', () => {
  assert.equal(
    attachmentDisposition('报告/一:二.pdf', 'llm-safety-report.pdf'),
    `attachment; filename="llm-safety-report.pdf"; filename*=UTF-8''${encodeURIComponent('报告 一 二.pdf')}`,
  );
});

test('没给兜底名时：纯 ASCII 文件名直接兜底，否则用 download.<扩展名>', () => {
  assert.equal(
    attachmentDisposition('report (1).csv'),
    `attachment; filename="report (1).csv"; filename*=UTF-8''report%20%281%29.csv`,
  );
  assert.match(attachmentDisposition('任务日志.json'), /^attachment; filename="download\.json";/);
});

test('兜底名的扩展名只取 1～10 位字母数字，引号、分号拼不进响应头', () => {
  const header = attachmentDisposition(`工具.x";filename*=UTF-8''evil`);
  assert.match(header, /^attachment; filename="download\.bin"; filename\*=UTF-8''[^;"'\s]+$/);
  assert.equal(header.match(/filename\*=/g)?.length, 1, '只能有一个 filename*');
  assert.match(attachmentDisposition('报告.PDF'), /^attachment; filename="download\.PDF";/);
  assert.match(attachmentDisposition('报告.abcdefghijk'), /^attachment; filename="download\.bin";/);
  assert.match(attachmentDisposition('报告'), /^attachment; filename="download\.bin";/);
});

test('去掉 Unicode 双向控制符，防止把扩展名伪装成别的', () => {
  const header = attachmentDisposition('发票\u202Efdp.exe');
  const name = decodeURIComponent(header.split("UTF-8''")[1]!);
  assert.equal(name, '发票fdp.exe');
  assert.match(header, /filename="download\.exe"/);
  for (const c of ['\u202A', '\u202B', '\u202C', '\u202D', '\u2066', '\u2067', '\u2068', '\u2069'])
    assert.equal(
      decodeURIComponent(attachmentDisposition(`a${c}b.txt`).split("UTF-8''")[1]!),
      'ab.txt',
    );
});

test('文件名清理后为空时用兜底名', () => {
  assert.equal(
    attachmentDisposition('///', 'x.html'),
    `attachment; filename="x.html"; filename*=UTF-8''x.html`,
  );
});
