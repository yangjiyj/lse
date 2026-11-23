import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyChromiumSmokePdf } from '../src/modules/reports/html/smoke-validation.js';

const title = 'LSE Report Renderer Smoke';
const fixture = (producer = 'Skia/PDF m149', pages = 2) =>
  Buffer.from(
    '%PDF-1.7\n/Title (' +
      title +
      ')\n/Producer (' +
      producer +
      ')\n' +
      Array.from({ length: pages }, () => '<< /Type /Page >>').join('\n') +
      '\n%%EOF\n',
  );
test('smoke accepts the fixed Chromium format with matching multipage output', () => {
  verifyChromiumSmokePdf(fixture(), 2, title);
});
test('smoke rejects a successful-looking PDFKit fallback', () => {
  assert.throws(() => verifyChromiumSmokePdf(fixture('PDFKit'), 2, title), /Chromium/);
});
test('smoke rejects truncated output and unfinished pagination', () => {
  assert.throws(() => verifyChromiumSmokePdf(fixture().subarray(0, 30), 2, title), /truncated/);
  assert.throws(() => verifyChromiumSmokePdf(fixture('Skia/PDF m149', 1), 2, title), /page count/);
  assert.throws(() => verifyChromiumSmokePdf(fixture(), 1, title), /multiple pages/);
});
test('smoke rejects missing cover metadata and unsupported object streams', () => {
  assert.throws(() => verifyChromiumSmokePdf(fixture(), 2, 'Wrong cover'), /title metadata/);
  assert.throws(
    () =>
      verifyChromiumSmokePdf(
        Buffer.from(fixture().toString().replace('%%EOF', '/ObjStm\n%%EOF')),
        2,
        title,
      ),
    /Unsupported/,
  );
});
