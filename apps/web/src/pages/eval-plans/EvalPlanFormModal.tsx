import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type EvalPlanInput, type EvalPlanItem } from '@/lib/api';
import { ENGINE_CATALOG, engineLabel } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { describeCron } from './cron-describe';
import {
  CRON_PRESETS,
  DEFAULT_MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  REQUIRED_ENGINES,
  planFormToInput,
  planToForm,
  type PlanFormState,
} from './eval-plan-form';

const ENGINE_HINTS: Record<string, string> = Object.fromEntries(
  ENGINE_CATALOG.map((e) => [e.code, e.hint]),
);

export function EvalPlanFormModal({
  plan,
  onClose,
}: {
  /** null = 新建；对象 = 编辑 */
  plan: EvalPlanItem | null;
  onClose: () => void;
}) {
  const [form, setForm] = useState<PlanFormState>(() => planToForm(plan));
  // 编辑时计划原已选的样本库：即使后来被禁用也列出来（标「已禁用」），方便取消勾选。
  const [initialSetIds] = useState(() => new Set(planToForm(plan).questionSetIds));
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const targets = useQuery({
    queryKey: ['model-targets', 'plan-options'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 100 }),
  });
  const sets = useQuery({
    queryKey: ['question-sets', 'plan-options'],
    queryFn: () => api.questionSets.list({ page: 1, pageSize: 100 }),
  });
  const engines = useQuery({
    queryKey: ['engines-catalog'],
    queryFn: () => api.engines.list(),
    staleTime: 60 * 60 * 1000,
  });
  useEffect(() => setError(null), [form]);

  const save = useMutation({
    mutationFn: (input: EvalPlanInput) => {
      if (!plan) return api.evalPlans.create(input);
      // 启停走单独接口，编辑不改启停状态。
      const { enabled: _enabled, ...rest } = input;
      return api.evalPlans.update(plan.id, rest);
    },
    onSuccess: () => {
      toast.success(plan ? '评估计划已更新' : '评估计划已创建');
      void qc.invalidateQueries({ queryKey: ['eval-plans'] });
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : '保存失败'),
  });
  const set = <K extends keyof PlanFormState>(k: K, v: PlanFormState[K]) =>
    setForm((p) => ({ ...p, [k]: v }));
  const toggleIn = (k: 'questionSetIds' | 'engines', v: string) =>
    setForm((p) => ({
      ...p,
      [k]: p[k].includes(v) ? p[k].filter((x) => x !== v) : [...p[k], v],
    }));
  const submit = () => {
    const input = planFormToInput(form, plan?.templateParams);
    if (typeof input === 'string') return setError(input);
    save.mutate(input);
  };
  const executableTargets = (targets.data?.items ?? []).filter(
    (t) => t.targetType !== 'GATEWAY_LOG',
  );
  const allSetItems = (sets.data?.items ?? []).filter(
    (s) => s.enabled !== false || initialSetIds.has(s.id),
  );
  // 默认只列种子库和自有样本库；任务自动生成的运行记录收进折叠区。
  const setItems = allSetItems.filter((s) => s.kind !== 'run');
  const runRecordItems = allSetItems.filter((s) => s.kind === 'run');
  const renderSetOption = (s: (typeof allSetItems)[number]) => (
    <label key={s.id} className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={form.questionSetIds.includes(s.id)}
        onChange={() => toggleIn('questionSetIds', s.id)}
      />
      <span>{s.enabled === false ? `${s.name}（已禁用）` : s.name}</span>
    </label>
  );

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={plan ? '编辑评估计划' : '新建评估计划'}
      description="按 cron 定时生成评估任务。同一计划上次任务未结束、或距上次触发不足最小间隔时，本次触发跳过并记录原因。"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={save.isPending} onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="计划名称" htmlFor="plan-name" required>
          <Input
            id="plan-name"
            value={form.name}
            maxLength={160}
            onChange={(e) => set('name', e.target.value)}
          />
        </Field>
        <Field label="评估对象" htmlFor="plan-target" required>
          <Select
            id="plan-target"
            value={form.targetId}
            onChange={(e) => set('targetId', e.target.value)}
          >
            <option value="">请选择</option>
            {executableTargets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.isActive ? t.name : `${t.name}（已禁用）`}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="执行周期（cron）"
          htmlFor="plan-cron"
          required
          hint={`${describeCron(form.cron)}；5 段：分 时 日 月 周`}
        >
          <Input
            id="plan-cron"
            className="font-mono"
            value={form.cron}
            onChange={(e) => set('cron', e.target.value)}
          />
        </Field>
        <Field label="常用周期" htmlFor="plan-cron-preset">
          <Select
            id="plan-cron-preset"
            value={CRON_PRESETS.some((p) => p.value === form.cron) ? form.cron : ''}
            onChange={(e) => {
              if (e.target.value) set('cron', e.target.value);
            }}
          >
            <option value="">自定义</option>
            {CRON_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="时区" htmlFor="plan-tz">
          <Input
            id="plan-tz"
            value={form.timezone}
            onChange={(e) => set('timezone', e.target.value)}
          />
        </Field>
        <Field
          label="最小间隔（分钟）"
          htmlFor="plan-min-interval"
          hint={`默认 ${DEFAULT_MIN_INTERVAL_MINUTES}，范围 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES}；cron 相邻两次触发也不得小于它`}
        >
          <Input
            id="plan-min-interval"
            inputMode="numeric"
            value={form.minIntervalMinutes}
            onChange={(e) => set('minIntervalMinutes', e.target.value)}
          />
        </Field>
        <Field label="并发数" htmlFor="plan-concurrency" hint="1–32，默认 4">
          <Input
            id="plan-concurrency"
            inputMode="numeric"
            value={form.concurrency}
            onChange={(e) => set('concurrency', e.target.value)}
          />
        </Field>
        <Field
          label="抽样题数"
          htmlFor="plan-sample"
          hint="留空为全量；抽样计划固定种子，各次运行题目一致"
        >
          <Input
            id="plan-sample"
            inputMode="numeric"
            value={form.sampleSize}
            onChange={(e) => set('sampleSize', e.target.value)}
          />
        </Field>
        <Field label="样本库" required className="sm:col-span-2">
          <div className="max-h-40 space-y-1.5 overflow-y-auto rounded border border-slate-200 p-3">
            {sets.isLoading ? (
              <Spinner className="h-4 w-4" />
            ) : allSetItems.length === 0 ? (
              <p className="text-sm text-slate-500">暂无数据</p>
            ) : (
              <>
                {setItems.map(renderSetOption)}
                {runRecordItems.length > 0 && (
                  <details className="pt-1">
                    <summary className="cursor-pointer text-xs text-slate-500">
                      展开运行记录（{runRecordItems.length}）任务自动生成的样本快照，一般无需选择
                    </summary>
                    <div className="mt-1.5 space-y-1.5">{runRecordItems.map(renderSetOption)}</div>
                  </details>
                )}
              </>
            )}
          </div>
        </Field>
        <Field label="安全引擎" hint="规则与敏感信息为内置引擎，始终启用" className="sm:col-span-2">
          <div className="space-y-1.5 rounded border border-slate-200 p-3">
            {engines.isLoading ? (
              <Spinner className="h-4 w-4" />
            ) : (
              (engines.data ?? [])
                .filter((e) => e.builtin || e.available)
                .map((e) => {
                  const required = REQUIRED_ENGINES.includes(e.engine);
                  return (
                    <label
                      key={e.engine}
                      className="flex items-center gap-2 text-sm"
                      title={ENGINE_HINTS[e.engine] ?? '评估回答的安全性。'}
                    >
                      <input
                        type="checkbox"
                        checked={required || form.engines.includes(e.engine)}
                        disabled={required}
                        onChange={() => toggleIn('engines', e.engine)}
                      />
                      <span>{engineLabel(e.engine)}</span>
                    </label>
                  );
                })
            )}
          </div>
        </Field>
        <Field label="描述" htmlFor="plan-desc" className="sm:col-span-2">
          <Textarea
            id="plan-desc"
            rows={2}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </Field>
        {!plan && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />
            创建后立即启用调度
          </label>
        )}
        {error && <p className="text-sm text-severity-critical sm:col-span-2">{error}</p>}
      </div>
    </Modal>
  );
}
