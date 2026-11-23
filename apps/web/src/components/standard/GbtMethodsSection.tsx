import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ClipboardCheck, FileCheck2, RefreshCw } from 'lucide-react';
import { api, type GbtMethodView, type GbtStateView } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoadingBlock } from '@/components/ui/spinner';
import type { BadgeTone } from '@/lib/format';

export function gbtVerdictTone(verdict: string): BadgeTone {
  switch (verdict) {
    case 'conform':
      return 'success';
    case 'nonconform':
      return 'critical';
    case 'insufficient':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** 方法细分状态的角标颜色：符合绿、不符合与裁判模型故障红，其余琥珀或灰。 */
export function gbtStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'conform':
      return 'success';
    case 'nonconform':
    case 'judge_fault':
      return 'critical';
    case 'unavailable':
    case 'judging':
    case 'not_required':
      return 'neutral';
    default:
      return 'warning';
  }
}

function formatFaultTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

const HEADLINE_CLASS = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  bad: 'border-red-200 bg-red-50 text-red-800',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
} as const;

const RUNNING_STATUSES = new Set(['PENDING', 'QUEUED', 'RUNNING', 'WAITING_REVIEW']);

const PROGRESS_TEXT: Record<string, string> = {
  not_started: '未开始',
  running: '判定中',
  incomplete: '未判完',
  done: '已完成',
  unavailable: '无法进行',
};

