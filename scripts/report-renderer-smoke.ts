import assert from 'node:assert/strict';
import { buildTaskReport } from '../apps/api/src/modules/reports/report-builder.js';
import { buildReportHtmlModel } from '../apps/api/src/modules/reports/html/model.js';
import { renderReportHtmlString } from '../apps/api/src/modules/reports/html/render.js';
import { closeBrowser, renderHtmlToPdf } from '../apps/api/src/modules/reports/html/chromium.js';
import { renderReportDownload } from '../apps/api/src/modules/reports/report-renderer.js';
import { verifyChromiumSmokePdf } from '../apps/api/src/modules/reports/html/smoke-validation.js';

const title = 'LSE Report Renderer Smoke';
const end = 'LSE-SMOKE-END';
const date = new Date('2000-01-01T00:00:00Z');
// Entirely synthetic: no database, task data, credentials or model requests.
const built = buildTaskReport({
  task: {
    id: 'report-renderer-smoke',
    name: title,
    description: null,
    status: 'COMPLETED',
    concurrency: 1,
    engines: [],
    dimensions: [],
    totalQuestions: 1,
    processedQuestions: 1,
    passedCount: 1,
    failedCount: 0,
    errorCount: 0,
    createdAt: date,
    startedAt: date,
    finishedAt: date,
    modelTarget: { name: 'Synthetic', provider: 'smoke', model: 'smoke' },
    questionSets: [],
  },
  generatedAt: date,
  verdictCounts: { PASS: 1 },
  findings: [],
  engineRuns: [],
  wrongAnswers: [],
  results: [
    {
      id: 'synthetic-result',
      finalVerdict: 'PASS',
      status: 'SUCCESS',
      question: {
        content: '报告排版验证样本',
        type: 'SHOULD_ANSWER',
        shouldRefuse: false,
        language: 'zh',
        severity: null,
        category: null,
      },
    },
  ],
});
const model = buildReportHtmlModel(built, { evidenceDetail: 'none', sections: [] });
model.title = title;
const html = renderReportHtmlString(model).replace(
  '</body>',
  '<div style="break-before:page"><h1>报告渲染验收</h1><p>' + end + '</p></div></body>',
);
const configuredRenderer = process.env.REPORT_RENDERER || 'html';
assert.ok(['html', 'pdfkit'].includes(configuredRenderer), 'Unknown report renderer');
const executablePath =
  configuredRenderer === 'pdfkit' ? '/opt/lse-chromium/chrome' : process.env.REPORT_CHROMIUM_PATH;
assert.ok(executablePath, 'REPORT_CHROMIUM_PATH is required for HTML report acceptance');
async function main(): Promise<void> {
  let pageCount = 0;
  try {
    const rendered = await renderReportDownload('html', {
      html: () =>
        renderHtmlToPdf(html, {
          executablePath,
          verifyPageLayout: (layout) => {
            assert.ok(layout.pageCount >= 2, 'Report pagination did not produce multiple pages');
            assert.ok(layout.firstPageText.includes(title), 'Report cover title is missing');
            assert.ok(layout.lastPageText.includes(end), 'Report final page evidence is missing');
            pageCount = layout.pageCount;
          },
        }),
      pdfkit: async () => {
        throw new Error('Report acceptance must never fall back to PDFKit');
      },
    });
    assert.equal(rendered.renderer, 'html');
    verifyChromiumSmokePdf(rendered.buffer, pageCount, title);
    console.log(
      JSON.stringify({
        check: 'report-renderer',
        configuredRenderer,
        renderer: rendered.renderer,
        producer: 'Skia/PDF',
        pages: pageCount,
        coverVerified: true,
        finalPageVerified: true,
      }),
    );
  } finally {
    await closeBrowser();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
