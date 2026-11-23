import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, TASK_STATUS_LABELS } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Field } from '@/components/ui/field';

export interface PlanRunSelection {
  planId?: string;
  baseTaskId?: string;
  headTaskId?: string;
}

function runLabel(t: { name: string; status: string; createdAt: string }): string {
  const status = TASK_STATUS_LABELS[t.status as keyof typeof TASK_STATUS_LABELS] ?? t.status;
  return `${formatDateTime(t.createdAt)} · ${status} · ${t.name}`;
}

/**
 * 按计划选运行：选计划后默认对比最近一次与其上一次；可改选本次运行与基线运行。
 * 基线留“上一次（自动）”时由后端取本次之前的相邻一次运行。
 */
export function PlanRunPicker({
  value,
  onChange,
}: {
  value: PlanRunSelection;
  onChange: (next: PlanRunSelection) => void;
}) {
  const plans = useQuery({
    queryKey: ['eval-plans', 'compare-options'],
    queryFn: () => api.evalPlans.list({ page: 1, pageSize: 100 }),
  });
  const runs = useQuery({
    queryKey: ['eval-plans', value.planId, 'tasks'],
    queryFn: () => api.evalPlans.tasks(value.planId!),
    enabled: Boolean(value.planId),
  });
  const runItems = runs.data?.items ?? [];
  const headIndex = value.headTaskId ? runItems.findIndex((t) => t.id === value.headTaskId) : 0;
  const olderRuns = headIndex >= 0 ? runItems.slice(headIndex + 1) : runItems;

  return (
    <Card>
      <CardContent className="p-4">
        <h2 className="mb-3 text-sm font-semibold">按计划选运行</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="评估计划" htmlFor="compare-plan">
            <Select
              id="compare-plan"
              value={value.planId ?? ''}
              onChange={(e) => onChange({ planId: e.target.value || undefined })}
            >
              <option value="">请选择</option>
              {(plans.data?.items ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="本次运行" htmlFor="compare-head">
            <Select
              id="compare-head"
              disabled={!value.planId}
              value={value.headTaskId ?? ''}
              onChange={(e) =>
                onChange({ planId: value.planId, headTaskId: e.target.value || undefined })
              }
            >
              <option value="">最近一次</option>
              {runItems.map((t) => (
                <option key={t.id} value={t.id}>
                  {runLabel(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="基线运行" htmlFor="compare-base">
            <Select
              id="compare-base"
              disabled={!value.planId}
              value={value.baseTaskId ?? ''}
              onChange={(e) => {
                const baseTaskId = e.target.value || undefined;
                // 显式选基线时同时固定本次运行（未选则取最近一次）。
                const headTaskId = value.headTaskId ?? (baseTaskId ? runItems[0]?.id : undefined);
                onChange({ planId: value.planId, headTaskId, baseTaskId });
              }}
            >
              <option value="">上一次（自动）</option>
              {olderRuns.map((t) => (
                <option key={t.id} value={t.id}>
                  {runLabel(t)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {value.planId && runs.isSuccess && runItems.length < 2 && (
          <p className="mt-3 text-sm text-severity-high">
            该计划运行次数不足两次，暂无可对比的运行。
          </p>
        )}
      </CardContent>
    </Card>
  );
}
