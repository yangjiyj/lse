import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { QueryState } from '@/components/QueryState';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import {
  detectStrategiesApi,
  type DetectStrategyInput,
  type DetectStrategyView,
} from '@/lib/detect-tasks';
import { formatDateTime } from '@/lib/format';
import { describeCron } from '@/pages/eval-plans/cron-describe';
import {
  CRON_PRESETS,
  DEFAULT_MIN_INTERVAL_MINUTES,
  DEFAULT_TIMEZONE,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
} from '@/pages/eval-plans/eval-plan-form';
import { useClampPage } from './DetectJobsPage';
import {
  JOB_MAX_PARALLEL,
  JobItemList,
  draftFromInput,
  draftToInput,
  placeServerError,
  type JobItemDraft,
} from './JobItemList';

const PAGE_SIZE = 20;
const MANUAL = 'manual';
const CUSTOM = 'custom';

/** 检测策略（2.4.3）：按周期自动生成组合任务。 */
export function DetectStrategiesPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('detect_task:manage');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<DetectStrategyView | 'new' | null>(null);
  const [removing, setRemoving] = useState<DetectStrategyView | null>(null);

  const strategies = useQuery({
    queryKey: ['detect-strategies', 'list', page],
    queryFn: () => detectStrategiesApi.list({ page, pageSize: PAGE_SIZE }),
  });
  useClampPage(strategies.data?.total, page, PAGE_SIZE, setPage);
  const run = useMutation({
    mutationFn: (id: string) => detectStrategiesApi.run(id),
    onSuccess: (job) => {
      toast.success('已生成组合任务');
      void queryClient.invalidateQueries({ queryKey: ['detect-strategies'] });
      void queryClient.invalidateQueries({ queryKey: ['detect-jobs'] });
      navigate(`/detect-tasks/jobs/${encodeURIComponent(job.id)}`);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => detectStrategiesApi.remove(id),
    onSuccess: () => {
      toast.success('已删除');
      setRemoving(null);
      void queryClient.invalidateQueries({ queryKey: ['detect-strategies'] });
    },
    onError: (err) => {
      setRemoving(null);
      toast.error((err as Error).message);
    },
  });

  const rows = strategies.data?.items ?? [];
  return (
    <div className="space-y-5">
      <PageHeader
        title="检测策略"
        actions={canManage && <Button onClick={() => setEditing('new')}>新建检测策略</Button>}
      />
      <Card className="min-w-0 p-6">
        <QueryState
          isLoading={strategies.isLoading}
          isError={strategies.isError}
          error={strategies.error}
          onRetry={() => void strategies.refetch()}
          empty={rows.length === 0}
          emptyTitle="还没有检测策略"
          emptyDescription="新建检测策略，按周期自动生成组合任务。"
        />
        {!strategies.isLoading && !strategies.isError && rows.length > 0 && (
          <Table>
            <THead>
              <TR>
                <TH>名称</TH>
                <TH>子任务</TH>
                <TH>执行周期</TH>
                <TH>下次执行</TH>
                <TH>上次跳过原因</TH>
                <TH>状态</TH>
                {canManage && <TH>操作</TH>}
              </TR>
            </THead>
            <TBody>
              {rows.map((s) => (
                <TR key={s.id}>
                  <TD className="font-medium text-ink">{s.name}</TD>
                  <TD className="tabular-nums">{s.items.length}</TD>
                  <TD>{s.cron ? describeCron(s.cron) : '仅手动执行'}</TD>
                  <TD className="whitespace-nowrap">
                    {s.nextRunAt ? formatDateTime(s.nextRunAt) : '—'}
                  </TD>
                  <TD className="max-w-[16rem]">{s.lastSkipReason ?? '—'}</TD>
                  <TD>{s.enabled ? '已启用' : '已停用'}</TD>
                  {canManage && (
                    <TD>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={run.isPending}
                          onClick={() => run.mutate(s.id)}
                        >
                          立即执行
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setEditing(s)}>
                          编辑
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(s)}>
                          删除
                        </Button>
                      </div>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={strategies.data?.total ?? 0}
          onPageChange={setPage}
        />
      </Card>

      {editing && (
        <StrategyFormModal
          strategy={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        size="sm"
        title="删除检测策略"
        footer={
          <>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate(removing.id)}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-ink-2">
          删除「{removing?.name}」后不再定时执行，已生成的组合任务保留。
        </p>
      </Modal>
    </div>
  );
}

/** 弹窗表单是六列网格：一般一格占一半；自定义 cron 时最后一行三格各占三分之一。 */
const HALF = 'sm:col-span-3';

function initialCronMode(cron: string | null | undefined): string {
  if (!cron) return MANUAL;
  return CRON_PRESETS.some((p) => p.value === cron) ? cron : CUSTOM;
}

function StrategyFormModal({
  strategy,
  onClose,
}: {
  strategy: DetectStrategyView | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(strategy?.name ?? '');
  const [description, setDescription] = useState(strategy?.description ?? '');
  const [parallel, setParallel] = useState(String(strategy?.maxParallel ?? 4));
  const [enabled, setEnabled] = useState(strategy?.enabled ?? true);
  const [cronMode, setCronMode] = useState(() =>
    strategy ? initialCronMode(strategy.cron) : CRON_PRESETS[0]!.value,
  );
  const [customCron, setCustomCron] = useState(
    strategy?.cron && initialCronMode(strategy.cron) === CUSTOM ? strategy.cron : '',
  );
  const [timezone, setTimezone] = useState(strategy?.timezone ?? DEFAULT_TIMEZONE);
  const [minInterval, setMinInterval] = useState(
    String(strategy?.minIntervalMinutes ?? DEFAULT_MIN_INTERVAL_MINUTES),
  );
  const [items, setItems] = useState<JobItemDraft[]>(() =>
    (strategy?.items ?? []).map(draftFromInput),
  );
  const [error, setError] = useState<string | null>(null);
  // 点过保存后才把没动过的子任务的校验提示也显示出来
  const [showProblems, setShowProblems] = useState(false);

  const cron = cronMode === MANUAL ? null : cronMode === CUSTOM ? customCron.trim() : cronMode;
  const tail = cronMode === CUSTOM ? 'sm:col-span-2' : HALF;
  const maxParallel = Number(parallel);
  const interval = Number(minInterval);
  const parallelOk =
    Number.isInteger(maxParallel) && maxParallel >= 1 && maxParallel <= JOB_MAX_PARALLEL;
  const intervalOk =
    Number.isInteger(interval) &&
    interval >= MIN_INTERVAL_MINUTES &&
    interval <= MAX_INTERVAL_MINUTES;
  const cronOk = cron === null || cron.split(/\s+/).length === 5;
  const ready =
    name.trim().length > 0 &&
    parallelOk &&
    intervalOk &&
    cronOk &&
    timezone.trim().length > 0 &&
    items.length > 0 &&
    items.every((i) => !i.problem);

  const save = useMutation({
    mutationFn: (body: DetectStrategyInput) =>
      strategy ? detectStrategiesApi.update(strategy.id, body) : detectStrategiesApi.create(body),
    onSuccess: () => {
      toast.success(strategy ? '检测策略已更新' : '检测策略已创建');
      void queryClient.invalidateQueries({ queryKey: ['detect-strategies'] });
      onClose();
    },
    // 后端指出「第 N 项」的问题落到对应子任务，其余显示在底部。
    onError: (err) => {
      const placed = placeServerError(items, err);
      setItems(placed.items);
      setError(placed.message);
    },
  });
  const submit = () =>
    save.mutate({
      name: name.trim(),
      description: description.trim(),
      items: items.map(draftToInput),
      maxParallel,
      cron,
      timezone: timezone.trim(),
      enabled,
      minIntervalMinutes: interval,
    });

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={strategy ? '编辑检测策略' : '新建检测策略'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          {/* 按钮置灰时点击落到外层：显示各子任务还缺什么 */}
          <span onClick={() => setShowProblems(true)}>
            <Button disabled={!ready || save.isPending} onClick={submit}>
              保存
            </Button>
          </span>
        </>
      }
    >
      <div className="space-y-4">
        {/* 两列对齐：范围写进标签，不在输入框下面另起一行；启用放进网格补齐空位。
            自定义 cron 多出一格，时区、最小间隔、启用三个并一行，不留半行空位 */}
        <div className="grid gap-4 sm:grid-cols-6">
          <Field label="名称" htmlFor="strategy-name" required className={HALF}>
            <Input
              id="strategy-name"
              value={name}
              maxLength={160}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label={`并发上限（1–${JOB_MAX_PARALLEL}）`}
            htmlFor="strategy-parallel"
            error={parallelOk ? undefined : `请填 1–${JOB_MAX_PARALLEL} 的整数`}
            className={HALF}
          >
            <Input
              id="strategy-parallel"
              inputMode="numeric"
              value={parallel}
              onChange={(e) => setParallel(e.target.value)}
            />
          </Field>
          <Field label="执行周期" htmlFor="strategy-cron" className={HALF}>
            <Select
              id="strategy-cron"
              value={cronMode}
              onChange={(e) => setCronMode(e.target.value)}
            >
              <option value={MANUAL}>仅手动执行</option>
              {CRON_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
              <option value={CUSTOM}>自定义</option>
            </Select>
          </Field>
          {cronMode === CUSTOM && (
            <Field
              label={`cron 表达式（${
                cronOk && customCron.trim() ? describeCron(customCron.trim()) : '分 时 日 月 周'
              }）`}
              htmlFor="strategy-cron-custom"
              error={customCron.trim() && !cronOk ? '要 5 段：分 时 日 月 周' : undefined}
              className={HALF}
            >
              <Input
                id="strategy-cron-custom"
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
              />
            </Field>
          )}
          {cron !== null && (
            <>
              <Field label="时区" htmlFor="strategy-tz" className={tail}>
                <Input
                  id="strategy-tz"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                />
              </Field>
              <Field
                label={`最小间隔（${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 分钟）`}
                htmlFor="strategy-interval"
                error={
                  intervalOk
                    ? undefined
                    : `请填 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 的整数`
                }
                className={tail}
              >
                <Input
                  id="strategy-interval"
                  inputMode="numeric"
                  value={minInterval}
                  onChange={(e) => setMinInterval(e.target.value)}
                />
              </Field>
            </>
          )}
          <label className={`flex h-9 items-center gap-2 self-end text-sm ${tail}`}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            启用
          </label>
          <Field label="说明" htmlFor="strategy-description" className="sm:col-span-6">
            <Textarea
              id="strategy-description"
              rows={2}
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
        <JobItemList
          items={items}
          showProblems={showProblems}
          onChange={(next) => {
            setItems(next);
            setError(null);
          }}
        />
        {error && <p className="text-[13px] text-destructive">{error}</p>}
      </div>
    </Modal>
  );
}
