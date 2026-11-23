import { usePlatformAppEnabled } from '@/lib/use-platform-app-enabled';
import { isAgentEvalTarget } from '@/lib/eval-targets';
import { useState, type ComponentProps, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Download,
  Eye,
  FileText,
  Layers3,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Square,
  X,
} from 'lucide-react';
import {
  api,
  type BatchDetail,
  type BatchPlan,
  type BatchStatus,
  type CreateBatchRequest,
  type Paginated,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, riskCategoryLabel, severityLabel, type BadgeTone } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Markdown } from '@/components/Markdown';
import { SensitiveText } from '@/components/SensitiveText';
import { QueryState } from '@/components/QueryState';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { Pagination } from '@/components/ui/pagination';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { randomId } from '@/lib/random-id';

const STATUS: Record<BatchStatus, string> = {
  PENDING: '待开始',
  RUNNING: '评估中',
  PAUSED: '已暂停',
  COMPLETED: '已完成',
  FAILED: '执行失败',
  CANCELED: '已取消',
};
const STRATEGY = { ROUND_ROBIN: '轮询执行', SEQUENTIAL: '依次执行', PARALLEL: '并行执行' };
const VERDICT: Record<string, string> = {
  PASS: '未发现风险',
  FAIL: '发现风险',
  ERROR: '执行错误',
  UNKNOWN: '待判定',
};
const STOP_REASON: Record<string, string> = {
  REQUEST_BUDGET_EXHAUSTED: '已达到请求预算上限',
  DURATION_BUDGET_EXHAUSTED: '已达到运行时长上限',
  TARGET_CONFIGURATION_CHANGED: '评估对象配置已变更',
  JUDGE_CONFIGURATION_CHANGED: '判定模型配置已变更',
  TARGET_AUTHENTICATION_FAILED: '评估对象认证失败',
  EXECUTION_FAILED: '评估执行失败',
  QUEUE_UNAVAILABLE: '评估队列暂不可用',
  USER_PAUSED: '已手动暂停',
  USER_CANCELED: '已手动取消',
};
const PAGE_SIZE = 10;
const RESULT_PAGE_SIZE = 20;
const count = (value: number) => value.toLocaleString('zh-CN');
/** 每个对象样本数的默认值：先小规模摸底，避免一点“创建并开始”就对客户模型接口大规模调用。 */
const DEFAULT_SAMPLE_COUNT = 200;
/** 超过该样本数时，创建前需要二次确认。 */
const LARGE_RUN_SAMPLE_THRESHOLD = 2000;
const percent = (value: number) => `${(Math.max(0, Math.min(1, value)) * 100).toFixed(1)}%`;
const message = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试。');
const active = (plan: BatchPlan) => plan.status === 'PENDING' || plan.status === 'RUNNING';

async function allPages<T>(fetchPage: (page: number) => Promise<Paginated<T>>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const result = await fetchPage(page);
    items.push(...result.items);
    if (items.length >= result.total) return items;
    if (!result.items.length) throw new Error('选项加载不完整，请刷新后重试。');
  }
}

function initialForm(): CreateBatchRequest {
  return {
    name: '',
    targetIds: [],
    questionSetIds: [],
    sampleCount: DEFAULT_SAMPLE_COUNT,
    seed: randomId(),
    judgeMode: 'MODEL',
    strategy: 'ROUND_ROBIN',
    concurrency: 4,
    targetConcurrency: 2,
    batchSize: 20,
    rpm: 120,
    maxAttempts: 3,
    maxDurationMinutes: 1440,
  };
}

function BatchModal(props: ComponentProps<typeof Modal>) {
  if (!props.open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={typeof props.title === 'string' ? props.title + '弹窗' : undefined}
    >
      <Modal {...props} />
    </div>
  );
}

function Status({ status }: { status: BatchStatus }) {
  const tone: BadgeTone =
    status === 'RUNNING'
      ? 'info'
      : status === 'COMPLETED'
        ? 'success'
        : status === 'FAILED'
          ? 'danger'
          : status === 'PAUSED'
            ? 'warning'
            : 'neutral';
  return (
    <Badge tone={tone} icon>
      {STATUS[status]}
    </Badge>
  );
}

function Progress({ processed, expected }: { processed: number; expected: number }) {
  const value = expected ? processed / expected : 0;
  return (
    <div className="min-w-[120px] space-y-1.5">
      <div className="flex justify-between gap-3 text-xs tabular-nums">
        <span>
          {count(processed)} / {count(expected)}
        </span>
        <span>{percent(value)}</span>
      </div>
      <div
        role="progressbar"
        aria-label="样本处理进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, value * 100)}
        className="h-1.5 overflow-hidden rounded-full bg-severity-unknown-bg"
      >
        <div className="h-full bg-brand-600 transition-all" style={{ width: percent(value) }} />
      </div>
    </div>
  );
}

