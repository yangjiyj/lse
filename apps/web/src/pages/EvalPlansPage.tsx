import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type EvalPlanItem, type EvalPlanRunItem } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, TASK_STATUS_LABELS } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { RowActionMenu, type RowActionItem } from '@/components/page-kit/RowActionMenu';
import { describeCron } from './eval-plans/cron-describe';
import { EvalPlanFormModal } from './eval-plans/EvalPlanFormModal';

const PAGE_SIZE = 20;
const RUNS_PAGE_SIZE = 10;
export const TRIGGER_LABELS: Record<string, string> = {
  manual: '手动',
  schedule: '定时',
  ci: 'CI',
};
const LINK = 'text-sm text-brand-600 hover:underline disabled:text-slate-400';

function errMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

function LastRunCell({ plan }: { plan: EvalPlanItem }) {
  if (!plan.lastTriggeredAt && !plan.lastSkipReason) {
    return <span className="text-ink-3">暂无运行</span>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {plan.lastTriggeredAt && (
        <span className="tabular-nums">{formatDateTime(plan.lastTriggeredAt)}</span>
      )}
      {plan.lastSkipReason && (
        <span className="text-xs text-severity-high">最近一次跳过：{plan.lastSkipReason}</span>
      )}
    </div>
  );
}

/** 与上次对比：计划 + 本次任务，后端按计划取本次之前最近一次已完成运行对齐。 */
export function compareWithPreviousHref(planId: string, taskId: string): string {
  const q = new URLSearchParams({ planId, headTaskId: taskId });
  return `/eval-tasks/compare?${q.toString()}`;
}

