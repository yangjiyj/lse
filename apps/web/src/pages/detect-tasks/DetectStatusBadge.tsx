import { DETECT_TASK_STATUS_LABELS, type DetectTaskStatus } from '@lse/shared';
import { Badge } from '@/components/ui/badge';
import { TASK_STATUS_TONE } from '@/lib/format';

/** 检测任务的统一状态（六种）。 */
export function DetectStatusBadge({ value }: { value: DetectTaskStatus | string }) {
  const label = DETECT_TASK_STATUS_LABELS[value as DetectTaskStatus] ?? value;
  const tone = TASK_STATUS_TONE[value as DetectTaskStatus] ?? 'neutral';
  return (
    <Badge tone={tone} icon>
      {label}
    </Badge>
  );
}

function NotStartedBadge() {
  return (
    <Badge tone="neutral" icon>
      未启动
    </Badge>
  );
}

/**
 * 组合任务的状态：PENDING 表示还没启动，显示「未启动」而不是「排队中」；
 * 失败但有完成的子任务时显示「部分失败」。列表、详情共用。
 */
export function DetectJobStatusBadge({
  job,
}: {
  job: { status: DetectTaskStatus | string; itemCounts?: Partial<Record<string, number>> };
}) {
  if (job.status === 'PENDING') return <NotStartedBadge />;
  if (job.status === 'FAILED' && (job.itemCounts?.COMPLETED ?? 0) > 0) {
    return (
      <Badge tone="warning" icon>
        部分失败
      </Badge>
    );
  }
  return <DetectStatusBadge value={job.status} />;
}

/**
 * 组合任务里子任务的状态：还没领取、没建检测记录的显示「未启动」；
 * 建了记录后跟着记录走（记录在排队就是「排队中」）。
 */
export function DetectJobItemStatusBadge({
  item,
}: {
  item: {
    status: DetectTaskStatus | string;
    recordId: string | null;
    launchedAt?: string | null;
  };
}) {
  if (item.status === 'PENDING' && !item.recordId && !item.launchedAt) {
    return <NotStartedBadge />;
  }
  return <DetectStatusBadge value={item.status} />;
}
