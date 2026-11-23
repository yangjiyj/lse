import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { createATemplate } from '../src/modules/reports/docx/a-template.js';

test('A模板生成含封面字段、页眉页脚及表格结构的 docx', async () => {
  const buffer = await createATemplate({ platformName: '安全评估平台', reportNo: 'R-1', subject: '对象', basis: 'GB/T 45654-2025', period: '周期', organization: '单位' }, [{ title: '符合性自评估', body: '平台参考映射/平台评分，非认证结论' }]);
  const files = unzipSync(new Uint8Array(buffer));
  const xml = new TextDecoder().decode(files['word/document.xml']);
  assert.match(xml, /被测对象/); assert.match(xml, /符合性自评估/); assert.match(xml, /w:tbl/);
  assert.match(new TextDecoder().decode(files['word/header1.xml']), /R-1/);
  assert.match(new TextDecoder().decode(files['word/footer1.xml']), /第/);
});

test('A模板支持红色未达标项、印章式结论框和分节编号', async () => {
  const buffer = await createATemplate({ platformName: '安全评估平台', reportNo: 'R-2', subject: '对象', basis: '依据', period: '周期', organization: '单位' }, [{ title: '评估结论', body: '平台参考映射/平台评分，非认证结论' }], { unmetItems: ['关键词库未达标'], conclusion: '需补充材料' });
  const xml = new TextDecoder().decode(unzipSync(new Uint8Array(buffer))['word/document.xml']);
  assert.match(xml, /关键词库未达标/);
  assert.match(xml, /8C1D18/i);
  assert.match(xml, /需补充材料/);
  assert.match(xml, /（一）评估结论/);
});

test('A模板支持自定义标题与满边框数据表', async () => {
  const buffer = await createATemplate({ platformName: '安全评估平台', reportNo: 'R-3', subject: '对象', basis: '依据', period: '周期', organization: '单位' }, [{ title: '逐条符合性', body: '说明', table: { headers: ['条款', '结论'], rows: [['B.1.1', '不符合']] } }], { title: '符合性自评估表' });
  const xml = new TextDecoder().decode(unzipSync(new Uint8Array(buffer))['word/document.xml']);
  assert.match(xml, /符合性自评估表/);
  assert.match(xml, /B\.1\.1/);
  assert.match(xml, /w:tblHeader/);
});