function BatchOutcome({ detail }: { detail: BatchDetail }) {
  const summary = detail.summary;
  const risk = summary.state === 'RISK_DETECTED';
  const incomplete = !summary.coverageComplete || summary.state === 'INCOMPLETE';
  const headline = risk ? '已发现风险' : incomplete ? '评估尚不完整' : '本次样本未观察到风险';
  return (
    <section className="border-y border-line py-4">
      <h3
        className={`text-base font-semibold ${risk ? 'text-severity-critical' : incomplete ? 'text-severity-high' : 'text-severity-pass'}`}
      >
        {headline}
      </h3>
      <p className="mt-1 text-sm text-ink-3">
        {incomplete
          ? '部分样本尚未完成或无法判定，当前结果不足以形成完整结论。'
          : '结论仅适用于本次样本与当前配置，未观察到风险不代表不存在风险。'}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        {[
          ['计划样本', summary.counts.expected],
          ['已处理', summary.counts.processed],
          ['有效结果', summary.counts.valid],
          ['未发现风险', summary.counts.pass],
          ['风险样本', summary.counts.fail],
          ['执行错误', summary.counts.error],
          ['待判定', summary.counts.unknown],
          ['高危及严重风险', summary.counts.critical],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-ink-3">{label}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">{count(Number(value))}</dd>
          </div>
        ))}
      </dl>
      {summary.commonRisks.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {summary.commonRisks.map((risk) => (
            <span
              key={risk.category}
              className="rounded bg-severity-critical-bg px-2 py-1 text-xs text-severity-critical"
            >
              {riskCategoryLabel(risk.category)} · {risk.affectedTargets} 个对象
            </span>
          ))}
        </div>
      )}
      {summary.recommendations.length > 0 && (
        <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-ink-3">
          {summary.recommendations.map((recommendation, index) => (
            <li key={index}>{recommendation}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

type ControlAction = 'start' | 'pause' | 'resume' | 'cancel' | 'retryErrors';
export function BatchEvaluationsPage() {
  const platformAppEnabled = usePlatformAppEnabled();
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canRead = hasPermission('eval_task:read');
  const canCreate = hasPermission('eval_task:create');
  const canOperate = hasPermission('eval_task:re_eval');
  const canViewResults = hasPermission('eval_task:log_view');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateBatchRequest>(initialForm);
  const [targetSearch, setTargetSearch] = useState('');
  const [setSearch, setSetSearch] = useState('');
  const [searchParams] = useSearchParams();
  // 从检测任务总览跳来时带 ?id=，直接打开这次批量评估。
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get('id'));
  const [resultsOpen, setResultsOpen] = useState(false);
  const [resultPage, setResultPage] = useState(1);
  const [runId, setRunId] = useState('');
  const [verdict, setVerdict] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const [resumeRequests, setResumeRequests] = useState('');
  const [resumeDuration, setResumeDuration] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmLarge, setConfirmLarge] = useState(false);

  const list = useQuery({
    queryKey: ['batch-evaluations', page],
    queryFn: () => api.batchEvaluations.list({ page, pageSize: PAGE_SIZE }),
    enabled: canRead,
    refetchInterval: (query) => (query.state.data?.items.some(active) ? 4000 : false),
  });
  const detail = useQuery({
    queryKey: ['batch-evaluation', selectedId],
    queryFn: () => api.batchEvaluations.get(selectedId!),
    enabled: canRead && !!selectedId,
    refetchInterval: (query) => (query.state.data && active(query.state.data) ? 4000 : false),
  });
  const targets = useQuery({
    queryKey: ['batch-target-options'],
    queryFn: () =>
      allPages((page) => api.modelTargets.list({ page, pageSize: 100, includeSystem: true })),
    enabled: createOpen && canCreate,
  });
  const sets = useQuery({
    queryKey: ['batch-question-set-options'],
    queryFn: () =>
      allPages((page) => api.questionSets.list({ page, pageSize: 100, enabled: true })),
    enabled: createOpen && canCreate,
  });
  const results = useQuery({
    queryKey: ['batch-results', selectedId, resultPage, runId, verdict],
    queryFn: () =>
      api.batchEvaluations.results(selectedId!, {
        page: resultPage,
        pageSize: RESULT_PAGE_SIZE,
        runId: runId || undefined,
        verdict: verdict || undefined,
      }),
    enabled: canRead && canViewResults && !!selectedId && resultsOpen,
    refetchInterval: () => (detail.data && active(detail.data) ? 4000 : false),
  });
  const report = useQuery({
    queryKey: ['batch-report', selectedId],
    queryFn: () => api.batchEvaluations.report(selectedId!),
    enabled: canRead && !!selectedId && reportOpen && hasPermission('report:read'),
  });
  const updateDetail = (updated: BatchDetail) => {
    qc.setQueryData(['batch-evaluation', updated.id], updated);
    void qc.invalidateQueries({ queryKey: ['batch-evaluations'] });
    void qc.invalidateQueries({ queryKey: ['batch-results', updated.id] });
    void qc.invalidateQueries({ queryKey: ['batch-report', updated.id] });
  };
  const create = useMutation({
    mutationFn: async () => {
      const created = await api.batchEvaluations.create({
        ...form,
        name:
          form.name.trim() || `批量评估 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      });
      setSelectedId(created.id);
      updateDetail(created);
      setCreateOpen(false);
      return api.batchEvaluations.start(created.id);
    },
    onSuccess: (updated) => {
      updateDetail(updated);
      toast.success('批量评估已开始');
    },
    onError: (error) => {
      toast.error(message(error));
      void qc.invalidateQueries({ queryKey: ['batch-evaluations'] });
    },
  });
  const control = useMutation({
    mutationFn: async (action: ControlAction) => {
      if (!selectedId) throw new Error('请选择评估任务。');
      if (action === 'resume' || action === 'retryErrors')
        return api.batchEvaluations[action](selectedId, {
          maxRequests: Number(resumeRequests || detail.data?.maxRequests),
          maxDurationMinutes: Number(resumeDuration || detail.data?.maxDurationMinutes),
        });
      return api.batchEvaluations[action](selectedId);
    },
    onSuccess: (updated) => {
      updateDetail(updated);
      setConfirmCancel(false);
      setResumeRequests('');
      setResumeDuration('');
      toast.success('评估状态已更新');
    },
    onError: (error) => toast.error(message(error)),
  });
  const download = useMutation({
    mutationFn: (runId?: string) =>
      runId
        ? api.batchEvaluations.downloadReport(selectedId!, runId)
        : api.batchEvaluations.downloadReport(selectedId!),
    onError: (error) => toast.error(message(error)),
  });

  const openDetail = (id: string) => {
    setSelectedId(id);
    setReportOpen(false);
    setResultsOpen(false);
    setResultPage(1);
    setRunId('');
    setVerdict('');
    setResumeRequests('');
    setResumeDuration('');
  };
  const toggle = (key: 'targetIds' | 'questionSetIds', id: string) =>
    setForm((current) => ({
      ...current,
      [key]: current[key].includes(id)
        ? current[key].filter((item) => item !== id)
        : [...current[key], id],
    }));
  const selectedTargets = (targets.data ?? []).filter((target) =>
    isAgentEvalTarget(target, platformAppEnabled),
  );
  const visibleTargets = selectedTargets.filter((target) =>
    target.name.toLowerCase().includes(targetSearch.toLowerCase()),
  );
  const matchedSets = (sets.data ?? []).filter(
    (set) => set.enabled !== false && set.name.toLowerCase().includes(setSearch.toLowerCase()),
  );
  // 默认只列种子库和自有样本库；任务自动生成的运行记录收进折叠区。
  const visibleSets = matchedSets.filter((set) => set.kind !== 'run');
  const runRecordSets = matchedSets.filter((set) => set.kind === 'run');
  const sampleTotal = form.sampleCount * form.targetIds.length;
  const defaultBudget = sampleTotal * (form.judgeMode === 'MODEL' ? 2 : 1) * form.maxAttempts;
  const optionsReady = targets.isSuccess && sets.isSuccess;
  const renderSetOption = (set: (typeof matchedSets)[number]) => (
    <label
      key={set.id}
      className="flex cursor-pointer items-center gap-2 border-b border-line py-2 text-sm"
    >
      <input
        type="checkbox"
        checked={form.questionSetIds.includes(set.id)}
        disabled={set.questionCount === 0}
        onChange={() => toggle('questionSetIds', set.id)}
      />
      <span className="min-w-0 flex-1 break-words">{set.name}</span>
      <span className="shrink-0 text-xs text-ink-3">{count(set.questionCount)} 条</span>
    </label>
  );
  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      create.isPending ||
      !canCreate ||
      !optionsReady ||
      !form.targetIds.length ||
      !form.questionSetIds.length
    )
      return;
    if (form.sampleCount > LARGE_RUN_SAMPLE_THRESHOLD) {
      setConfirmLarge(true);
      return;
    }
    create.mutate();
  };
  const d = detail.data;
  const resumeBudgetValid =
    d &&
    Number(resumeRequests || d.maxRequests) > d.requestsUsed &&
    Number.isSafeInteger(Number(resumeRequests || d.maxRequests)) &&
    Number.isInteger(Number(resumeDuration || d.maxDurationMinutes)) &&
    Number(resumeDuration || d.maxDurationMinutes) >= 1 &&
    Number(resumeDuration || d.maxDurationMinutes) <= 10080;
  const busy = control.isPending || create.isPending;
  const numericFields = [
    ['concurrency', '总并发数', 1, 32],
    ['targetConcurrency', '单对象并发数', 1, 16],
    ['batchSize', '批次样本数', 1, 200],
    ['rpm', '每分钟请求上限', 1, 60000],
    ['maxAttempts', '每条结果最多尝试次数', 1, 5],
    ['maxDurationMinutes', '最长运行时间（分钟）', 1, 10080],
  ] as const;

  if (!canRead)
    return (
      <QueryState
        isLoading={false}
        isError={false}
        empty={false}
        permissionDenied
        emptyTitle=""
        emptyDescription=""
      />
    );

  return (
    <div className="space-y-5">
      <PageHeader
        title="批量评估"
        description="对多个评估对象与样本库批量发起评估，汇总进度与风险结果。"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              aria-label="刷新批量评估"
              title="刷新"
              disabled={list.isFetching}
              onClick={() => {
                void list.refetch();
                if (selectedId) void detail.refetch();
              }}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            {canCreate && (
              <Button
                onClick={() => {
                  setForm(initialForm());
                  setTargetSearch('');
                  setSetSearch('');
                  setCreateOpen(true);
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                新建批量评估
              </Button>
            )}
          </>
        }
      />
      <QueryState
        isLoading={list.isLoading}
        isError={list.isError}
        error={list.error}
        onRetry={() => void list.refetch()}
        empty={list.isSuccess && !list.data.items.length}
        emptyTitle="暂无批量评估"
        emptyDescription="当前没有批量评估记录。"
        emptyIcon={<Layers3 className="h-6 w-6" />}
      />
      {list.data && list.data.items.length > 0 && (
        <section>
          <Table>
            <THead>
              <TR>
                <TH>评估名称</TH>
                <TH>状态</TH>
                <TH>处理进度</TH>
                <TH>结果概览</TH>
                <TH>请求预算</TH>
                <TH>创建时间</TH>
                <TH>操作</TH>
              </TR>
            </THead>
            <TBody>
              {list.data.items.map((plan) => (
                <TR key={plan.id} className="[&>td]:py-3">
                  <TD data-label="评估名称">
                    <div className="min-w-0">
                      <div className="max-w-[240px] break-words font-medium">{plan.name}</div>
                      <div className="mt-1 text-xs text-ink-3">
                        {plan.targetCount} 个对象 ·{' '}
                        {plan.judgeMode === 'MODEL' ? '模型判定' : '规则初筛'} ·{' '}
                        {STRATEGY[plan.strategy]}
                      </div>
                    </div>
                  </TD>
                  <TD data-label="状态">
                    <Status status={plan.status} />
                  </TD>
                  <TD data-label="处理进度">
                    <Progress processed={plan.processedSamples} expected={plan.totalSamples} />
                  </TD>
                  <TD data-label="结果概览">
                    <div className="text-xs leading-5">
                      <span className="text-severity-critical">
                        风险 {count(plan.failedSamples)}
                      </span>{' '}
                      · 有效 {count(plan.validSamples)}
                      <br />
                      <span className="text-severity-high">
                        错误 {count(plan.errorSamples)} · 待判定 {count(plan.unknownSamples)}
                      </span>
                    </div>
                  </TD>
                  <TD data-label="请求预算" className="whitespace-nowrap tabular-nums">
                    {count(plan.requestsUsed)} / {count(plan.maxRequests)}
                  </TD>
                  <TD data-label="创建时间" className="whitespace-nowrap text-xs text-ink-3">
                    {formatDateTime(plan.createdAt)}
                  </TD>
                  <TD data-label="操作">
                    <Button
                      variant="ghost"
                      size="sm"
                      title="查看评估详情"
                      aria-label={`查看${plan.name}`}
                      onClick={() => openDetail(plan.id)}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={list.data.total}
            onPageChange={setPage}
          />
        </section>
      )}

      {selectedId && (
        <section className="border-t border-line pt-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="min-w-0 break-words text-lg font-semibold">{d?.name ?? '评估详情'}</h2>
            <Button
              variant="ghost"
              size="sm"
              aria-label="收起评估详情"
              title="收起详情"
              onClick={() => {
                setSelectedId(null);
                setReportOpen(false);
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <QueryState
            isLoading={detail.isLoading}
            isError={detail.isError}
            error={detail.error}
            onRetry={() => void detail.refetch()}
            empty={false}
            emptyTitle=""
            emptyDescription=""
          />
          {d && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <Status status={d.status} />
                <span className="mr-auto text-sm text-ink-3">
                  {d.judgeMode === 'MODEL' ? '模型判定' : '规则初筛'} · {STRATEGY[d.strategy]}
                </span>
                {canCreate && d.status === 'PENDING' && (
                  <Button size="sm" disabled={busy} onClick={() => control.mutate('start')}>
                    <Play className="mr-1.5 h-4 w-4" />
                    开始评估
                  </Button>
                )}
                {canOperate && ['PENDING', 'RUNNING'].includes(d.status) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => control.mutate('pause')}
                  >
                    <Pause className="mr-1.5 h-4 w-4" />
                    暂停评估
                  </Button>
                )}
                {canOperate &&
                  ['PAUSED', 'FAILED', 'COMPLETED'].includes(d.status) &&
                  (d.errorSamples > 0 || d.unknownSamples > 0) && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !resumeBudgetValid}
                      onClick={() => control.mutate('retryErrors')}
                    >
                      <RefreshCw className="mr-1.5 h-4 w-4" />
                      重试错误与待判定
                    </Button>
                  )}
                {canOperate && ['PENDING', 'RUNNING', 'PAUSED', 'FAILED'].includes(d.status) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmCancel(true)}
                  >
                    <Square className="mr-1.5 h-4 w-4" />
                    取消评估
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canViewResults}
                  title={canViewResults ? '查看样本结果与证据' : '当前账号没有查看结果明细的权限'}
                  onClick={() => {
                    setResultPage(1);
                    setResultsOpen(true);
                  }}
                >
                  <Eye className="mr-1.5 h-4 w-4" />
                  结果明细
                </Button>
                {hasPermission('report:read') && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setReportOpen((current) => !current);
                      void qc.invalidateQueries({ queryKey: ['batch-report', selectedId] });
                    }}
                  >
                    <FileText className="mr-1.5 h-4 w-4" />
                    {reportOpen ? '收起报告' : '查看报告'}
                  </Button>
                )}
                {hasPermission('report:download') && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={download.isPending}
                    onClick={() => download.mutate(undefined)}
                  >
                    <Download className="mr-1.5 h-4 w-4" />
                    下载报告
                  </Button>
                )}
              </div>
              {d.stopReason && (
                <p
                  role="status"
                  className="border-l-2 border-severity-medium bg-severity-medium-bg px-3 py-2 text-sm text-severity-medium"
                >
                  {STOP_REASON[d.stopReason] ?? '评估已停止，请检查结果后继续。'}
                </p>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <Progress processed={d.processedSamples} expected={d.totalSamples} />
                <div className="text-sm text-ink-3">
                  请求预算{' '}
                  <span className="font-medium tabular-nums">
                    {count(d.requestsUsed)} / {count(d.maxRequests)}
                  </span>
                  <span className="ml-3">最长运行 {count(d.maxDurationMinutes)} 分钟</span>
                </div>
              </div>
              {canOperate &&
                (['PAUSED', 'FAILED'].includes(d.status) ||
                  (d.status === 'COMPLETED' && (d.errorSamples > 0 || d.unknownSamples > 0))) && (
                  <div className="flex flex-wrap items-end gap-3 border-y border-line py-4">
                    <Field label="继续评估请求上限" htmlFor="resume-requests">
                      <Input
                        id="resume-requests"
                        type="number"
                        min={d.requestsUsed + 1}
                        step={1}
                        value={resumeRequests || d.maxRequests}
                        onChange={(event) => setResumeRequests(event.target.value)}
                      />
                    </Field>
                    <Field label="总运行时长上限（分钟）" htmlFor="resume-duration">
                      <Input
                        id="resume-duration"
                        type="number"
                        min={1}
                        max={10080}
                        step={1}
                        value={resumeDuration || d.maxDurationMinutes}
                        onChange={(event) => setResumeDuration(event.target.value)}
                      />
                    </Field>
                    {['PAUSED', 'FAILED'].includes(d.status) && (
                      <Button
                        disabled={busy || !resumeBudgetValid}
                        onClick={() => control.mutate('resume')}
                      >
                        <Play className="mr-1.5 h-4 w-4" />
                        继续评估
                      </Button>
                    )}
                    <p className="w-full text-xs text-ink-3">
                      请求上限须大于已用请求数；运行时长从首次开始评估时计算，暂停期间仍计入。
                    </p>
                  </div>
                )}
              <BatchOutcome detail={d} />
              <section>
                <h3 className="mb-3 text-sm font-semibold">评估对象对比</h3>
                <Table>
                  <THead>
                    <TR>
                      <TH>评估对象</TH>
                      <TH>状态 / 进度</TH>
                      <TH>有效结果</TH>
                      <TH>风险 / 高危及严重</TH>
                      <TH>错误 / 待判定</TH>
                      <TH>风险率</TH>
                      <TH>正常请求误拒率</TH>
                      <TH>平均耗时</TH>
                      <TH>用量</TH>
                      {hasPermission('report:download') && <TH>报告</TH>}
                    </TR>
                  </THead>
                  <TBody>
                    {d.runs.map((run) => (
                      <TR key={run.id} className="[&>td]:py-3">
                        <TD
                          data-label="评估对象"
                          className="md:max-w-[220px] break-words font-medium"
                        >
                          <span className="min-w-0">{run.targetName}</span>
                        </TD>
                        <TD data-label="状态 / 进度">
                          <div className="min-w-0">
                            <div className="mb-2">
                              <Status status={run.status} />
                            </div>
                            <Progress
                              processed={run.processedSamples}
                              expected={run.expectedSamples}
                            />
                          </div>
                        </TD>
                        <TD data-label="有效结果">
                          <div>
                            {count(run.validSamples)}
                            <div className="mt-1 text-xs text-ink-3">
                              有效率 {percent(run.validRate)}
                            </div>
                          </div>
                        </TD>
                        <TD data-label="风险 / 高危及严重" className="text-severity-critical">
                          {count(run.failedSamples)} / {count(run.criticalSamples)}
                        </TD>
                        <TD data-label="错误 / 待判定" className="text-severity-high">
                          {count(run.errorSamples)} / {count(run.unknownSamples)}
                        </TD>
                        <TD data-label="风险率">
                          {run.validSamples > 0 && run.riskRate !== null
                            ? percent(run.riskRate)
                            : '暂无有效结果'}
                        </TD>
                        <TD data-label="正常请求误拒率">
                          {run.falseRefusalRate == null
                            ? '暂无有效结果'
                            : percent(run.falseRefusalRate)}
                        </TD>
                        <TD data-label="平均耗时">
                          {run.averageLatencyMs === null
                            ? '—'
                            : `${count(Math.round(run.averageLatencyMs))} ms`}
                        </TD>
                        <TD data-label="用量">{count(run.totalTokens)} tokens</TD>
                        {hasPermission('report:download') && (
                          <TD data-label="报告">
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={download.isPending}
                              title="下载对象评估报告"
                              aria-label={`下载${run.targetName}报告`}
                              onClick={() => download.mutate(run.id)}
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                          </TD>
                        )}
                      </TR>
                    ))}
                  </TBody>
                </Table>
                <p className="mt-2 text-xs text-ink-3">
                  风险率按有效结果计算，执行错误和待判定样本不计入分母。
                </p>
              </section>
              {reportOpen && hasPermission('report:read') && (
                <section className="border-t border-line pt-4">
                  <h3 className="mb-3 text-base font-semibold">批量评估报告</h3>
                  <QueryState
                    isLoading={report.isLoading}
                    isError={report.isError}
                    error={report.error}
                    onRetry={() => void report.refetch()}
                    empty={false}
                    emptyTitle=""
                    emptyDescription=""
                  />
                  {report.data && (
                    <>
                      <p className="mb-4 text-xs text-ink-3">
                        生成时间 {formatDateTime(report.data.generatedAt)}
                      </p>
                      <div className="min-w-0 break-words">
                        <Markdown content={report.data.content} />
                      </div>
                    </>
                  )}
                </section>
              )}
            </div>
          )}
        </section>
      )}

      <BatchModal
        open={createOpen}
        onClose={() => {
          if (!create.isPending) setCreateOpen(false);
        }}
        title="新建批量评估"
        size="lg"
        footer={
          <>
            <Button
              variant="outline"
              disabled={create.isPending}
              onClick={() => setCreateOpen(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="create-batch-form"
              disabled={
                create.isPending ||
                !optionsReady ||
                !form.targetIds.length ||
                !form.questionSetIds.length
              }
            >
              <Play className="mr-1.5 h-4 w-4" />
              {create.isPending ? '正在创建…' : '创建并开始'}
            </Button>
          </>
        }
      >
        <form id="create-batch-form" onSubmit={submitCreate} className="space-y-5">
          <Field label="评估名称" htmlFor="batch-name">
            <Input
              id="batch-name"
              maxLength={200}
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="可留空自动命名"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <fieldset className="min-w-0">
              <legend className="mb-2 text-sm font-medium">
                评估对象 <span className="text-ink-3">已选 {form.targetIds.length}</span>
              </legend>
              <Input
                aria-label="搜索评估对象"
                placeholder="搜索名称"
                value={targetSearch}
                onChange={(event) => setTargetSearch(event.target.value)}
              />
              <QueryState
                isLoading={targets.isLoading}
                isError={targets.isError}
                error={targets.error}
                onRetry={() => void targets.refetch()}
                empty={targets.isSuccess && !visibleTargets.length}
                emptyTitle="没有可选模型"
                emptyDescription="暂无已启用的模型评估对象。"
              />
              <div className="mt-2 max-h-44 overflow-y-auto">
                {visibleTargets.map((target) => (
                  <label
                    key={target.id}
                    className="flex cursor-pointer items-center gap-2 border-b border-line py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={form.targetIds.includes(target.id)}
                      onChange={() => toggle('targetIds', target.id)}
                    />
                    <span className="min-w-0 break-words">{target.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="min-w-0">
              <legend className="mb-2 text-sm font-medium">
                样本库 <span className="text-ink-3">已选 {form.questionSetIds.length}</span>
              </legend>
              <Input
                aria-label="搜索样本库"
                placeholder="搜索名称"
                value={setSearch}
                onChange={(event) => setSetSearch(event.target.value)}
              />
              <QueryState
                isLoading={sets.isLoading}
                isError={sets.isError}
                error={sets.error}
                onRetry={() => void sets.refetch()}
                empty={sets.isSuccess && !visibleSets.length}
                emptyTitle="没有可选样本库"
                emptyDescription="暂无匹配的样本库。"
              />
              <div className="mt-2 max-h-44 overflow-y-auto">
                {visibleSets.map(renderSetOption)}
                {runRecordSets.length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer py-2 text-xs text-ink-3">
                      展开运行记录（{runRecordSets.length}）
                      <span className="ml-1">任务自动生成的样本快照，一般无需选择</span>
                    </summary>
                    {runRecordSets.map(renderSetOption)}
                  </details>
                )}
              </div>
            </fieldset>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="每个对象样本数" htmlFor="batch-samples" required>
              <Input
                id="batch-samples"
                type="number"
                min={1}
                max={100000}
                step={1}
                required
                value={form.sampleCount}
                onChange={(event) => setForm({ ...form, sampleCount: Number(event.target.value) })}
              />
            </Field>
            <Field label="执行策略" htmlFor="batch-strategy">
              <Select
                id="batch-strategy"
                value={form.strategy}
                onChange={(event) =>
                  setForm({
                    ...form,
                    strategy: event.target.value as CreateBatchRequest['strategy'],
                  })
                }
              >
                <option value="ROUND_ROBIN">轮询执行</option>
                <option value="SEQUENTIAL">依次执行</option>
                <option value="PARALLEL">并行执行</option>
              </Select>
            </Field>
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">判定方式</legend>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="judge-mode"
                  checked={form.judgeMode === 'MODEL'}
                  onChange={() => setForm({ ...form, judgeMode: 'MODEL' })}
                />
                模型判定
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="judge-mode"
                  checked={form.judgeMode === 'RULES'}
                  onChange={() => setForm({ ...form, judgeMode: 'RULES' })}
                />
                规则初筛
              </label>
            </div>
            <p className="mt-2 text-xs text-ink-3">
              {form.judgeMode === 'MODEL'
                ? '使用独立判定模型复核响应，需已配置可用的判定模型。'
                : '仅按规则初筛；无法判定的响应保留为待判定，不作为通过结果。'}
            </p>
          </fieldset>
          <div className="border-y border-line py-3 text-sm text-ink-3">
            计划评估 <strong className="text-ink">{count(sampleTotal)}</strong> 条对象样本组合
            <span className="ml-3">
              默认请求预算 <strong className="text-ink">{count(defaultBudget)}</strong> 次
            </span>
          </div>
          <details>
            <summary className="cursor-pointer text-sm font-medium">并发与预算设置</summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {numericFields.map(([key, label, min, max]) => (
                <Field key={key} label={label} htmlFor={`batch-${key}`}>
                  <Input
                    id={`batch-${key}`}
                    type="number"
                    min={min}
                    max={max}
                    step={1}
                    required
                    value={form[key]}
                    onChange={(event) => setForm({ ...form, [key]: Number(event.target.value) })}
                  />
                </Field>
              ))}
              <Field
                label="请求预算上限"
                htmlFor="batch-maxRequests"
                hint="留空按样本组合、判定方式与尝试次数自动计算。"
              >
                <Input
                  id="batch-maxRequests"
                  type="number"
                  min={1}
                  step={1}
                  value={form.maxRequests ?? ''}
                  placeholder={count(defaultBudget)}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      maxRequests: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                />
              </Field>
              <Field
                label="抽样种子"
                htmlFor="batch-seed"
                hint="保持种子与样本库一致，可复现同一抽样计划。"
              >
                <Input
                  id="batch-seed"
                  required
                  maxLength={200}
                  value={form.seed}
                  onChange={(event) => setForm({ ...form, seed: event.target.value })}
                />
              </Field>
            </div>
          </details>
        </form>
      </BatchModal>

      <BatchModal
        open={resultsOpen && !!selectedId && canViewResults}
        onClose={() => setResultsOpen(false)}
        title="结果明细"
        size="xl"
      >
        <div className="mb-4 flex flex-wrap gap-3">
          <Field label="评估对象" htmlFor="batch-result-target">
            <Select
              id="batch-result-target"
              value={runId}
              onChange={(event) => {
                setRunId(event.target.value);
                setResultPage(1);
              }}
            >
              <option value="">全部对象</option>
              {d?.runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.targetName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="判定结果" htmlFor="batch-result-verdict">
            <Select
              id="batch-result-verdict"
              value={verdict}
              onChange={(event) => {
                setVerdict(event.target.value);
                setResultPage(1);
              }}
            >
              <option value="">全部结果</option>
              {Object.entries(VERDICT).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <QueryState
          isLoading={results.isLoading}
          isError={results.isError}
          error={results.error}
          onRetry={() => void results.refetch()}
          empty={results.isSuccess && !results.data.items.length}
          filtered={!!runId || !!verdict}
          emptyTitle="暂无结果"
          emptyDescription="任务尚未产生结果。"
        />
        {results.data && (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>序号 / 对象</TH>
                  <TH>输入与响应</TH>
                  <TH>判定与依据</TH>
                  <TH>执行情况</TH>
                </TR>
              </THead>
              <TBody>
                {results.data.items.map((result) => (
                  <TR key={result.id}>
                    <TD data-label="序号 / 对象">
                      <div className="min-w-0">
                        <span className="tabular-nums">{result.sequence}</span>
                        <div className="mt-1 max-w-[160px] break-words text-xs">
                          {result.targetName}
                        </div>
                      </div>
                    </TD>
                    <TD data-label="输入与响应" className="md:min-w-[240px] md:max-w-[460px]">
                      <details className="min-w-0 break-words">
                        <summary className="cursor-pointer text-sm">
                          <span className="line-clamp-2">
                            <SensitiveText
                              text={result.prompt}
                              targetType="batch_evaluation"
                              targetId={selectedId!}
                              field="batch_evaluation.prompt"
                            />
                          </span>
                        </summary>
                        <p className="mt-2 whitespace-pre-wrap break-words text-xs">
                          <SensitiveText
                            text={result.prompt}
                            targetType="batch_evaluation"
                            targetId={selectedId!}
                            field="batch_evaluation.prompt"
                          />
                        </p>
                        <div className="mt-3 border-t border-line pt-2 text-xs">
                          <strong>模型响应</strong>
                          <p className="mt-1 whitespace-pre-wrap break-words">
                            <SensitiveText
                              text={result.response ?? '暂无响应'}
                              targetType="batch_evaluation"
                              targetId={selectedId!}
                              field="batch_evaluation.response"
                            />
                          </p>
                        </div>
                      </details>
                    </TD>
                    <TD data-label="判定与依据" className="md:min-w-[160px] md:max-w-[320px]">
                      <div className="min-w-0">
                        <span
                          className={
                            result.verdict === 'FAIL'
                              ? 'font-medium text-severity-critical'
                              : 'font-medium'
                          }
                        >
                          {VERDICT[result.verdict ?? 'UNKNOWN']}
                        </span>
                        <p className="mt-1 text-xs text-ink-3">
                          {riskCategoryLabel(result.category)}
                          {result.severity
                            ? ` · ${severityLabel(result.severity.toUpperCase())}`
                            : ''}
                        </p>
                        {result.evidence.length > 0 && (
                          <details className="mt-2 text-xs">
                            <summary className="cursor-pointer">判定依据</summary>
                            <ul className="mt-1 list-inside list-disc space-y-1">
                              {result.evidence.map((evidence, index) => (
                                <li key={index} className="break-words">
                                  <SensitiveText
                                    text={evidence}
                                    targetType="batch_evaluation"
                                    targetId={selectedId!}
                                    field="batch_evaluation.evidence"
                                  />
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        {result.errorMessage && (
                          <p className="mt-2 break-words text-xs text-severity-high">
                            {result.errorMessage}
                          </p>
                        )}
                      </div>
                    </TD>
                    <TD data-label="执行情况" className="whitespace-nowrap text-xs leading-5">
                      尝试 {result.attempts} 次<br />
                      {result.latencyMs === null ? '暂无耗时' : `${count(result.latencyMs)} ms`}
                      <br />
                      {count(result.totalTokens)} tokens
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination
              page={resultPage}
              pageSize={RESULT_PAGE_SIZE}
              total={results.data.total}
              onPageChange={setResultPage}
            />
          </>
        )}
      </BatchModal>
      <BatchModal
        open={confirmLarge}
        onClose={() => setConfirmLarge(false)}
        title="确认大规模评估"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmLarge(false)}>
              返回修改
            </Button>
            <Button
              disabled={create.isPending}
              onClick={() => {
                setConfirmLarge(false);
                create.mutate();
              }}
            >
              确认并开始
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-ink-3">
          本次将评估 <strong className="text-ink">{count(sampleTotal)}</strong>{' '}
          条对象样本组合，按默认预算预计最多发出{' '}
          <strong className="text-ink">{count(defaultBudget)}</strong>{' '}
          次请求，可能产生模型调用费用或触发对方限流。建议先用较小的样本数摸底，再逐步放大。
        </p>
      </BatchModal>

      <BatchModal
        open={confirmCancel}
        onClose={() => {
          if (!control.isPending) setConfirmCancel(false);
        }}
        title="取消批量评估"
        footer={
          <>
            <Button
              variant="outline"
              disabled={control.isPending}
              onClick={() => setConfirmCancel(false)}
            >
              返回
            </Button>
            <Button
              variant="destructive"
              disabled={control.isPending}
              onClick={() => control.mutate('cancel')}
            >
              确认取消
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-ink-3">
          取消后保留已有结果，未完成样本将停止执行。此任务无法继续。
        </p>
      </BatchModal>
    </div>
  );
}
