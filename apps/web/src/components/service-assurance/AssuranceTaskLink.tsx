import { useState } from 'react';
import type { ServiceAssuranceRunListItem } from '@lse/shared';
import { FileText, Link2, Unlink } from 'lucide-react';
import type { EvalTask } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';

interface AssuranceTaskLinkProps {
  run: ServiceAssuranceRunListItem;
  tasks: EvalTask[];
  canLink: boolean;
  canGenerateReport: boolean;
  linking: boolean;
  reporting: boolean;
  onLink: (taskId: string) => void;
  onUnlink: () => void;
  onGenerateReport: (taskId: string) => void;
}

const ACTIVE = ['PENDING', 'RUNNING'];

export function AssuranceTaskLink({
  run,
  tasks,
  canLink,
  canGenerateReport,
  linking,
  reporting,
  onLink,
  onUnlink,
  onGenerateReport,
}: AssuranceTaskLinkProps) {
  const [taskId, setTaskId] = useState('');
  const active = ACTIVE.includes(run.status);
  const linkedTask = run.taskId ? (tasks.find((task) => task.id === run.taskId) ?? null) : null;

  if (run.taskId) {
    const completed = linkedTask?.status === 'COMPLETED';
    return (
      <section
        aria-label="归属评估任务"
        className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm"
      >
        <div className="min-w-0">
          <p className="font-semibold text-slate-900">
            已关联评估任务：{run.taskName ?? linkedTask?.name ?? '（任务不可见）'}
          </p>
          {canGenerateReport && (
            <p
              id="service-assurance-report-hint"
              className="mt-0.5 text-xs leading-5 text-slate-600"
            >
              {completed
                ? '汇总报告包含该任务下全部已关联的服务核验记录，不仅是当前选中的一次运行。'
                : '归属评估任务完成后才能生成汇总报告；本次核验结果仍可查看。'}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {canGenerateReport && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onGenerateReport(run.taskId!)}
              disabled={!completed || reporting}
              aria-describedby="service-assurance-report-hint"
            >
              <FileText className="h-4 w-4" />
              {reporting ? '生成中' : '生成归属任务汇总报告'}
            </Button>
          )}
          {canLink && (
            <Button type="button" variant="outline" onClick={onUnlink} disabled={linking || active}>
              <Unlink className="h-4 w-4" />
              取消关联
            </Button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="归属评估任务"
      className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm"
    >
      <p className="font-semibold text-slate-900">未关联评估任务</p>
      <p className="mt-0.5 text-xs leading-5 text-slate-600">
        关联后，已确认的风险将计入该任务的发现项，并纳入该任务的汇总报告；核验执行结束后方可关联。
      </p>
      {canLink && (
        <div className="mt-3 flex min-w-0 flex-wrap items-end gap-3">
          <Field
            label="关联评估任务"
            htmlFor="service-assurance-link-task"
            className="min-w-[14rem]"
          >
            <Select
              id="service-assurance-link-task"
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
              disabled={tasks.length === 0}
            >
              <option value="">
                {tasks.length === 0 ? '暂无可关联的评估任务' : '请选择评估任务'}
              </option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            type="button"
            onClick={() => taskId && onLink(taskId)}
            disabled={!taskId || linking || active}
          >
            <Link2 className="h-4 w-4" />
            {linking ? '正在关联' : '关联评估任务'}
          </Button>
        </div>
      )}
    </section>
  );
}
