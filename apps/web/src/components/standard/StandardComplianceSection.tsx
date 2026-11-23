import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileCheck2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoadingBlock } from '@/components/ui/spinner';
import { NonComplianceList } from '@/components/standard/NonComplianceList';
import { riskCategoryLabel, standardTrainingDataLabel, type BadgeTone } from '@/lib/format';

const GROUP_LABELS: Record<string, string> = {
  MANUAL_SAFETY: '人工输出安全合格率',
  TECHNICAL_SAFETY: '技术输出安全合格率',
  SHOULD_REFUSE: '应拒答问题拒答率',
  NON_REFUSAL: '非拒答问题拒答率',
};

const RUNNING_STATUSES = new Set(['PENDING', 'QUEUED', 'RUNNING', 'WAITING_REVIEW']);

function statusLabel(status: string | undefined): { text: string; tone: BadgeTone } {
  switch ((status ?? '').toUpperCase()) {
    case 'PENDING':
      return { text: '待执行', tone: 'neutral' };
    case 'QUEUED':
      return { text: '排队中', tone: 'info' };
    case 'RUNNING':
      return { text: '执行中', tone: 'info' };
    case 'WAITING_REVIEW':
      return { text: '待复核', tone: 'warning' };
    case 'COMPLETED':
      return { text: '已完成', tone: 'success' };
    case 'CANCELED':
      return { text: '已取消', tone: 'neutral' };
    default:
      return { text: status ?? '—', tone: 'neutral' };
  }
}

function conclusionLabel(conclusion: string | undefined): { text: string; tone: BadgeTone } {
  switch ((conclusion ?? '').toUpperCase()) {
    case 'ATTAINED':
      return { text: '达到阈值', tone: 'success' };
    case 'NOT_ATTAINED':
      return { text: '未达到阈值', tone: 'critical' };
    case 'INSUFFICIENT_EVIDENCE':
      return { text: '证据不足', tone: 'warning' };
    default:
      return { text: conclusion ?? '—', tone: 'neutral' };
  }
}

/**
 * 任务里的国标符合情况：四项指标 + 不合格项。
 * 覆盖度必须和结论一起显示 —— 只跑了部分风险类别的"达标"不能被读成整项合规。
 */
export function StandardComplianceSection({ runId }: { runId: string }) {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const summary = useQuery({
    queryKey: ['standard-summary', runId],
    queryFn: () => api.standardEvaluations.summary(runId),
    refetchInterval: (query) =>
      RUNNING_STATUSES.has((query.state.data?.status ?? '').toUpperCase()) ? 5_000 : false,
  });

  const report = useMutation({
    mutationFn: () => api.standardEvaluations.generateReport(runId),
    onSuccess: () => {
      toast.success('国标对标报告已生成。');
      void queryClient.invalidateQueries({ queryKey: ['standard-summary', runId] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '生成报告失败'),
  });

  if (summary.isLoading) return <LoadingBlock label="正在加载国标符合情况…" />;
  if (summary.isError || !summary.data) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-slate-500">国标符合情况加载失败。</CardContent>
      </Card>
    );
  }

  const data = summary.data;
  const metrics = data.metrics.groups ?? {};
  const status = statusLabel(data.status);
  const conclusion = conclusionLabel(data.conclusion);
  const progress = data.progress;
  const coverage = data.coverage;
  const attained = Object.values(metrics).filter((m) => m.conclusion === 'ATTAINED').length;
  const measured = Object.keys(metrics).length;
  const notAttained = Object.values(metrics).filter((m) => m.conclusion === 'NOT_ATTAINED').length;
  const insufficient = Object.values(metrics).filter(
    (m) => m.conclusion === 'INSUFFICIENT_EVIDENCE',
  ).length;
  // 指标达标数要和结论一起读：有未达标指标时明示，避免「3 项达标」被读成整体通过。
  const metricsSummary =
    measured > 0
      ? `${measured} 项指标中 ${attained} 项达标${
          notAttained > 0 ? `，${notAttained} 项未达阈值` : ''
        }${insufficient > 0 ? `，${insufficient} 项证据不足` : ''}`
      : '尚未产生指标';

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <FileCheck2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <h2 className="font-semibold text-slate-900">GB/T 45654 输出安全符合情况</h2>
              <p className="text-xs text-slate-500">
                {metricsSummary} · {standardTrainingDataLabel(data.trainingData)}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>{status.text}</Badge>
            <Badge tone={conclusion.tone}>{conclusion.text}</Badge>
            <Button
              variant="outline"
              size="sm"
              disabled={
                !hasPermission('standard_report:generate') ||
                report.isPending ||
                data.status !== 'COMPLETED'
              }
              onClick={() => report.mutate()}
            >
              {report.isPending ? '生成中…' : '生成对标报告'}
            </Button>
          </div>
        </div>

        {progress && progress.total > 0 && progress.ratio < 1 && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>执行进度</span>
              <span>
                {progress.processed}/{progress.total} 条
              </span>
            </div>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.processed}
              className="h-2 w-full overflow-hidden rounded-full bg-slate-200"
            >
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.round(progress.ratio * 100)}%` }}
              />
            </div>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-4">
          {Object.entries(GROUP_LABELS).map(([group, label]) => {
            const metric = metrics[group];
            return (
              <div key={group} className="rounded-lg border border-slate-200 p-4">
                <div className="text-xs text-slate-500">{label}</div>
                <div className="mt-2 text-xl font-semibold">
                  {metric?.ratioPercent == null ? '—' : `${metric.ratioPercent.toFixed(2)}%`}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {metric
                    ? `${metric.numerator}/${metric.denominator} · ${conclusionLabel(metric.conclusion).text}`
                    : '尚无判定证据'}
                </div>
              </div>
            );
          })}
        </div>

        {coverage &&
          (coverage.missingCategories.length > 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
              <div className="font-medium">结论只覆盖本次抽样范围</div>
              本次样本覆盖 {coverage.coveredCategories.length} 个国标风险类别
              {coverage.missingCoreCategories.length > 0 ? (
                <>
                  ，<strong>{coverage.missingCoreCategories.length} 个核心类别没有样本</strong>（
                  {coverage.missingCoreCategories
                    .slice(0, 6)
                    .map((code) => riskCategoryLabel(code))
                    .join('、')}
                  {coverage.missingCoreCategories.length > 6 ? ' 等' : ''}）
                </>
              ) : (
                <>，还有 {coverage.missingCategories.length} 个非核心类别未抽到</>
              )}
              。提高各组抽样条数可以覆盖更多类别。以上指标不代表整项国标认证。
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">
              本次样本覆盖<strong>全部 {coverage.coveredCategories.length} 个国标风险类别</strong>与{' '}
              {coverage.coveredTopics.length} 个非拒答主题。
              指标仅基于本次抽样的样本量，不代表整项国标认证。
            </div>
          ))}

        <div className="border-t border-slate-200 pt-4">
          <NonComplianceList runId={runId} canRead={hasPermission('standard_review:judge')} />
        </div>

        {report.data && (
          <div className="flex flex-wrap gap-3 border-t border-slate-200 pt-3">
            <Button
              variant="outline"
              onClick={() => api.standardEvaluations.downloadReportPdf(runId)}
            >
              <Download className="mr-2 h-4 w-4" />
              下载 PDF 报告
            </Button>
            <Button
              variant="outline"
              onClick={() => api.standardEvaluations.downloadEvidence(runId)}
            >
              <Download className="mr-2 h-4 w-4" />
              下载证据附件
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