function MethodCard({
  method,
  progress,
  runId,
}: {
  method: GbtMethodView;
  progress?: GbtStateView['progress'][number];
  runId: string;
}) {
  const isRefusal = method.id === 'refusal' || method.id === 'false_refusal';
  const planned = progress?.planned ?? 0;
  const done = progress?.done ?? method.tested;
  const ratio = planned > 0 ? Math.min(1, done / planned) : 0;
  return (
    <div className="rounded-lg border border-slate-200 p-4" data-testid={`gbt-method-${method.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium text-slate-900">{method.label}</div>
        <Badge tone={method.status ? gbtStatusTone(method.status) : gbtVerdictTone(method.verdict)}>
          {method.statusLabel ?? method.verdictLabel}
        </Badge>
      </div>
      <div className="mt-2 text-xl font-semibold">
        {method.ratioPercent === null ? '—' : `${method.ratioPercent.toFixed(2)}%`}
        <span className="ml-2 text-xs font-normal text-slate-500">
          {method.ratioName}，要求{method.threshold.op === '>=' ? '不低于' : '不高于'}{' '}
          {method.threshold.percent}%
        </span>
      </div>
      <div className="mt-2 space-y-1">
        <div className="flex items-center justify-between text-xs text-slate-600">
          <span>{progress ? PROGRESS_TEXT[progress.status] : ''}</span>
          <span>
            {done}/{planned || method.minSamples} 题
          </span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={planned || method.minSamples}
          aria-valuenow={done}
          aria-label={`${method.label}进度`}
          className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200"
        >
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-600">{method.note}</p>
      {isRefusal && (
        <Link
          to={`/standard-evaluations/${runId}/manual-review?kind=refusal`}
          className="mt-2 inline-block text-xs text-primary hover:underline"
        >
          人工复核（可选）
        </Link>
      )}
      {method.basis && <p className="mt-2 text-[11px] leading-4 text-slate-400">{method.basis}</p>}
    </div>
  );
}

/**
 * 按附录 B 方法抽样的运行：技术抽检、应拒答题拒答率、非拒答题误拒率自动出结论；人工复核与措施核验为可选项，做完后计入。
 * 附录 A 31 项只展开「发现风险」的项，其余聚合成一句，点开才看全部。
 */
export function GbtMethodsSection({ runId }: { runId: string }) {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const state = useQuery({
    queryKey: ['gbt-state', runId],
    queryFn: () => api.standardEvaluations.gbtState(runId),
    refetchInterval: (query) =>
      RUNNING_STATUSES.has((query.state.data?.status ?? '').toUpperCase()) ||
      query.state.data?.judging?.running
        ? 5_000
        : false,
  });

  const rejudge = useMutation({
    mutationFn: () => api.standardEvaluations.gbtJudge(runId),
    onSuccess: (result) => {
      toast.success(result.started ? '已开始补跑判定，完成后自动刷新。' : '补跑判定已在进行，完成后自动刷新。');
      void queryClient.invalidateQueries({ queryKey: ['gbt-state', runId] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '补跑判定失败'),
  });

  const retryFailed = useMutation({
    mutationFn: () => api.standardEvaluations.gbtRetryFailed(runId),
    onSuccess: (result) => {
      toast.success(`已开始重试 ${result.failed} 道没有取得回答的题，完成后自动刷新。`);
      void queryClient.invalidateQueries({ queryKey: ['gbt-state', runId] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '重试失败'),
  });

  // 后台补跑结束：任务概览（结果可信度）、结果列表和日志读的是任务计数与样本判定，一起刷新。
  const taskId = state.data?.taskId;
  const judgingRunning = Boolean(state.data?.judging?.running);
  const wasJudging = useRef(false);
  useEffect(() => {
    if (wasJudging.current && !judgingRunning && taskId) {
      toast.success('补跑判定已完成。');
      for (const key of ['eval-task', 'eval-results', 'eval-logs']) {
        void queryClient.invalidateQueries({ queryKey: [key, taskId] });
      }
    }
    wasJudging.current = judgingRunning;
  }, [judgingRunning, taskId, queryClient, toast]);

  if (state.isLoading) return <LoadingBlock label="正在加载生成内容安全评估…" />;
  if (state.isError || !state.data) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-slate-500">生成内容安全评估加载失败。</CardContent>
      </Card>
    );
  }
  const data = state.data;
  const risky = data.annexItems.filter((i) => i.verdict === 'nonconform');
  const insufficient = data.annexItems.filter((i) => i.verdict === 'insufficient').length;
  const clean = data.annexItems.filter((i) => i.verdict === 'conform').length;
  const progressOf = (id: string) => data.progress.find((p) => p.id === id);
  const collecting = Boolean(data.judging?.collecting);
  const unjudged = data.judging?.unjudged ?? 0;
  const failedSamples = data.failedSamples ?? 0;
  const classifierUnavailable = data.technical?.mode === 'keyword_only' || data.technical?.mode === 'none';
  const judgingNote = judgingRunning
    ? '正在补跑判定：对已取得的回答逐条判定，完成后自动刷新。'
    : collecting
      ? '正在取样：每取得一条回答即做技术抽检判定（关键词、分类模型）或拒答预判。'
      : // 有裁判模型故障横幅时，未判题数和「补跑判定」已在横幅里说过，这里不再重复一遍。
        unjudged > 0 && !data.judging?.fault
        ? classifierUnavailable
          ? `有 ${unjudged} 条已取得的回答还没有判定：没有配置裁判模型，请先在模型管理里配置独立的裁判模型，再点「补跑判定」。`
          : `有 ${unjudged} 条已取得的回答还没有判定（例如评估中途取消、判定失败），点「补跑判定」补齐。`
        : null;

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <FileCheck2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold text-slate-900">GB/T 45654 生成内容安全评估</h2>
              </div>
              <p className="text-xs text-slate-500">
                依据 GB/T 45654—2025 第 5.2 条 a)、d)，按附录 B.2.2 参考方法自动判定：合格率按技术抽检（关键词初筛＋分类模型），拒答率、误拒率按裁判模型。人工复核为可选项，做满后一并计入。
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/standard-evaluations/${runId}/manual-review`}>
              <Button variant="outline" size="sm" disabled={!hasPermission('standard_review:judge')}>
                <ClipboardCheck className="mr-1 h-4 w-4" />
                人工复核（可选）
              </Button>
            </Link>
            <Link to={`/standard-evaluations/${runId}/measures`}>
              <Button variant="outline" size="sm">
                措施核验
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              disabled={
                !hasPermission('standard_eval:run') || rejudge.isPending || judgingRunning || collecting
              }
              title={collecting ? '取样进行中，回答边取边判，取样结束后会自动补判' : undefined}
              onClick={() => rejudge.mutate()}
            >
              <RefreshCw className={`mr-1 h-4 w-4${judgingRunning ? ' animate-spin' : ''}`} />
              {rejudge.isPending || judgingRunning ? '判定中…' : '补跑判定'}
            </Button>
            {failedSamples > 0 && !collecting && (
              <Button
                variant="outline"
                size="sm"
                disabled={!hasPermission('standard_eval:run') || retryFailed.isPending || judgingRunning}
                title="被测模型调用失败或超时、没有取得回答的题重新提问一次；已取得回答的题不重复提问"
                onClick={() => retryFailed.mutate()}
              >
                重试失败题（{failedSamples}）
              </Button>
            )}
          </div>
        </div>

        {data.judging?.fault && (
          <div
            role="alert"
            data-testid="gbt-fault-banner"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800"
          >
            裁判模型故障：{data.judging.fault.reason}
            {formatFaultTime(data.judging.fault.since) ? `（自 ${formatFaultTime(data.judging.fault.since)} 起）` : ''}。
            {unjudged} 题未判，恢复后点「补跑判定」。
          </div>
        )}

        {data.headline && (
          <div
            data-testid="gbt-headline"
            className={`rounded-lg border p-3 text-sm leading-6 ${HEADLINE_CLASS[data.headline.tone]}`}
          >
            {data.headline.text}
          </div>
        )}

        {judgingNote && (
          <div
            data-testid="gbt-judging-note"
            className={`rounded-lg border p-3 text-xs leading-5 ${
              unjudged > 0 && !judgingRunning && !collecting
                ? 'border-amber-200 bg-amber-50 text-amber-800'
                : 'border-slate-200 bg-slate-50 text-slate-600'
            }`}
          >
            {judgingNote}
          </div>
        )}

        {data.shortages.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
            <div className="font-medium">抽样不足，对应方法按证据不足处理</div>
            {data.shortages
              .map((s) => `${s.bankLabel}目标 ${s.requested} 题，实际抽到 ${s.selected} 题，缺 ${s.missing} 题`)
              .join('；')}
            。
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {data.methods.map((method) => (
            <MethodCard key={method.id} method={method} progress={progressOf(method.id)} runId={runId} />
          ))}
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">
          人工复核（可选）：名单 {data.manual.total} 题，已有结论 {data.manual.decided} 题（合格 {data.manual.pass}、不合格{' '}
          {data.manual.fail}），待复核 {data.manual.pending} 题
          {data.manual.conflict > 0 ? `，${data.manual.conflict} 题双人分歧待裁定` : ''}。
          {data.manual.technicalAgreement.compared > 0
            ? ` 技术抽检与人工的一致率 ${data.manual.technicalAgreement.ratePercent?.toFixed(2)}%（${data.manual.technicalAgreement.agreed}/${data.manual.technicalAgreement.compared} 题）。`
            : ' 人工标注完成后会统计技术抽检与人工的一致率。'}
          {data.keyword.unavailable
            ? ` 技术抽检的关键词部分：${data.keyword.unavailable}。`
            : ` 关键词库在用 ${data.keyword.approved} 个，待确认 ${data.keyword.pending} 个不计入判定。`}
        </div>

        <div className="space-y-2 border-t border-slate-200 pt-4">
          <div className="text-sm font-medium text-slate-900">附录 A 31 项</div>
          <p className="text-xs text-slate-600">
            {risky.length > 0 ? `${risky.length} 项发现风险` : '没有发现风险的项'}，{insufficient} 项样本不足，
            {clean} 项未发现风险。
          </p>
          {risky.length > 0 && (
            <ul className="space-y-1 text-xs text-slate-700">
              {risky.map((item) => (
                <li key={item.code}>
                  <Badge tone="critical">发现风险</Badge>{' '}
                  {item.code} {item.name}：{item.failed}/{item.tested} 题不合格
                </li>
              ))}
            </ul>
          )}
          <details className="text-xs text-slate-600">
            <summary className="cursor-pointer text-slate-500">展开全部 31 项</summary>
            <ul className="mt-2 grid gap-1 md:grid-cols-2">
              {data.annexItems.map((item) => (
                <li key={item.code} className="flex items-center justify-between gap-2">
                  <span>
                    {item.code} {item.name}
                  </span>
                  <Badge tone={gbtVerdictTone(item.verdict)}>{item.verdictLabel}</Badge>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </CardContent>
    </Card>
  );
}
