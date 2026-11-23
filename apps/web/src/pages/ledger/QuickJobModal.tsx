import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { TOOL_TASK_ENTRIES, canCreateToolTask } from '@lse/shared';
import { useAuth } from '@/lib/auth';
import { LEDGER_QUERY_KEY, ledgerApi, type QuickAutoItem } from '@/lib/ledger';
import {
  JobItemEditor,
  jobItemProblem,
  type JobItemParams,
} from '@/pages/detect-tasks/JobItemEditor';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { LoadingBlock } from '@/components/ui/spinner';

interface Draft {
  item: QuickAutoItem;
  checked: boolean;
  params: JobItemParams;
  problem: string | null;
}

/**
 * 按台账快速建任务：按清单生成规则列出这个资产适用的检测；平台自动执行的勾选后补齐参数建组合任务，
 * 人工执行的给出入口链接。
 */
export function QuickJobModal({ assetId, onClose }: { assetId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const quick = useQuery({
    queryKey: [LEDGER_QUERY_KEY, 'quick-items', assetId],
    queryFn: () => ledgerApi.quickItems(assetId),
  });
  const rows: Draft[] =
    drafts ??
    (quick.data?.auto ?? []).map((item) => ({
      item,
      checked: item.ready === true,
      params: item.params as JobItemParams,
      problem: jobItemProblem(item.jobKind, item.params),
    }));
  const patch = (index: number, change: Partial<Draft>) =>
    setDrafts(rows.map((r, i) => (i === index ? { ...r, ...change } : r)));
  const checked = rows.filter((r) => r.checked);
  const blocked = checked.length === 0 || checked.some((r) => r.problem !== null);

  const submit = useMutation({
    mutationFn: (start: boolean) =>
      ledgerApi.quickJob(assetId, {
        items: checked.map((r) => ({
          jobKind: r.item.jobKind,
          title: r.item.title,
          params: r.params,
        })),
        start,
      }),
    onSuccess: (job) => {
      void queryClient.invalidateQueries({ queryKey: [LEDGER_QUERY_KEY, 'detail', assetId] });
      void queryClient.invalidateQueries({ queryKey: ['detect-jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['detect-tasks'] });
      navigate(`/detect-tasks/jobs/${encodeURIComponent(job.id)}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title="快速建任务"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="outline"
            disabled={blocked || submit.isPending}
            onClick={() => submit.mutate(false)}
          >
            建任务
          </Button>
          <Button disabled={blocked || submit.isPending} onClick={() => submit.mutate(true)}>
            建任务并启动
          </Button>
        </>
      }
    >
      {quick.isLoading ? (
        <LoadingBlock />
      ) : quick.isError ? (
        <p className="text-sm text-severity-critical">{(quick.error as Error).message}</p>
      ) : (
        <div className="space-y-3">
          {rows.map((r, index) => (
            <section
              key={`${r.item.jobKind}-${r.item.entryKey}`}
              aria-label={r.item.title}
              className="rounded-xl border border-line p-4"
            >
              <label className="flex items-center gap-2 text-sm font-medium text-ink">
                <input
                  type="checkbox"
                  checked={r.checked}
                  onChange={() => patch(index, { checked: !r.checked })}
                />
                {r.item.title}
              </label>
              {r.checked && (
                <div className="mt-3">
                  <JobItemEditor
                    kind={r.item.jobKind}
                    value={r.params}
                    onChange={(params, problem) => patch(index, { params, problem })}
                  />
                  {r.problem && (
                    <p className="mt-2 text-[12.5px] text-severity-medium">{r.problem}</p>
                  )}
                </div>
              )}
            </section>
          ))}
          {(quick.data?.manual ?? []).length > 0 && (
            <ul className="space-y-1.5 text-sm" aria-label="人工执行">
              {quick.data!.manual.map((m) => (
                <li key={m.entryKey}>
                  {canCreateToolTask(TOOL_TASK_ENTRIES[m.entryKey], hasPermission) ? (
                    <Link to={m.createPath} className="text-brand-700 hover:underline">
                      {m.title}
                    </Link>
                  ) : (
                    <span className="text-ink-2">{m.title}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {rows.length === 0 && (quick.data?.manual ?? []).length === 0 && (
            <p className="text-sm text-ink-3">—</p>
          )}
          {error && <p className="text-sm text-severity-critical">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
