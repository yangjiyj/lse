import type { ServiceAssuranceRunListItem } from '@lse/shared';
import { Ban, Clock3 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { BadgeTone } from '@/lib/format';

const MODE_LABEL = {
  SAFE: '基础检查',
  DEEP: '基础及附加授权检查',
  SBOM: '组件清单核验',
} as const;

const STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  PENDING: { label: '等待执行', tone: 'neutral' },
  RUNNING: { label: '正在核验', tone: 'info' },
  COMPLETED: { label: '已完成', tone: 'success' },
  PARTIAL: { label: '覆盖不完整', tone: 'warning' },
  FAILED: { label: '核验未完成', tone: 'critical' },
  CANCELED: { label: '已取消', tone: 'neutral' },
};

function dateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

interface AssuranceTimelineProps {
  runs: ServiceAssuranceRunListItem[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onCancel: (runId: string) => void;
  canceling: boolean;
  canCancel: (run: ServiceAssuranceRunListItem) => boolean;
  toolbar?: React.ReactNode;
  emptyText?: string;
}

export function AssuranceTimeline({
  runs,
  selectedRunId,
  onSelect,
  onCancel,
  canceling,
  canCancel,
  toolbar,
  emptyText = '暂无服务安全核验记录。',
}: AssuranceTimelineProps) {
  return (
    <section className="min-w-0 rounded-md border border-line bg-white shadow-sm">
      <div className="border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">核验记录</h2>
        {toolbar}
      </div>
      {runs.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink-3">{emptyText}</p>
      ) : (
        <div className="max-h-[30rem] divide-y divide-slate-100 overflow-y-auto scrollbar-thin">
          {runs.map((run) => {
            const status = STATUS_META[run.status] ?? {
              label: run.statusMessage,
              tone: 'neutral' as const,
            };
            const selected = selectedRunId === run.runId;
            return (
              <div key={run.runId} className={cn('min-w-0 p-3', selected && 'bg-sky-50/70')}>
                <button
                  type="button"
                  className="w-full min-w-0 text-left"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(run.runId)}
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="break-words text-sm font-semibold text-ink">
                        {run.targetName}
                      </div>
                      {run.targetAddress && (
                        <p className="mt-1 break-all text-xs text-ink-3">{run.targetAddress}</p>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                        <span>{MODE_LABEL[run.mode]}</span>
                        <span data-testid="assurance-run-task">
                          {run.taskId ? `已关联：${run.taskName ?? '（任务不可见）'}` : '未关联'}
                        </span>
                        {run.targetKind === 'MCP' && <span>MCP（历史记录）</span>}
                        <span className="inline-flex items-center gap-1">
                          <Clock3 className="h-3.5 w-3.5" />
                          {dateTime(run.createdAt)}
                        </span>
                      </div>
                    </div>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                  {run.status === 'FAILED' && (
                    <p className="mt-2 break-words text-xs leading-5 text-ink-3">
                      {run.statusMessage}
                    </p>
                  )}
                </button>
                {selected && canCancel(run) && (
                  <div className="mt-3 flex justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={canceling}
                      onClick={() => onCancel(run.runId)}
                    >
                      <Ban className="h-4 w-4" />
                      {canceling ? '正在取消' : '取消核验'}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
