import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { isDetectTaskTerminal } from '@lse/shared';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { ReportTemplateSelect } from '@/components/reports/ReportTemplateSelect';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import {
  detectJobsApi,
  detectTasksApi,
  type DetectJobDetail,
  type DetectJobItemView,
  type DetectRecordAction,
} from '@/lib/detect-tasks';
import { formatDateTime } from '@/lib/format';
import { DetectJobItemStatusBadge, DetectJobStatusBadge } from './DetectStatusBadge';
import { jobProgress, jobSource } from './DetectJobsPage';

type JobAction = 'start' | 'pause' | 'resume' | 'stop';
const ACTION_LABELS: Record<JobAction, string> = {
  start: '启动',
  pause: '暂停',
  resume: '恢复',
  stop: '停止',
};

/** 各状态下能做的操作；删除另算（未启动或已结束）。 */
function jobActions(status: string): JobAction[] {
  if (status === 'PENDING') return ['start'];
  if (status === 'RUNNING') return ['pause', 'stop'];
  if (status === 'PAUSED') return ['resume', 'stop'];
  return [];
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[12.5px] text-ink-3">{label}</div>
      <div className="mt-0.5 text-[14px] text-ink">{children}</div>
    </div>
  );
}

export function DetectJobDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('detect_task:manage');
  const canReport = hasPermission('report:generate');
  const [confirm, setConfirm] = useState<'stop' | 'delete' | null>(null);
  const [itemStopping, setItemStopping] = useState<DetectJobItemView | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  const queryKey = ['detect-jobs', 'detail', id];
  const job = useQuery({
    queryKey,
    queryFn: () => detectJobsApi.get(id),
    // 执行中、已暂停时轮询；停止后只要还有已启动、没结束的子任务（语料、资产测绘会跑完）也接着轮询。
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      if (d.status === 'RUNNING' || d.status === 'PAUSED') return 3000;
      return d.items.some((i) => i.launchedAt && !isDetectTaskTerminal(i.status)) ? 3000 : false;
    },
  });
  const refreshLists = () => {
    void queryClient.invalidateQueries({ queryKey: ['detect-jobs', 'list'] });
    void queryClient.invalidateQueries({ queryKey: ['detect-tasks'] });
  };
  const lifecycle = useMutation({
    mutationFn: (action: JobAction) => detectJobsApi.lifecycle(id, action),
    onSuccess: (data, action) => {
      queryClient.setQueryData<DetectJobDetail>(queryKey, data);
      toast.success(`已${ACTION_LABELS[action]}`);
      setConfirm(null);
      refreshLists();
    },
    onError: (err) => {
      setConfirm(null);
      toast.error((err as Error).message);
      // 停止时有子任务没停下（409）：重新拉详情，显示各子任务的原因。
      void queryClient.invalidateQueries({ queryKey });
      refreshLists();
    },
  });
  // 单个子任务的暂停、恢复、停止（如单独暂停的评估子任务，组合任务不会自动恢复它）。
  const itemAction = useMutation({
    mutationFn: (v: { item: DetectJobItemView; action: DetectRecordAction }) =>
      detectTasksApi.action(v.item.recordKind!, v.item.recordId!, v.action),
    onSuccess: (_res, v) => {
      toast.success(
        v.action === 'resume' && v.item.status === 'RUNNING'
          ? '已撤销暂停'
          : `已${ACTION_LABELS[v.action]}`,
      );
      setItemStopping(null);
      void queryClient.invalidateQueries({ queryKey });
      refreshLists();
    },
    onError: (err) => {
      setItemStopping(null);
      toast.error((err as Error).message);
    },
  });
  const remove = useMutation({
    mutationFn: () => detectJobsApi.remove(id),
    onSuccess: () => {
      toast.success('已删除');
      refreshLists();
      navigate('/detect-tasks/jobs');
    },
    onError: (err) => {
      setConfirm(null);
      toast.error((err as Error).message);
    },
  });

  const data = job.data;
  if (job.isLoading) return <LoadingBlock />;
  if (!data) {
    return (
      <div className="py-10 text-center text-sm text-ink-3">
        {(job.error as Error | null)?.message ?? '组合任务不存在'}
      </div>
    );
  }
  const busy = lifecycle.isPending || remove.isPending;
  const deletable = data.status === 'PENDING' || isDetectTaskTerminal(data.status);
  // 与后端一致：组合任务结束、且至少一项完成后才能生成综合报告。
  const reportReady = isDetectTaskTerminal(data.status) && (data.itemCounts.COMPLETED ?? 0) > 0;

  return (
    <div className="space-y-5">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2"
          onClick={() => navigate('/detect-tasks/jobs')}
        >
          <ArrowLeft className="h-4 w-4" />
          返回组合任务
        </Button>
      </div>
      <PageHeader
        title={data.name}
        actions={
          <>
            {canReport && (
              <Button
                variant="outline"
                disabled={!reportReady}
                title={reportReady ? undefined : '组合任务结束、且至少一项完成后才能生成'}
                onClick={() => setReportOpen(true)}
              >
                生成综合报告
              </Button>
            )}
            {canManage &&
              jobActions(data.status).map((action) => (
                <Button
                  key={action}
                  variant={action === 'stop' ? 'outline' : 'primary'}
                  disabled={busy}
                  onClick={() =>
                    action === 'stop' ? setConfirm('stop') : lifecycle.mutate(action)
                  }
                >
                  {ACTION_LABELS[action]}
                </Button>
              ))}
            {canManage && deletable && (
              <Button variant="outline" disabled={busy} onClick={() => setConfirm('delete')}>
                删除
              </Button>
            )}
          </>
        }
      />
      {reportOpen && (
        <JobReportModal jobId={data.id} jobName={data.name} onClose={() => setReportOpen(false)} />
      )}

      <SectionCard title="概况">
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <Meta label="状态">
            <DetectJobStatusBadge job={data} />
          </Meta>
          <Meta label="进度">{jobProgress(data)}</Meta>
          <Meta label="并发上限">{data.maxParallel}</Meta>
          <Meta label="来源">
            {data.strategyId ? (
              <Link to="/detect-tasks/strategies" className="text-brand-600 hover:underline">
                {jobSource(data)}
              </Link>
            ) : (
              jobSource(data)
            )}
          </Meta>
          <Meta label="创建人">{data.createdBy?.username ?? '—'}</Meta>
          <Meta label="创建时间">{formatDateTime(data.createdAt)}</Meta>
          <Meta label="开始时间">{data.startedAt ? formatDateTime(data.startedAt) : '—'}</Meta>
          <Meta label="结束时间">{data.finishedAt ? formatDateTime(data.finishedAt) : '—'}</Meta>
        </div>
      </SectionCard>

      <SectionCard title="子任务">
        <Table>
          <THead>
            <TR>
              <TH>#</TH>
              <TH>名称</TH>
              <TH>类型</TH>
              <TH>状态</TH>
              <TH>检测记录</TH>
              <TH>启动时间</TH>
              <TH>结束时间</TH>
              <TH>操作</TH>
            </TR>
          </THead>
          <TBody>
            {data.items.map((item, index) => (
              <TR key={item.id}>
                <TD className="tabular-nums">{index + 1}</TD>
                <TD>
                  <div className="font-medium text-ink">{item.title}</div>
                  {item.error && (
                    <div className="mt-0.5 text-[12.5px] text-severity-medium">{item.error}</div>
                  )}
                </TD>
                <TD>{item.kindLabel}</TD>
                <TD>
                  <DetectJobItemStatusBadge item={item} />
                  {data.status === 'RUNNING' && item.status === 'PAUSED' && (
                    <div className="mt-0.5 text-[12.5px] text-severity-medium">
                      已单独暂停，组合任务不会自动恢复
                    </div>
                  )}
                </TD>
                <TD>
                  {item.href ? (
                    <Link to={item.href} className="text-brand-600 hover:underline">
                      {item.recordName || '查看'}
                    </Link>
                  ) : (
                    '—'
                  )}
                </TD>
                <TD className="whitespace-nowrap">
                  {item.launchedAt ? formatDateTime(item.launchedAt) : '—'}
                </TD>
                <TD className="whitespace-nowrap">
                  {item.finishedAt ? formatDateTime(item.finishedAt) : '—'}
                </TD>
                <TD>
                  <div className="flex gap-2">
                    {item.actions.map((a) => (
                      <Button
                        key={a}
                        size="sm"
                        variant="outline"
                        disabled={itemAction.isPending}
                        onClick={() =>
                          a === 'stop'
                            ? setItemStopping(item)
                            : itemAction.mutate({ item, action: a })
                        }
                      >
                        {a === 'resume' && item.status === 'RUNNING'
                          ? '撤销暂停'
                          : ACTION_LABELS[a]}
                      </Button>
                    ))}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </SectionCard>

      <Modal
        open={itemStopping !== null}
        onClose={() => setItemStopping(null)}
        size="sm"
        title="停止子任务"
        footer={
          <>
            <Button variant="outline" onClick={() => setItemStopping(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={itemAction.isPending}
              onClick={() =>
                itemStopping && itemAction.mutate({ item: itemStopping, action: 'stop' })
              }
            >
              确认停止
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-ink-2">
          停止「{itemStopping?.title}」后不能恢复，已完成的部分保留。
        </p>
      </Modal>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        size="sm"
        title={confirm === 'delete' ? '删除组合任务' : '停止组合任务'}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => (confirm === 'delete' ? remove.mutate() : lifecycle.mutate('stop'))}
            >
              {confirm === 'delete' ? '确认删除' : '确认停止'}
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-ink-2">
          {confirm === 'delete'
            ? '删除后不能恢复，已生成的检测记录保留。'
            : '未启动的子任务将取消，已在执行的语料扫描、资产测绘会继续跑完。'}
        </p>
      </Modal>
    </div>
  );
}

/** 从组合任务生成综合检测报告（2.4.7）：各子任务的结果汇成一份，按四类检测分章。 */
function JobReportModal({
  jobId,
  jobName,
  onClose,
}: {
  jobId: string;
  jobName: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(`${jobName} 综合检测报告`);
  const [templateId, setTemplateId] = useState('');
  const generate = useMutation({
    mutationFn: () =>
      detectJobsApi.report(jobId, {
        title: title.trim(),
        ...(templateId ? { templateId } : {}),
      }),
    onSuccess: (report) => {
      toast.success('综合检测报告已生成');
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      onClose();
      navigate(`/reports?reportId=${encodeURIComponent(report.id)}`);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="生成综合报告"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!title.trim() || generate.isPending} onClick={() => generate.mutate()}>
            生成
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="报告标题" htmlFor="job-report-title" required>
          <Input
            id="job-report-title"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <ReportTemplateSelect value={templateId} onChange={setTemplateId} />
      </div>
    </Modal>
  );
}
