import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { QueryState } from '@/components/QueryState';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Pagination } from '@/components/ui/pagination';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import { detectJobsApi, type DetectJobView } from '@/lib/detect-tasks';
import { formatDateTime } from '@/lib/format';
import { DetectJobStatusBadge } from './DetectStatusBadge';
import {
  JOB_MAX_PARALLEL,
  JobItemList,
  draftToInput,
  placeServerError,
  type JobItemDraft,
} from './JobItemList';

const PAGE_SIZE = 20;

/** 进度「完成 X/Y」，有失败的另外标出。 */
export function jobProgress(job: Pick<DetectJobView, 'itemCount' | 'itemCounts'>): string {
  const done = `完成 ${job.itemCounts.COMPLETED ?? 0}/${job.itemCount}`;
  const failed = job.itemCounts.FAILED ?? 0;
  return failed > 0 ? `${done}，失败 ${failed}` : done;
}

/** 来源：按怎么触发的写（手动执行策略、定时触发、快速建任务、检测方案、手工新建）。 */
export function jobSource(
  job: Pick<DetectJobView, 'strategyId' | 'schemeId' | 'triggeredBy'>,
): string {
  if (job.triggeredBy === 'schedule') return '定时触发';
  if (job.strategyId) return '手动执行策略';
  if (job.triggeredBy === 'scheme' || job.schemeId) return '检测方案';
  if (job.triggeredBy === 'quick') return '快速建任务';
  return '手工';
}

/** 删掉某页最后一条后总数变少：当前页超出就回到最后一页。 */
export function useClampPage(
  total: number | undefined,
  page: number,
  pageSize: number,
  setPage: (page: number) => void,
) {
  useEffect(() => {
    if (total === undefined) return;
    const last = Math.max(1, Math.ceil(total / pageSize));
    if (page > last) setPage(last);
  }, [total, page, pageSize, setPage]);
}

/** 组合任务（2.4.2、2.4.9）：一次选多个检测工具，按并发上限一键启动。 */
export function DetectJobsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('detect_task:manage');
  const [searchParams, setSearchParams] = useSearchParams();
  // 从「新建检测任务」选了组合任务时带 ?new=1，直接打开新建。
  const [creating, setCreating] = useState(() => canManage && searchParams.get('new') === '1');
  const [page, setPage] = useState(1);

  const jobs = useQuery({
    queryKey: ['detect-jobs', 'list', page],
    queryFn: () => detectJobsApi.list({ page, pageSize: PAGE_SIZE }),
    refetchInterval: (q) =>
      q.state.data?.items.some((j) => j.status === 'RUNNING' || j.status === 'PAUSED')
        ? 5000
        : false,
  });
  useClampPage(jobs.data?.total, page, PAGE_SIZE, setPage);

  const closeCreate = () => {
    setCreating(false);
    if (searchParams.has('new')) {
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  };

  const rows = jobs.data?.items ?? [];
  return (
    <div className="space-y-5">
      <PageHeader
        title="组合任务"
        actions={canManage && <Button onClick={() => setCreating(true)}>新建组合任务</Button>}
      />
      <Card className="min-w-0 p-6">
        <QueryState
          isLoading={jobs.isLoading}
          isError={jobs.isError}
          error={jobs.error}
          onRetry={() => void jobs.refetch()}
          empty={rows.length === 0}
          emptyTitle="还没有组合任务"
          emptyDescription="新建组合任务，一次启动多项检测。"
        />
        {!jobs.isLoading && !jobs.isError && rows.length > 0 && (
          <Table>
            <THead>
              <TR>
                <TH>名称</TH>
                <TH>状态</TH>
                <TH>进度</TH>
                <TH>来源</TH>
                <TH>创建人</TH>
                <TH>创建时间</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((job) => (
                <TR key={job.id}>
                  <TD>
                    <Link
                      to={`/detect-tasks/jobs/${encodeURIComponent(job.id)}`}
                      className="font-medium text-brand-600 hover:underline"
                    >
                      {job.name}
                    </Link>
                  </TD>
                  <TD>
                    <DetectJobStatusBadge job={job} />
                  </TD>
                  <TD className="whitespace-nowrap tabular-nums">{jobProgress(job)}</TD>
                  <TD>{jobSource(job)}</TD>
                  <TD>{job.createdBy?.username ?? '—'}</TD>
                  <TD className="whitespace-nowrap">{formatDateTime(job.createdAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={jobs.data?.total ?? 0}
          onPageChange={setPage}
        />
      </Card>
      {creating && <CreateJobModal onClose={closeCreate} />}
    </div>
  );
}

function CreateJobModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [parallel, setParallel] = useState('4');
  const [items, setItems] = useState<JobItemDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 点过提交后才把没动过的子任务的校验提示也显示出来
  const [showProblems, setShowProblems] = useState(false);

  const maxParallel = Number(parallel);
  const parallelOk =
    Number.isInteger(maxParallel) && maxParallel >= 1 && maxParallel <= JOB_MAX_PARALLEL;
  const ready =
    name.trim().length > 0 && parallelOk && items.length > 0 && items.every((i) => !i.problem);

  const create = useMutation({
    mutationFn: (start: boolean) =>
      detectJobsApi.create({
        name: name.trim(),
        maxParallel,
        items: items.map(draftToInput),
        start,
      }),
    onSuccess: (job, start) => {
      toast.success(start ? '组合任务已启动' : '组合任务已保存');
      void queryClient.invalidateQueries({ queryKey: ['detect-jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['detect-tasks'] });
      onClose();
      navigate(`/detect-tasks/jobs/${encodeURIComponent(job.id)}`);
    },
    // 后端指出「第 N 项」的问题落到对应子任务，其余显示在底部。
    onError: (err) => {
      const placed = placeServerError(items, err);
      setItems(placed.items);
      setError(placed.message);
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="新建组合任务"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          {/* 按钮置灰时点击落到外层：显示各子任务还缺什么 */}
          <span className="flex gap-2" onClick={() => setShowProblems(true)}>
            <Button
              variant="outline"
              disabled={!ready || create.isPending}
              onClick={() => create.mutate(false)}
            >
              仅保存
            </Button>
            <Button disabled={!ready || create.isPending} onClick={() => create.mutate(true)}>
              一键启动
            </Button>
          </span>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
          <Field label="名称" htmlFor="detect-job-name" required>
            <Input
              id="detect-job-name"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label={`并发上限（1–${JOB_MAX_PARALLEL}）`}
            htmlFor="detect-job-parallel"
            error={parallelOk ? undefined : `请填 1–${JOB_MAX_PARALLEL} 的整数`}
          >
            <Input
              id="detect-job-parallel"
              inputMode="numeric"
              value={parallel}
              onChange={(e) => setParallel(e.target.value)}
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
