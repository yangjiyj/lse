import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ServiceAssuranceAssessmentItem, ServiceAssuranceRunListItem } from '@lse/shared';
import { AlertTriangle, CheckCircle2, CircleDashed, RefreshCw, ShieldCheck } from 'lucide-react';
import { AssuranceEvidenceDrawer } from '@/components/service-assurance/AssuranceEvidenceDrawer';
import { AssuranceIntro } from '@/components/service-assurance/AssuranceIntro';
import { AssuranceRetestDialog } from '@/components/service-assurance/AssuranceRetestDialog';
import { AssuranceReviewDialog } from '@/components/service-assurance/AssuranceReviewDialog';
import { AssuranceResultList } from '@/components/service-assurance/AssuranceResultList';
import { AssuranceRunForm } from '@/components/service-assurance/AssuranceRunForm';
import { AssuranceSummary } from '@/components/service-assurance/AssuranceSummary';
import { AssuranceTaskLink } from '@/components/service-assurance/AssuranceTaskLink';
import { AssuranceTimeline } from '@/components/service-assurance/AssuranceTimeline';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/select';
import { AssuranceExecutionSummary } from '@/components/service-assurance/AssuranceExecutionSummary';
import { LoadingBlock } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import {
  api,
  type ServiceAssuranceCreateRequest,
  type ServiceAssuranceRetestRequest,
  type ServiceAssuranceReviewRequest,
} from '@/lib/api';
import { cn } from '@/lib/utils';

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function statusBand(run: ServiceAssuranceRunListItem | null): {
  title: string;
  detail: string;
  icon: typeof ShieldCheck;
  className: string;
} {
  if (!run) {
    return {
      title: '等待核验',
      detail: '发起核验后，此处显示当前阶段与覆盖状态。',
      icon: CircleDashed,
      className: 'border-slate-300 bg-slate-100 text-slate-700',
    };
  }
  if (run.status === 'PENDING' || run.status === 'RUNNING') {
    return {
      title: run.status === 'PENDING' ? '等待执行' : '正在核验',
      detail: run.statusMessage,
      icon: CircleDashed,
      className: 'border-sky-200 bg-sky-50 text-sky-900',
    };
  }
  if (run.status === 'PARTIAL' || run.status === 'FAILED' || run.status === 'CANCELED') {
    return {
      title: '核验未完成',
      detail: run.statusMessage,
      icon: AlertTriangle,
      className: 'border-amber-200 bg-amber-50 text-amber-950',
    };
  }
  if (run.coverageStatus !== 'COMPLETE') {
    return {
      title: '执行完成，部分范围无法判断',
      detail: run.statusMessage,
      icon: AlertTriangle,
      className: 'border-amber-200 bg-amber-50 text-amber-950',
    };
  }
  return {
    title: '核验已完成',
    detail: run.statusMessage,
    icon: CheckCircle2,
    className: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  };
}

const runsKey = (filterTaskId: string) => ['service-assurance', 'runs', filterTaskId || 'all'];
type RunsCache = { items: ServiceAssuranceRunListItem[] };

