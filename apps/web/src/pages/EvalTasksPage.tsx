import { usePlatformAppEnabled } from '@/lib/use-platform-app-enabled';
import { isContentEvalTarget } from '@/lib/eval-targets';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { reEvalBlockedReason } from '@/lib/task-retest';
import { RefreshCw, Trash2, Square, Layers3, Search, Box, Pause, Play } from 'lucide-react';
import { MAX_SAMPLE_SIZE } from '@lse/shared';
import { api, ApiError, type EvalTask, type ModelTarget } from '@/lib/api';
import { TenantCell, TenantFilterSelect, useTenantView } from '@/lib/tenant-view';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/PageHeader';
import { AgentEvalModal } from '@/pages/AgentEvalModal';
import { AgentFanoutModal } from '@/pages/AgentFanoutModal';
import { AdrTraceImportModal } from '@/pages/AdrTraceImportModal';
import { ContentSafetyEvalModal } from '@/pages/ContentSafetyEvalModal';
import { RedTeamEvalModal } from '@/pages/RedTeamEvalModal';
import { MultimodalEvalModal } from '@/pages/MultimodalEvalModal';
import { ComprehensiveEvalModal } from '@/pages/ComprehensiveEvalModal';
import { EvaluationPlanSelector, type EvaluationPlanKind } from './EvaluationPlanSelector';
import { useEndpointEvalLauncher } from './model-targets/useEndpointEvalLauncher';
import { StandardComplianceModal } from '@/pages/StandardComplianceModal';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';
import { QueryState } from '@/components/QueryState';
import { ExportButtons } from '@/components/ExportButtons';
import { cn } from '@/lib/utils';
import { TaskStatusBadge } from '@/components/ui/status-badge';
import {
  DateRangeFilter,
  ModalNotice,
  OutcomeSummary,
  TaskScoreCell,
  TaskStatusNote,
  TaskProgress,
} from '@/components/eval-tasks/task-list-parts';
import {
  EVAL_TASK_STATUSES,
  TASK_STATUS_LABELS,
  ENGINE_CATALOG,
  engineLabel,
  formatDateTime,
  EVAL_SCORE_HINT,
} from '@/lib/format';

// 安全引擎旁 tooltip：用能力口径中文说明「这项能查什么」，不露 sidecar/deepeval/llm-guard 等技术标识。
const ENGINE_HINT_BY_CODE: Record<string, string> = Object.fromEntries(
  ENGINE_CATALOG.map((e) => [e.code, e.hint]),
);

const BUILTIN_ENGINES = ENGINE_CATALOG.filter((e) => e.builtin).map((e) => e.code);
const GATEWAY_ASSURANCE_ENGINE = 'gateway-assurance';
const TASK_EXPORT_FORMATS: Array<{ format: 'csv' | 'json'; label: string }> = [
  { format: 'csv', label: 'CSV' },
  { format: 'json', label: 'JSON' },
];

function isGatewayAssuranceTask(task: { engines: string[]; name: string }): boolean {
  return (
    task.engines.includes(GATEWAY_ASSURANCE_ENGINE) || task.name.includes('Assurance 自动闭环')
  );
}

function isComprehensiveTask(task: { dimensions: string[] }): boolean {
  return task.dimensions.includes('comprehensive');
}

function isRedTeamListTask(task: {
  engines: string[];
  dimensions: string[];
  name: string;
}): boolean {
  return (
    task.engines.includes('autonomous-red-team') ||
    task.dimensions.includes('redteam_attack') ||
    /红队|red.?team/i.test(task.name)
  );
}

function hasLayerResultData(task: {
  stealthBreakCount?: number;
  recognizedCount?: number;
}): boolean {
  return task.stealthBreakCount !== undefined || task.recognizedCount !== undefined;
}

function executableTarget(target: ModelTarget, platformAppEnabled = false): boolean {
  return isContentEvalTarget(target, platformAppEnabled);
}

function targetOptionLabel(target: ModelTarget): string {
  if (target.targetType === 'AGENT_API') return `${target.name}（评估对象）`;
  return `${target.name}（${target.model}）`;
}

