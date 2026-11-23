import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  aiComponentsApi,
  ApiError,
  type AiComponentFindingItem,
  type AiComponentReviewStatus,
} from '@/lib/api';
import { severityLabel } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { JUDGE_STATUS_LABEL, REVIEW_LABEL, SEVERITY_BORDER } from './labels';
import { ToolChangeDiff } from './ToolChangeDiff';

export function FindingCard({
  f,
  scanId,
  canScan,
}: {
  f: AiComponentFindingItem;
  scanId: string;
  canScan: boolean;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const refresh = () =>
    void qc.invalidateQueries({ queryKey: ['ai-components', 'findings', scanId] });
  const review = useMutation({
    mutationFn: (status: AiComponentReviewStatus) => aiComponentsApi.review(f.id, { status }),
    onSuccess: () => {
      toast.success('复核结论已保存');
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '保存失败'),
  });
  const accept = useMutation({
    mutationFn: () => aiComponentsApi.acceptBaseline(f.id),
    onSuccess: () => {
      toast.success('已将当前描述确认为新基线');
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '操作失败'),
  });
  const judge = f.detail?.judge;
  const more = (f.detail?.totalLocations ?? f.locations.length) - f.locations.length;
  const tax = (f.taxonomy ?? []).filter((t) => t.framework.startsWith('AIG_')).map((t) => t.id);

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span
          className={`mt-0.5 shrink-0 rounded-lg border px-1.5 text-xs leading-5 ${SEVERITY_BORDER[f.severity]}`}
        >
          {severityLabel(f.severity)}
        </span>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="text-left text-sm font-medium text-slate-900 hover:text-brand-600"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
          >
            {f.title}
          </button>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-500">
            <span>
              {f.filePath ?? '—'}
              {f.line ? `:${f.line}` : ''}
            </span>
            <span>置信度 {Math.round(f.confidence * 100)}%</span>
            {tax.length ? <span>分类 {tax.join('、')}</span> : null}
            {judge && judge.status !== 'NOT_NEEDED' ? (
              <span>{JUDGE_STATUS_LABEL[judge.status] ?? judge.status}</span>
            ) : null}
            <span>{REVIEW_LABEL[f.reviewStatus]}</span>
          </div>
        </div>
      </div>
      {open ? (
        <div className="space-y-2 border-t border-slate-200 px-3 py-2.5 text-xs leading-5 text-slate-700">
          <p>{f.description}</p>
          <div className="space-y-1">
            {f.locations.map((l, i) => (
              <div key={i} className="rounded-lg bg-slate-50 px-2 py-1 font-mono">
                <span className="text-slate-500">
                  {l.path}:{l.line}
                  {l.toolName ? ` · 工具 ${l.toolName}` : ''}
                </span>
                <div className="whitespace-pre-wrap break-all">{l.excerpt}</div>
              </div>
            ))}
            {more > 0 ? <p className="text-slate-500">另有 {more} 处同类命中未展开</p> : null}
          </div>
          {f.ruleId === 'mcp.rug_pull' &&
          f.detail?.baseline?.previousDescription !== undefined &&
          f.detail.currentTool ? (
            <ToolChangeDiff
              baseline={{
                description: f.detail.baseline.previousDescription ?? null,
                inputSchema: f.detail.baseline.previousInputSchema ?? null,
                annotations: f.detail.baseline.previousAnnotations ?? null,
                inputSchemaRecorded: f.detail.baseline.inputSchemaRecorded ?? false,
              }}
              current={{
                description: f.detail.currentTool.description,
                inputSchema: f.detail.currentTool.inputSchema ?? null,
                annotations: f.detail.currentTool.annotations ?? null,
              }}
            />
          ) : null}
          {judge?.reason || judge?.note ? (
            <p className="text-slate-500">模型复核：{judge.reason ?? judge.note}</p>
          ) : null}
          <p>
            <span className="text-slate-500">修复建议：</span>
            {f.remediation}
          </p>
          {canScan ? (
            <div className="flex flex-wrap gap-3 pt-1">
              {(['CONFIRMED', 'FALSE_POSITIVE', 'PENDING'] as const)
                .filter((s) => s !== f.reviewStatus)
                .map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="text-brand-600 hover:underline disabled:text-slate-400"
                    disabled={review.isPending}
                    onClick={() => review.mutate(s)}
                  >
                    {s === 'PENDING' ? '撤销复核' : `标记为${REVIEW_LABEL[s]}`}
                  </button>
                ))}
              {f.ruleId === 'mcp.rug_pull' && f.reviewStatus !== 'FALSE_POSITIVE' ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={accept.isPending}
                  onClick={() => accept.mutate()}
                >
                  确认变更并更新基线
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
