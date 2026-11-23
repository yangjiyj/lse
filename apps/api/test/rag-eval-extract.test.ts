import { test } from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import JSZip from 'jszip';
import {
  RagExtractError,
  chunkText,
  detectFormat,
  extractDocumentText,
} from '../src/modules/rag-eval/extract.js';

/** 用 pdfkit 生成一份真实 PDF（标准字体仅支持拉丁字符）。 */
export function makePdf(lines: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const parts: Buffer[] = [];
    doc.on('data', (c: Buffer) => parts.push(c));
    doc.on('end', () => resolve(Buffer.concat(parts)));
    doc.on('error', reject);
    for (const line of lines) doc.text(line);
    doc.end();
  });
}

/** 生成最小可用的 DOCX（word/document.xml + 内容类型 + 关系）。 */
export async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('detectFormat 识别支持的扩展名', () => {
  assert.equal(detectFormat('a.TXT'), 'txt');
  assert.equal(detectFormat('b.markdown'), 'md');
  assert.equal(detectFormat('c.pdf'), 'pdf');
  assert.equal(detectFormat('d.docx'), 'docx');
  assert.equal(detectFormat('e.doc'), null);
  assert.equal(detectFormat('noext'), null);
});

test('txt/md 按 UTF-8 解码并规范换行，非 UTF-8 报错', async () => {
  const text = await extractDocumentText(Buffer.from('\uFEFF第一段\r\n\r\n\r\n第二段  \r\n'), 'md');
  assert.equal(text, '第一段\n\n第二段');
  await assert.rejects(
    extractDocumentText(Buffer.from([0xff, 0xfe, 0xfd]), 'txt'),
    (e: unknown) => e instanceof RagExtractError && /UTF-8/.test((e as Error).message),
  );
  await assert.rejects(extractDocumentText(Buffer.alloc(0), 'txt'), RagExtractError);
});

test('真实 PDF 可提取文本', async () => {
  const pdf = await makePdf([
    'Refund policy: returns accepted within 30 days.',
    'Support hotline 400-800-1234.',
  ]);
  const text = await extractDocumentText(pdf, 'pdf');
  assert.match(text, /returns accepted within 30 days/);
  assert.match(text, /400-800-1234/);
});

test('真实 DOCX 可提取文本（含中文）', async () => {
  const docx = await makeDocx([
    '差旅报销须在出差结束后十五个工作日内提交。',
    '住宿标准为每晚五百元。',
  ]);
  const text = await extractDocumentText(docx, 'docx');
  assert.match(text, /十五个工作日内提交/);
  assert.match(text, /每晚五百元/);
});

test('损坏的 PDF/DOCX 返回解析失败', async () => {
  await assert.rejects(extractDocumentText(Buffer.from('not a pdf'), 'pdf'), RagExtractError);
  await assert.rejects(extractDocumentText(Buffer.from('not a zip'), 'docx'), RagExtractError);
});

test('chunkText 按自然断点切块、带重叠且可追溯原文区间', () => {
  const para = '这是一句用于测试切块的中文句子。'.repeat(30);
  const text = `${para}\n\n${para}`;
  const chunks = chunkText(text, { size: 200, overlap: 40 });
  assert.ok(chunks.length > 3);
  chunks.forEach((c, i) => {
    assert.equal(c.seq, i);
    assert.ok(c.content.length <= 200);
    assert.equal(text.slice(c.charStart, c.charEnd), c.content);
  });
  assert.ok(chunks[0]!.content.endsWith('。'));
  assert.ok(chunks[1]!.charStart < chunks[0]!.charEnd, '相邻块应有重叠');
  assert.deepEqual(chunkText('短文本'), [{ seq: 0, content: '短文本', charStart: 0, charEnd: 3 }]);
});
