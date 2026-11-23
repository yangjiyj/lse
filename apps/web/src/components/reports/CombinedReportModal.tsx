// 组合报告（2.6.3）：多选已完成的评估任务，填标题后生成。筛选与任务列表相同。
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { api, ApiError, type Report } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Field } from '@/components/ui/field';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { QueryState } from '@/components/QueryState';
import { DateRangeFilter } from '@/components/eval-tasks/task-list-parts';
import { ReportTemplateSelect } from '@/components/reports/ReportTemplateSelect';
import { formatDateTime } from '@/lib/format';

export const COMBINED_MIN_TASKS = 2;
export const COMBINED_MAX_TASKS = 20;
const PAGE_SIZE = 10;

export function CombinedReportModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (report: Report) => void;
}) {
  const { error: toastError, success: toastSuccess } = useToast();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [templateId, setTemplateId] = useState('');
  // 记下任务名：翻页、改筛选后已选的任务仍要列出来、能移除。
  const [selected, setSelected] = useState<Array<{ id: string; name: string }>>([]);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [resultFilter, setResultFilter] = useState<'' | 'risk' | 'pass' | 'error'>('');
  const [startFrom, setStartFrom] = useState('');
  const [startTo, setStartTo] = useState('');

  const models = useQuery({
    queryKey: ['model-targets', 'task-filter'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 100 }),
    enabled: open,
  });
  const tasks = useQuery({
    queryKey: [
      'eval-tasks',
      'combined-report',
      page,
      search,
      modelFilter,
      resultFilter,
      startFrom,
      startTo,
    ],
    queryFn: () =>
      api.evalTasks.list({
        page,
        pageSize: PAGE_SIZE,
        status: 'COMPLETED',
        keyword: search || undefined,
        modelTargetId: modelFilter || undefined,
        result: resultFilter || undefined,
        startFrom: startFrom || undefined,
        startTo: startTo || undefined,
      }),
    enabled: open,
  });

  function reset() {
    setTitle('');
    setTemplateId('');
    setSelected([]);
    setPage(1);
    setKeyword('');
    setSearch('');
    setModelFilter('');
    setResultFilter('');
    setStartFrom('');
    setStartTo('');
  }
  function close() {
    reset();
    onClose();
  }

  const create = useMutation({
    mutationFn: () =>
      api.reports.createCombined({
        title: title.trim(),
        taskIds: selected.map((t) => t.id),
        ...(templateId ? { templateId } : {}),
      }),
    onSuccess: (report) => {
      toastSuccess('组合报告已生成');
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      reset();
      onCreated(report);
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '生成失败'),
  });

  function toggle(task: { id: string; name: string }, checked: boolean) {
    setSelected((prev) =>
      checked
        ? prev.some((t) => t.id === task.id) || prev.length >= COMBINED_MAX_TASKS
          ? prev
          : [...prev, { id: task.id, name: task.name }]
        : prev.filter((t) => t.id !== task.id),
    );
  }

  const items = tasks.data?.items ?? [];
  const canSubmit =
    title.trim().length > 0 &&
    selected.length >= COMBINED_MIN_TASKS &&
    selected.length <= COMBINED_MAX_TASKS &&
    !create.isPending;

  return (
    <Modal
      open={open}
      onClose={close}
      title="组合报告"
      size="xl"
      footer={
        <>
          <span className="mr-auto text-[13px] text-ink-3">
            已选 {selected.length} / {COMBINED_MAX_TASKS} 个任务
          </span>
          <ReportTemplateSelect value={templateId} onChange={setTemplateId} emptyLabel="默认模板" />
          <Button variant="outline" onClick={close}>
            取消
          </Button>
          <Button onClick={() => create.mutate()} disabled={!canSubmit}>
            生成组合报告
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="报告标题" htmlFor="combined-report-title" required>
          <Input
            id="combined-report-title"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        {selected.length > 0 ? (
          <ul aria-label="已选任务" className="flex flex-wrap gap-2">
            {selected.map((t) => (
              <li
                key={t.id}
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-white pl-3 pr-1 text-[13px] text-ink-2"
              >
                {t.name}
                <button
                  type="button"
                  aria-label={`移除：${t.name}`}
                  onClick={() => toggle(t, false)}
                  className="grid h-6 w-6 place-items-center rounded-md text-ink-3 hover:bg-canvas hover:text-ink"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center gap-2.5">
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
                className="w-[220px] pl-9"
              />
            </div>
            <Button type="submit" variant="outline" className="h-10">
              搜索
            </Button>
          </form>
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
            {(models.data?.items ?? []).map((m) => (
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
        </div>
        <QueryState
          isLoading={tasks.isLoading}
          isError={tasks.isError}
          error={tasks.error}
          onRetry={() => void tasks.refetch()}
          empty={items.length === 0}
          filtered={Boolean(search || modelFilter || resultFilter || startFrom || startTo)}
          emptyTitle="没有已完成的评估任务"
          emptyDescription="组合报告只能选择已完成的任务。"
        />
        {items.length > 0 ? (
          <>
            <Table>
              <THead>
                <TR>
                  <TH className="w-10" />
                  <TH>任务名称</TH>
                  <TH>评估模型</TH>
                  <TH>完成时间</TH>
                  <TH>评估得分</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((t) => {
                  const checked = selected.some((x) => x.id === t.id);
                  return (
                    <TR key={t.id}>
                      <TD data-label="选择" className="pl-4">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[#1F57E0]"
                          aria-label={`选择：${t.name}`}
                          checked={checked}
                          disabled={!checked && selected.length >= COMBINED_MAX_TASKS}
                          onChange={(e) => toggle(t, e.target.checked)}
                        />
                      </TD>
                      <TD data-label="任务名称" className="font-medium text-ink">
                        {t.name}
                      </TD>
                      <TD data-label="评估模型">{t.modelTarget?.name ?? '—'}</TD>
                      <TD data-label="完成时间" className="whitespace-nowrap text-xs text-ink-3">
                        {formatDateTime(t.finishedAt)}
                      </TD>
                      <TD data-label="评估得分" className="tabular-nums">
                        {t.evalScore == null ? '—' : t.evalScore.toFixed(1)}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={tasks.data?.total ?? 0}
              onPageChange={setPage}
            />
          </>
        ) : null}
      </div>
    </Modal>
  );
}
