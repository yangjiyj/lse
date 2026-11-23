import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList } from 'lucide-react';
import { api, type FleetJob } from '@/lib/api';
import { errorMessage, FLEET_JOB_STATUSES, FLEET_JOB_STATUS_LABELS } from '@/lib/fleet';
import { Select } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { JobsTable } from '@/components/fleet/JobsTable';
import { RejectJobDialog } from '@/components/fleet/RejectJobDialog';
import { ForceCloseJobDialog } from '@/components/fleet/ForceCloseJobDialog';
import { useTenantView } from '@/lib/tenant-view';

const PAGE_SIZE = 20;

export function JobsTab({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [rejectFor, setRejectFor] = useState<FleetJob | null>(null);
  const [forceCloseFor, setForceCloseFor] = useState<FleetJob | null>(null);
  const { isAllTenants, listParams, tenantFilter, tenantName, guardRow } = useTenantView();

  const q = useQuery({
    queryKey: ['fleet', 'jobs', status, page, tenantFilter],
    queryFn: () =>
      api.fleet.evalJobs({ status: status || undefined, page, pageSize: PAGE_SIZE, ...listParams }),
    retry: false,
    placeholderData: (prev) => prev,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['fleet'] });

  const approve = useMutation({
    mutationFn: (id: string) => api.fleet.approveEvalJob(id),
    onSuccess: () => {
      toast.success('已批准，待终端领取');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, '批准失败')),
  });
  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.fleet.rejectEvalJob(id, reason),
    onSuccess: () => {
      toast.success('已驳回');
      setRejectFor(null);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, '驳回失败')),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.fleet.cancelEvalJob(id),
    onSuccess: () => {
      toast.success('已取消');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, '取消失败')),
  });
  const forceClose = useMutation({
    mutationFn: (id: string) => api.fleet.cancelEvalJob(id, { force: true }),
    onSuccess: () => {
      toast.success('已强制结束');
      setForceCloseFor(null);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, '强制结束失败')),
  });

  const items = q.data?.items ?? [];
  const busyId =
    (approve.isPending && approve.variables) ||
    (cancel.isPending && cancel.variables) ||
    (forceClose.isPending && forceClose.variables) ||
    null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="fleet-job-status" className="text-[13px] text-ink-3">
          状态
        </label>
        <Select
          id="fleet-job-status"
          className="w-44"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部</option>
          {FLEET_JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {FLEET_JOB_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner className="h-5 w-5" />
        </div>
      ) : q.isError ? (
        <NoteBox tone="warning" role="alert">
          任务列表加载失败。
          <Button className="ml-2" size="sm" variant="outline" onClick={() => void q.refetch()}>
            重试
          </Button>
        </NoteBox>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="h-7 w-7" />}
          title={status ? '没有符合条件的任务' : '还没有真机测评任务'}
          description="在智能体清单中选择可测对象，进入测评向导。"
        />
      ) : (
        <>
          <JobsTable
            jobs={items}
            canManage={canManage}
            busyId={busyId}
            isAllTenants={isAllTenants}
            tenantName={tenantName}
            onRowAction={
              isAllTenants
                ? (job) =>
                    guardRow(
                      job.tenantId,
                      job.evalTaskId ? `/eval-tasks/${job.evalTaskId}` : '/fleet?tab=jobs',
                    )
                : undefined
            }
            onApprove={(j) => approve.mutate(j.id)}
            onReject={setRejectFor}
            onCancel={(j) => cancel.mutate(j.id)}
            onForceClose={setForceCloseFor}
          />
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={q.data?.total ?? 0}
            onPageChange={setPage}
          />
        </>
      )}

      <RejectJobDialog
        job={rejectFor}
        pending={reject.isPending}
        onClose={() => setRejectFor(null)}
        onSubmit={(reason) => rejectFor && reject.mutate({ id: rejectFor.id, reason })}
      />
      <ForceCloseJobDialog
        job={forceCloseFor}
        pending={forceClose.isPending}
        onClose={() => setForceCloseFor(null)}
        onConfirm={() => forceCloseFor && forceClose.mutate(forceCloseFor.id)}
      />
    </div>
  );
}
