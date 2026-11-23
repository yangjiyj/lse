import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { SeverityBadge, VerdictBadge } from '@/components/ui/status-badge';

/** 题目的「检测记录」：这道题在各任务里的结果，点任务名进任务详情。 */
export function QuestionResults({ setId, questionId }: { setId: string; questionId: string }) {
  const [open, setOpen] = useState(false);
  const results = useQuery({
    queryKey: ['question-results', setId, questionId],
    queryFn: () => api.questionSets.questionResults(setId, questionId),
    enabled: open,
  });
  const items = results.data?.items ?? [];
  const total = results.data?.total ?? 0;
  return (
    <div className="mt-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        检测记录
      </Button>
      {open && (
        <div className="mt-2 rounded-xl bg-[#F7F9FD] px-3 py-2 text-xs">
          {results.isLoading ? (
            <Spinner />
          ) : results.isError ? (
            <span className="text-destructive">{(results.error as Error).message}</span>
          ) : items.length === 0 ? (
            <span className="text-ink-3">暂无检测记录</span>
          ) : (
            <ul className="divide-y divide-line">
              {items.map((r, i) => (
                <li key={`${r.taskId}-${i}`} className="flex flex-wrap items-center gap-2 py-1.5">
                  <span className="tabular-nums text-ink-3">{formatDateTime(r.createdAt)}</span>
                  <Link
                    to={`/eval-tasks/${r.taskId}`}
                    className="font-medium text-brand-700 hover:underline"
                  >
                    {r.taskName}
                  </Link>
                  <span className="text-ink-2">{r.targetName}</span>
                  <VerdictBadge value={r.verdict} />
                  {r.severity ? <SeverityBadge value={r.severity} /> : null}
                </li>
              ))}
            </ul>
          )}
          {total > items.length && (
            <p className="pt-1.5 text-ink-3">{`最近 ${items.length} 条，共 ${total.toLocaleString('zh-CN')} 条`}</p>
          )}
        </div>
      )}
    </div>
  );
}
