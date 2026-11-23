import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/lib/errors.js';
import { ChromiumUnavailableError } from '../src/modules/reports/html/chromium.js';
import { renderReportDownload } from '../src/modules/reports/report-renderer.js';

test('HTML 成功时交付原始渲染结果并记录实际渲染器', async () => {
  const expected = Buffer.from('%PDF-html');
  let pdfkitCalls = 0;
  const result = await renderReportDownload('html', {
    html: async () => expected,
    pdfkit: async () => {
      pdfkitCalls += 1;
      return Buffer.from('%PDF-pdfkit');
    },
  });
  assert.equal(result.buffer, expected);
  assert.equal(result.renderer, 'html');
  assert.equal(pdfkitCalls, 0);
});

for (const [label, cause, synchronous] of [
  ['浏览器不可用', new ChromiumUnavailableError('无法启动 chromium'), false],
  ['分页超时', new Error('Pagination timeout'), false],
  ['模型构建失败', new Error('Invalid report model'), true],
] as const) {
  test('HTML ' + label + '时返回明确 503，禁止隐式降级 PDFKit', async () => {
    let pdfkitCalls = 0;
    await assert.rejects(
      renderReportDownload('html', {
        html: synchronous
          ? () => {
              throw cause;
            }
          : async () => {
              throw cause;
            },
        pdfkit: async () => {
          pdfkitCalls += 1;
          return Buffer.from('%PDF-degraded');
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.statusCode, 503);
        assert.equal(error.code, 'REPORT_RENDER_FAILED');
        assert.match(error.message, /报告.*重试/);
        assert.equal(error.cause, cause);
        assert.equal(error.details, undefined);
        return true;
      },
    );
    assert.equal(pdfkitCalls, 0);
  });
}

test('显式配置 PDFKit 时保持兼容，不尝试启动 HTML 渲染器', async () => {
  const expected = Buffer.from('%PDF-explicit-pdfkit');
  let htmlCalls = 0;
  const result = await renderReportDownload('pdfkit', {
    html: async () => {
      htmlCalls += 1;
      throw new Error('HTML unavailable');
    },
    pdfkit: async () => expected,
  });
  assert.equal(result.buffer, expected);
  assert.equal(result.renderer, 'pdfkit');
  assert.equal(htmlCalls, 0);
});

test('显式 PDFKit 的错误保持原样，不伪装成成功下载', async () => {
  const cause = new Error('Missing PDFKit font');
  await assert.rejects(
    renderReportDownload('pdfkit', {
      html: async () => Buffer.from('%PDF-html'),
      pdfkit: async () => {
        throw cause;
      },
    }),
    (error: unknown) => error === cause,
  );
});
