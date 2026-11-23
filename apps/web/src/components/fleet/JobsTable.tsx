import { Link } from 'react-router-dom';
import { Check, X } from 'lucide-react';
import type { FleetJob } from '@/lib/api';
import { productLabel } from '@/lib/endpoint-agents';
import { fleetJobError } from '@/lib/fleet-job-error';
import { FLEET_JOB_STATUS_HINT } from '@/lib/fleet';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { JobStatusBadge } from './FleetBadges';

interface Props {
  jobs: FleetJob[];
  canManage: boolean;
  onApprove: (job: FleetJob) => void;
  onReject: (job: FleetJob) => void;
  onCancel: (job: FleetJob) => void;
  /** 已下发/执行中的任务：终端管理员可以强制结束。 */
  onForceClose: (job: FleetJob) => void;
  /** 紧凑模式：详情里的最近任务，去掉终端列和操作列。 */
  compact?: boolean;
  busyId?: string | null;
  /** 全局视角：显示「租户」列。 */
  isAllTenants?: boolean;
  tenantName?: (tenantId?: string | null) => string;
  /** 全局视角：点行操作/行链接前先进入该行所属租户；返回 true 表示已接管。 */
  onRowAction?: (job: FleetJob) => boolean;
}

const host = (job: FleetJob) => job.endpoint?.hostname ?? '—';

function who(u: { username: string; displayName?: string | null } | null): string {
  return u?.username ?? '—';
}

function JobAction({
  job,
  canManage,
  onApprove,
  onReject,
  onCancel,
  onForceClose,
  busy,
}: {
  job: FleetJob;
  canManage: boolean;
  onApprove: (j: FleetJob) => void;
  onReject: (j: FleetJob) => void;
  onCancel: (j: FleetJob) => void;
  onForceClose: (j: FleetJob) => void;
  busy: boolean;
}) {
  if (job.status === 'PENDING_APPROVAL') {
    if (!canManage)
      return (
        <span className="text-[13px] text-ink-3">{FLEET_JOB_STATUS_HINT.PENDING_APPROVAL}</span>
      );
    // 升级前遗留的待批准旧任务：任何管理员（包括发起人本人）都可以批准或驳回。
    return (
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          disabled={busy}
          aria-label={`批准：${host(job)}`}
          onClick={() => onApprove(job)}
        >
          <Check className="h-3.5 w-3.5" />
          批准
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          aria-label={`驳回：${host(job)}`}
          onClick={() => onReject(job)}
        >
          <X className="h-3.5 w-3.5" />
          驳回
        </Button>
      </div>
    );
  }
  if (job.status === 'QUEUED') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-ink-3">{FLEET_JOB_STATUS_HINT.QUEUED}</span>
        {canManage && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onCancel(job)}>
            取消
          </Button>
        )}
      </div>
    );
  }
  if (job.status === 'DELIVERED' || job.status === 'RUNNING') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-ink-3">{FLEET_JOB_STATUS_HINT[job.status]}</span>
        {canManage && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onForceClose(job)}>
            强制结束
          </Button>
        )}
      </div>
    );
  }
  if (job.status === 'COMPLETED' && job.evalTaskId) {
    return (
      <Link
        to={`/eval-tasks/${job.evalTaskId}`}
        className="text-[13px] font-semibold text-primary hover:underline"
      >
        查看评估任务
      </Link>
    );
  }
  const hint = FLEET_JOB_STATUS_HINT[job.status];
  if (hint) return <span className="text-[13px] text-ink-3">{hint}</span>;
  if (job.status === 'REJECTED') {
    return <span className="text-[13px] text-ink-3">驳回原因：{job.rejectReason || '—'}</span>;
  }
  if (job.status === 'FAILED' || job.status === 'EXPIRED') {
    return (
      <span className="text-[13px] text-ink-3">
        {fleetJobError(job.errorCode ?? (job.status === 'EXPIRED' ? 'expired' : null), job.product)}
      </span>
    );
  }
  return <span className="text-[13px] text-ink-3">—</span>;
}

/** 测评任务表：新任务创建即下发；升级前遗留的待批准旧任务行仍带批准/驳回。 */
export function JobsTable({
  jobs,
  canManage,
  onApprove,
  onReject,
  onCancel,
  onForceClose,
  compact,
  busyId,
  isAllTenants,
  tenantName,
  onRowAction,
}: Props) {
  return (
    <Table>
      <THead>
        <TR>
          {isAllTenants && !compact && <TH>租户</TH>}
          <TH>状态</TH>
          {!compact && <TH>终端</TH>}
          <TH>智能体</TH>
          <TH>样本</TH>
          <TH>发起人</TH>
          <TH>发起时间</TH>
          <TH>截止时间</TH>
          <TH>备注</TH>
          <TH>{compact ? '说明' : '操作'}</TH>
        </TR>
      </THead>
      <TBody>
        {jobs.map((job) => {
          return (
            <TR key={job.id}>
              {isAllTenants && !compact && (
                <TD data-label="租户"><span data-testid="tenant-cell">{tenantName?.(job.tenantId) ?? ''}</span></TD>
              )}
              <TD data-label="状态">
                <JobStatusBadge status={job.status} />
              </TD>
              {!compact && (
                <TD data-label="终端" className="font-medium">
                  {host(job)}
                </TD>
              )}
              <TD data-label="智能体">{productLabel(job.product)}</TD>
              <TD data-label="样本">{job.sampleCount == null ? '数量未上报' : `${job.sampleCount} 条`}
                <span className="block text-xs text-ink-3">{job.suite === 'runtime_v2' ? '蜜罐沙箱' : job.suite === 'classic' ? '真实配置' : '环境未上报'} · {job.scenarioCount} 个场景</span></TD>
              <TD data-label="发起人">
                <div>{who(job.requestedBy)}</div>
                {/* 新任务由发起人自己下发；只有升级前遗留、由别人批准过的旧任务才多写一行。 */}
                {job.approvedBy && job.approvedBy.id !== job.requestedBy?.id && (
                  <div className="text-xs text-ink-3">批准：{who(job.approvedBy)}</div>
                )}
              </TD>
              <TD data-label="发起时间">{job.createdAt ? formatDateTime(job.createdAt) : '未上报'}</TD>
              <TD data-label="截止时间">{job.deadline ? formatDateTime(job.deadline) : '—'}</TD>
              <TD data-label="备注" className="max-w-[240px]">
                <span className="line-clamp-2 break-words" title={job.reason}>
                  {job.reason}
                </span>
              </TD>
              <TD data-label={compact ? '说明' : '操作'}
                onClickCapture={onRowAction ? (ev) => {
                  if (onRowAction(job)) {
                    ev.preventDefault();
                    ev.stopPropagation();
                  }
                } : undefined}>
                <JobAction
                  job={job}
                  canManage={canManage}
                  onApprove={onApprove}
                  onReject={onReject}
                  onCancel={onCancel}
                  onForceClose={onForceClose}
                  busy={busyId === job.id}
                />
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
