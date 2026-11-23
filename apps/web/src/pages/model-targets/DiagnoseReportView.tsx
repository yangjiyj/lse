import { CheckCircle2, AlertTriangle, XCircle, MinusCircle } from 'lucide-react';
import type { ModelTargetDiagnoseReport } from '@/lib/api';
import { formatLatency } from '@/lib/format';

const STATUS_META = {
  pass: { text: '通过', className: 'text-severity-pass', Icon: CheckCircle2 },
  warn: { text: '警告', className: 'text-severity-medium', Icon: AlertTriangle },
  fail: { text: '失败', className: 'text-destructive', Icon: XCircle },
  skip: { text: '未检查', className: 'text-muted-foreground', Icon: MinusCircle },
} as const;

/** 接入诊断结果：逐项展示 通过/警告/失败 与中文建议。 */
export function DiagnoseReportView({ report }: { report: ModelTargetDiagnoseReport }) {
  return (
    <section aria-label="接入诊断结果" className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span
          className={
            report.ok ? 'font-semibold text-severity-pass' : 'font-semibold text-destructive'
          }
        >
          {report.ok ? '诊断通过' : '诊断发现问题'}
        </span>
        <span className="text-xs text-muted-foreground">
          HTTP {report.httpStatus ?? '-'} · 耗时 {formatLatency(report.latencyMs)}
          {report.contentType ? ` · ${report.contentType}` : ''}
        </span>
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {report.checks.map((check) => {
          const meta = STATUS_META[check.status];
          return (
            <li key={check.key} className="flex gap-3 p-3" data-testid={`diagnose-${check.key}`}>
              <meta.Icon
                className={`mt-0.5 h-4 w-4 shrink-0 ${meta.className}`}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{check.label}</span>
                  <span className={`text-xs ${meta.className}`}>{meta.text}</span>
                </div>
                <p className="mt-0.5 break-all text-sm text-foreground/90">{check.message}</p>
                {check.suggestion && (
                  <p className="mt-0.5 text-xs text-muted-foreground">建议：{check.suggestion}</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {report.answerSample && (
        <div className="text-sm">
          <span className="text-muted-foreground">读取到的回答：</span>
          <span className="break-all">{report.answerSample}</span>
        </div>
      )}
      {report.responsePreview && (
        <details className="rounded-md border border-border p-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">响应原文预览（已脱敏）</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono">
            {report.responsePreview}
          </pre>
        </details>
      )}
    </section>
  );
}
