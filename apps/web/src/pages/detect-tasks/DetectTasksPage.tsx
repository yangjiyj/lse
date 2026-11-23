import { useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canCreateToolTask,
  DETECT_CATEGORIES,
  DETECT_CATEGORY_LABELS,
  DETECT_RECORD_KIND_LABELS,
  DETECT_RECORD_KINDS,
  DETECT_TASK_STATUSES,
  DETECT_TASK_STATUS_LABELS,
  TOOL_TASK_ENTRIES,
  type DetectCategory,
  type DetectRecordKind,
  type DetectTaskStatus,
  type ToolTaskEntry,
} from '@lse/shared';
import { PageHeader } from '@/components/PageHeader';
import { QueryState } from '@/components/QueryState';
import { FilterBar } from '@/components/page-kit/FilterBar';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import {
  detectTasksApi,
  type DetectRecordAction,
  type DetectTaskQuery,
  type DetectTaskRow,
} from '@/lib/detect-tasks';
import { formatDateTime } from '@/lib/format';
import { TenantCell, TenantFilterSelect, useTenantView } from '@/lib/tenant-view';
import { useKeyedPage } from '@/lib/use-keyed-page';
import { DetectStatusBadge } from './DetectStatusBadge';
import { NewTaskChooser } from './NewTaskChooser';

const PAGE_SIZE = 20;
const ACTION_LABELS: Record<DetectRecordAction, string> = {
  pause: '暂停',
  resume: '恢复',
  stop: '停止',
};
/** 顶部统计数字：总任务和四种主要状态，点击按状态下钻。 */
const STAT_STATUSES: DetectTaskStatus[] = ['RUNNING', 'PAUSED', 'COMPLETED', 'FAILED'];
const ENTRIES = Object.values(TOOL_TASK_ENTRIES) as ToolTaskEntry[];

/** 日期筛选按北京时间的自然日：起始日 0 点到截止日 23:59:59.999。 */
const dayStart = (d: string) => `${d}T00:00:00+08:00`;
const dayEnd = (d: string) => `${d}T23:59:59.999+08:00`;

