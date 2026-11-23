import { AppError } from '../../lib/errors.js';

export type ReportRenderer = 'html' | 'pdfkit';

export interface ReportRenderers {
  html: () => Promise<Buffer>;
  pdfkit: () => Promise<Buffer>;
}

/** Honor the configured renderer; a failed HTML export must never become a different report. */
export async function renderReportDownload(
  renderer: ReportRenderer,
  renderers: ReportRenderers,
): Promise<{ buffer: Buffer; renderer: ReportRenderer }> {
  if (renderer === 'pdfkit') {
    return { buffer: await renderers.pdfkit(), renderer: 'pdfkit' };
  }
  try {
    return { buffer: await renderers.html(), renderer: 'html' };
  } catch (cause) {
    const error = new AppError(
      503,
      '报告排版服务暂不可用，未生成降级文件。请稍后重试或联系管理员检查报告渲染配置。',
      'REPORT_RENDER_FAILED',
    );
    error.cause = cause;
    throw error;
  }
}