interface CreateForm {
  name: string;
  description: string;
  modelTargetId: string;
  questionSetIds: string[];
  engines: string[];
  dimensions: string[];
  concurrency: number;
  /** 抽样题数：留空为全量；大规模题库按小类分层抽样。 */
  sampleSize: string;
}
const EMPTY_FORM: CreateForm = {
  name: '',
  description: '',
  modelTargetId: '',
  questionSetIds: [],
  engines: [...BUILTIN_ENGINES],
  dimensions: [],
  concurrency: 4,
  sampleSize: '',
};
/** 所选样本库合计超过该题数时，默认建议抽样。 */
const LARGE_POOL_THRESHOLD = 5000;
const SUGGESTED_SAMPLE_SIZE = 2000;

export function EvalTasksPage() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const platformAppEnabled = usePlatformAppEnabled();
  const endpointLauncher = useEndpointEvalLauncher();
  const navigate = useNavigate();

  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [resultFilter, setResultFilter] = useState<'' | 'risk' | 'pass' | 'error'>('');
  const [startFrom, setStartFrom] = useState('');
  const [startTo, setStartTo] = useState('');
  // 勾选任务用于多模型对比分析
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [contentSafetyOpen, setContentSafetyOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [fanoutOpen, setFanoutOpen] = useState(false);
  const [adrImportOpen, setAdrImportOpen] = useState(false);
  const [redTeamOpen, setRedTeamOpen] = useState(false);
  const [multimodalOpen, setMultimodalOpen] = useState(false);
  const [comprehensiveOpen, setComprehensiveOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [standardOpen, setStandardOpen] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  // 样本库「内置合规题库」一键“用于评估”：带着题库 ID 跳转过来时直接打开新建任务并预选。
  const location = useLocation();
  useEffect(() => {
    const state = location.state as {
      endpointRetestTargetId?: string;
      endpointRetestMode?: 'run';
    } | null;
    if (!state?.endpointRetestTargetId) return;
    endpointLauncher.mutate({
      id: state.endpointRetestTargetId,
      mode: state.endpointRetestMode ?? 'posture',
    });
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state]);
  const presetSetId = (location.state as { useQuestionSetId?: string } | null)?.useQuestionSetId;
  useEffect(() => {
    if (!presetSetId) return;
    setForm({ ...EMPTY_FORM, questionSetIds: [presetSetId] });
    setOpen(true);
    navigate(location.pathname, { replace: true, state: null });
  }, [presetSetId]);
  // 态势概览的检测入口通过 ?launch=redteam|content|standard 直接打开对应发起弹窗。
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const launch = searchParams.get('launch');
    if (!launch) return;
    const opener = {
      redteam: setRedTeamOpen,
      content: setContentSafetyOpen,
      standard: setStandardOpen,
    }[launch as 'redteam' | 'content' | 'standard'];
    if (opener && hasPermission('eval_task:create')) opener(true);
    const next = new URLSearchParams(searchParams);
    next.delete('launch');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, hasPermission]);

  const { isAllTenants, listParams, tenantFilter, guardCreate, guardRow } = useTenantView();
  const canCreate = hasPermission('eval_task:create');
  const canReEval = hasPermission('eval_task:re_eval');
  const canDelete = hasPermission('eval_task:delete');

  const pageSize = 10;
  const listFilters = {
    keyword: search || undefined,
    status: statusFilter || undefined,
    modelTargetId: modelFilter || undefined,
    result: resultFilter || undefined,
    startFrom: startFrom || undefined,
    startTo: startTo || undefined,
    ...listParams,
  };
  const list = useQuery({
    queryKey: [
      'eval-tasks',
      page,
      search,
      statusFilter,
      modelFilter,
      resultFilter,
      startFrom,
      startTo,
      tenantFilter,
    ],
    queryFn: () => api.evalTasks.list({ page, pageSize, ...listFilters }),
    refetchInterval: (q) => {
      const items = q.state.data?.items ?? [];
      return items.some((t) => t.status === 'PENDING' || t.status === 'RUNNING') ? 4000 : false;
    },
  });

  // 全部租户视角下点行先进入该行所属租户，再打开同一个任务详情。
  const openTask = (t: EvalTask) => {
    const path = `/eval-tasks/${t.id}`;
    if (!guardRow(t.tenantId, path)) navigate(path);
  };
  const taskAction = (t: EvalTask, fn: () => void) => {
    if (!guardRow(t.tenantId, `/eval-tasks/${t.id}`)) fn();
  };

  const filterModels = useQuery({
    queryKey: ['model-targets', 'task-filter'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 100 }),
    enabled: hasPermission('eval_task:read'),
  });
  const models = useQuery({
    queryKey: ['model-targets', 'active-for-task'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 100 }),
    enabled: open || planOpen,
  });
  const sets = useQuery({
    queryKey: ['question-sets', 'all-for-task'],
    queryFn: () => api.questionSets.list({ page: 1, pageSize: 100, enabled: true }),
    enabled: open,
  });
  const enginesCatalog = useQuery({
    queryKey: ['engines-catalog'],
    queryFn: () => api.engines.list(),
    enabled: open,
    staleTime: 60 * 60 * 1000,
  });

  // 弹窗打开后，按后端真实可用情况把"默认勾对的引擎"种进表单（仅一次，不覆盖用户手动改动）。
  const enginesSeeded = useRef(false);
  useEffect(() => {
    if (!open) {
      enginesSeeded.current = false;
      return;
    }
    const items = enginesCatalog.data;
    if (!items || enginesSeeded.current) return;
    enginesSeeded.current = true;
    setForm((prev) => ({
      ...prev,
      engines: items
        .filter((e) => ['rule-judge', 'sensitive-info'].includes(e.engine))
        .map((e) => e.engine),
    }));
  }, [open, enginesCatalog.data]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['eval-tasks'] });

  const createMutation = useMutation({
    mutationFn: () =>
      api.evalTasks.create({
        // 任务名称留空则自动命名，不强制用户填写。
        name:
          form.name.trim() ||
          `样本库回归评估 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        description: form.description.trim() || undefined,
        modelTargetId: form.modelTargetId,
        questionSetIds: form.questionSetIds,
        engines: form.engines,
        // 评估维度（报告归类）由后端依据所选样本库自动推断，不再让用户手勾。
        dimensions: [],
        concurrency: form.concurrency,
        sampleSize: form.sampleSize.trim() ? Number(form.sampleSize) : undefined,
      }),
    onSuccess: (task) => {
      toast.success('已发起样本库回归评估');
      setOpen(false);
      setForm(EMPTY_FORM);
      invalidate();
      navigate(`/eval-tasks/${task.id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '创建失败'),
  });

  const reEvalMutation = useMutation({
    mutationFn: (id: string) => api.evalTasks.reEval(id),
    onSuccess: () => {
      toast.success('已重新发起评估');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.evalTasks.remove(id),
    onSuccess: () => {
      toast.success('已删除');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.evalTasks.cancel(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['eval-tasks'] });
      qc.setQueriesData<{ items: Array<{ id: string; status: string }> }>(
        { queryKey: ['eval-tasks'] },
        (old) =>
          old
            ? {
                ...old,
                items: old.items.map((item) =>
                  item.id === id ? { ...item, status: 'CANCELED' } : item,
                ),
              }
            : old,
      );
    },
    onSuccess: () => {
      toast.success('已请求停止，任务将尽快结束（可能还需几秒收尾）');
      invalidate();
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : '停止失败');
      invalidate();
    },
  });

  // 暂停、恢复（2.4.2）：执行中的任务暂停后先是「暂停中」，进行中的题做完再停。
  const pauseMutation = useMutation({
    mutationFn: (id: string) => api.evalTasks.pause(id),
    onSuccess: (res) => {
      toast.success(res.pauseRequested ? '已请求暂停，进行中的题做完后停下' : '已暂停');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '暂停失败'),
  });
  const resumeMutation = useMutation({
    mutationFn: (id: string) => api.evalTasks.resume(id),
    onSuccess: () => {
      toast.success('已恢复');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '恢复失败'),
  });

  const toggle = (field: 'questionSetIds' | 'engines' | 'dimensions', value: string) =>
    setForm((prev) => {
      const set = new Set(prev[field]);
      if (set.has(value)) set.delete(value);
      else set.add(value);
      return { ...prev, [field]: [...set] };
    });

  const poolTotal = (sets.data?.items ?? [])
    .filter((s) => form.questionSetIds.includes(s.id))
    .reduce((sum, s) => sum + s.questionCount, 0);
  const sampleLimit = Math.min(MAX_SAMPLE_SIZE, poolTotal);
  const sampleNum = form.sampleSize.trim() ? Number(form.sampleSize) : null;
  const sampleInvalid =
    sampleNum !== null &&
    (!Number.isInteger(sampleNum) || sampleNum < 1 || sampleNum > sampleLimit);
  const canSubmit =
    form.modelTargetId && form.questionSetIds.length > 0 && poolTotal > 0 && !sampleInvalid;

  return (
    <div>
      <PageHeader
        title="评估任务"
        description="评估任务的创建、执行与复核"
        actions={
          canCreate ? (
            <Button onClick={() => guardCreate(() => setPlanOpen(true))}>
              <Layers3 className="h-4 w-4" />
              新建评估
            </Button>
          ) : null
        }
      />

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-5 py-4">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setPage(1);
                setSearch(keyword.trim());
              }}
            >
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
                  aria-hidden="true"
                />
                <Input
                  placeholder="按任务名称搜索…"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  className="w-[240px] pl-9"
                />
              </div>
              <Button type="submit" variant="outline" className="h-10">
                搜索
              </Button>
            </form>
            <Select
              value={statusFilter}
              onChange={(e) => {
                setPage(1);
                setStatusFilter(e.target.value);
              }}
              className="w-auto min-w-[120px] max-w-[160px]"
            >
              <option value="">全部状态</option>
              {EVAL_TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
            <Select
              aria-label="评估模型"
              value={modelFilter}
              onChange={(e) => {
                setPage(1);
                setModelFilter(e.target.value);
              }}
              className="w-auto min-w-[140px] max-w-[200px]"
            >
              <option value="">全部评估模型</option>
              {(filterModels.data?.items ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="运行结果"
              value={resultFilter}
              onChange={(e) => {
                setPage(1);
                setResultFilter(e.target.value as typeof resultFilter);
              }}
              className="w-auto min-w-[130px] max-w-[160px]"
            >
              <option value="">全部运行结果</option>
              <option value="risk">发现风险</option>
              <option value="pass">全部通过</option>
              <option value="error">存在异常</option>
            </Select>
            <TenantFilterSelect />
            <DateRangeFilter
              from={startFrom}
              to={startTo}
              fromLabel="执行时间起"
              toLabel="执行时间止"
              onFrom={(v) => {
                setPage(1);
                setStartFrom(v);
              }}
              onTo={(v) => {
                setPage(1);
                setStartTo(v);
              }}
            />
            {hasPermission('eval_task:read') && !!list.data?.total && (
              <ExportButtons
                name="导出任务列表"
                className="ml-auto"
                formats={TASK_EXPORT_FORMATS}
                onExport={(format) => api.evalTasks.exportList(listFilters, format)}
              />
            )}
            <Button
              variant="outline"
              className={cn('h-10', !list.data?.total && 'ml-auto')}
              disabled={compareIds.length < 2}
              title="勾选至少 2 个任务后对比各模型的得分、通过率与风险分布"
              onClick={() => navigate(`/eval-tasks/compare?ids=${compareIds.join(',')}`)}
            >
              对比分析{compareIds.length > 0 ? `（${compareIds.length}）` : ''}
            </Button>
          </div>

          <div className={list.data && list.data.items.length > 0 ? 'p-5' : 'px-5 pb-5'}>
            <QueryState
              isLoading={list.isLoading}
              isError={list.isError}
              error={list.error}
              onRetry={() => void list.refetch()}
              empty={!list.data || list.data.items.length === 0}
              filtered={Boolean(
                search || statusFilter || modelFilter || resultFilter || startFrom || startTo,
              )}
              permissionDenied={!hasPermission('eval_task:read')}
              emptyTitle="暂无评估任务"
              emptyDescription="选择“新建评估”创建首个任务。"
            />
            {!list.isLoading &&
            !list.isError &&
            hasPermission('eval_task:read') &&
            list.data &&
            list.data.items.length > 0 ? (
              <>
                <Table fit className="md:min-w-[960px]" aria-label="评估任务列表">
                  <THead>
                    <TR>
                      <TH className="w-10 pl-4">
                        <span className="sr-only">选择对比</span>
                      </TH>
                      {isAllTenants && <TH>租户</TH>}
                      <TH className="w-[32%]">任务名称</TH>
                      <TH className="w-[92px]">状态</TH>
                      <TH className="w-[120px]">进度</TH>
                      <TH>结论</TH>
                      <TH className="w-24 text-right" title={EVAL_SCORE_HINT}>
                        评估得分
                      </TH>
                      <TH className="w-[150px] text-right">操作</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {list.data.items.map((t) => (
                      <TR key={t.id} className="cursor-pointer" onClick={() => openTask(t)}>
                        {isAllTenants && (
                          <TD data-label="租户">
                            <TenantCell tenantId={t.tenantId} />
                          </TD>
                        )}
                        <TD
                          data-label="选择对比"
                          className="pl-4"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[#1F57E0]"
                            aria-label={`选择对比：${t.name}`}
                            checked={compareIds.includes(t.id)}
                            onChange={(e) =>
                              setCompareIds((prev) =>
                                e.target.checked
                                  ? [...prev, t.id].slice(-20)
                                  : prev.filter((id) => id !== t.id),
                              )
                            }
                          />
                        </TD>
                        <TD data-label="任务名称" className="py-3 align-top">
                          <span
                            className="line-clamp-2 min-w-0 max-w-full break-words text-[14px] font-semibold leading-5 text-ink"
                            title={t.name}
                          >
                            {t.name}
                          </span>
                          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
                            <span
                              className="inline-flex min-w-0 max-w-[16rem] items-center gap-1"
                              title={`评估对象：${t.modelTarget?.name ?? '—'}`}
                            >
                              <Box className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                              <span className="truncate">{t.modelTarget?.name ?? '—'}</span>
                            </span>
                            <span className="text-line-2" aria-hidden="true">
                              |
                            </span>
                            {isGatewayAssuranceTask(t) ? (
                              <span>
                                最近更新 {formatDateTime(t.updatedAt)} · 累计 {t.logCount} 轮
                              </span>
                            ) : (
                              <span className="tabular-nums">{formatDateTime(t.createdAt)}</span>
                            )}
                            {isComprehensiveTask(t) && (
                              <Badge tone="info" className="px-1.5">
                                综合评估
                              </Badge>
                            )}
                            {isGatewayAssuranceTask(t) && (
                              <Badge
                                tone="success"
                                className="px-1.5"
                                title="由网关实时流量自动持续检测，无需手动重复发起"
                              >
                                持续闭环
                              </Badge>
                            )}
                          </div>
                        </TD>
                        <TD data-label="状态" className="align-top py-3">
                          <TaskStatusBadge value={t.status} />
                          <TaskStatusNote
                            targetType={t.modelTarget?.targetType}
                            description={t.description}
                          />
                        </TD>
                        <TD data-label="进度" className="align-top py-3">
                          <TaskProgress
                            processed={t.processedQuestions}
                            total={t.totalQuestions}
                            status={t.status}
                          />
                        </TD>
                        <TD data-label="结论" className="align-top py-3 text-xs">
                          <OutcomeSummary task={t} />
                          {isRedTeamListTask(t) && !hasLayerResultData(t) && (
                            <div className="mt-1 text-xs leading-4 text-muted-foreground">
                              本次未生成攻击回合的逐层明细
                            </div>
                          )}
                        </TD>
                        <TD
                          data-label="评估得分"
                          className="whitespace-nowrap py-3 text-right align-top text-[15px] font-bold tabular-nums"
                        >
                          <TaskScoreCell task={t} />
                        </TD>
                        <TD
                          data-label="操作"
                          className="py-3 align-top"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex flex-wrap items-center justify-start gap-1 md:justify-end">
                            <Button
                              variant="secondary"
                              size="sm"
                              className="bg-brand-50 text-brand-700 hover:bg-brand-100"
                              onClick={() => openTask(t)}
                            >
                              查看
                            </Button>
                            {canReEval && !reEvalBlockedReason(t) && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                aria-label="重新评估"
                                title="重新评估"
                                disabled={t.status === 'RUNNING' || t.status === 'PENDING'}
                                onClick={() => taskAction(t, () => reEvalMutation.mutate(t.id))}
                              >
                                <RefreshCw className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {canReEval &&
                              t.pausable &&
                              (t.status === 'PENDING' || t.status === 'RUNNING') && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  aria-label={t.pauseRequested ? '暂停中' : '暂停'}
                                  title={t.pauseRequested ? '暂停中，进行中的题做完再停' : '暂停'}
                                  disabled={t.pauseRequested || pauseMutation.isPending}
                                  onClick={() => taskAction(t, () => pauseMutation.mutate(t.id))}
                                >
                                  <Pause className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            {canReEval &&
                              t.pausable &&
                              (t.status === 'PAUSED' || t.pauseRequested) && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  aria-label={t.pauseRequested ? '撤销暂停' : '恢复'}
                                  title={t.pauseRequested ? '撤销暂停' : '恢复'}
                                  disabled={resumeMutation.isPending}
                                  onClick={() => taskAction(t, () => resumeMutation.mutate(t.id))}
                                >
                                  <Play className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            {canDelete &&
                              (t.status === 'RUNNING' ||
                                t.status === 'PENDING' ||
                                (t.status === 'PAUSED' && t.pausable)) && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  aria-label="停止"
                                  title="停止"
                                  disabled={cancelMutation.isPending}
                                  onClick={() => taskAction(t, () => cancelMutation.mutate(t.id))}
                                >
                                  <Square className="h-3.5 w-3.5 text-severity-medium" />
                                </Button>
                              )}
                            {canDelete && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                aria-label="删除"
                                title="删除"
                                disabled={t.status === 'RUNNING'}
                                onClick={() =>
                                  taskAction(t, () => {
                                    if (confirm(`确认删除任务「${t.name}」？`))
                                      deleteMutation.mutate(t.id);
                                  })
                                }
                              >
                                <Trash2 className="h-3.5 w-3.5 text-destructive" />
                              </Button>
                            )}
                          </div>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                <Pagination
                  page={page}
                  pageSize={pageSize}
                  total={list.data.total}
                  onPageChange={setPage}
                />
              </>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <ContentSafetyEvalModal
        initialTargetId={selectedTargetId}
        open={contentSafetyOpen}
        onClose={() => setContentSafetyOpen(false)}
      />
      <RedTeamEvalModal
        initialTargetId={selectedTargetId}
        open={redTeamOpen}
        onClose={() => setRedTeamOpen(false)}
      />
      <MultimodalEvalModal
        initialTargetId={selectedTargetId}
        open={multimodalOpen}
        onClose={() => setMultimodalOpen(false)}
      />
      <StandardComplianceModal
        initialTargetId={selectedTargetId}
        open={standardOpen}
        onClose={() => setStandardOpen(false)}
      />
      <ComprehensiveEvalModal
        initialTargetId={selectedTargetId}
        open={comprehensiveOpen}
        onClose={() => setComprehensiveOpen(false)}
      />
      <AgentEvalModal
        initialTargetId={selectedTargetId}
        open={agentOpen}
        onClose={() => setAgentOpen(false)}
      />
      <AgentFanoutModal
        initialTargetId={selectedTargetId}
        open={fanoutOpen}
        onClose={() => setFanoutOpen(false)}
      />
      <AdrTraceImportModal
        initialTargetId={selectedTargetId}
        open={adrImportOpen}
        onClose={() => setAdrImportOpen(false)}
      />

      {endpointLauncher.dialog}
      <Modal
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        title="选择评估方案"
        description="先明确评估对象和范围，再按实际接入条件开放可执行模块。未具备轨迹或工具观测条件的能力不会被标为已覆盖。"
        size="lg"
      >
        <EvaluationPlanSelector
          targets={models.data?.items ?? []}
          loading={models.isLoading}
          failed={models.isError}
          retry={() => void models.refetch()}
          onSelect={(kind: EvaluationPlanKind, targetId: string) => {
            setSelectedTargetId(targetId);
            setPlanOpen(false);
            // 终端智能体：复用评估对象页的「配置体检 / 真机测评」发起逻辑。
            if (kind === 'endpoint-posture' || kind === 'endpoint-run') {
              endpointLauncher.mutate({
                id: targetId,
                mode: kind === 'endpoint-run' ? 'run' : 'posture',
              });
              return;
            }
            // MCP 专项：走样本库回归流程，并预选内置的 MCP 专项样本库（找不到时留空由用户选）。
            if (kind === 'mcp') {
              void (async () => {
                let setId: string | undefined;
                try {
                  const found = await api.questionSets.list({
                    page: 1,
                    pageSize: 100,
                    keyword: 'MCP',
                    origin: 'builtin',
                  });
                  setId = found.items.find((item) => item.source?.startsWith('builtin:mcp:'))?.id;
                } catch {
                  setId = undefined;
                }
                setForm({
                  ...EMPTY_FORM,
                  modelTargetId: targetId,
                  questionSetIds: setId ? [setId] : [],
                });
                setOpen(true);
              })();
              return;
            }
            const actions = {
              content: setContentSafetyOpen,
              standard: setStandardOpen,
              agent: setAgentOpen,
              redteam: setRedTeamOpen,
              regression: setOpen,
              comprehensive: setComprehensiveOpen,
              fanout: setFanoutOpen,
              trace: setAdrImportOpen,
              multimodal: setMultimodalOpen,
            };
            if (kind === 'regression') setForm({ ...EMPTY_FORM, modelTargetId: targetId });
            actions[kind](true);
          }}
        />
      </Modal>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="新建样本库回归评估"
        description="使用已有样本库执行基线验证或整改复测，不包含多轮自适应攻击。"
        size="xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || !canSubmit}
            >
              {createMutation.isPending && <Spinner className="h-4 w-4" />}
              创建并执行
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <ModalNotice detail="执行时间取决于样本数量和模型响应速度。任务详情将展示结论、执行缺口与逐项结果。">
            平台将对所选评估对象执行样本库中的测试样本（默认全量，大规模题库可按小类分层抽样），并记录逐项判定和证据。
          </ModalNotice>
          <Field label="评估对象" htmlFor="regression-target" required>
            <Select
              id="regression-target"
              aria-label="评估对象"
              value={form.modelTargetId}
              onChange={(e) => setForm({ ...form, modelTargetId: e.target.value })}
            >
              <option value="">请选择评估对象…</option>
              {models.data?.items
                .filter((target) => executableTarget(target, platformAppEnabled))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {targetOptionLabel(m)}
                  </option>
                ))}
            </Select>
          </Field>

          <Field label="样本库（必选）" hint="可选择一个或多个样本库。">
            <div className="max-h-44 space-y-2 overflow-y-auto rounded-xl border border-line p-3.5">
              {sets.isLoading ? (
                <Spinner className="h-4 w-4" />
              ) : sets.data && sets.data.items.length > 0 ? (
                sets.data.items.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={form.questionSetIds.includes(s.id)}
                      onChange={() => toggle('questionSetIds', s.id)}
                    />
                    <span>{s.name}</span>
                    <span className="text-xs text-muted-foreground">
                      （{s.questionCount.toLocaleString('zh-CN')} 条）
                    </span>
                  </label>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  暂无样本库，请先在「样本库管理」创建或导入测试样本。
                </p>
              )}
            </div>
          </Field>

          <Field
            label="抽样题数"
            hint={`留空为全量评估；填写后按小类分层抽样（每类至少 1 题，可复现），上限 ${sampleLimit.toLocaleString('zh-CN')}`}
          >
            <div className="space-y-1.5">
              <Input
                type="number"
                aria-label="抽样题数"
                min={1}
                max={sampleLimit}
                value={form.sampleSize}
                placeholder="留空 = 全量"
                onChange={(e) => setForm({ ...form, sampleSize: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                已选样本库合计 {poolTotal.toLocaleString('zh-CN')} 题，本次将评估{' '}
                {(sampleNum && !sampleInvalid
                  ? Math.min(sampleNum, poolTotal)
                  : poolTotal
                ).toLocaleString('zh-CN')}{' '}
                题
              </p>
              {sampleInvalid ? (
                <p className="text-xs text-destructive">
                  抽样题数须为 1–{sampleLimit.toLocaleString('zh-CN')} 的整数
                </p>
              ) : poolTotal > LARGE_POOL_THRESHOLD && sampleNum === null ? (
                <p className="text-xs text-severity-medium">
                  题量较大，全量评估耗时与调用成本较高，建议抽样
                  <button
                    type="button"
                    className="ml-1 underline"
                    onClick={() => setForm({ ...form, sampleSize: String(SUGGESTED_SAMPLE_SIZE) })}
                  >
                    按 {SUGGESTED_SAMPLE_SIZE.toLocaleString('zh-CN')} 题分层抽样
                  </button>
                </p>
              ) : null}
            </div>
          </Field>

          {/* 高级设置：默认折叠，已配好默认；评估维度由后端按样本库自动推断，不再让用户手勾 */}
          <details className="rounded-md border border-border bg-muted/10 px-3 py-2">
            <summary className="cursor-pointer select-none text-sm font-medium text-slate-700">
              高级设置
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                任务名称 / 并发数 / 安全引擎，已预置默认配置
              </span>
            </summary>
            <div className="mt-3 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="任务名称" hint="留空将自动按时间命名">
                  <Input
                    value={form.name}
                    placeholder="留空自动命名"
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </Field>
                <Field label="并发数" hint="1–32，默认 4">
                  <Input
                    type="number"
                    min={1}
                    max={32}
                    value={form.concurrency}
                    onChange={(e) => setForm({ ...form, concurrency: Number(e.target.value) || 1 })}
                  />
                </Field>
              </div>

              <Field label="安全引擎" hint="规则与敏感信息为内置引擎，始终启用">
                <div className="space-y-1.5 rounded-md border border-border p-3">
                  {enginesCatalog.isLoading ? (
                    <Spinner className="h-4 w-4" />
                  ) : (
                    // 仅展示当前可用的引擎（内置或已启用）；未部署的不外露，避免客户误读为产品缺失。
                    enginesCatalog.data
                      ?.filter((e) => e.builtin || e.available)
                      .map((e) => {
                        const required = ['rule-judge', 'sensitive-info'].includes(e.engine);
                        const checked = required || form.engines.includes(e.engine);
                        // 名称与说明统一走能力口径中文，不外露后端引擎标识/英文原名。
                        return (
                          <label
                            key={e.engine}
                            className="flex items-center gap-2 text-sm"
                            title={ENGINE_HINT_BY_CODE[e.engine] ?? '评估回答的安全性。'}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={required}
                              onChange={() => toggle('engines', e.engine)}
                            />
                            <span>{engineLabel(e.engine)}</span>
                            {e.builtin && (
                              <span className="text-xs text-muted-foreground">内置</span>
                            )}
                          </label>
                        );
                      })
                  )}
                </div>
              </Field>

              <Field label="描述">
                <Textarea
                  rows={2}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </Field>
            </div>
          </details>
        </div>
      </Modal>
    </div>
  );
}
