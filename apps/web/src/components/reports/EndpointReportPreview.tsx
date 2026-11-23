import { useMemo } from 'react';
import type { Report } from '@/lib/api';
import { useBranding } from '@/lib/branding';
import {
  renderEndpointReportHtml,
  type EndpointReportInput,
} from '../../../../../packages/shared/src/endpoint-report-html';

/** 终端智能体测评报告的在线预览：与 PDF/HTML 导出共用同一个渲染器，所见即所得。 */
export function EndpointReportPreview({ report }: { report: Report }) {
  const { platformTitle } = useBranding();
  const summary = report.summary.endpointSummary as unknown as EndpointReportInput;
  const html = useMemo(
    () =>
      renderEndpointReportHtml(
        summary,
        {
          title: summary.mode === 'posture' ? '智能体配置体检报告' : '智能体运行态安全测评报告',
          reportId: report.id,
          classification: '内部使用',
          generatedAt: report.createdAt,
          ...((summary as { assessedAt?: string }).assessedAt
            ? { assessedAt: (summary as { assessedAt?: string }).assessedAt! }
            : {}),
          platformName: platformTitle,
        },
        { preview: true },
      ),
    [summary, report.id, report.createdAt, platformTitle],
  );
  return (
    <iframe
      title="终端测评报告预览"
      srcDoc={html}
      sandbox=""
      className="h-[78vh] w-full rounded-lg border border-line bg-white"
    />
  );
}