export function ServiceAssurancePage() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const canRead = hasPermission('service_assurance:read');
  const canScan = hasPermission('service_assurance:scan');
  const canVerify = hasPermission('service_assurance:verify');
  const canReview = hasPermission('service_assurance:review');
  const canGenerateReport = hasPermission('report:generate');
  const canManageScopes =
    hasPermission('platform_setting:update') || hasPermission('system_setting:update');
  // 旧路由 ?taskId= 仍可用：作为记录列表的任务筛选。
  const [filterTaskId, setFilterTaskId] = useState(searchParams.get('taskId') ?? '');
  const [draftTaskId, setDraftTaskId] = useState('');
  // 从检测任务总览跳来时带 ?run=，直接选中这次核验。
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => searchParams.get('run'));
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<ServiceAssuranceAssessmentItem | null>(null);
  const [retestTarget, setRetestTarget] = useState<ServiceAssuranceAssessmentItem | null>(null);

  const readinessQuery = useQuery({
    queryKey: ['service-assurance', 'readiness'],
    queryFn: () => api.serviceAssurance.readiness(),
    enabled: canRead,
  });
  const tasksQuery = useQuery({
    queryKey: ['service-assurance', 'tasks'],
    queryFn: () => api.evalTasks.list({ page: 1, pageSize: 100 }),
    enabled: canRead,
  });
  const scopePoliciesQuery = useQuery({
    queryKey: ['service-assurance', 'scope-policies'],
    queryFn: () => api.serviceAssurance.scopePolicies(),
    enabled: canRead,
  });
  const tasks = tasksQuery.data?.items ?? [];

  const runsQuery = useQuery({
    queryKey: runsKey(filterTaskId),
    queryFn: () =>
      api.serviceAssurance.listRuns(filterTaskId ? { taskId: filterTaskId } : { pageSize: 50 }),
    enabled: canRead,
    refetchInterval: (query) =>
      query.state.data?.items.some((run) => run.status === 'PENDING' || run.status === 'RUNNING')
        ? 2500
        : false,
  });
  const runs = runsQuery.data?.items ?? [];

  useEffect(() => {
    if (runs.length === 0) {
      setSelectedRunId(null);
      return;
    }
    if (!selectedRunId || !runs.some((run) => run.runId === selectedRunId)) {
      setSelectedRunId(runs[0]!.runId);
    }
  }, [runs, selectedRunId]);

  const detailQuery = useQuery({
    queryKey: ['service-assurance', 'run', selectedRunId],
    queryFn: () => api.serviceAssurance.getRun(selectedRunId!),
    enabled: canRead && !!selectedRunId,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status === 'PENDING' || status === 'RUNNING' ? 2500 : false;
    },
  });

  const invalidateRuns = () =>
    void queryClient.invalidateQueries({ queryKey: ['service-assurance', 'runs'] });

  const selectCreatedRun = (run: ServiceAssuranceRunListItem) => {
    // 新记录不属于当前筛选的任务时切回“全部记录”，并预置缓存，避免列表刷新前选中丢失。
    const nextFilter = filterTaskId && run.taskId !== filterTaskId ? '' : filterTaskId;
    queryClient.setQueryData<RunsCache>(runsKey(nextFilter), (current) => ({
      ...current,
      items: [run, ...(current?.items ?? []).filter((item) => item.runId !== run.runId)],
    }));
    setFilterTaskId(nextFilter);
    setSelectedRunId(run.runId);
    invalidateRuns();
  };

  const refreshRun = (run: ServiceAssuranceRunListItem) => {
    invalidateRuns();
    void queryClient.invalidateQueries({ queryKey: ['service-assurance', 'run', run.runId] });
  };

  const createMutation = useMutation({
    mutationFn: (body: ServiceAssuranceCreateRequest) => api.serviceAssurance.createRun(body),
    onSuccess: ({ run }) => {
      selectCreatedRun(run);
      toast.success('核验任务已创建。');
    },
    onError: (error) => toast.error(message(error, '核验任务创建失败。')),
  });

  const cancelMutation = useMutation({
    mutationFn: (runId: string) => api.serviceAssurance.cancelRun(runId),
    onSuccess: ({ run }) => {
      refreshRun(run);
      toast.success('核验已取消。');
    },
    onError: (error) => toast.error(message(error, '取消核验失败。')),
  });

  const linkMutation = useMutation({
    mutationFn: ({ runId, taskId }: { runId: string; taskId: string | null }) =>
      taskId
        ? api.serviceAssurance.linkTask(runId, taskId)
        : api.serviceAssurance.unlinkTask(runId),
    onSuccess: ({ run }) => {
      refreshRun(run);
      toast.success(run.taskId ? '已关联评估任务。' : '已取消关联评估任务。');
    },
    onError: (error) => toast.error(message(error, '关联评估任务失败。')),
  });

  const reviewMutation = useMutation({
    mutationFn: ({
      assessmentId,
      body,
    }: {
      assessmentId: string;
      body: ServiceAssuranceReviewRequest;
    }) => api.serviceAssurance.reviewAssessment(assessmentId, body),
    onSuccess: () => {
      setReviewTarget(null);
      invalidateRuns();
      if (selectedRunId) {
        void queryClient.invalidateQueries({
          queryKey: ['service-assurance', 'run', selectedRunId],
        });
      }
      toast.success('复核结论已保存。');
    },
    onError: (error) => toast.error(message(error, '复核结论保存失败。')),
  });

  const retestMutation = useMutation({
    mutationFn: ({
      assessmentId,
      body,
    }: {
      assessmentId: string;
      body: ServiceAssuranceRetestRequest;
    }) => api.serviceAssurance.retestAssessment(assessmentId, body),
    onSuccess: ({ run }) => {
      setRetestTarget(null);
      selectCreatedRun(run);
      toast.success('复测任务已创建。');
    },
    onError: (error) => toast.error(message(error, '复测任务创建失败。')),
  });

  const reportMutation = useMutation({
    mutationFn: (taskId: string) =>
      api.reports
        .create({ taskId, kind: 'service_assurance', explanationMode: 'local' })
        .then((report) => ({ report, taskId })),
    onSuccess: ({ report, taskId }) => {
      toast.success('AI 服务安全核验报告已生成。');
      navigate(`/reports?taskId=${taskId}&reportId=${report.id}`);
    },
    onError: (error) => toast.error(message(error, '报告生成失败。')),
  });

  const selectedRun = useMemo(
    () => detailQuery.data?.run ?? runs.find((run) => run.runId === selectedRunId) ?? null,
    [detailQuery.data?.run, runs, selectedRunId],
  );
  const currentStatus = statusBand(selectedRun);
  const StatusIcon = currentStatus.icon;

  const refresh = () => {
    void readinessQuery.refetch();
    void tasksQuery.refetch();
    void scopePoliciesQuery.refetch();
    void runsQuery.refetch();
    if (selectedRunId) void detailQuery.refetch();
  };

  const filterChanged = (taskId: string) => {
    setFilterTaskId(taskId);
    setSelectedRunId(null);
    setEvidenceOpen(false);
    setReviewTarget(null);
    setRetestTarget(null);
  };

  if (!canRead) {
    return (
      <EmptyState
        icon={<ShieldCheck className="h-6 w-6" />}
        title="无权查看服务安全核验"
        description="请联系管理员分配服务安全核验读取权限。"
      />
    );
  }

  const canOperate = (run: ServiceAssuranceRunListItem | null) =>
    !!run && (run.mode === 'DEEP' ? canVerify : canScan);

  return (
    <div data-testid="service-assurance-page" className="min-w-0 space-y-5 overflow-x-hidden">
      <PageHeader
        title="AI 服务安全核验"
        description="AI 服务部署、接口暴露与组件清单核验"
        actions={
          <Button
            type="button"
            variant="outline"
            size="icon"
            title="刷新核验数据"
            aria-label="刷新核验数据"
            onClick={refresh}
            disabled={
              readinessQuery.isFetching ||
              scopePoliciesQuery.isFetching ||
              tasksQuery.isFetching ||
              runsQuery.isFetching ||
              detailQuery.isFetching
            }
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        }
      />

      <AssuranceIntro />

      {tasksQuery.isLoading || readinessQuery.isLoading || scopePoliciesQuery.isLoading ? (
        <div className="rounded-md border border-slate-200 bg-white p-6">
          <LoadingBlock label="正在加载核验工作台" />
        </div>
      ) : tasksQuery.isError || readinessQuery.isError || scopePoliciesQuery.isError ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-800">
          核验工作台暂时无法加载，请刷新后重试。
        </div>
      ) : (
        <>
          {(canScan || canVerify) && (
            <AssuranceRunForm
              tasks={tasks}
              selectedTaskId={draftTaskId}
              onTaskChange={setDraftTaskId}
              readiness={readinessQuery.data ?? { modes: [] }}
              scopePolicies={scopePoliciesQuery.data?.policies ?? []}
              canScan={canScan}
              canVerify={canVerify}
              canManageScopes={canManageScopes}
              submitting={createMutation.isPending}
              onSubmit={(body) => createMutation.mutate(body)}
            />
          )}

          <AssuranceTimeline
            runs={runs}
            selectedRunId={selectedRunId}
            emptyText={filterTaskId ? '该评估任务下暂无核验记录。' : '暂无服务安全核验记录。'}
            toolbar={
              <div className="mt-2 max-w-xs">
                <label htmlFor="service-assurance-filter-task" className="sr-only">
                  按评估任务筛选
                </label>
                <Select
                  id="service-assurance-filter-task"
                  value={filterTaskId}
                  onChange={(event) => filterChanged(event.target.value)}
                >
                  <option value="">全部记录</option>
                  {filterTaskId && !tasks.some((task) => task.id === filterTaskId) && (
                    <option value={filterTaskId}>指定评估任务</option>
                  )}
                  {tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.name}
                    </option>
                  ))}
                </Select>
              </div>
            }
            onSelect={(runId) => {
              setSelectedRunId(runId);
              setEvidenceOpen(false);
            }}
            onCancel={(runId) => cancelMutation.mutate(runId)}
            canceling={cancelMutation.isPending}
            canCancel={(run) => ['PENDING', 'RUNNING'].includes(run.status) && canOperate(run)}
          />

          {runsQuery.isLoading ? (
            <div className="rounded-md border border-slate-200 bg-white p-6">
              <LoadingBlock label="正在加载核验记录" />
            </div>
          ) : selectedRun ? (
            <>
              <AssuranceTaskLink
                key={selectedRun.runId}
                run={selectedRun}
                tasks={tasks}
                canLink={canOperate(selectedRun)}
                canGenerateReport={canGenerateReport}
                linking={linkMutation.isPending}
                reporting={reportMutation.isPending}
                onLink={(taskId) => linkMutation.mutate({ runId: selectedRun.runId, taskId })}
                onUnlink={() => linkMutation.mutate({ runId: selectedRun.runId, taskId: null })}
                onGenerateReport={(taskId) => reportMutation.mutate(taskId)}
              />
              <div
                className={cn(
                  'flex min-w-0 items-start gap-3 rounded-md border px-4 py-3',
                  currentStatus.className,
                )}
                aria-live="polite"
              >
                <StatusIcon className="mt-0.5 h-5 w-5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{currentStatus.title}</div>
                  <p className="mt-0.5 break-words text-sm leading-6">{currentStatus.detail}</p>
                </div>
              </div>

              <AssuranceSummary summary={selectedRun.summary} />
              {detailQuery.data && <AssuranceExecutionSummary detail={detailQuery.data} />}

              {detailQuery.isLoading ? (
                <div className="rounded-md border border-slate-200 bg-white p-6">
                  <LoadingBlock label="正在加载核验结论" />
                </div>
              ) : detailQuery.isError ? (
                <div className="rounded-md border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-800">
                  本次核验结论暂时无法加载。
                </div>
              ) : (
                <AssuranceResultList
                  detail={detailQuery.data ?? null}
                  canReview={canReview}
                  canRetest={selectedRun.targetKind !== 'MCP' && canOperate(selectedRun)}
                  onOpenEvidence={() => setEvidenceOpen(true)}
                  onReview={setReviewTarget}
                  onRetest={setRetestTarget}
                />
              )}
            </>
          ) : null}
        </>
      )}

      <AssuranceEvidenceDrawer
        open={evidenceOpen}
        runId={selectedRunId}
        canReview={canReview}
        onClose={() => setEvidenceOpen(false)}
      />
      <AssuranceReviewDialog
        open={!!reviewTarget}
        assessment={reviewTarget}
        submitting={reviewMutation.isPending}
        onClose={() => setReviewTarget(null)}
        onSubmit={(body) => {
          if (!reviewTarget) return;
          reviewMutation.mutate({ assessmentId: reviewTarget.assessmentId, body });
        }}
      />
      <AssuranceRetestDialog
        open={!!retestTarget}
        mode={selectedRun?.mode ?? 'SAFE'}
        assessment={retestTarget}
        submitting={retestMutation.isPending}
        onClose={() => setRetestTarget(null)}
        onSubmit={(body) => {
          if (!retestTarget) return Promise.resolve();
          return retestMutation
            .mutateAsync({ assessmentId: retestTarget.assessmentId, body })
            .then(() => undefined);
        }}
      />
    </div>
  );
}