function RunsPanel({ plan, onClose }: { plan: EvalPlanItem; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const runs = useQuery({
    queryKey: ['eval-plans', plan.id, 'runs', page],
    queryFn: () => api.evalPlans.runs(plan.id, { page, pageSize: RUNS_PAGE_SIZE }),
  });
  const items = runs.data?.items ?? [];
  const total = runs.data?.total ?? 0;
  const hasOlderPage = page * RUNS_PAGE_SIZE < total;
  /** 本页之后（更早）是否还有生成了任务的运行，决定能否“与上次对比”。 */
  const hasEarlierTask = (idx: number) =>
    hasOlderPage || items.slice(idx + 1).some((r: EvalPlanRunItem) => r.task);

  return (
    <SectionCard
      title={`运行记录：${plan.name}`}
      extra={
        <button type="button" className={LINK} onClick={onClose}>
          收起
        </button>
      }
    >
      <>
        {runs.isLoading ? (
          <LoadingBlock />
        ) : runs.isError ? (
          <p className="text-sm text-severity-critical">{errMessage(runs.error, '加载失败')}</p>
        ) : items.length === 0 ? (
          <EmptyState title="暂无数据" description="该计划还没有触发过。" />
        ) : (
          <>
            <Table aria-label="运行记录">
              <THead>
                <TR>
                  <TH>触发时间</TH>
                  <TH>触发方式</TH>
                  <TH>结果</TH>
                  <TH>评估任务</TH>
                  <TH>任务状态</TH>
                  <TH>操作</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((r, idx) => (
                  <TR key={r.id} className="h-10">
                    <TD data-label="触发时间" className="tabular-nums">
                      {formatDateTime(r.createdAt)}
                    </TD>
                    <TD data-label="触发方式">{TRIGGER_LABELS[r.triggeredBy] ?? r.triggeredBy}</TD>
                    <TD data-label="结果">
                      {r.status === 'triggered' ? (
                        <Badge tone="info">已生成任务</Badge>
                      ) : (
                        <span className="flex flex-col gap-0.5">
                          <Badge tone="warning">已跳过</Badge>
                          {r.reason && <span className="text-xs text-ink-3">{r.reason}</span>}
                        </span>
                      )}
                    </TD>
                    <TD data-label="评估任务">
                      {r.task ? (
                        <Link to={`/eval-tasks/${r.task.id}`} className={LINK}>
                          {r.task.name}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TD>
                    <TD data-label="任务状态">
                      {r.task
                        ? (TASK_STATUS_LABELS[r.task.status as keyof typeof TASK_STATUS_LABELS] ??
                          r.task.status)
                        : '—'}
                    </TD>
                    <TD data-label="操作">
                      {r.task && hasEarlierTask(idx) ? (
                        <Link to={compareWithPreviousHref(plan.id, r.task.id)} className={LINK}>
                          与上次对比
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination
              page={page}
              pageSize={RUNS_PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          </>
        )}
      </>
    </SectionCard>
  );
}

export function EvalPlansPage() {
  const { hasPermission } = useAuth();
  const canRead = hasPermission('eval_task:read');
  const canCreate = hasPermission('eval_task:create');
  const canDelete = hasPermission('eval_task:delete');
  const qc = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  // undefined = 关闭；null = 新建；对象 = 编辑
  const [editing, setEditing] = useState<EvalPlanItem | null | undefined>(undefined);
  const [runsOf, setRunsOf] = useState<EvalPlanItem | null>(null);

  const list = useQuery({
    queryKey: ['eval-plans', 'list', page, keyword],
    queryFn: () =>
      api.evalPlans.list({ page, pageSize: PAGE_SIZE, keyword: keyword.trim() || undefined }),
    enabled: canRead,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['eval-plans'] });
  const toggle = useMutation({
    mutationFn: (p: EvalPlanItem) => api.evalPlans.toggle(p.id, !p.enabled),
    onSuccess: (p) => {
      toast.success(p.enabled ? '计划已启用' : '计划已停用');
      void invalidate();
    },
    onError: (e) => toast.error(errMessage(e, '操作失败')),
  });
  const trigger = useMutation({
    mutationFn: (p: EvalPlanItem) => api.evalPlans.trigger(p.id),
    onSuccess: (r) => {
      if (r.status === 'triggered') toast.success('已生成评估任务');
      else toast.error(`本次触发已跳过：${r.reason ?? ''}`);
      void invalidate();
    },
    onError: (e) => {
      toast.error(errMessage(e, '触发失败'));
      void invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (p: EvalPlanItem) => api.evalPlans.remove(p.id),
    onSuccess: (_r, p) => {
      toast.success('计划已删除');
      if (runsOf?.id === p.id) setRunsOf(null);
      void invalidate();
    },
    onError: (e) => toast.error(errMessage(e, '删除失败')),
  });

  const planMoreItems = (p: EvalPlanItem): RowActionItem[] => {
    const items: RowActionItem[] = [];
    if (canCreate) {
      items.push(
        { key: 'edit', label: '编辑', onSelect: () => setEditing(p) },
        {
          key: 'toggle',
          label: p.enabled ? '停用' : '启用',
          disabled: toggle.isPending,
          onSelect: () => toggle.mutate(p),
        },
      );
    }
    if (canDelete) {
      items.push({
        key: 'delete',
        label: '删除',
        danger: true,
        disabled: remove.isPending,
        onSelect: () => {
          if (
            window.confirm(
              `确认删除评估计划「${p.name}」？已生成的评估任务会保留，运行记录将删除。`,
            )
          ) {
            remove.mutate(p);
          }
        },
      });
    }
    return items;
  };

  if (!canRead) {
    return (
      <div>
        <PageHeader title="评估计划" />
        <EmptyState title="缺少查看评估计划的权限" />
      </div>
    );
  }
  const items = list.data?.items ?? [];
  return (
    <div className="space-y-5">
      <PageHeader
        title="评估计划"
        description="按计划定时或经 CI 触发评估，每次触发生成一个评估任务；可与上次运行做回归对比。"
        actions={canCreate ? <Button onClick={() => setEditing(null)}>新建计划</Button> : undefined}
      />
      <div className="space-y-4">
        <div className="flex items-center gap-2 rounded-card border border-line bg-white p-3 shadow-card">
          <Input
            aria-label="搜索计划名称"
            placeholder="搜索计划名称"
            className="max-w-xs"
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setPage(1);
            }}
          />
        </div>
        {list.isLoading ? (
          <LoadingBlock />
        ) : list.isError ? (
          <p className="text-sm text-severity-critical">{errMessage(list.error, '加载失败')}</p>
        ) : items.length === 0 ? (
          <EmptyState title="暂无数据" description="还没有评估计划。" />
        ) : (
          <>
            <Table aria-label="评估计划列表">
              <THead>
                <TR>
                  <TH>计划名称</TH>
                  <TH>评估对象</TH>
                  <TH>执行周期</TH>
                  <TH>下次执行</TH>
                  <TH>状态</TH>
                  <TH>最近运行</TH>
                  <TH>计划 ID</TH>
                  <TH>操作</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((p) => (
                  <TR key={p.id} className="h-10">
                    <TD data-label="计划名称" className="font-medium">
                      {p.name}
                    </TD>
                    <TD data-label="评估对象">
                      {p.targetName}
                      {!p.targetActive && (
                        <span className="ml-1 text-xs text-severity-high">（已禁用）</span>
                      )}
                    </TD>
                    <TD data-label="执行周期">
                      <div className="flex flex-col gap-0.5">
                        <span>{describeCron(p.cron)}</span>
                        <span className="font-mono text-xs text-ink-3">
                          {p.cron}
                          {p.timezone !== 'Asia/Shanghai' ? ` · ${p.timezone}` : ''}
                        </span>
                      </div>
                    </TD>
                    <TD data-label="下次执行" className="tabular-nums">
                      {p.enabled && p.nextRunAt ? formatDateTime(p.nextRunAt) : '—'}
                    </TD>
                    <TD data-label="状态">
                      <Badge tone={p.enabled ? 'success' : 'neutral'}>
                        {p.enabled ? '已启用' : '已停用'}
                      </Badge>
                    </TD>
                    <TD data-label="最近运行">
                      <LastRunCell plan={p} />
                    </TD>
                    <TD data-label="计划 ID" className="font-mono text-xs text-ink-3">
                      {p.id}
                    </TD>
                    <TD data-label="操作" className="whitespace-nowrap">
                      <div className="flex items-center gap-3">
                        {canCreate && (
                          <button
                            type="button"
                            className={LINK}
                            disabled={trigger.isPending}
                            onClick={() => trigger.mutate(p)}
                          >
                            立即执行
                          </button>
                        )}
                        <button type="button" className={LINK} onClick={() => setRunsOf(p)}>
                          运行记录
                        </button>
                        <RowActionMenu items={planMoreItems(p)} />
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={list.data?.total ?? 0}
              onPageChange={setPage}
            />
          </>
        )}
      </div>
      {runsOf && <RunsPanel key={runsOf.id} plan={runsOf} onClose={() => setRunsOf(null)} />}
      {editing !== undefined && (
        <EvalPlanFormModal
          key={editing?.id ?? 'new'}
          plan={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}
