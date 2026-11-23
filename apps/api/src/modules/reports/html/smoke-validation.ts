import assert from 'node:assert/strict';

/** Checks the fixed Chromium PDF format used by the offline image, without a PDF parser dependency. */
export function verifyChromiumSmokePdf(pdf: Buffer, expectedPages: number, title: string): void {
  const raw = pdf.toString('latin1');
  assert.ok(raw.startsWith('%PDF-'), 'Report renderer did not produce PDF bytes');
  assert.ok(raw.trimEnd().endsWith('%%EOF'), 'Report PDF is truncated');
  assert.ok(!raw.includes('/ObjStm'), 'Unsupported compressed PDF object format in smoke check');
  assert.match(raw, /\/Producer\s*\(Skia\/PDF[^)]*\)/, 'Report PDF was not produced by Chromium');
  assert.ok(raw.includes('/Title (' + title + ')'), 'Report PDF title metadata is missing');
  const pages = (raw.match(/\/Type\s*\/Page\b/g) ?? []).length;
  assert.ok(expectedPages >= 2, 'Smoke fixture must contain multiple pages');
  assert.equal(
    pages,
    expectedPages,
    'Printed PDF page count differs from completed HTML pagination',
  );
}