function StatTile({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: number | undefined;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-w-[120px] flex-1 rounded-xl border px-4 py-3 text-left transition ${
        active ? 'border-brand-500 bg-brand-50' : 'border-line bg-white hover:border-brand-300'
      }`}
    >
      <div className="text-[12.5px] text-ink-3">{label}</div>
      <div className="mt-1 text-[22px] font-bold tabular-nums text-ink">{value ?? '—'}</div>
    </button>
  );
}

/** 全部任务（2.4.1、2.4.4）：各类检测记录按状态、四类统计，点击下钻，统一筛选和操作。 */
export function DetectTasksPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const { isAllTenants, listParams, tenantFilter, guardRow } = useTenantView();
  const [chooserOpen, setChooserOpen] = useState(false);
  const [filter, setFilter] = useState<DetectTaskQuery>({});
  const [name, setName] = useState('');
  const [stopping, setStopping] = useState<DetectTaskRow | null>(null);
  // 页码跟筛选、租户绑定：条件变了回第 1 页。
  const [page, setPage] = useKeyedPage(JSON.stringify([filter, tenantFilter]));
  const canCreate =
    hasPermission('detect_task:manage') ||
    ENTRIES.some((entry) => canCreateToolTask(entry, hasPermission));

  const update = (patch: Partial<DetectTaskQuery>) => setFilter((f) => ({ ...f, ...patch }));

  // 统计不按类别筛：四类统计要看全部类别；选了类别时状态数取该类别的。
  const statsQuery = useQuery({
    queryKey: [
      'detect-tasks',
      'stats',
      filter.kind,
      filter.createdFrom,
      filter.createdTo,
      tenantFilter,
    ],
    queryFn: () =>
      detectTasksApi.stats({
        kind: filter.kind,
        createdFrom: filter.createdFrom,
        createdTo: filter.createdTo,
        ...listParams,
      }),
  });
  const listQuery = useQuery({
    queryKey: ['detect-tasks', 'list', filter, page, tenantFilter],
    queryFn: () => detectTasksApi.list({ ...filter, ...listParams, page, pageSize: PAGE_SIZE }),
    refetchInterval: (q) =>
      q.state.data?.items.some((r) => r.status === 'PENDING' || r.status === 'RUNNING')
        ? 5000
        : false,
  });
  const action = useMutation({
    mutationFn: (v: { row: DetectTaskRow; action: DetectRecordAction }) =>
      detectTasksApi.action(v.row.kind, v.row.id, v.action),
    onSuccess: (res, v) => {
      toast.success(
        v.action === 'pause' && res.pauseRequested
          ? '已请求暂停，进行中的题做完后停下'
          : v.action === 'resume' && v.row.pauseRequested
            ? '已撤销暂停'
            : `已${ACTION_LABELS[v.action]}`,
      );
      setStopping(null);
      void queryClient.invalidateQueries({ queryKey: ['detect-tasks'] });
    },
    onError: (err) => {
      setStopping(null);
      toast.error((err as Error).message);
    },
  });
  // 全部租户视角下先进入该行所属租户（链接、操作都一样）。
  const runAction = (row: DetectTaskRow, a: DetectRecordAction) => {
    if (guardRow(row.tenantId, '/detect-tasks')) return;
    if (a === 'stop') setStopping(row);
    else action.mutate({ row, action: a });
  };
  const guardLink = (tenantId: string | null, path: string) => (e: MouseEvent) => {
    if (guardRow(tenantId, path)) e.preventDefault();
  };

  const stats = statsQuery.data;
  const kinds = (stats?.kinds ?? []).filter(
    (k) => !filter.category || DETECT_RECORD_KINDS[k] === filter.category,
  );
  const scoped = filter.category ? stats?.byCategory[filter.category] : stats;
  const rows = listQuery.data?.items ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="全部任务"
        actions={
          <>
            <TenantFilterSelect />
            {canCreate && <Button onClick={() => setChooserOpen(true)}>新建检测任务</Button>}
          </>
        }
      />

      <div className="flex flex-wrap gap-3">
        <StatTile
          label="总任务"
          value={scoped?.total}
          active={!filter.status}
          onClick={() => update({ status: undefined })}
        />
        {STAT_STATUSES.map((s) => (
          <StatTile
            key={s}
            label={DETECT_TASK_STATUS_LABELS[s]}
            value={scoped?.byStatus[s]}
            active={filter.status === s}
            onClick={() => update({ status: filter.status === s ? undefined : s })}
          />
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        {DETECT_CATEGORIES.map((c) => (
          <StatTile
            key={c}
            label={DETECT_CATEGORY_LABELS[c]}
            value={stats?.byCategory[c]?.total}
            active={filter.category === c}
            onClick={() => changeCategory(filter.category === c ? undefined : c)}
          />
        ))}
      </div>

      <SectionCard title="检测记录">
        <FilterBar>
          <Select
            aria-label="类别"
            className="w-40"
            value={filter.category ?? ''}
            onChange={(e) => changeCategory((e.target.value || undefined) as DetectCategory)}
          >
            <option value="">全部类别</option>
            {DETECT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {DETECT_CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="类型"
            className="w-40"
            value={filter.kind ?? ''}
            onChange={(e) => update({ kind: (e.target.value || undefined) as DetectRecordKind })}
          >
            <option value="">全部类型</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {DETECT_RECORD_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="状态"
            className="w-40"
            value={filter.status ?? ''}
            onChange={(e) => update({ status: (e.target.value || undefined) as DetectTaskStatus })}
          >
            <option value="">全部状态</option>
            {DETECT_TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {DETECT_TASK_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              update({ q: name.trim() || undefined });
            }}
          >
            <Input
              aria-label="名称"
              placeholder="名称"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                // 清空即生效，不用再按回车
                if (!e.target.value.trim() && filter.q) update({ q: undefined });
              }}
              className="w-40"
            />
          </form>
          <Input
            type="date"
            aria-label="创建时间起"
            value={filter.createdFrom?.slice(0, 10) ?? ''}
            onChange={(e) =>
              update({ createdFrom: e.target.value ? dayStart(e.target.value) : undefined })
            }
            className="w-36"
          />
          <Input
            type="date"
            aria-label="创建时间止"
            value={filter.createdTo?.slice(0, 10) ?? ''}
            onChange={(e) =>
              update({ createdTo: e.target.value ? dayEnd(e.target.value) : undefined })
            }
            className="w-36"
          />
        </FilterBar>

        <QueryState
          isLoading={listQuery.isLoading}
          isError={listQuery.isError}
          error={listQuery.error}
          onRetry={() => void listQuery.refetch()}
          empty={rows.length === 0}
          filtered={Object.values(filter).some(Boolean)}
          emptyTitle="没有符合条件的检测任务"
          emptyDescription="换个筛选条件，或新建检测任务。"
        />
        {!listQuery.isLoading && !listQuery.isError && rows.length > 0 && (
          <Table>
            <THead>
              <TR>
                {isAllTenants && <TH>租户</TH>}
                <TH>名称</TH>
                <TH>类型</TH>
                <TH>类别</TH>
                <TH>状态</TH>
                <TH>所属组合任务</TH>
                <TH>创建人</TH>
                <TH>创建时间</TH>
                <TH>操作</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={`${row.kind}:${row.id}`}>
                  {isAllTenants && (
                    <TD>
                      <TenantCell tenantId={row.tenantId} />
                    </TD>
                  )}
                  <TD>
                    <Link
                      to={row.href}
                      onClick={guardLink(row.tenantId, row.href)}
                      className="font-medium text-brand-600 hover:underline"
                    >
                      {row.name || '—'}
                    </Link>
                  </TD>
                  <TD>{row.kindLabel}</TD>
                  <TD>{DETECT_CATEGORY_LABELS[row.category]}</TD>
                  <TD>
                    <DetectStatusBadge value={row.status} />
                  </TD>
                  <TD>
                    {row.job ? (
                      <Link
                        to={`/detect-tasks/jobs/${encodeURIComponent(row.job.id)}`}
                        onClick={guardLink(
                          row.tenantId,
                          `/detect-tasks/jobs/${encodeURIComponent(row.job.id)}`,
                        )}
                        className="text-brand-600 hover:underline"
                      >
                        {row.job.name}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TD>
                  <TD>{row.createdBy?.username ?? '—'}</TD>
                  <TD className="whitespace-nowrap">{formatDateTime(row.createdAt)}</TD>
                  <TD>
                    <div className="flex gap-2">
                      {row.pauseRequested && (
                        <Button size="sm" variant="outline" disabled>
                          暂停中
                        </Button>
                      )}
                      {row.actions.map((a) => (
                        <Button
                          key={a}
                          size="sm"
                          variant="outline"
                          disabled={action.isPending}
                          onClick={() => runAction(row, a)}
                        >
                          {a === 'resume' && row.pauseRequested ? '撤销暂停' : ACTION_LABELS[a]}
                        </Button>
                      ))}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={listQuery.data?.total ?? 0}
          onPageChange={setPage}
        />
      </SectionCard>

      <NewTaskChooser open={chooserOpen} onClose={() => setChooserOpen(false)} />
      <Modal
        open={stopping !== null}
        onClose={() => setStopping(null)}
        size="sm"
        title="停止检测任务"
        footer={
          <>
            <Button variant="outline" onClick={() => setStopping(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={action.isPending}
              onClick={() => stopping && action.mutate({ row: stopping, action: 'stop' })}
            >
              确认停止
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-ink-2">
          停止「{stopping?.name}」后不能恢复，已完成的部分保留。
        </p>
      </Modal>
    </div>
  );

  function changeCategory(category: DetectCategory | undefined) {
    // 换了类别，原来选的类型不属于新类别时清掉。
    setFilter((f) => ({
      ...f,
      category,
      kind: f.kind && category && DETECT_RECORD_KINDS[f.kind] !== category ? undefined : f.kind,
    }));
  }
}
