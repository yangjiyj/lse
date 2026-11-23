import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, type EvalTaskRetestInfo } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { formatDateTime, TASK_STATUS_LABELS, type EvalTaskStatus } from '@/lib/format';

interface Props {
  taskId: string;
  retest: EvalTaskRetestInfo | undefined;
  canCreate: boolean;
}

/**
 * 失败用例复测：父任务显示“重跑失败用例”与已发起的复测任务；
 * 复测任务显示“复测：x/y 已修复”（按题目对齐父任务）与父任务链接。
 */
export function FailedRetestPanel({ taskId, retest, canCreate }: Props) {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.evalTasks.retestFailed(taskId),
    onSuccess: (out) => {
      toast.success(`已发起失败用例复测，共 ${out.questionIds.length} 道用例`);
      qc.invalidateQueries({ queryKey: ['eval-task', taskId] });
      navigate(`/eval-tasks/${out.task.id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '发起复测失败'),
  });

  if (!retest) return null;
  const of = retest.retestOf;
  const blocked = retest.retestBlockedReason;

  return (
    <section
      aria-label="失败用例复测"
      className="rounded-card border border-[#EDF1F8] bg-white px-5 py-4 text-sm shadow-card"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          {of ? (
            <>
              <div className="font-semibold text-ink">
                复测：{of.fixed}/{of.total} 已修复
              </div>
              <div className="text-xs text-ink-2">
                仍失败 {of.stillFailing} 道，尚无复测结果 {of.notRetested}{' '}
                道；按题目与父任务对齐统计，平台评分，非认证结论。
              </div>
              <div className="text-xs text-ink-2">
                父任务：
                <button
                  type="button"
                  className="text-brand-600 hover:underline"
                  onClick={() => navigate(`/eval-tasks/${of.parentTaskId}`)}
                >
                  {of.parentTaskName ?? of.parentTaskId}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="font-semibold text-ink">失败用例复测</div>
              <div className="text-xs text-ink-2">
                本任务判定为失败或执行异常的用例 {retest.failedQuestionCount}{' '}
                道；复测只重跑这些用例，沿用原任务的评估对象、引擎与维度。
              </div>
            </>
          )}
        </div>
        {canCreate && (
          <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
            <Button
              variant="outline"
              disabled={Boolean(blocked) || mutation.isPending}
              title={blocked ?? undefined}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending && <Spinner className="h-4 w-4" />}
              重跑失败用例
            </Button>
            {blocked && <span className="text-xs text-ink-3">{blocked}</span>}
          </div>
        )}
      </div>
      {retest.retestTasks.length > 0 && (
        <div className="mt-3 border-t border-line pt-2">
          <div className="mb-1 text-xs text-ink-2">已发起的复测任务</div>
          <ul className="space-y-1">
            {retest.retestTasks.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 text-xs">
                <button
                  type="button"
                  className="text-brand-600 hover:underline"
                  onClick={() => navigate(`/eval-tasks/${r.id}`)}
                >
                  {r.name}
                </button>
                <span className="text-ink-2">
                  {TASK_STATUS_LABELS[r.status as EvalTaskStatus] ?? r.status}
                </span>
                <span className="text-ink-3">{formatDateTime(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
