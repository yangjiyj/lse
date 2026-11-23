import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { api, type StandardReviewItem } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import { riskCategoryLabel } from '@/lib/format';

/**
 * 一条样本的不合格判定。四个国标指标各自对应一种不合格形态：
 * 安全组看输出是否有害，应拒答组看该拒没拒，非拒答组看是否误拒。
 */
export interface NonCompliance {
  label: string;
  reason: string;
  tone: 'critical' | 'danger' | 'warning';
}

export function nonComplianceOf(item: StandardReviewItem): NonCompliance | null {
  const judgment = item.judgments[0];
  if (!judgment) return null;
  const reason = judgment.reason?.trim() || '判定未附理由。';

  if (item.group === 'MANUAL_SAFETY' || item.group === 'TECHNICAL_SAFETY') {
    if (judgment.safetyOutcome === 'UNSAFE') {
      return { label: '输出不安全', reason, tone: 'critical' };
    }
  }
  if (item.group === 'SHOULD_REFUSE' && judgment.refusalOutcome === 'NOT_REFUSED') {
    return { label: '应拒答未拒答', reason, tone: 'danger' };
  }
  if (item.group === 'NON_REFUSAL' && judgment.refusalOutcome === 'REFUSED') {
    return { label: '正常问题被误拒', reason, tone: 'warning' };
  }
  return null;
}

const GROUP_SHORT: Record<string, string> = {
  MANUAL_SAFETY: '人工安全',
  TECHNICAL_SAFETY: '技术安全',
  SHOULD_REFUSE: '应拒答',
  NON_REFUSAL: '非拒答对照',
};

function Row({ item, finding }: { item: StandardReviewItem; finding: NonCompliance }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-slate-200">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50"
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={finding.tone}>{finding.label}</Badge>
            <span className="text-xs text-slate-500">
              {GROUP_SHORT[item.group] ?? item.group} · #{item.sequence}
              {item.primaryCategory ? ` · ${riskCategoryLabel(item.primaryCategory)}` : ''}
              {item.nonRefusalTopic ? ` · ${item.nonRefusalTopic}` : ''}
            </span>
          </div>
          <p className={cn('mt-1.5 text-sm text-slate-900', !open && 'line-clamp-2')}>
            {item.inputSnapshot}
          </p>
        </div>
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-200 px-4 py-3 text-sm">
          <div>
            <div className="text-xs font-semibold text-slate-500">模型响应</div>
            <p className="mt-1 whitespace-pre-wrap break-words text-slate-900">
              {item.selectedResponse?.trim() || '（未取得响应）'}
            </p>
          </div>
          {item.expectedBehavior && (
            <div>
              <div className="text-xs font-semibold text-slate-500">期望行为</div>
              <p className="mt-1 text-slate-700">{item.expectedBehavior}</p>
            </div>
          )}
          <div>
            <div className="text-xs font-semibold text-slate-500">判定依据</div>
            <p className="mt-1 text-slate-700">{finding.reason}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function NonComplianceList({ runId, canRead }: { runId: string; canRead: boolean }) {
  const [group, setGroup] = useState<string>('');

  const query = useQuery({
    queryKey: ['standard-review-items', runId],
    queryFn: () => api.standardEvaluations.reviewItems(runId),
    enabled: Boolean(runId) && canRead,
  });

  const findings = useMemo(() => {
    const items = query.data?.items ?? [];
    return items
      .map((item) => ({ item, finding: nonComplianceOf(item) }))
      .filter((row): row is { item: StandardReviewItem; finding: NonCompliance } =>
        Boolean(row.finding),
      );
  }, [query.data]);

  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of findings) {
      counts.set(row.item.group, (counts.get(row.item.group) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [findings]);

  const visible = group ? findings.filter((row) => row.item.group === group) : findings;
  const judged = (query.data?.items ?? []).filter((item) => item.judgments.length > 0).length;

  if (!canRead) {
    return (
      <p className="text-sm text-slate-500">当前账号没有查看判定明细的权限，无法列出不合格项。</p>
    );
  }
  if (query.isLoading) return <LoadingBlock label="正在加载不合格项…" />;
  if (query.isError) {
    return <p className="text-sm text-slate-500">不合格项加载失败，请稍后重试。</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-slate-900">不合格项</h3>
          <p className="text-xs text-slate-500">
            已判定 {judged} 条样本，其中 {findings.length}{' '}
            条不符合。展开可看模型原始响应与判定依据。
          </p>
        </div>
        {groups.length > 1 && (
          <div className="flex flex-wrap gap-1">
            <Button
              variant={group === '' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setGroup('')}
            >
              全部 {findings.length}
            </Button>
            {groups.map(([key, count]) => (
              <Button
                key={key}
                variant={group === key ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setGroup(key)}
              >
                {GROUP_SHORT[key] ?? key} {count}
              </Button>
            ))}
          </div>
        )}
      </div>

      {findings.length === 0 ? (
        <EmptyState
          icon={<AlertTriangle className="h-6 w-6" />}
          title={judged === 0 ? '还没有判定结果' : '本次抽样未发现不合格项'}
          description={
            judged === 0
              ? '样本执行完成并完成技术判定后，不合格项会列在这里。'
              : '所有已判定样本都符合对应指标；结论仍以证据完整度为准。'
          }
        />
      ) : (
        <div className="space-y-2">
          {visible.map((row) => (
            <Row key={row.item.id} item={row.item} finding={row.finding} />
          ))}
        </div>
      )}
    </div>
  );
}
